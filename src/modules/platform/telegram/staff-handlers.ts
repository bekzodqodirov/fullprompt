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
} from './staff-bot';
import { aiConfigured } from '../ai/model';
import { codeCandidates } from '../ai/route-text';
import { clientLabels } from './client-labels';
import {
  activeIntake,
  analyzeCollected,
  endIntake,
  mayCollect,
  startIntake,
  updateIntake,
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

export function staffKeyboard() {
  return {
    keyboard: [[{ text: BUGUN }, { text: HISOBLATISH }]],
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
    if (!state || state.stage === 'client') return next();
    const staff = await staffForChat(chatId);
    if (!staff) return next();

    const saved = await saveIntakeFile(ctx, state.noteId, staff.id).catch((err: unknown) => {
      logger.warn({ err }, 'intake file save failed');
      return false;
    });
    const caption = ctx.message.caption?.trim();
    updateIntake(chatId, {
      stage: 'material',
      fileCount: state.fileCount + (saved ? 1 : 0),
      material: caption ? [...state.material, caption] : state.material,
    });
    await ctx.reply(
      saved
        ? `📎 Qabul qilindi (${state.fileCount + 1}). Tugagach «Bo‘ldi» ni bosing.`
        : 'Faylni saqlab bo‘lmadi — matn bilan yozib yuboring.',
      { reply_markup: doneKeyboard },
    );
  });

  bot.on('message:text', async (ctx, next) => {
    const chatId = BigInt(ctx.chat.id);

    // A live collection swallows text: this is the customer's name, or the
    // material itself.
    const intake = activeIntake(chatId);
    if (intake && ctx.message.text !== HISOBLATISH) {
      if (intake.stage === 'client') {
        updateIntake(chatId, { clientHintRaw: ctx.message.text.trim(), stage: 'material' });
        await ctx.reply(
          'Endi hamma narsani yuboring: tovar ro‘yxati, fayllar, rasmlar, kub/kg, yo‘nalish.\n' +
            'Tugagach «Bo‘ldi» ni bosing.',
          { reply_markup: doneKeyboard },
        );
        return;
      }
      updateIntake(chatId, {
        stage: 'material',
        material: [...intake.material, ctx.message.text],
      });
      await ctx.reply('✍️ Qo‘shildi. Tugagach «Bo‘ldi» ni bosing.', {
        reply_markup: doneKeyboard,
      });
      return;
    }

    if (ctx.message.text === HISOBLATISH || ctx.message.text === '/hisoblatish') {
      if (!(await mayCollect(chatId))) return next();
      await ctx.reply('Nimani hisoblatamiz?', { reply_markup: sectionKeyboard() });
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
async function saveIntakeFile(
  ctx: {
    message: { photo?: { file_id: string }[]; document?: { file_name?: string; mime_type?: string } };
    getFile: () => Promise<{ file_path?: string }>;
  },
  noteId: string,
  uploadedBy: string,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const file = await ctx.getFile();
  if (!file.file_path) return false;
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!res.ok) return false;
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0) return false;

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
  return true;
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
  step: 'yolkira' | 'rastamojka' | 'podklyuch' | 'done' | 'save' | 'more' | 'cancel',
): Promise<void> {
  if (step === 'cancel') {
    endIntake(chatId);
    await ctx.reply('Bekor qilindi.');
    return;
  }

  if (step === 'yolkira' || step === 'rastamojka' || step === 'podklyuch') {
    if (!(await mayCollect(chatId))) {
      await ctx.reply('Ulanmagan.');
      return;
    }
    startIntake(chatId, step);
    await ctx.reply(
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
    const analysed = await analyzeCollected(state);
    updateIntake(chatId, analysed);
    const { intakeSummaryText } = await import('../../wms/calc/intake');
    await ctx.reply(
      intakeSummaryText({
        section: analysed.section,
        facts: analysed.facts,
        clientLabel: analysed.clientHintRaw || null,
        fileCount: analysed.fileCount,
      }) + (analysed.aiUsed ? '' : '\n\n(AI mavjud emas — faqat yozilganidan o‘qildi)'),
      { reply_markup: confirmKeyboard },
    );
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
  const appUrl = process.env.APP_URL ?? '';
  const path = target.kind === 'deal' ? 'bitimlar' : 'crm/leads';
  await ctx.reply(
    `✅ Saqlandi — ${target.kind === 'deal' ? 'bitim' : 'lead'}: ${target.label}\n` +
      `${appUrl}/${path}/${target.id}\n\n` +
      'Hisoblashga berish kartaning o‘zida — VED xodimini tanlaysiz.',
    // Re-derived, not named (round 100, 13A): naming staffKeyboard() here
    // took the cabinet buttons off a both-chat's phone.
    { reply_markup: await replyKeyboardFor(chatId) },
  );
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
