import type { Bot } from 'grammy';
import { composeMyDayText } from '../tasks/digest';
import { logger } from '../logger';
import {
  assistantFromBot,
  completeTaskFromBot,
  decideApprovalFromBot,
  isCabinetText,
  landCollectedIntake,
  linkStaffChat,
  lookupFromBot,
  noteStaffEntry,
  noteTaskPending,
  parseCallback,
  staffByPhone,
  staffForChat,
  takeStaffEntry,
  takeTaskPending,
  type CalcStep,
} from './staff-bot';
import { aiConfigured } from '../ai/model';
import { codeCandidates } from '../ai/route-text';
import { clientLabels } from './client-labels';
import {
  activeIntake,
  analyzeCollected,
  MAX_INTAKE_IMAGES,
  type IntakeState,
  endIntake,
  mayCollect,
  startIntake,
  updateIntake,
  MAX_QUESTION_ROUNDS,
} from './calc-intake';
import { phoneKeyboard } from './client-cabinet';
import { replyKeyboardFor } from './keyboards';

/**
 * The grammy shell of the staff bot — thin on purpose: every decision lives
 * in staff-bot.ts where the tests can reach it. Registered BEFORE the client
 * cabinet, and every handler that is not for this chat calls next(), so a
 * customer's contact or text falls through to the cabinet untouched.
 *
 * Staff texts are Uzbek, like every staff notification the system already
 * sends — the team writes Uzbek, and a bot that answers each person in the
 * office's four locales would be four times the words for the same button.
 */

/** The single thing the calc conversation needs from grammy's context. */
type CalcReplyCtx = { reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown> };

const BUGUN = '📋 Bugun';
const HISOBLATISH = '🧮 Hisoblatish';
/**
 * The owner's own words, 2026-09-05: «telegramda AI ning o'zi tahminiy
 * hisoblab bersin rastamojka qancha bo'lishini».
 *
 * A SECOND door onto the same collector, not a second collector. It fixes
 * the section to rastamojka (the AI never prices freight — his decision),
 * asks the follow-up questions that make a declaration priceable, and
 * promises a figure in this chat. Everything after the confirm is the path
 * «🧮 Hisoblatish» already walks.
 */
const AI_RASTAMOJKA = '🤖 AI rastamojka';

/** The two labels that open a collection — one list, so every reader agrees. */
export const CALC_ENTRY_LABELS = [HISOBLATISH, AI_RASTAMOJKA];

export function staffKeyboard() {
  return {
    keyboard: [[{ text: BUGUN }, { text: HISOBLATISH }], [{ text: AI_RASTAMOJKA }]],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/**
 * The merged keyboard for a chat that is BOTH staff and client (round 100,
 * 13A). Telegram reply keyboards are exclusive — sending the staff one
 * physically removes the cabinet's buttons from the phone — so a both-chat
 * gets ONE keyboard carrying the staff row above the cabinet rows. The
 * cabinet labels come from the same dictionary its own keyboard and its
 * router read.
 */
export function bothKeyboard(locale?: string | null) {
  const t = clientLabels(locale);
  return {
    keyboard: [
      [{ text: BUGUN }, { text: HISOBLATISH }],
      [{ text: AI_RASTAMOJKA }],
      [{ text: t.btnCargo }, { text: t.btnBalance }],
      [{ text: t.btnHistory }, { text: t.btnLanguage }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

/** The three sections, as buttons (owner: yo'lkira / rastamojka / podklyuch). */
function sectionKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🚚 Yo‘lkira', callback_data: 'c:yolkira' }],
      [{ text: '🛃 Rastamojka', callback_data: 'c:rastamojka' }],
      [{ text: '🔑 Podklyuch', callback_data: 'c:podklyuch' }],
    ],
  };
}

const doneKeyboard = {
  inline_keyboard: [
    [{ text: '✅ Bo‘ldi — tahlil qil', callback_data: 'c:done' }],
    [{ text: '✖️ Bekor qilish', callback_data: 'c:cancel' }],
  ],
};

const confirmKeyboard = {
  inline_keyboard: [
    [{ text: '✅ Tasdiqlash', callback_data: 'c:save' }],
    [{ text: '➕ Yana ma’lumot', callback_data: 'c:more' }],
    [{ text: '✖️ Bekor qilish', callback_data: 'c:cancel' }],
  ],
};

/**
 * The confirm step of an AI-rastamojka collection carries ONE extra control:
 * the certificate of origin.
 *
 * It is the single answer that changes the duty without changing the cargo —
 * PP-3818's additional duty applies only when there is no certificate — and
 * it is the seller who knows. Default TRUE, so the ordinary job quotes at the
 * ordinary rate and only the exception is a press.
 */
function aiConfirmKeyboard(hasCertificate: boolean) {
  return {
    inline_keyboard: [
      [{ text: '✅ Tasdiqlash', callback_data: 'c:save' }],
      [
        {
          text: hasCertificate ? '📄 Sertifikat: bor' : '📄 Sertifikat: yo‘q',
          callback_data: 'c:cert',
        },
      ],
      [{ text: '➕ Yana ma’lumot', callback_data: 'c:more' }],
      [{ text: '✖️ Bekor qilish', callback_data: 'c:cancel' }],
    ],
  };
}

/**
 * A section button pressed while a collection is already live.
 *
 * It used to REPLACE the state silently: a person half-way through forwarding
 * a packing list pressed «🛃 Rastamojka» to re-read the label and lost
 * everything they had sent, with the bot answering as if they had just
 * started. A collection is minutes of somebody's attention — it is not
 * discarded without being asked.
 */
function restartKeyboard(step: string) {
  return {
    inline_keyboard: [
      [{ text: '🔄 Ha, boshqatdan', callback_data: `c:go_${step}` }],
      [{ text: '↩️ Yo‘q, davom etaman', callback_data: 'c:more' }],
    ],
  };
}

export function registerStaffBot(bot: Bot): void {
  bot.on('callback_query:data', async (ctx, next) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    if (!parsed) return next();
    const chatId = BigInt(ctx.chat?.id ?? ctx.callbackQuery.from.id);

    if (parsed.kind === 'entry') {
      await ctx.answerCallbackQuery();
      if (parsed.who === 'client') {
        // The client door is the existing cabinet — nothing more (owner's
        // answer 4). Same phone-verified entry as always.
        const { clientLabels } = await import('./client-labels');
        const t = clientLabels(ctx.from?.language_code);
        await ctx.reply(`${t.notLinked}\n\n${t.linkByPhone}`, {
          reply_markup: phoneKeyboard(ctx.from?.language_code),
        });
        return;
      }
      // Staff door: ask for the Telegram-verified own number, and remember
      // WHY we asked — the contact handler must not staff-link a customer
      // who simply shared a phone.
      noteStaffEntry(chatId);
      await ctx.reply('Hodim sifatida ulanish uchun telefon raqamingizni yuboring 👇', {
        reply_markup: phoneKeyboard('uz'),
      });
      return;
    }

    if (parsed.kind === 'calc') {
      await ctx.answerCallbackQuery();
      await handleCalcCallback(ctx as unknown as CalcReplyCtx, chatId, parsed.step);
      return;
    }

    if (parsed.kind === 'task_done') {
      const staff = await staffForChat(chatId);
      if (!staff) {
        await ctx.answerCallbackQuery({ text: 'Ulanmagan' });
        return;
      }
      noteTaskPending(chatId, parsed.taskId);
      await ctx.answerCallbackQuery();
      await ctx.reply('Natijani yozib yuboring (natijasiz yopish uchun «-» yuboring):');
      return;
    }

    // approval
    const outcome = await decideApprovalFromBot(chatId, parsed.approvalId, parsed.verdict);
    const answers: Record<string, string> = {
      decided: parsed.verdict === 'approved' ? '✅ Ruxsat berildi' : '⛔ Rad etildi',
      not_linked: 'Ulanmagan',
      forbidden: 'Bu qaror sizning huquqingizda emas',
      already_decided: 'Allaqachon hal qilingan',
      not_found: 'So‘rov topilmadi',
    };
    await ctx.answerCallbackQuery({ text: answers[outcome] });
    if (outcome === 'decided') {
      await ctx.reply(
        parsed.verdict === 'approved'
          ? '✅ Ruxsat berildi — beruvchiga xabar ketdi.'
          : '⛔ Rad etildi — so‘ragan xodimga xabar ketdi.',
      );
    }
  });

  // Staff phone-linking: ONLY after the «Hodim» button asked for it, so a
  // customer's shared contact falls through to the cabinet flow untouched.
  bot.on('message:contact', async (ctx, next) => {
    const chatId = BigInt(ctx.chat.id);
    if (!takeStaffEntry(chatId)) return next();
    const contact = ctx.message.contact;
    // The cabinet's spoof-proof rule: only the sender's OWN number counts.
    if (contact.user_id !== ctx.from?.id) {
      await ctx.reply('Faqat o‘zingizning raqamingizni yuboring.');
      return;
    }
    const staff = await staffByPhone(contact.phone_number);
    if (!staff) {
      await ctx.reply(
        'Bu raqam xodimlar ro‘yxatida topilmadi. Sistemaga kirib Profil → Telegram ulash orqali urinib ko‘ring, yoki adminga ayting.',
      );
      return;
    }
    const outcome = await linkStaffChat(staff.id, chatId);
    if (outcome === 'chat_taken') {
      await ctx.reply('Bu Telegram boshqa xodimga ulangan. Adminga ayting.');
      return;
    }
    await ctx.reply(`✅ Ulandi: ${staff.fullName}. Xabarnomalar shu yerga keladi.`, {
      // A client who just became staff keeps their cabinet rows (13A).
      reply_markup: await replyKeyboardFor(chatId),
    });
  });

  // Photos and documents during a collection: stored at once, pre-bound to
  // the note the confirm step will write (#180's pattern). Outside a
  // collection they are somebody else's business — next().
  bot.on(['message:photo', 'message:document'], async (ctx, next) => {
    const chatId = BigInt(ctx.chat.id);
    const state = activeIntake(chatId);
    if (!state) return next();
    const staff = await staffForChat(chatId);
    if (!staff) return next();
    // A photo sent BEFORE the customer is named used to fall through to the
    // cabinet, which answers a staff chat with nothing at all — so the first
    // thing a seller does after pressing the button vanished. Say what is
    // wanted; the photo is not stored, because the note it would be bound to
    // is only meaningful once the collection is under way.
    if (state.stage === 'client') {
      await ctx.reply('Avval mijozni yozing: kodi (GS777), telefon raqami yoki ismi.');
      return;
    }

    const saved = await saveIntakeFile(ctx, state.noteId, staff.id).catch((err: unknown) => {
      logger.warn({ err }, 'intake file save failed');
      return null;
    });
    const caption = ctx.message.caption?.trim();
    // The reduced copy the model will LOOK at (his third report: the cube and
    // the kilos are written on the packing list, and the analysis only ever
    // read text). Capped: a forwarded album is a request body nobody
    // budgeted for, and what does not fit is COUNTED, never dropped in
    // silence — the summary says how many were read.
    let images = state.images;
    let imagesSkipped = state.imagesSkipped;
    if (saved && saved.isPhoto) {
      if (images.length < MAX_INTAKE_IMAGES) {
        const reduced = await reduceForModel(saved.body).catch(() => null);
        if (reduced) images = [...images, { data: reduced, mediaType: 'image/jpeg' as const }];
        else imagesSkipped += 1;
      } else {
        imagesSkipped += 1;
      }
    }
    // The invoice, READ rather than merely stored (sub-round C). Until now
    // an attached document was saved to the card and never opened by
    // anything — a fifty-row packing list the seller had already been sent
    // by the supplier, retyped by hand or lost.
    const read = saved && !saved.isPhoto ? await readInvoice(ctx, saved.body) : null;

    const updated = updateIntake(chatId, {
      stage: 'material',
      fileCount: state.fileCount + (saved ? 1 : 0),
      material: caption ? [...state.material, caption] : state.material,
      images,
      imagesSkipped,
      invoiceGoods: read?.goods?.length ? read.goods : state.invoiceGoods,
      // First one wins: a second PDF about the same shipment is a
      // contradiction nobody can resolve from a chat.
      pdf: state.pdf ?? read?.pdf ?? null,
    });
    if (!saved) {
      await ctx.reply('Faylni saqlab bo‘lmadi — matn bilan yozib yuboring.');
      return;
    }
    if (read?.refusal) await ctx.reply(read.refusal);
    else if (read?.goods?.length) {
      await ctx.reply(`📄 Fayldan ${read.goods.length} ta tovar o‘qildi.`);
    }
    await showIntakePrompt(ctx, chatId, updated ?? state);
  });

  bot.on('message:text', async (ctx, next) => {
    const chatId = BigInt(ctx.chat.id);

    // A live collection swallows text: this is the customer's name, or the
    // material itself.
    //
    // TWO exemptions, both found by the audit. The entry labels, so pressing
    // «🧮 Hisoblatish» or «🤖 AI rastamojka» mid-collection reaches the
    // restart question below instead of being filed as material; and the day
    // screen, because «📋 Bugun» is on the same keyboard the seller is
    // looking at and answering it with silence reads as a broken bot.
    const intake = activeIntake(chatId);
    const isEntryLabel = CALC_ENTRY_LABELS.includes(ctx.message.text);
    const isDayScreen = ctx.message.text === BUGUN || ctx.message.text === '/bugun';
    if (intake && !isEntryLabel && !isDayScreen) {
      if (intake.stage === 'question') {
        await applyLineAnswer(ctx, chatId, intake, ctx.message.text);
        return;
      }
      if (intake.stage === 'client') {
        updateIntake(chatId, { clientHintRaw: ctx.message.text.trim(), stage: 'material' });
        await ctx.reply(
          'Endi hamma narsani yuboring: tovar ro‘yxati, fayllar, rasmlar, kub/kg, yo‘nalish.\n' +
            'Tugagach «Bo‘ldi» ni bosing.',
          { reply_markup: doneKeyboard },
        );
        return;
      }
      const updated = updateIntake(chatId, {
        stage: 'material',
        material: [...intake.material, ctx.message.text],
      });
      await showIntakePrompt(ctx, chatId, updated ?? intake);
      return;
    }

    if (ctx.message.text === HISOBLATISH || ctx.message.text === '/hisoblatish') {
      if (!(await mayCollect(chatId))) return next();
      await ctx.reply('Nimani hisoblatamiz?', { reply_markup: sectionKeyboard() });
      return;
    }

    // The owner's own door: rastamojka, and the machine answers in this chat.
    if (ctx.message.text === AI_RASTAMOJKA || ctx.message.text === '/ai') {
      if (!(await mayCollect(chatId))) return next();
      await handleCalcCallback(ctx as unknown as CalcReplyCtx, chatId, 'ai');
      return;
    }

    // A cabinet button belongs to the CABINET, whoever else this chat is
    // (round 100, 13A): before this line a staff+client chat pressing
    // «📦 Yuklarim» reached the lookup below and heard «Topilmadi». Checked
    // BEFORE the task-result capture too, so pressing a cabinet button while
    // a «Bajarildi» answer is awaited serves the cabinet and leaves the
    // capture armed instead of eating the button as the result.
    if (isCabinetText(ctx.message.text)) return next();

    // Step 2 of «Bajarildi»: this text IS the result.
    const pendingTask = takeTaskPending(chatId);
    if (pendingTask) {
      const result = ctx.message.text.trim() === '-' ? '' : ctx.message.text.trim();
      const outcome = await completeTaskFromBot(chatId, pendingTask, result);
      const answers: Record<string, string> = {
        done: '✅ Vazifa yopildi.',
        not_linked: 'Ulanmagan.',
        not_yours: 'Bu vazifa sizniki emas.',
        already_closed: 'Bu vazifa allaqachon yopilgan.',
        not_found: 'Vazifa topilmadi.',
      };
      await ctx.reply(answers[outcome] ?? outcome);
      return;
    }

    if (ctx.message.text === BUGUN || ctx.message.text === '/bugun') {
      const staff = await staffForChat(chatId);
      if (!staff) return next();
      const text = await composeMyDayText(staff.id).catch((err) => {
        logger.warn({ err }, 'bugun compose failed');
        return null;
      });
      await ctx.reply(text ?? '✅ Bugunga ochiq vazifa yo‘q.');
      return;
    }

    // Anything else a MEMBER OF STAFF types is a lookup: a client code, a box
    // label, a crate or a truck (owner's item 2). A customer's text still
    // falls through — the cabinet answers those, and it must be the LAST
    // fence before the AI: a stranger's words never reach the model or the
    // question ledger.
    const staff = await staffForChat(chatId);
    if (!staff) return next();
    const text = ctx.message.text;
    const freeLookup = async (query: string) =>
      lookupFromBot(chatId, query).catch((err) => {
        logger.warn({ err }, 'bot lookup failed');
        return null;
      });
    // Free first, and free again: the whole text as a code (today's exact
    // behaviour), then any code-shaped word inside a sentence — «GS777
    // qayerda» is answered for nothing before the paid model is considered.
    let answer = await freeLookup(text);
    if (!answer) {
      for (const candidate of codeCandidates(text)) {
        answer = await freeLookup(candidate);
        if (answer) break;
      }
    }
    if (answer) {
      await ctx.reply(answer);
      return;
    }
    if (!aiConfigured()) {
      // No key = exactly the day before the AI shipped.
      await ctx.reply(
        'Topilmadi. Mijoz kodi (GS777), karobka kodi (YW26-000123), yashik (CR-…) yoki partiya kodini yozing.',
      );
      return;
    }
    await ctx.reply('🤖 O‘ylayapman…');
    // NOT awaited, and that is the whole point: grammy's built-in poller is
    // SEQUENTIAL — it handles one update at a time — so awaiting a model
    // loop here would hold the CUSTOMER bot for as long as the answer takes.
    // One admin asking «bu oy qancha pul kirdi» would freeze every cabinet
    // tap, every /start and every arrival flow for tens of seconds, and the
    // owner's own words are that 95 % of customer contact is this channel.
    // The answer is delivered by chat id when it lands, exactly as the
    // notification path already sends unsolicited messages.
    void answerWithAssistant(ctx, chatId, text);
  });
}

/**
 * After the analysis: ask about the next unpriceable line, or offer the
 * confirm (sub-round C).
 *
 * The loop exists because a rastamojka figure needs a measure PER ROW —
 * `unitsForRow` prices per dona on a count and per kg on a weight and can
 * price a row stating neither only by guessing. Asking the seller now costs
 * one message; not asking costs the VED a request they must hand back.
 *
 * Three questions at most (`MAX_QUESTION_ROUNDS`). A bot that keeps asking is
 * a bot the office stops answering, and the confirm always names what is
 * still missing, so nothing is hidden by stopping.
 */
async function askNextOrConfirm(
  ctx: CalcReplyCtx,
  chatId: bigint,
  state: IntakeState,
): Promise<void> {
  const { nextLineToAsk, lineQuestionText, intakeSummaryText } = await import(
    '../../wms/calc/intake'
  );
  const line =
    state.ai && state.round < MAX_QUESTION_ROUNDS
      ? nextLineToAsk(state.section, state.facts, { after: state.askingIndex })
      : null;

  if (line) {
    const next = updateIntake(chatId, {
      stage: 'question',
      askingIndex: line.index,
      round: state.round + 1,
      reasked: false,
    });
    await ctx.reply(lineQuestionText(line), {
      reply_markup: {
        inline_keyboard: [[{ text: '⏭ Bilmayman, o‘tkazib yubor', callback_data: 'c:skip' }]],
      },
    });
    void next;
    return;
  }

  const settled = updateIntake(chatId, { stage: 'review', askingIndex: null }) ?? state;
  await ctx.reply(
    intakeSummaryText({
      section: settled.section,
      facts: settled.facts,
      clientLabel: settled.clientHintRaw || null,
      fileCount: settled.fileCount,
    }) +
      (settled.aiUsed
        ? ''
        : settled.budgetSpent
          ? '\n\n(AI kunlik limiti tugadi — faqat yozilganidan o‘qildi)'
          : '\n\n(AI mavjud emas — faqat yozilganidan o‘qildi)') +
      (settled.ai
        ? `\n\n📄 Sertifikat: ${settled.hasCertificate ? 'bor' : 'yo‘q'} (o‘zgartirish uchun tugmani bosing)`
        : ''),
    { reply_markup: settled.ai ? aiConfirmKeyboard(settled.hasCertificate) : confirmKeyboard },
  );
}

/**
 * The seller's answer to «how many, or how heavy?», written onto the row that
 * was asked about.
 *
 * Addressed by INDEX and never by name: two lines of a packing list are
 * routinely called the same thing. An unreadable answer is re-asked ONCE and
 * then kept as material — the VED reads everything the seller sent, so
 * nothing is lost by moving on, and a wrong reading would be a weight nobody
 * stated with a duty computed on it.
 */
async function applyLineAnswer(
  ctx: CalcReplyCtx,
  chatId: bigint,
  state: IntakeState,
  text: string,
): Promise<void> {
  const { parseLineAnswer } = await import('../../wms/calc/intake-manual');
  const { nextLineToAsk } = await import('../../wms/calc/intake');
  const index = state.askingIndex ?? 0;
  const goods = state.facts.goods ?? [];
  const row = goods[index];
  const bareMeans =
    nextLineToAsk(state.section, state.facts, { after: index - 1 })?.bareMeans ?? 'quantity';
  const answer = row ? parseLineAnswer(text, { bareMeans }) : null;

  if (!answer) {
    // Keep the words either way — the note shows the seller's own material
    // verbatim (law 11), so an unread answer is still in front of the VED.
    const kept = updateIntake(chatId, { material: [...state.material, text] }) ?? state;
    if (!kept.reasked) {
      updateIntake(chatId, { reasked: true });
      await ctx.reply('Tushunmadim. «50 dona» yoki «300 kg» ko‘rinishida yozing.');
      return;
    }
    await askNextOrConfirm(ctx, chatId, { ...kept, reasked: false });
    return;
  }

  const patched = goods.map((g, i) =>
    i === index
      ? {
          ...g,
          quantity: 'quantity' in answer ? answer.quantity : g.quantity,
          weightKg: 'weightKg' in answer ? answer.weightKg : g.weightKg,
        }
      : g,
  );
  const next =
    updateIntake(chatId, {
      facts: { ...state.facts, goods: patched },
      material: [...state.material, text],
      reasked: false,
    }) ?? state;
  await askNextOrConfirm(ctx, chatId, next);
}

/**
 * Analyse the collected material off the middleware chain, and send the
 * summary when it lands. Everything is caught: a rejection here would be an
 * unhandled promise, and the person is left with «⏳ Tahlil qilinmoqda…» and
 * no answer, so the failure has to say so in the chat.
 */
async function analyseIntakeAndReply(
  ctx: { reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown> },
  chatId: bigint,
  state: Parameters<typeof analyzeCollected>[0],
): Promise<void> {
  try {
    const analysed = await analyzeCollected(state);
    updateIntake(chatId, analysed);
    // ONE exit from the analysis: ask about the first line that cannot be
    // priced, else offer the confirm. Both shapes are the same function, so
    // the summary the seller reads is identical whichever way they arrive.
    await askNextOrConfirm(ctx, chatId, analysed);
  } catch {
    await ctx.reply('Tahlil qilib bo‘lmadi. Qaytadan urinib ko‘ring.').catch(() => {});
  }
}

/**
 * Ask the assistant OFF the middleware chain and deliver the answer when it
 * arrives (see the call site: the poller is sequential, so this must not be
 * awaited). Everything is caught — a rejection here would be an unhandled
 * promise, which is the one way a background answer could take the process
 * down rather than merely fail.
 */
async function answerWithAssistant(
  ctx: { api: { sendMessage: (chatId: number | string, text: string) => Promise<unknown> } },
  chatId: bigint,
  text: string,
): Promise<void> {
  const replies: Record<string, string> = {
    not_configured:
      'Topilmadi. Mijoz kodi (GS777), karobka kodi (YW26-000123), yashik (CR-…) yoki partiya kodini yozing.',
    limit: 'Bugungi AI savollar chegarasi tugadi — ertaga yana so‘rang.',
    error: 'AI javob berolmadi. Keyinroq urinib ko‘ring.',
  };
  try {
    const outcome = await assistantFromBot(chatId, text);
    if (!outcome) return;
    const answer =
      outcome.status === 'ok'
        ? outcome.answer
        : outcome.status === 'gave_up'
          ? (outcome.answer ?? 'Oxirigacha yetolmadim — savolni soddaroq berib ko‘ring.')
          : (replies[outcome.status] ?? replies.error!);
    await ctx.api.sendMessage(String(chatId), answer);
  } catch (err) {
    logger.warn({ err }, 'bot assistant failed');
    await ctx.api
      .sendMessage(String(chatId), replies.error!)
      .catch((sendErr: unknown) => logger.warn({ err: sendErr }, 'bot assistant reply failed'));
  }
}

/**
 * Pull one photo or document out of Telegram and store it against the note
 * the confirm step will write. Thumbnails are made INLINE — `enqueue()`
 * inside the bot process would start the whole worker fleet, which is the
 * two-backup-systems mistake (#253-261) in a new place.
 */
/** How long the bot waits for Telegram to hand over one file. */
const FILE_DOWNLOAD_MS = 30_000;

/** A PDF past this is not shown to the model — Anthropic refuses it anyway. */
const MAX_PDF_BYTES = 10 * 1024 * 1024;

/**
 * What an attached document is worth to the calculation.
 *
 * Three answers and they are different in kind:
 *  - a WORKBOOK or a CSV is READ, exactly, by the same parser the deal's
 *    «Позиции» import uses — no model, no tokens, no guessing;
 *  - a PDF cannot be read here, so it is carried to the model as a document
 *    block, which is the one thing that can look at it;
 *  - a DOCX is refused IN WORDS. It is a zip like an xlsx, so the sniff would
 *    call it a workbook and the parser would answer «no goods» — a silent
 *    nothing where the seller is waiting for a figure.
 */
async function readInvoice(
  ctx: { message: { document?: { file_name?: string; mime_type?: string } } },
  body: Buffer,
): Promise<{
  goods?: import('../../wms/calc/intake').CalcFacts['goods'];
  pdf?: { data: Buffer; name: string } | null;
  refusal?: string;
} | null> {
  const name = ctx.message.document?.file_name ?? '';
  const mime = ctx.message.document?.mime_type ?? null;
  const isPdf = body.subarray(0, 5).toString('latin1') === '%PDF-';
  if (isPdf) {
    if (body.length > MAX_PDF_BYTES) {
      return { refusal: '📄 PDF juda katta (10 MB dan ortiq) — Excel yoki matn bilan yuboring.' };
    }
    return { pdf: { data: body, name: name || 'invoice.pdf' } };
  }
  if (/\.docx?$/i.test(name) || (mime ?? '').includes('wordprocessingml')) {
    return { refusal: '📄 DOCX o‘qilmaydi — PDF yoki Excel qilib yuboring.' };
  }
  const { goodsFromFile } = await import('../../wms/deals/goods-file');
  const goods = await goodsFromFile(body, mime).catch(() => null);
  if (!goods) return null;
  return {
    goods: goods.map((g) => ({
      name: g.description,
      quantity: g.quantity,
      weightKg: g.weightKg,
      tnvedCode: g.tnvedCode,
      note: null,
    })),
  };
}

async function saveIntakeFile(
  ctx: {
    message: { photo?: { file_id: string }[]; document?: { file_name?: string; mime_type?: string } };
    getFile: () => Promise<{ file_path?: string }>;
  },
  noteId: string,
  uploadedBy: string,
): Promise<{ isPhoto: boolean; body: Buffer } | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  const file = await ctx.getFile();
  if (!file.file_path) return null;
  // A deadline, because there was none: a Telegram file endpoint that accepts
  // the connection and then stops sending held this handler — and grammy's
  // poller is SEQUENTIAL, so it held every customer's cabinet with it. Thirty
  // seconds is generous for a 20 MB document and finite, which is the point.
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
    signal: AbortSignal.timeout(FILE_DOWNLOAD_MS),
  });
  if (!res.ok) return null;
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0) return null;

  const isPhoto = Boolean(ctx.message.photo?.length);
  const { saveAttachment } = await import('../files/service');
  const { generateThumbnails } = await import('../jobs/thumbnails');
  const { id } = await saveAttachment(
    {
      entityType: 'crm_activity',
      entityId: noteId,
      fileName: isPhoto
        ? `hisoblatish_${Date.now()}.jpg`
        : (ctx.message.document?.file_name ?? `fayl_${Date.now()}`),
      contentType: isPhoto ? 'image/jpeg' : (ctx.message.document?.mime_type ?? 'application/octet-stream'),
      body,
      uploadedBy,
    },
    { thumbnails: 'skip' },
  );
  await generateThumbnails(id).catch(() => {});
  return { isPhoto, body };
}

/**
 * The copy the model looks at: rotated by EXIF, at most 1568 px on the long
 * side (past that the vision API downsamples anyway), JPEG.
 *
 * A packing list photographed by a phone is 3-5 MB; six of those base64'd is
 * a request body of thirty megabytes for numbers that survive a resize
 * perfectly well. `sharp` is lazily imported for the same reason the
 * thumbnail job does it — a native module must never be traced into the
 * standalone bundle.
 */
const MODEL_IMAGE_PX = 1568;
async function reduceForModel(original: Buffer): Promise<Buffer | null> {
  const sharp = (await import('sharp')).default;
  const out = await sharp(original)
    .rotate()
    .resize(MODEL_IMAGE_PX, MODEL_IMAGE_PX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  // Anthropic refuses an image past ~5 MB; one that still does not fit is
  // counted as skipped rather than sent to be rejected.
  return out.length > 4_500_000 ? null : out;
}

/**
 * ONE live «Bo'ldi» control, edited in place.
 *
 * His second report: «har bir sms uchun "bo'ldi tahlil qil" degan sms
 * chiqvotti» — eight forwards left eight identical keyboards and no way to
 * tell which one was current. The prompt now says what has been collected
 * so far and is EDITED rather than re-sent; only when the edit is refused
 * (the message is too old, or was deleted) does a fresh one appear.
 */
async function showIntakePrompt(
  ctx: {
    api: {
      editMessageText: (
        chatId: string,
        messageId: number,
        text: string,
        extra?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
    reply: (text: string, extra?: Record<string, unknown>) => Promise<{ message_id: number }>;
  },
  chatId: bigint,
  state: IntakeState,
): Promise<void> {
  const parts = [
    state.material.length ? `✍️ ${state.material.length} ta xabar` : '',
    state.fileCount ? `📎 ${state.fileCount} ta fayl` : '',
    state.images.length ? `🖼 ${state.images.length} ta rasm o‘qiladi` : '',
    state.imagesSkipped ? `⚠️ ${state.imagesSkipped} ta rasm o‘qilmaydi` : '',
  ].filter(Boolean);
  const text = `Qabul qilindi: ${parts.join(' · ')}\nYana yuboring yoki «Bo‘ldi» ni bosing.`;

  if (state.promptMessageId !== null) {
    try {
      await ctx.api.editMessageText(String(chatId), state.promptMessageId, text, {
        reply_markup: doneKeyboard,
      });
      return;
    } catch {
      // Too old, deleted, or identical — fall through and send a fresh one.
    }
  }
  const sent = await ctx.reply(text, { reply_markup: doneKeyboard });
  updateIntake(chatId, { promptMessageId: sent.message_id });
}

/**
 * The «Hisoblatish» conversation, one press at a time.
 *
 * Section → who the customer is → send everything → analyse → confirm. Each
 * step reads the live collection rather than trusting the button: a stale
 * keyboard from yesterday's message must not resurrect a finished intake.
 */
async function handleCalcCallback(
  ctx: { reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown> },
  chatId: bigint,
  step: CalcStep,
): Promise<void> {
  if (step === 'cancel') {
    endIntake(chatId);
    await ctx.reply('Bekor qilindi.');
    return;
  }

  // The four opening presses, and their `go_` twins — the same four after the
  // person has answered «yes, start over» to the restart question below.
  const opening = step.startsWith('go_') ? step.slice(3) : step;
  if (
    opening === 'yolkira' ||
    opening === 'rastamojka' ||
    opening === 'podklyuch' ||
    opening === 'ai'
  ) {
    if (!(await mayCollect(chatId))) {
      await ctx.reply('Ulanmagan.');
      return;
    }
    // A live collection is minutes of somebody's attention. Replacing it in
    // silence is what this used to do; now it asks — unless the answer has
    // already arrived (`go_`).
    if (!step.startsWith('go_') && activeIntake(chatId)) {
      await ctx.reply(
        'Sizda tugallanmagan yig‘ish bor. Boshqatdan boshlaymizmi? Yuborilgan hamma narsa o‘chadi.',
        { reply_markup: restartKeyboard(opening) },
      );
      return;
    }
    startIntake(chatId, opening === 'ai' ? 'rastamojka' : opening, { ai: opening === 'ai' });
    await ctx.reply(
      (opening === 'ai'
        ? '🤖 AI rastamojka. Men faqat rastamojkani hisoblayman — yo‘lkirani VED xodimi beradi.\n\n'
        : '') +
        'Mijozni yozing: **kodi** (GS777) yoki **telefon raqami**. Kod bo‘lmasa — ismini yozing.',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const state = activeIntake(chatId);
  if (!state) {
    await ctx.reply('Bu so‘rov eskirgan. «🧮 Hisoblatish» tugmasidan qaytadan boshlang.');
    return;
  }

  if (step === 'cert') {
    const next = updateIntake(chatId, { hasCertificate: !state.hasCertificate });
    await ctx.reply(
      next?.hasCertificate
        ? '📄 Sertifikat BOR deb hisoblanadi — qo‘shimcha boj qo‘shilmaydi.'
        : '📄 Sertifikat YO‘Q deb hisoblanadi — qonun bo‘yicha qo‘shimcha boj qo‘shiladi.',
      { reply_markup: aiConfirmKeyboard(next?.hasCertificate ?? true) },
    );
    return;
  }

  if (step === 'skip') {
    await askNextOrConfirm(ctx, chatId, { ...state, reasked: false });
    return;
  }

  if (step === 'more') {
    updateIntake(chatId, { stage: 'material' });
    await ctx.reply('Yana ma’lumot yuboring, tugagach «Bo‘ldi» ni bosing.', {
      reply_markup: doneKeyboard,
    });
    return;
  }

  if (step === 'done') {
    if (state.material.length === 0 && state.fileCount === 0) {
      await ctx.reply('Hali hech narsa yuborilmadi.');
      return;
    }
    await ctx.reply('⏳ Tahlil qilinmoqda…');
    // OFF the middleware chain, exactly like the assistant's answer (#706):
    // grammy's poller is sequential and the same bot serves every customer,
    // so awaiting an Opus call over twenty thousand characters here freezes
    // every cabinet tap, every /start and every «yukingiz keldi» until it
    // returns.
    void analyseIntakeAndReply(ctx, chatId, state);
    return;
  }

  // save
  const staff = await staffForChat(chatId);
  if (!staff) {
    await ctx.reply('Ulanmagan.');
    return;
  }
  const target = await landCollectedIntake(chatId, staff.id, staff.fullName).catch(
    (err: unknown) => {
      logger.error({ err }, 'calc intake landing failed');
      return null;
    },
  );
  if (!target) {
    await ctx.reply('Saqlab bo‘lmadi. Sistemadan qo‘lda kiriting.');
    return;
  }
  endIntake(chatId);
  // The AI VED hodimi picks the job up — off the poller (grammy's poller is
  // sequential and the same bot serves every customer, so awaiting a grouping
  // call plus a baza pick here would freeze every cabinet tap, #706) and OUT
  // OF THIS PROCESS. A `void` promise here lived in the container the owner
  // restarts on every deploy: a restart mid-pass left committed AI groups,
  // no bazas, no retry, no row saying a pass was owed, and a seller who was
  // promised an answer and got silence. pg-boss owns it now, exactly as the
  // customs parse in this same sub-round is owned; the answer comes back
  // through the notification drain rather than a `ctx` that is gone by then.
  const appUrl = process.env.APP_URL ?? '';
  const path = target.kind === 'deal' ? 'bitimlar' : 'crm/leads';
  await ctx.reply(
    `✅ Saqlandi — ${target.kind === 'deal' ? 'bitim' : 'lead'}: ${target.label}\n` +
      `${appUrl}/${path}/${target.id}\n\n` +
      // Honest about which half landed: the material is on the card either
      // way, but only a queued request will be calculated by anybody.
      (target.queued
        ? '🧮 Hisoblash navbatiga tushdi — VED xodimi javob beradi.'
        : `⚠️ Hisoblash navbatiga tushmadi: ${queueRefusal(target.queueError)}`),
    // Re-derived, not named (round 100, 13A): naming staffKeyboard() here
    // took the cabinet buttons off a both-chat's phone.
    { reply_markup: await replyKeyboardFor(chatId) },
  );
}

/**
 * WHY the job did not reach the VED's queue (audit A38).
 *
 * One constant sentence used to answer every cause, and it sent the person to
 * a door that refuses for the same reason: with twenty open requests the card
 * form says «Ochiq so'rovlar juda ko'p» too. A `Record<string, string>` and
 * not a runtime key: these are the BOT's words, Uzbek, in this file with the
 * rest of them, and an unknown code prints the honest fallback.
 */
const QUEUE_REFUSAL: Record<string, string> = {
  too_many_open: 'sizda 20 ta ochiq so‘rov bor — VED javob bergach qayta yuboring.',
  too_many_items: 'tovarlar juda ko‘p (1000 dan ortiq).',
  not_found: 'karta topilmadi.',
  note_taken: 'bu material allaqachon yozilgan.',
  note_foreign: 'material boshqa kartaga tegishli.',
  unauthenticated: 'siz tizimda emassiz.',
  server_behind: 'server yangilanmoqda — biroz keyinroq urinib ko‘ring.',
};

function queueRefusal(code: string | null | undefined): string {
  return (code && QUEUE_REFUSAL[code]) ?? 'kartadan qo‘lda yuboring.';
}

/** The two doors an unknown chat is offered (owner: «hodim yoki mijoz alohida kirish»). */
export function entryKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '👨‍💼 Hodim', callback_data: 'e:s' },
        { text: '📦 Mijoz', callback_data: 'e:c' },
      ],
    ],
  };
}
