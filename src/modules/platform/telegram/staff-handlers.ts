import type { Bot } from 'grammy';
import { bugunReply } from '../tasks/digest';
import { logger } from '../logger';
import { keyboardOf, staffTextHtml } from '../notifications/staff-html';
import { sendStaffMessage } from '../notifications/service';
import { offerStaffCommands } from './commands';
import { editMarkup, editText, sendText, sendTextBriefRetry, sendTyping } from './send';
import { answerPress } from './press';
import { isBacklog } from './lifecycle';
import { HANDLED_SENTENCE, tellBacklogOnce } from './backlog';
import { claimOnce, handledAlready, markOnce, messageKey, pressKey, type OnceKey } from './once';
import { flushWaitWrites } from './waits';
import { db } from '../db/client';
import { clientAnswerKeyboard } from './map-link';
import {
  AI_RASTAMOJKA,
  BUGUN,
  CALC_ENTRY_LABELS,
  botActorFor,
  HISOBLATISH,
  HOLAT,
  MEN_BERGAN,
  TOPSHIRIQ,
  TASK_ANSWERS,
  holatFor,
  ownerSummaryFromBot,
  ZAMETKALAR,
  assistantFromBot,
  closeLeadMessage,
  closeTaskMessage,
  completeTaskFromBot,
  dayButtons,
  decideApprovalFromBot,
  type BotApprovalResult,
  isCabinetText,
  landCollectedIntake,
  landingLinkFor,
  linkStaffChat,
  lookupFromBot,
  noteStaffEntry,
  noteTaskPending,
  parseCallback,
  escapesIntake,
  settlePressedApproval,
  settleLinkAskRow,
  staffByPhone,
  staffForChat,
  takeStaffEntry,
  takeTaskPending,
  noteReplyPending,
  pressRefusalText,
  refusalFor,
  taskPressCheck,
  type CalcStep,
  type NoteStep,
  AI_ZONE_ROUTES,
  isZoneStep,
  zonePressAnswer,
  type ZoneStep,
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
import {
  activeCapture,
  captureIsEmpty,
  endCapture,
  startCapture,
  updateCapture,
  type CaptureState,
} from './note-capture';
import { sendNote } from './note-send';
import { buttonLabel, splitMessage } from './limits';
import { activeDraft } from './task-draft';
import {
  BUSY_INTAKE,
  REPLY_SENTENCES,
  refuseMediaReply,
  replyVerdictFor,
  threadReplyFromBot,
  verdictSentence,
} from './reply-door';
import {
  answerGiven,
  answerPendingText,
  BUSY_DRAFT,
  draftLive,
  draftMedia,
  draftText,
  handleDraftCallback,
  handleForwardCallback,
  handleTaskPress,
  offerForwardTask,
  pickAssignee,
  startTaskDraft,
} from './task-handlers';

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

/**
 * The labels and the escape predicate live in staff-bot.ts, where a test can
 * reach them: «🤖 AI rastamojka» is a SECOND door onto the same collector (it
 * fixes the section to rastamojka, asks the follow-up questions a declaration
 * needs and promises a figure in this chat), and «📌 Zametkalar» opens the
 * library the office re-sends from.
 */
export { CALC_ENTRY_LABELS };

/**
 * The keyboard's options, REQUIRED: whether «📊 Holat» is this person's is a
 * question about the person (`holatFor`), and an optional flag would let a
 * caller forget to ask it and quietly draw the button for everybody — or for
 * nobody, including the owner it exists for.
 */
export interface StaffKeyboardOptions {
  holat: boolean;
}

/**
 * The staff rows — one list for both keyboards, so they cannot drift. The
 * topshiriq round's two labels join the top (spec §6); positions move,
 * labels never — a label is a router.
 */
function staffRows(opts: StaffKeyboardOptions) {
  return [
    [{ text: BUGUN }, { text: TOPSHIRIQ }],
    [{ text: MEN_BERGAN }, { text: HISOBLATISH }],
    [{ text: AI_RASTAMOJKA }, { text: ZAMETKALAR }],
    ...(opts.holat ? [[{ text: HOLAT }]] : []),
  ];
}

export function staffKeyboard(opts: StaffKeyboardOptions) {
  return {
    keyboard: staffRows(opts),
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
export function bothKeyboard(locale: string | null | undefined, opts: StaffKeyboardOptions) {
  const t = clientLabels(locale);
  return {
    keyboard: [
      ...staffRows(opts),
      [{ text: t.btnCargo }, { text: t.btnBalance }],
      [{ text: t.btnHistory }, { text: t.btnLanguage }],
      [{ text: t.btnManager }],
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

/**
 * The AI door's first question (item 13, the owner: «managerdan sorasin nima
 * podklyuch yokida rastamojka deb»). Rastamojka is the customs alone;
 * podklyuch adds the road at the tariff's list price.
 */
function aiSectionKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🛃 Faqat rastamojka', callback_data: 'c:ai' }],
      [{ text: '🔑 Podklyuch (rastamojka + yo‘lkira)', callback_data: 'c:aipk' }],
    ],
  };
}

/**
 * «Yuk qayerdan chiqadi?» — his tariff's zones, as buttons. A button and not
 * a typed city: the zone is a 36-58 % difference in the road's price, and
 * `guessZone` over free text is a SUGGESTION the workspace makes a person
 * confirm (workspace.ts). Here the person IS confirming, by pressing.
 *
 * Only the zones the tariff PRICES today are drawn (`priced`, read at the
 * moment the question is asked): «horgos» appears the day he types its
 * prices on /admin/tarif and not before. Pure, so the rule is a test.
 */
export function zoneKeyboard(priced: readonly string[]) {
  return {
    inline_keyboard: [
      ...(Object.entries(AI_ZONE_ROUTES) as [ZoneStep, (typeof AI_ZONE_ROUTES)[ZoneStep]][])
        .filter(([, r]) => priced.includes(r.zone))
        .map(([step, r]) => [{ text: r.label, callback_data: `c:${step}` }]),
      [{ text: '✖️ Bekor qilish', callback_data: 'c:cancel' }],
    ],
  };
}

/**
 * The zones the tariff prices today — through a dynamic import, because
 * platform must not import wms statically. A failed read answers his two
 * seeded zones rather than no buttons at all: the question must stay
 * answerable, and the landing still drops a zone that turned out unpriced.
 */
async function pricedZonesNow(): Promise<string[]> {
  try {
    const { onDate, tariffZones } = await import('../../wms/calc/dictionaries');
    return await tariffZones(onDate());
  } catch (err) {
    logger.error({ err }, '[staff-bot] tariff zones unreadable — offering the seeded two');
    const { OWNER_TARIFF_ZONES } = await import('../../wms/calc/tariff-seed');
    return [...OWNER_TARIFF_ZONES];
  }
}

const CLIENT_QUESTION =
  'Mijozni yozing: **kodi** (GS777) yoki **telefon raqami**. Kod bo‘lmasa — ismini yozing.';

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
      await answerPress(ctx);
      if (parsed.who === 'client') {
        // The client door is the existing cabinet — nothing more (owner's
        // answer 4). Same phone-verified entry as always, in the phone's
        // language NORMALISED (a raw «en-GB» fell back to Russian).
        const { localeFromTelegram } = await import('./client-labels');
        const locale = localeFromTelegram(ctx.from?.language_code);
        const t = clientLabels(locale);
        await ctx.reply(`${t.notLinked}\n\n${t.linkByPhone}`, {
          reply_markup: phoneKeyboard(locale),
        });
        return;
      }
      // Staff door: ask for the Telegram-verified own number, and remember
      // WHY we asked — the contact handler must not staff-link a customer
      // who simply shared a phone.
      await askStaffPhone(ctx, chatId);
      return;
    }

    if (parsed.kind === 'calc') {
      await answerPress(ctx);
      await handleCalcCallback(ctx as unknown as CalcReplyCtx, chatId, parsed.step);
      return;
    }

    if (parsed.kind === 'task_done') {
      const staff = await staffForChat(chatId);
      if (!staff) {
        await answerPress(ctx, 'Ulanmagan');
        return;
      }
      // A draft is live: its text must never become this task's result.
      if (activeDraft(chatId)) {
        await answerPress(ctx, BUSY_DRAFT);
        await ctx.reply(BUSY_DRAFT);
        return;
      }
      // The task is LOADED before anything waits for typing, and refused at
      // once in words (the review's blocker, telegram-mechanics-1): an old
      // ✅ on a calc job used to ask for a result, and the person typed one
      // into silence. Closed, not theirs, or an open calc job (with its link).
      const check = await taskPressCheck(chatId, parsed.taskId, 'act');
      if (!check.ok) {
        await answerPress(ctx, TASK_ANSWERS[check.result]);
        await ctx.reply(pressRefusalText(check));
        return;
      }
      // The pressed message is REMEMBERED and left exactly as it is (round
      // C): nothing is closed until the result is typed, so a message that
      // changed now would be announcing a close that may never happen. The
      // close rewrites it — a task's own message whole, a list by one row.
      const pressed = ctx.callbackQuery.message;
      const pressedText = pressed && 'text' in pressed ? pressed.text : undefined;
      await answerPress(ctx);
      // On a LIST the prompt names the task — «which one did I just press?»
      // is not a question the person should have to scroll back to answer.
      const label = parsed.list ? pressedButtonText(pressed, ctx.callbackQuery.data) : null;
      // «✅ Natijasiz» so nobody has to type a dash (spec §4); the dash still works.
      const prompt = await ctx.reply(
        (label ? `${label}\n` : '') + 'Natijani yozib yuboring (natijasiz yopish uchun «-» yuboring):',
        { reply_markup: { inline_keyboard: [[{ text: '✅ Natijasiz', callback_data: `tn:${parsed.taskId}` }]] } },
      );
      // Armed AFTER the prompt, at the prompt's own date (Q5 a): a wait exists
      // only once its question is on the screen, and a backlog text written
      // before it cannot be its answer.
      noteTaskPending(
        chatId,
        parsed.taskId,
        pressed && pressedText
          ? {
              messageId: pressed.message_id,
              text: pressedText,
              markup: 'reply_markup' in pressed ? pressed.reply_markup : undefined,
              kind: parsed.list ? 'list' : 'single',
            }
          : null,
        'result',
        { promptMessageId: prompt.message_id, armedAt: prompt.date },
      );
      return;
    }

    if (parsed.kind === 'note') {
      await handleNoteCallback(ctx, chatId, parsed.step, parsed.noteId, parsed.page);
      return;
    }

    // The topshiriq round's buttons (docs/TELEGRAM-TOPSHIRIQ.md §3-6). ABOVE
    // the approval guard below, which returns on every kind it does not name —
    // a button nobody answers spins for fifteen seconds (#939).
    if (
      parsed.kind === 'task_accept' ||
      parsed.kind === 'task_wait' ||
      parsed.kind === 'task_postpone' ||
      parsed.kind === 'task_question' ||
      parsed.kind === 'task_reply' ||
      parsed.kind === 'task_noresult' ||
      parsed.kind === 'task_remind' ||
      parsed.kind === 'task_cancel' ||
      parsed.kind === 'task_sources'
    ) {
      await handleTaskPress(ctx, chatId, parsed);
      return;
    }
    if (parsed.kind === 'draft') {
      await handleDraftCallback(ctx, chatId, parsed.step);
      return;
    }
    if (parsed.kind === 'draft_pick') {
      await answerPress(ctx);
      await pickAssignee(ctx, chatId, parsed.userId);
      return;
    }
    if (parsed.kind === 'forward') {
      const staff = await staffForChat(chatId);
      if (!staff) {
        await answerPress(ctx, 'Ulanmagan');
        return;
      }
      // A press is an explicit intent and keeps its search; keyed by the
      // «📌 Topshiriq qilamizmi?» offer (Q5 a): two taps, one model call.
      const searchKey = parsed.step === 'search' ? await pressKey(ctx, 'search') : null;
      await handleForwardCallback(ctx, chatId, parsed.step, (text) =>
        answerStaffText(ctx as unknown as StaffTailCtx, chatId, staff.id, text, {
          backlog: false,
          messageId: null,
          once: searchKey,
        }),
      );
      return;
    }

    // «📞 Bog'landim» under an advert lead (0113). BEFORE the approval guard
    // below, which returns on every kind it does not name (#939). The decision
    // lives in wms — reached the established way, by dynamic import.
    if (parsed.kind === 'lead_contacted') {
      const { markContactedFromBot } = await import('../../wms/crm/inbound-notify');
      const { outcome, by } = await markContactedFromBot(chatId, parsed.leadId);
      const answers: Record<typeof outcome, string> = {
        recorded: '✅ Qayd etildi',
        already: 'Allaqachon qayd etilgan',
        not_linked: 'Ulanmagan',
        forbidden: 'Bu sizning huquqingizda emas',
        not_yours: 'Bu lid sizniki emas',
        not_found: 'Lid topilmadi',
      };
      await answerPress(ctx, answers[outcome]);
      const pressed = ctx.callbackQuery.message;
      if (
        (outcome === 'recorded' || outcome === 'already') &&
        pressed &&
        'text' in pressed &&
        pressed.text
      ) {
        // Off the poller, on the sender's short deadline (#706).
        void closeLeadMessage(
          chatId,
          {
            messageId: pressed.message_id,
            text: pressed.text,
            markup: 'reply_markup' in pressed ? pressed.reply_markup : undefined,
          },
          parsed.leadId,
          outcome === 'already'
            ? '📞 Allaqachon bog‘lanilgan'
            : by
              ? `📞 Bog‘lanildi — ${by}`
              : '📞 Bog‘lanildi',
        ).catch((err: unknown) => logger.warn({ err }, 'lead press not settled'));
      }
      return;
    }

    // ✅/❌ on a calc↔prixod guess (0119). BEFORE the approval guard (#939),
    // the decision in wms by dynamic import, the settle off the poller (#706).
    if (parsed.kind === 'calc_link') {
      const { decideLinkFromBot } = await import('../../wms/calc/link-bot');
      const outcome = await decideLinkFromBot(chatId, parsed.receiptId, parsed.requestTag, parsed.verdict);
      // Record<union>: an outcome nobody wrote words for is a compile error,
      // not an empty spinner on the phone.
      const answers: Record<typeof outcome, string> = {
        confirmed: '✅ Tasdiqlandi',
        dropped: '❌ Olib tashlandi',
        already: 'Allaqachon hal qilingan',
        changed: 'Bu prixod o‘zgargan — Hisob nazoratini oching',
        not_mine: 'Bu hisob sizniki emas',
        request_foreign: 'Boshqa mijozning hisobi',
        not_linked: 'Ulanmagan',
        forbidden: 'Huquqingiz yo‘q',
      };
      await answerPress(ctx, answers[outcome]);
      const pressed = ctx.callbackQuery.message;
      if (
        (outcome === 'confirmed' || outcome === 'dropped' || outcome === 'already' || outcome === 'changed') &&
        pressed &&
        'text' in pressed &&
        pressed.text
      ) {
        void settleLinkAskRow(
          chatId,
          {
            messageId: pressed.message_id,
            text: pressed.text,
            markup: 'reply_markup' in pressed ? pressed.reply_markup : undefined,
          },
          ctx.callbackQuery.data,
          answers[outcome],
        ).catch((err: unknown) => logger.warn({ err }, 'calc link press not settled'));
      }
      return;
    }

    // «💬 Javob yozish» / «❓ Sotuvchidan so‘rash» (0127). BEFORE the approval
    // guard below, which returns on every kind it does not name (#939) — and
    // every path answers the press.
    if (parsed.kind === 'thread_reply') {
      await handleThreadReplyPress(ctx, chatId);
      return;
    }

    // approval. Guarded now rather than reached by falling through: the union
    // grew a fifth member and an unguarded tail would have read `approvalId`
    // off a notes callback.
    if (parsed.kind !== 'approval') return;
    const outcome = await decideApprovalFromBot(chatId, parsed.approvalId, parsed.verdict);
    // Record<union>: a result the service can return and nobody wrote words
    // for is a compile error here, not an empty spinner on the phone.
    const answers: Record<BotApprovalResult, string> = {
      decided: parsed.verdict === 'approved' ? '✅ Ruxsat berildi' : '⛔ Rad etildi',
      not_linked: 'Ulanmagan',
      forbidden: 'Bu qaror sizning huquqingizda emas',
      already_decided: 'Allaqachon hal qilingan',
      not_found: 'So‘rov topilmadi',
      not_your_client: 'Bu mijoz bo‘yicha qaror uning sotuvchisi yoki buxgalterda',
    };
    await answerPress(ctx, answers[outcome]);
    // The pressed copy is settled in place (round C) — ALSO when somebody
    // else decided first: that press is the proof a stale copy was still
    // asking. Off the poller, on the sender's short deadline.
    const pressed = ctx.callbackQuery.message;
    if (
      (outcome === 'decided' || outcome === 'already_decided') &&
      pressed &&
      'text' in pressed &&
      pressed.text
    ) {
      const staff = await staffForChat(chatId);
      void settlePressedApproval(
        chatId,
        {
          messageId: pressed.message_id,
          text: pressed.text,
          markup: 'reply_markup' in pressed ? pressed.reply_markup : undefined,
        },
        parsed.approvalId,
        staff?.locale,
      ).catch((err: unknown) => logger.warn({ err }, 'approval press not settled'));
    }
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
    if (!takeStaffEntry(chatId, ctx.message.date)) {
      // A crash redelivery of the contact that already linked a colleague
      // (Q5 a, judge Q5H-5): the first run consumed the intent, so this one
      // would reach the cabinet's contact door — which links CLIENT codes on
      // that phone into the staff chat, or answers «raqam topilmadi» with the
      // keyboard taken away. Keyed on THIS message, never guessed.
      if ((await handledAlready(chatId, ctx.message.message_id)) === 'staff_link') {
        const here = await staffForChat(chatId);
        if (here) {
          await ctx.reply(`✅ Ulandi: ${here.fullName}. Xabarnomalar shu yerga keladi.`, {
            reply_markup: await replyKeyboardFor(chatId),
          });
          return;
        }
      }
      // A contact card in a STAFF chat is «call this person» — the obvious
      // task. The draft or Door B takes it BEFORE the cabinet, whose contact
      // handler answers «send your OWN number» with a one-time keyboard that
      // takes the staff keyboard off the phone (telegram-mechanics-19). The
      // sender's own number still falls through to the cabinet's linking.
      if (!activeIntake(chatId) && !activeCapture(chatId) && (await draftMedia(ctx, chatId))) return;
      return next();
    }
    // The intent's DELETE reaches the table before anything is linked (Q5 a).
    await flushWaitWrites();
    const contact = ctx.message.contact;
    // The cabinet's spoof-proof rule: only the sender's OWN number counts.
    // Every refusal below RESTORES the keyboard. The contact request is a
    // one-time reply keyboard, so asking for a phone has already wiped
    // whatever the person had — and a customer who tries «/hodim» out of
    // curiosity would otherwise be left with no buttons at all and two
    // sentences telling them why.
    const restore = async (text: string) => {
      await ctx.reply(text, { reply_markup: await replyKeyboardFor(chatId) });
    };
    if (contact.user_id !== ctx.from?.id) {
      await restore('Faqat o‘zingizning raqamingizni yuboring.');
      return;
    }
    const staff = await staffByPhone(contact.phone_number);
    if (!staff) {
      await restore(
        'Bu raqam xodimlar ro‘yxatida topilmadi. Sistemaga kirib Profil → Telegram ulash orqali urinib ko‘ring, yoki adminga ayting.',
      );
      return;
    }
    const result = await linkStaffChat(staff.id, chatId);
    // A switch, never an `if`: a third outcome must not fall into success.
    switch (result.outcome) {
      case 'chat_taken':
        await restore('Bu Telegram boshqa xodimga ulangan. Adminga ayting.');
        return;
      case 'not_colleague':
        // Only reachable in a race — `staffByPhone` already asks canLogIn (B8).
        await restore('Bu hodim akkaunti faol emas — Telegram ulanmadi. Adminga ayting.');
        return;
      case 'linked':
        break;
    }
    // What this contact did, so a crash redelivery of it can say so (Q5 a).
    await markOnce(await messageKey(ctx, 'staff_link'));
    if (result.previousChatId !== null) {
      await ctx.api
        .sendMessage(
          Number(result.previousChatId),
          'ℹ️ Sizning hodim akkountingiz boshqa Telegramga ko‘chirildi. Xabarnomalar endi bu yerga kelmaydi.',
        )
        .catch(() => {});
    }
    await ctx.reply(`✅ Ulandi: ${staff.fullName}. Xabarnomalar shu yerga keladi.`, {
      // A client who just became staff keeps their cabinet rows (13A).
      reply_markup: await replyKeyboardFor(chatId),
    });
    // The command menu too — until round C only `/start <code>` and /hodim
    // offered it, so a person linked by sharing their number never had one.
    offerStaffCommands(ctx, ctx.chat.id);
  });

  // Photos and documents during a collection: stored at once, pre-bound to
  // the note the confirm step will write (#180's pattern). Outside a
  // collection they are somebody else's business — next().
  bot.on(['message:photo', 'message:document'], async (ctx, next) => {
    const chatId = BigInt(ctx.chat.id);
    // No collector opened by THIS process takes a backlog file (Q5 a): every
    // one of them was opened after boot, and the file was sent before it.
    const late = isBacklog(ctx.message.date);
    const state = activeIntake(chatId);
    if (!state || late) {
      // A zametka being written from the phone takes its parts here. The calc
      // intake is asked FIRST and wins — one collector at a time, and that one
      // is minutes of a seller's forwarding.
      const capture = activeCapture(chatId);
      if (!capture || late) {
        // Third: a task draft takes it, or Door B offers to make one of a
        // forward (docs/TELEGRAM-TOPSHIRIQ.md §3); anything else is the
        // cabinet's.
        if (await draftMedia(ctx, chatId)) return;
        // A photo or file sent as a REPLY to a thread or task ping — only
        // after every collector declined it (E10 a, text first).
        if (await refuseMediaReply(ctx, chatId)) return;
        // A staff file into nothing, from the backlog: the cabinet answers a
        // staff chat with nothing at all, so it is told once instead.
        if (late && (await staffForChat(chatId))) {
          await tellBacklogOnce(ctx, chatId);
          return;
        }
        return next();
      }
      const owner = await staffForChat(chatId);
      if (!owner) return next();
      await capturePart(ctx, chatId, capture, owner.id);
      return;
    }
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

  // Voice, audio, video, a round video, a place, a sticker — the kinds the
  // staff bot never took before this round (telegram-mechanics-19). Inside
  // `registerStaffBot`, which bot.ts registers BEFORE the cabinet: the draft
  // first, then Door B, otherwise next() — so a customer's voice note still
  // reaches the cabinet's forward to their manager untouched. A live calc
  // intake or zametka capture keeps today's behaviour for these.
  bot.on(
    ['message:voice', 'message:audio', 'message:video', 'message:video_note', 'message:location', 'message:sticker'],
    async (ctx, next) => {
      const chatId = BigInt(ctx.chat.id);
      const late = isBacklog(ctx.message.date);
      if (!late && (activeIntake(chatId) || activeCapture(chatId))) return next();
      if (await draftMedia(ctx, chatId)) return;
      // A voice note as a REPLY to a thread or task ping (E10 a, text first) —
      // after the draft declined it, so a live draft's part still joins it.
      if (await refuseMediaReply(ctx, chatId)) return;
      if (late && (await staffForChat(chatId))) {
        await tellBacklogOnce(ctx, chatId);
        return;
      }
      return next();
    },
  );

  bot.on('message:text', async (ctx, next) => {
    const chatId = BigInt(ctx.chat.id);
    // A backlog text (Q5 a): written while the bot was down, so no collector
    // THIS process opened can have been what it was written for — every one
    // of them opened after boot. It still reaches the reply door (a swipe-
    // reply names its own target), the wait (which judges it by its date) and
    // the free lookups; everything else gets one sentence.
    const late = isBacklog(ctx.message.date);

    // A live collection swallows text: this is the customer's name, or the
    // material itself.
    //
    // The exemptions are `escapesIntake`, a NAMED predicate rather than two
    // inline conditions: the entry labels, so pressing «🧮 Hisoblatish» or
    // «🤖 AI rastamojka» mid-collection reaches the restart question instead
    // of being filed as material, plus every other button on the keyboard the
    // seller is looking at — answering one of those with silence reads as a
    // broken bot. A new button joins the predicate, in one edit, or it is
    // eaten by this branch.
    const intake = activeIntake(chatId);
    if (intake && !escapesIntake(ctx.message.text) && !late) {
      if (intake.stage === 'section') {
        // The podklyuch door is waiting for «qayerdan?» — a typed word here
        // is not the customer's name yet, and filing it as one would skip
        // the only question that prices the road.
        await ctx.reply('Avval yuk qayerdan chiqishini tanlang:', {
          reply_markup: zoneKeyboard(await pricedZonesNow()),
        });
        return;
      }
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
      if (await refuseWhileCapturing(ctx, chatId)) return;
      if (await refuseWhileDrafting(ctx, chatId)) return;
      await ctx.reply('Nimani hisoblatamiz?', { reply_markup: sectionKeyboard() });
      return;
    }

    // The owner's own door: rastamojka, and the machine answers in this chat.
    if (ctx.message.text === AI_RASTAMOJKA || ctx.message.text === '/ai') {
      if (!(await mayCollect(chatId))) return next();
      if (await refuseWhileCapturing(ctx, chatId)) return;
      if (await refuseWhileDrafting(ctx, chatId)) return;
      await ctx.reply('🤖 Nimani hisoblaymiz?', { reply_markup: aiSectionKeyboard() });
      return;
    }

    // A cabinet button belongs to the CABINET, whoever else this chat is
    // (round 100, 13A): before this line a staff+client chat pressing
    // «📦 Yuklarim» reached the lookup below and heard «Topilmadi». Checked
    // BEFORE the task-result capture too, so pressing a cabinet button while
    // a «Bajarildi» answer is awaited serves the cabinet and leaves the
    // capture armed instead of eating the button as the result.
    if (isCabinetText(ctx.message.text)) return next();

    // Zametkalar, in the ONE slot that works.
    //
    // Not earlier: a cabinet label must still reach the cabinet, which is the
    // regression round 100's 13A exists for. Not later: `takeTaskPending`
    // below DELETES ON READ, so a note press while a «Bajarildi» answer is
    // awaited would both be swallowed as the task's result and destroy the
    // capture — and further down still, an unrecognised label reaches the paid
    // model and costs a question out of the daily cap.
    if (ctx.message.text === ZAMETKALAR || ctx.message.text === '/zametka') {
      const staff = await staffForChat(chatId);
      if (!staff) return next();
      await showNotesList(ctx, chatId, staff.id, 1);
      return;
    }

    // «📊 Holat» in the same slot as «📋 Bugun» and for the same reasons:
    // below the cabinet pass-through, ABOVE both captures — `takeTaskPending`
    // deletes on read and would close a task with «📊 Holat» as its result —
    // and far above the paid model, which a refused press must never reach.
    if (ctx.message.text === HOLAT || ctx.message.text === '/holat') {
      const staff = await staffForChat(chatId);
      if (!staff) return next();
      await answerHolat(ctx as unknown as CalcReplyCtx, chatId);
      return;
    }

    // «📋 Bugun» ABOVE both captures (round C): pressed while a «Bajarildi»
    // result was awaited it used to reach `takeTaskPending` first — which
    // DELETES ON READ — and close the task with «📋 Bugun» as its result;
    // pressed while a note was being written it was filed into the note.
    if (ctx.message.text === BUGUN || ctx.message.text === '/bugun') {
      const staff = await staffForChat(chatId);
      if (!staff) return next();
      const day = await bugunReply(staff.id).catch((err) => {
        logger.warn({ err }, 'bugun compose failed');
        return null;
      });
      if (!day) {
        await ctx.reply('Vazifalarni o‘qib bo‘lmadi — birozdan keyin urinib ko‘ring.');
        return;
      }
      // The same words and the same «✅» rows as the 08:00 digest, so a task
      // is closed from the list it is read on — and «+ N ta muddatsiz» when
      // the rest of the person's work has no date (spec §7).
      const sent = await sendTextBriefRetry({
        chatId,
        html: staffTextHtml(day.text, 'TasksDue'),
        replyMarkup: keyboardOf(dayButtons(day.tasks)),
      });
      if (!sent.ok) logger.warn({ description: sent.description }, 'bugun reply not sent');
      return;
    }

    // «➕ Topshiriq» and «📤 Men bergan» (docs/TELEGRAM-TOPSHIRIQ.md §3, §6)
    // in the labels' slot, for the labels' reasons: ABOVE the note capture —
    // a «Men bergan» filed into a zametka being written is a lost press — and
    // above the one-text wait, which deletes on read (telegram-mechanics-24).
    if (ctx.message.text === TOPSHIRIQ || ctx.message.text === '/topshiriq') {
      const staff = await staffForChat(chatId);
      if (!staff) return next();
      await startTaskDraft(ctx, chatId);
      return;
    }
    if (ctx.message.text === MEN_BERGAN || ctx.message.text === '/berganlarim') {
      const staff = await staffForChat(chatId);
      if (!staff) return next();
      await answerGiven(ctx, chatId);
      return;
    }

    // A note being written from the phone swallows what follows — its name
    // first, then everything else — and it sits in the same slot for the same
    // reasons.
    const capture = activeCapture(chatId);
    if (capture && !late) {
      const staff = await staffForChat(chatId);
      if (!staff) return next();
      await captureText(ctx, chatId, capture, ctx.message.text);
      return;
    }

    // A task draft swallows what follows, the same way: a name while it asks
    // «Kimga?», a date after «📅 Sana yozish», otherwise a line of the task.
    // BELOW the capture (one collector at a time — they refuse each other at
    // the door) and ABOVE the one-text wait, so a draft's line is never
    // anybody's result.
    const draft = activeDraft(chatId);
    if (draft && !late) {
      const staff = await staffForChat(chatId);
      if (!staff) return next();
      await draftText(ctx, chatId, draft);
      return;
    }

    // A REPLY to one of the bot's own messages (the owner's E answers): a
    // swipe-reply to a thread ping lands on the card, to the VED's «Hisoblash:
    // …» task copy under that calculation, to a task copy as a question to its
    // giver. BELOW the labels and every live collector (one collector at a
    // time — a reply typed while a zametka, a draft or a calc intake is live
    // is filed by THAT collector); ABOVE Door B (a reply is not a forward) and
    // ABOVE `takeTaskPending`, which deletes on read — a reply names its own
    // target and must never be eaten as the result of ANOTHER task, while the
    // door hands a reply to the very message a wait was armed from back to
    // that wait (`threadReplyFromBot` step 2). Null = not handled: falls through.
    const replied = ctx.message.reply_to_message;
    if (replied && replied.from?.id === ctx.me.id && !escapesIntake(ctx.message.text)) {
      const out = await threadReplyFromBot(chatId, {
        replyToMessageId: replied.message_id,
        replyToForwarded: 'forward_origin' in replied && Boolean(replied.forward_origin),
        text: ctx.message.text,
        incomingMessageId: ctx.message.message_id,
        messageDate: ctx.message.date,
      });
      if (out) {
        await ctx.reply(out.text);
        return;
      }
    }

    // Door B: a forwarded TEXT with no collector live is offered as a task
    // («📌 Topshiriq qilamizmi?») — with «🔍 Qidirish» beside it for what a
    // forward did until today. ABOVE the one-text wait: a forward is never
    // the answer somebody was asked to type (spec §3). Its own staff check,
    // because it sits above the staff fence.
    if (ctx.message.forward_origin) {
      const staff = await staffForChat(chatId);
      if (staff) {
        // A backlog forward is the sentence, once — never one «📌» offer per
        // message: fifteen forwarded customer messages that were a lost
        // intake's material are one sentence and no offers (judge W4).
        if (late) {
          await tellBacklogOnce(ctx, chatId);
          return;
        }
        await offerForwardTask(ctx, chatId, null);
        return;
      }
    }

    // Step 2 of «Bajarildi»: this text IS the result — unless it is one of the
    // keyboard's own buttons, which is never anybody's result (every branch
    // above answers them; this is the fence for the next button to join).
    if (!escapesIntake(ctx.message.text)) {
      const pendingTask = takeTaskPending(chatId, ctx.message.date);
      // Judged by the MESSAGE's date (Q5 a): a backlog text written before the
      // wait's prompt is not its answer, and the wait stays for the real one.
      // The take's DELETE reaches the table BEFORE the effect: a kill after it
      // leaves no wait to answer twice, a kill before it is a kill before the
      // effect.
      if (pendingTask) await flushWaitWrites();
      if (pendingTask && pendingTask.kind !== 'result') {
        // A question, an answer, or a typed date after ⏰ — the same one wait.
        // A «date» that is not one is not consumed: it falls to the tail.
        if (await answerPendingText(ctx, chatId, pendingTask, ctx.message.text)) {
          await markOnce(await messageKey(ctx, 'wait'));
          return;
        }
      } else if (pendingTask) {
        const result = ctx.message.text.trim() === '-' ? '' : ctx.message.text.trim();
        const outcome = await completeTaskFromBot(chatId, pendingTask.taskId, result, pendingTask.pressed);
        // Every code the service can refuse with has its words (a Record over
        // the closed union) — a refusal is a sentence, never a throw into
        // bot.catch after the person typed their result.
        // …and an open calc job's refusal carries the job's page (review bot-12).
        await ctx.reply(outcome === 'done' ? '✅ Vazifa yopildi.' : await refusalFor(pendingTask.taskId, outcome));
        // The «✅ Natijasiz» on the prompt is spent either way.
        if (pendingTask.promptMessageId) {
          void editMarkup({ chatId, messageId: pendingTask.promptMessageId }).catch(() => {});
        }
        // The message the «✅» sat on becomes the record of the close (or, on
        // a list, loses that one row). Off the poller: an edit is a network
        // call and the answer above is what the person is waiting for.
        if (outcome === 'done' || outcome === 'already_closed') {
          void closeTaskMessage(chatId, pendingTask, outcome === 'done' ? result : '', outcome).catch(
            (err: unknown) => logger.warn({ err }, 'task message not closed'),
          );
        }
        // What this text did, so a crash redelivery of it hears «answered»
        // and never «send it again» (judge Q5H-2 a).
        await markOnce(await messageKey(ctx, 'wait'));
        return;
      }
    }

    // Anything else a MEMBER OF STAFF types is a lookup: a client code, a box
    // label, a crate or a truck (owner's item 2). A customer's text still
    // falls through — the cabinet answers those, and it must be the LAST
    // fence before the AI: a stranger's words never reach the model or the
    // question ledger.
    const staff = await staffForChat(chatId);
    if (!staff) return next();
    await answerStaffText(ctx as unknown as StaffTailCtx, chatId, staff.id, ctx.message.text, {
      backlog: late,
      messageId: ctx.message.message_id,
      once: null,
    });
  });
}

/** What the staff tail needs from grammy's context. */
type StaffTailCtx = {
  reply: (text: string, extra?: Record<string, unknown>) => Promise<{ message_id: number }>;
  api: import('grammy').Api;
};

/**
 * The staff tail — what a member of staff's words become when nothing above
 * claimed them: the free lookup, then any code-shaped word inside them, then
 * a typed zametka name, then (paid, last) the AI. ONE function, asked by the
 * ladder and by Door B's «🔍 Qidirish», so a forwarded text replays exactly
 * what it did before the topshiriq round.
 */
async function answerStaffText(
  ctx: StaffTailCtx,
  chatId: bigint,
  staffId: string,
  text: string,
  // REQUIRED (Q5 a): whether this is a backlog text, the incoming message
  // (null for Door B's «🔍», which replays a forward), and Door B's key.
  opts: { backlog: boolean; messageId: number | null; once: OnceKey | null },
): Promise<void> {
  // A crash redelivery of a text whose wait was already consumed: no wait is
  // left, so it lands here — and is told it was answered, never «send it
  // again», which would mint the duplicate (judge Q5H-2 a).
  if (opts.backlog && opts.messageId !== null && (await handledAlready(chatId, opts.messageId))) {
    await ctx.reply(HANDLED_SENTENCE);
    return;
  }
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
    const buttons = clientAnswerKeyboard(process.env.APP_URL, answer);
    await ctx.reply(answer.text, buttons ? { reply_markup: buttons } : undefined);
    return;
  }
  // «ushani soraganda berishi kerak» — his own word. Somebody typing the
  // note's name gets the note, for one indexed query, instead of falling
  // into the paid model, which cannot see this table and would answer
  // «topilmadi» having spent one of the day's forty questions.
  if (await answerFromNotes(ctx, chatId, staffId, text)) return;
  // A backlog text the free lookups could not answer (Q5 a): its words may be
  // a lost collector's material — never the AI's question, and never
  // «Topilmadi», which is the same lie in a cheaper voice. Once per chat.
  if (opts.backlog) {
    await tellBacklogOnce(ctx, chatId);
    return;
  }
  // Door B's «🔍 Qidirish» runs once per offer message: two taps, one model call.
  if (opts.once) {
    if (!(await claimOnce(db, opts.once))) {
      await ctx.reply('Bu qidiruv allaqachon bajarilgan.');
      return;
    }
  }
  if (!aiConfigured()) {
    // No key = exactly the day before the AI shipped.
    await ctx.reply(
      'Topilmadi. Mijoz kodi (GS777), karobka kodi (YW26-000123), yashik (CR-…) yoki partiya kodini yozing.',
    );
    return;
  }
  const thinking = await ctx.reply('🤖 O‘ylayapman…');
  // NOT awaited, and that is the whole point: grammy's built-in poller is
  // SEQUENTIAL — it handles one update at a time — so awaiting a model
  // loop here would hold the CUSTOMER bot for as long as the answer takes.
  // One admin asking «bu oy qancha pul kirdi» would freeze every cabinet
  // tap, every /start and every arrival flow for tens of seconds, and the
  // owner's own words are that 95 % of customer contact is this channel.
  // The answer is delivered by chat id when it lands, exactly as the
  // notification path already sends unsolicited messages.
  void answerWithAssistant(chatId, text, thinking.message_id);
}

/**
 * One collector at a time, the third one (spec §3): a calc collection or a
 * zametka is refused IN WORDS while a task draft is live, as the draft is
 * refused while they are.
 */
async function refuseWhileDrafting(ctx: NoteReplyCtx, chatId: bigint): Promise<boolean> {
  if (!draftLive(chatId)) return false;
  await ctx.reply(`Hozir topshiriq yozilyapti. ${BUSY_DRAFT}`);
  return true;
}

/** Chats whose «📊 Holat» is being computed right now. */
const holatInFlight = new Set<string>();

/** The pull's «not now» — a failed read is never told «not yours» (#475). */
const HOLAT_FAILED = 'Holatni hisoblab bo‘lmadi — keyinroq urinib ko‘ring.';

/**
 * «📊 Holat» — the evening summary on demand, in the push's own words.
 *
 * The door is asked on EVERY press (the keyboard on a phone outlives the grant
 * it was drawn for), and a refused person hears so in a sentence. The compose
 * reads what a dashboard render reads — seconds on a busy database, measured
 * 6.6 s on the shaped copy — so it runs OFF the sequential poller (#706) after
 * an immediate «⏳», and a chat already waiting is told to wait rather than
 * starting a second computation on the one Node process (round 108).
 */
async function answerHolat(ctx: CalcReplyCtx, chatId: bigint): Promise<void> {
  const key = String(chatId);
  if (holatInFlight.has(key)) {
    await ctx.reply('⏳ Hali hisoblanmoqda — biroz kuting.');
    return;
  }
  // A door that THREW is not a door that said no: during a database blip the
  // owner himself would be told the button is not his. The keyboard and the
  // command menu may read a throw as «no» (losing the button for one reply is
  // their stated trade); a press is a question asked, and gets «try again».
  let admitted: boolean;
  try {
    admitted = await holatFor(chatId);
  } catch (err) {
    logger.warn({ err }, 'holat door failed');
    await ctx.reply(HOLAT_FAILED);
    return;
  }
  if (!admitted) {
    await ctx.reply('📊 Holat faqat egasi uchun.');
    return;
  }
  holatInFlight.add(key);
  await ctx.reply('⏳ Hisoblanmoqda…');
  void (async () => {
    try {
      const outcome = await ownerSummaryFromBot(chatId);
      if (outcome.status !== 'ok') {
        await sendText({ chatId, text: '📊 Holat faqat egasi uchun.' });
        return;
      }
      // The drain's own dressing AND delivery (`sendStaffMessage`): the bold
      // title, the dashboard link lifted into «↗️ Ochish», and — when Telegram
      // refuses that button — the link put back into the text, exactly as the
      // 20:00 push does. A plain `sendText` would drop the refused keyboard and
      // with it the only copy of the link.
      const sent = await sendStaffMessage(chatId, 'OwnerSummary', { text: outcome.text });
      if (!sent.ok) logger.warn({ description: sent.description }, 'holat reply not sent');
    } catch (err) {
      logger.warn({ err }, 'holat compose failed');
      await sendText({ chatId, text: HOLAT_FAILED }).catch(() => {});
    } finally {
      holatInFlight.delete(key);
    }
  })();
}

/** The words on the button a callback came from — its own message's keyboard. */
function pressedButtonText(message: unknown, data: string): string | null {
  const rows =
    (message as { reply_markup?: { inline_keyboard?: { text?: string; callback_data?: string }[][] } })
      ?.reply_markup?.inline_keyboard ?? [];
  for (const row of rows) {
    for (const button of row) if (button.callback_data === data && button.text) return button.text;
  }
  return null;
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

  // The road is priced on the shipment's TOTALS (the tariff's density band),
  // so a podklyuch job missing either is asked ONCE, after the lines — one
  // message, «12 kub 3500 kg», read by the same parser as the material.
  if (
    state.ai &&
    state.section === 'podklyuch' &&
    !state.totalsAsked &&
    (state.facts.weightKg == null || state.facts.volumeM3 == null)
  ) {
    updateIntake(chatId, {
      stage: 'question',
      askingIndex: null,
      askingTotals: true,
      totalsAsked: true,
      reasked: false,
    });
    await ctx.reply(
      'Yo‘lkira uchun umumiy hajm va og‘irlik kerak. Masalan: «12 kub 3500 kg»' +
        (state.facts.volumeM3 != null ? `\n(hajm bor: ${state.facts.volumeM3} m³)` : '') +
        (state.facts.weightKg != null ? `\n(og‘irlik bor: ${state.facts.weightKg} kg)` : ''),
      {
        reply_markup: {
          inline_keyboard: [[{ text: '⏭ Bilmayman, o‘tkazib yubor', callback_data: 'c:skip' }]],
        },
      },
    );
    return;
  }

  const settled =
    updateIntake(chatId, { stage: 'review', askingIndex: null, askingTotals: false }) ?? state;
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
  const { parseLineAnswer, parseManualFacts } = await import('../../wms/calc/intake-manual');
  const { nextLineToAsk } = await import('../../wms/calc/intake');

  if (state.askingTotals) {
    // Whatever of the two the answer states; the other keeps what it had.
    const read = parseManualFacts(text);
    const weightKg = read.weightKg ?? state.facts.weightKg ?? null;
    const volumeM3 = read.volumeM3 ?? state.facts.volumeM3 ?? null;
    const kept =
      updateIntake(chatId, {
        facts: { ...state.facts, weightKg, volumeM3 },
        material: [...state.material, text],
      }) ?? state;
    if (read.weightKg == null && read.volumeM3 == null && !kept.reasked) {
      updateIntake(chatId, { reasked: true });
      await ctx.reply('Tushunmadim. «12 kub 3500 kg» ko‘rinishida yozing.');
      return;
    }
    await askNextOrConfirm(ctx, chatId, { ...kept, askingTotals: false, reasked: false });
    return;
  }
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
  chatId: bigint,
  text: string,
  thinkingMessageId: number | null,
): Promise<void> {
  const replies: Record<string, string> = {
    not_configured:
      'Topilmadi. Mijoz kodi (GS777), karobka kodi (YW26-000123), yashik (CR-…) yoki partiya kodini yozing.',
    limit: 'Bugungi AI savollar chegarasi tugadi — ertaga yana so‘rang.',
    error: 'AI javob berolmadi. Keyinroq urinib ko‘ring.',
  };
  // «Typing…» at the top of the chat for as long as the model works — the
  // answer takes tens of seconds and a silent chat reads as a dead bot.
  // Telegram shows the action for about five seconds, hence four.
  const typing = setInterval(() => void sendTyping(chatId).catch(() => {}), 4_000);
  void sendTyping(chatId).catch(() => {});
  let answer: string;
  try {
    const outcome = await assistantFromBot(chatId, text);
    if (!outcome) return;
    answer =
      outcome.status === 'ok'
        ? outcome.answer
        : outcome.status === 'gave_up'
          ? (outcome.answer ?? 'Oxirigacha yetolmadim — savolni soddaroq berib ko‘ring.')
          : (replies[outcome.status] ?? replies.error!);
  } catch (err) {
    logger.warn({ err }, 'bot assistant failed');
    answer = replies.error!;
  } finally {
    clearInterval(typing);
  }
  // NEW message(s) (round C), never the placeholder edited into the answer:
  // an edit makes no sound, so the person who asked and put the phone down
  // would never learn the answer came. Plain text (a model writes `<` and
  // `*` freely), and split rather than refused — the model may write more
  // than one message holds.
  for (const part of splitMessage(answer)) {
    const sent = await sendTextBriefRetry({ chatId, text: part });
    if (!sent.ok) {
      logger.warn({ description: sent.description }, 'bot assistant reply failed');
      break;
    }
  }
  // The placeholder points DOWN to where the answer is — best-effort.
  if (thinkingMessageId !== null) {
    void editText({ chatId, messageId: thinkingMessageId, html: '🤖 Javob pastda ⬇️' }).catch(() => {});
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

type BotFileCtx = {
  message: { photo?: { file_id: string }[]; document?: { file_name?: string; mime_type?: string } };
  getFile: () => Promise<{ file_path?: string }>;
};

/**
 * A file the bot was sent, stored.
 *
 * One home for the whole crossing (#513): the deadline, the empty-body
 * refusal, the photo-vs-document naming and the inline thumbnail. Two callers
 * now — a «Hisoblatish» collection and a zametka being written from the phone
 * — and they differ only in which entity the bytes are pre-bound to.
 */
async function saveBotFile(
  ctx: BotFileCtx,
  target: { entityType: string; entityId: string; uploadedBy: string; namePrefix: string },
): Promise<{ isPhoto: boolean; body: Buffer; attachmentId: string } | null> {
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
      entityType: target.entityType,
      entityId: target.entityId,
      fileName: isPhoto
        ? `${target.namePrefix}_${Date.now()}.jpg`
        : (ctx.message.document?.file_name ?? `fayl_${Date.now()}`),
      contentType: isPhoto ? 'image/jpeg' : (ctx.message.document?.mime_type ?? 'application/octet-stream'),
      body,
      uploadedBy: target.uploadedBy,
    },
    { thumbnails: 'skip' },
  );
  await generateThumbnails(id).catch(() => {});
  return { isPhoto, body, attachmentId: id };
}

async function saveIntakeFile(
  ctx: BotFileCtx,
  noteId: string,
  uploadedBy: string,
): Promise<{ isPhoto: boolean; body: Buffer } | null> {
  return saveBotFile(ctx, {
    entityType: 'crm_activity',
    entityId: noteId,
    uploadedBy,
    namePrefix: 'hisoblatish',
  });
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
    opening === 'ai' ||
    opening === 'aipk'
  ) {
    if (!(await mayCollect(chatId))) {
      await ctx.reply('Ulanmagan.');
      return;
    }
    // One collector at a time: a task draft is somebody's half-written task.
    if (draftLive(chatId)) {
      await ctx.reply(`Hozir topshiriq yozilyapti. ${BUSY_DRAFT}`);
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
    if (opening === 'aipk') {
      // The road needs its zone before anything else: it is the one answer
      // on this door that no material can be trusted to carry.
      startIntake(chatId, 'podklyuch', { ai: true });
      updateIntake(chatId, { stage: 'section' });
      await ctx.reply(
        '🤖 AI podklyuch: rastamojka + yo‘lkira (tarif narxida).\n\nYuk qayerdan chiqadi?',
        { reply_markup: zoneKeyboard(await pricedZonesNow()) },
      );
      return;
    }
    startIntake(chatId, opening === 'ai' ? 'rastamojka' : opening, { ai: opening === 'ai' });
    await ctx.reply(
      (opening === 'ai' ? '🤖 AI rastamojka — faqat bojxona to‘lovlari.\n\n' : '') + CLIENT_QUESTION,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  const state = activeIntake(chatId);
  if (!state) {
    await ctx.reply('Bu so‘rov eskirgan. «🧮 Hisoblatish» tugmasidan qaytadan boshlang.');
    return;
  }

  if (isZoneStep(step)) {
    // Only the question it answers: a stale zone button from yesterday's
    // message must not rewrite a live collection's road.
    if (state.stage !== 'section' || state.section !== 'podklyuch') {
      await ctx.reply('Bu tugma eskirgan.');
      return;
    }
    // …nor land a zone whose price has gone since the button was drawn.
    const answer = zonePressAnswer(step, await pricedZonesNow());
    if (!answer.ok) {
      await ctx.reply(answer.text);
      return;
    }
    const { route } = answer;
    updateIntake(chatId, { route, stage: 'client' });
    await ctx.reply(`✅ ${route.fromCity} → ${route.toCity}\n\n${CLIENT_QUESTION}`, {
      parse_mode: 'Markdown',
    });
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
  // The link is the SENDER's — a card they can open, the calculation's own
  // screen for the VED, or no line at all (`landingLinkFor`): one literal for
  // everyone handed the VED a CRM card that bounces him.
  const link = await landingLinkFor(staff.id, target);
  await ctx.reply(
    `✅ Saqlandi — ${target.kind === 'deal' ? 'bitim' : 'lead'}: ${target.label}\n` +
      (link ? `${link}\n` : '') +
      '\n' +
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

/**
 * «Hodim sifatida ulanish» — ONE door, asked by the inline «👨‍💼 Hodim» button
 * and by the /hodim command.
 *
 * Extracted so the two cannot drift: the intent that the contact handler reads
 * (`noteStaffEntry`, one-shot, ten minutes) and the sentence the person sees
 * are one thing in one place (#513). The keyboard it sends is a ONE-TIME
 * contact request, which replaces whatever was on the phone — every refusal in
 * the contact handler restores it.
 */
export async function askStaffPhone(
  ctx: { reply: (text: string, extra?: Record<string, unknown>) => Promise<{ date: number }> },
  chatId: bigint,
): Promise<void> {
  const asked = await ctx.reply('Hodim sifatida ulanish uchun telefon raqamingizni yuboring 👇', {
    reply_markup: phoneKeyboard('uz'),
  });
  // Armed AFTER the prompt, at its own date (Q5 a) — and durable, so a deploy
  // between «send your phone» and the contact no longer drops the intent.
  noteStaffEntry(chatId, asked.date);
}

/**
 * The two doors an unknown chat is offered (owner: «hodim yoki mijoz alohida
 * kirish»), in the language of the person who has not linked yet (round C) —
 * a Russian speaker used to be asked «Кто вы?» and then offered two Uzbek
 * buttons. Only the WORDS follow the language; the callback data is the
 * router and stays.
 */
export function entryKeyboard(locale?: string | null) {
  const t = clientLabels(locale);
  return {
    inline_keyboard: [
      [
        { text: t.entryStaff, callback_data: 'e:s' },
        { text: t.entryClient, callback_data: 'e:c' },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Zametkalar — the library the office re-sends from (owner, 2026-09-05:
// «har doim ishlatadgan rasim file text locationlarni tanlaganda bot qayta
// jonatb berishi kerak»).
//
// Everything DECIDED lives elsewhere: what a note is visible to whom is
// `notes/service.ts`, what one tap sends is the pure `notes/plan.ts`, and the
// delivery is `note-send.ts`. What is here is the conversation.
// ---------------------------------------------------------------------------

/** How many notes fit on one page of buttons before the message is a scroll. */
const NOTES_PER_PAGE = 12;

type NoteReplyCtx = {
  reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown>;
};

/**
 * «💬 Javob yozish» / «❓ Sotuvchidan so‘rash» pressed (0127). The button
 * carries no id: the press resolves its OWN pressed message through the reply
 * door — the same resolver a swipe-reply uses — and only then arms the one
 * text wait. Every path answers the callback (an unanswered press spins for
 * fifteen seconds with no error anywhere, #939).
 *
 * Refused while ANY collector is live: a collector sits above the one-text
 * wait in the ladder and would eat the next text, leaving the armed wait to
 * catch a LATER unrelated text (a «GS777») as a reply. No ForceReply — whether
 * it hides the persistent staff keyboard on a phone is unverified, and
 * «💬 Savol» already works with a plain wait.
 */
async function handleThreadReplyPress(
  ctx: {
    answerCallbackQuery: (opts?: { text?: string }) => Promise<unknown>;
    reply: (text: string, extra?: Record<string, unknown>) => Promise<{ message_id: number; date: number }>;
    callbackQuery: { message?: { message_id: number } };
  },
  chatId: bigint,
): Promise<void> {
  const staff = await staffForChat(chatId);
  if (!staff) {
    await answerPress(ctx, 'Ulanmagan');
    return;
  }
  if (activeIntake(chatId)) {
    await answerPress(ctx, BUSY_INTAKE);
    await ctx.reply(BUSY_INTAKE);
    return;
  }
  if (activeCapture(chatId)) {
    await answerPress(ctx, 'Avval zametkani saqlang');
    await refuseWhileCapturing(ctx, chatId);
    return;
  }
  if (activeDraft(chatId)) {
    await answerPress(ctx, BUSY_DRAFT);
    await ctx.reply(BUSY_DRAFT);
    return;
  }
  const messageId = ctx.callbackQuery.message?.message_id;
  const verdict = messageId
    ? await replyVerdictFor(chatId, messageId, staff.id).catch((err: unknown) => {
        logger.warn({ err }, '[thread] press verdict failed');
        return null;
      })
    : null;
  const refused = verdict ? verdictSentence(verdict) : REPLY_SENTENCES.not_replyable;
  if (refused || !messageId) {
    const text = refused ?? REPLY_SENTENCES.not_replyable;
    await answerPress(ctx, text);
    await ctx.reply(text);
    return;
  }
  await answerPress(ctx);
  // Armed AFTER the prompt, at its own date (Q5 a).
  const asked = await ctx.reply(REPLY_SENTENCES.pressPrompt);
  noteReplyPending(chatId, messageId, { armedAt: asked.date });
}

/**
 * One collector at a time. The calc intake wins because it is minutes of a
 * seller's forwarding; a note capture is refused IN WORDS rather than
 * discarded, which is the rule the section buttons already learned.
 */
async function refuseWhileCapturing(ctx: NoteReplyCtx, chatId: bigint): Promise<boolean> {
  if (!activeCapture(chatId)) return false;
  await ctx.reply(
    'Hozir yangi zametka yozilyapti. Avval uni saqlang yoki bekor qiling.',
    { reply_markup: captureKeyboard(activeCapture(chatId)!) },
  );
  return true;
}

function notesKeyboard(
  rows: { id: string; title: string; shared: boolean }[],
  page: number,
  pages: number,
) {
  const keyboard = rows.map((row) => [
    {
      // 🏢 in front of the company's, because a seller may have written their
      // own note with the same name — the two scopes are policed separately
      // on purpose, and this is what tells them apart at a glance.
      text: buttonLabel(`${row.shared ? '🏢 ' : ''}${row.title}`, 'Zametka'),
      callback_data: `n:${row.id}`,
    },
  ]);
  const nav: { text: string; callback_data: string }[] = [];
  if (page > 1) nav.push({ text: '⬅️', callback_data: `n:p${page - 1}` });
  if (page < pages) nav.push({ text: '➡️', callback_data: `n:p${page + 1}` });
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: '➕ Yangi zametka', callback_data: 'n:new' }]);
  return { inline_keyboard: keyboard };
}

async function notesPage(staffId: string, page: number) {
  const { listNotes } = await import('../notes/service');
  const all = await listNotes(staffId);
  const pages = Math.max(1, Math.ceil(all.length / NOTES_PER_PAGE));
  const safe = Math.min(Math.max(1, page), pages);
  return {
    all,
    pages,
    page: safe,
    rows: all.slice((safe - 1) * NOTES_PER_PAGE, safe * NOTES_PER_PAGE),
  };
}

async function showNotesList(
  ctx: NoteReplyCtx,
  chatId: bigint,
  staffId: string,
  page: number,
): Promise<void> {
  void chatId;
  const { all, rows, pages, page: safe } = await notesPage(staffId, page);
  if (all.length === 0) {
    await ctx.reply(
      '📌 Hozircha zametka yo‘q.\n«➕ Yangi zametka» ni bosing yoki saytdagi «Zametkalar» bo‘limida qo‘shing.',
      { reply_markup: { inline_keyboard: [[{ text: '➕ Yangi zametka', callback_data: 'n:new' }]] } },
    );
    return;
  }
  const header =
    pages > 1
      ? `📌 Zametkalar (${safe}/${pages}) — bosing, bot qayta yuboradi:`
      : '📌 Zametkalar — bosing, bot qayta yuboradi:';
  await ctx.reply(header, { reply_markup: notesKeyboard(rows, safe, pages) });
}

/**
 * Every `n:` press answers, on every path.
 *
 * An inline keyboard is permanent chat history: a button tapped a week later
 * can name a note that has been deleted or has moved out of this person's
 * sight, and «nothing happens» is the silence rounds 89 and 97 were spent
 * removing.
 */
async function handleNoteCallback(
  ctx: {
    answerCallbackQuery: (arg?: { text?: string }) => Promise<unknown>;
    reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown>;
    api: import('grammy').Api;
  },
  chatId: bigint,
  step: NoteStep,
  noteId?: string,
  page?: number,
): Promise<void> {
  const staff = await staffForChat(chatId);
  if (!staff) {
    await answerPress(ctx, 'Ulanmagan');
    return;
  }

  if (step === 'page') {
    await answerPress(ctx);
    await showNotesList(ctx, chatId, staff.id, page ?? 1);
    return;
  }

  if (step === 'new') {
    await answerPress(ctx);
    if (activeIntake(chatId)) {
      await ctx.reply(
        'Hozir hisoblatish davom etyapti. Avval uni tugating yoki bekor qiling.',
      );
      return;
    }
    if (activeCapture(chatId)) {
      await ctx.reply('Yangi zametka allaqachon yozilyapti — nomini yuboring.');
      return;
    }
    if (draftLive(chatId)) {
      await ctx.reply(`Hozir topshiriq yozilyapti. ${BUSY_DRAFT}`);
      return;
    }
    const { v4: uuidv4 } = await import('uuid');
    startCapture(chatId, uuidv4());
    await ctx.reply('Zametkaga nom bering (masalan: «Xitoy sklad manzili»):');
    return;
  }

  if (step === 'cancel') {
    await answerPress(ctx);
    endCapture(chatId);
    await ctx.reply('Bekor qilindi.');
    return;
  }

  if (step === 'share') {
    await answerPress(ctx);
    const capture = activeCapture(chatId);
    if (!capture) {
      await ctx.reply('Yozilayotgan zametka yo‘q.');
      return;
    }
    const actor = await botActorFor(chatId);
    if (!actor || !canShareFromBot(actor.permissions)) {
      await ctx.reply('Umumiy zametka qo‘shish huquqi sizda yo‘q.');
      return;
    }
    const updated = updateCapture(chatId, { shared: !capture.shared });
    await ctx.reply(
      updated?.shared ? '🏢 Hammaga ko‘rinadi.' : '👤 Faqat sizda ko‘rinadi.',
      { reply_markup: captureKeyboard(updated ?? capture) },
    );
    return;
  }

  if (step === 'save') {
    await answerPress(ctx);
    await saveCapturedNote(ctx, chatId, staff.id);
    return;
  }

  // send
  if (!noteId) {
    await answerPress(ctx);
    return;
  }
  // Answered BEFORE anything slow: the callback's own progress bar is what the
  // person is looking at, and it costs no message in the chat — so it leaves
  // no second artefact beside the note they are about to forward.
  await answerPress(ctx, '📤 Yuborilmoqda…', { say: false });
  void deliverNote(ctx, chatId, noteId, staff.id);
}

async function deliverNote(
  ctx: { reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown>; api: import('grammy').Api },
  chatId: bigint,
  noteId: string,
  staffId: string,
): Promise<void> {
  // NOT awaited by the caller, and that is the whole point: grammy's poller is
  // sequential, so several megabytes of upload inside the handler would hold
  // every customer's cabinet tap with it (#706).
  try {
    const outcome = await sendNote(ctx.api, chatId, noteId, staffId);
    if (outcome.status === 'not_found') {
      await ctx.reply('Bu zametka o‘chirilgan yoki sizga ochiq emas.').catch(() => {});
      return;
    }
    if (outcome.status === 'empty') {
      await ctx.reply('Bu zametkada yuboriladigan narsa yo‘q.').catch(() => {});
      return;
    }
    if (outcome.status === 'busy') {
      await ctx.reply('Yuborilmoqda — biroz kuting.').catch(() => {});
      return;
    }
    if (outcome.status === 'partial') {
      // Telegram has no transaction: what already arrived stays in the chat.
      // So the sentence NAMES the split, or a person forwards half a note
      // believing the apology meant nothing was sent.
      await ctx
        .reply(
          `⚠️ ${outcome.sent} ta qism yuborildi, ${outcome.failed} tasi yuborilmadi. Zametkani qaytadan bosing.`,
        )
        .catch(() => {});
      return;
    }
    if (outcome.messages > 1) {
      await ctx
        .reply(`⬆️ ${outcome.messages} ta xabar — hammasini belgilab, mijozga yuboring.`)
        .catch(() => {});
    }
  } catch (err) {
    logger.error({ err, noteId }, 'note send failed');
    await ctx.reply('Yuborib bo‘lmadi. Qaytadan urinib ko‘ring.').catch(() => {});
  }
}

function captureKeyboard(state: CaptureState) {
  const rows: { text: string; callback_data: string }[][] = [];
  if (state.stage === 'parts') {
    rows.push([{ text: '✅ Saqlash', callback_data: 'n:save' }]);
    rows.push([
      {
        text: state.shared ? '🏢 Hammaga: ha' : '🏢 Hammaga: yo‘q',
        callback_data: 'n:share',
      },
    ]);
  }
  rows.push([{ text: '✖️ Bekor qilish', callback_data: 'n:cancel' }]);
  return { inline_keyboard: rows };
}

async function captureText(
  ctx: NoteReplyCtx,
  chatId: bigint,
  state: CaptureState,
  text: string,
): Promise<void> {
  if (state.stage === 'title') {
    const title = text.trim().slice(0, 64);
    if (title === '') {
      await ctx.reply('Nom bo‘sh bo‘lmasin. Zametkaga nom bering:');
      return;
    }
    // Checked NOW, not after the photos are already in the object store: the
    // name is asked first and the row is written last, so a taken name would
    // otherwise surface as a refusal on «Saqlash» with the bytes already up.
    const { listNotes } = await import('../notes/service');
    const staff = await staffForChat(chatId);
    if (staff) {
      const taken = (await listNotes(staff.id)).some(
        (row) => row.title.trim().toLowerCase() === title.toLowerCase(),
      );
      if (taken) {
        await ctx.reply('Bu nom band. Boshqa nom bering:');
        return;
      }
    }
    const updated = updateCapture(chatId, { title, stage: 'parts' });
    await ctx.reply(
      `«${title}».\nEndi yuboring: matn, rasm yoki fayl.\n` +
        'Manzil varaqasini FAYL (📎) qilib yuborsangiz yozuvlari aniq qoladi — rasm qilib yuborilsa Telegram siqadi.\n' +
        'Tugagach «✅ Saqlash» ni bosing.',
      { reply_markup: captureKeyboard(updated ?? state) },
    );
    return;
  }
  const updated = updateCapture(chatId, { body: [...state.body, text.trim()], stage: 'parts' });
  await ctx.reply('Qabul qilindi.', { reply_markup: captureKeyboard(updated ?? state) });
}

async function capturePart(
  ctx: BotFileCtx & NoteReplyCtx,
  chatId: bigint,
  state: CaptureState,
  uploadedBy: string,
): Promise<void> {
  if (state.stage === 'title') {
    await ctx.reply('Avval nom bering.');
    return;
  }
  const { MAX_NOTE_PARTS, NOTE_ENTITY_TYPE } = await import('../notes/service');
  if (state.fileCount >= MAX_NOTE_PARTS) {
    await ctx.reply(`Bitta zametkaga eng ko‘pi ${MAX_NOTE_PARTS} ta fayl sig‘adi.`);
    return;
  }
  const saved = await saveBotFile(ctx, {
    entityType: NOTE_ENTITY_TYPE,
    entityId: state.noteId,
    uploadedBy,
    namePrefix: 'zametka',
  }).catch((err: unknown) => {
    logger.warn({ err }, 'note capture file save failed');
    return null;
  });
  if (!saved) {
    await ctx.reply('Faylni saqlab bo‘lmadi. Qaytadan yuboring.');
    return;
  }
  const updated = updateCapture(chatId, { fileCount: state.fileCount + 1 });
  await ctx.reply(`Qabul qilindi (${updated?.fileCount ?? state.fileCount + 1} ta fayl).`, {
    reply_markup: captureKeyboard(updated ?? state),
  });
}

async function saveCapturedNote(
  ctx: NoteReplyCtx,
  chatId: bigint,
  staffId: string,
): Promise<void> {
  const state = activeCapture(chatId);
  if (!state) {
    await ctx.reply('Yozilayotgan zametka yo‘q.');
    return;
  }
  if (state.stage === 'title') {
    await ctx.reply('Avval nom bering.');
    return;
  }
  if (captureIsEmpty(state)) {
    await ctx.reply('Zametka bo‘sh. Matn, rasm yoki fayl yuboring.');
    return;
  }
  const { NoteError, saveNote } = await import('../notes/service');
  const actor = await botActorFor(chatId);
  try {
    await saveNote(
      {
        id: state.noteId,
        title: state.title,
        body: state.body.join('\n\n'),
        shared: state.shared,
      },
      {
        actorId: staffId,
        canShare: Boolean(actor && canShareFromBot(actor.permissions)),
      },
    );
  } catch (err) {
    const word = err instanceof NoteError ? noteRefusals[err.code] : null;
    await ctx.reply(word ?? 'Saqlab bo‘lmadi. Qaytadan urinib ko‘ring.');
    if (!(err instanceof NoteError)) logger.error({ err }, 'note save from bot failed');
    return;
  }
  endCapture(chatId);
  await ctx.reply(
    `✅ «${state.title}» saqlandi.${state.shared ? ' Hamma xodim ko‘radi.' : ''}\n` +
      '📌 Zametkalar ro‘yxatidan bosib yuborishingiz mumkin.',
  );
}

/** Literal map: a refusal must be a sentence, never a code (#163's discipline). */
const noteRefusals: Record<string, string> = {
  unauthenticated: 'Ulanmagan.',
  validation: 'Ma’lumot to‘g‘ri emas.',
  forbidden: 'Bunga huquqingiz yo‘q.',
  not_found: 'Zametka topilmadi.',
  note_empty: 'Zametka bo‘sh — matn yoki fayl kerak.',
  title_taken: 'Bu nom band.',
  too_many_parts: 'Fayllar soni chegaradan oshdi.',
};

function canShareFromBot(permissions: Set<string>): boolean {
  // The same code the screen asks, reached without importing the whole
  // service into the union of every bot type.
  return permissions.has('admin.settings.manage');
}

/**
 * A typed note name, answered for free.
 *
 * One hit sends it — the exact path the button takes. Several offer buttons.
 * None leaves the caller's own behaviour untouched, so the model still gets
 * everything this cannot answer.
 */
async function answerFromNotes(
  ctx: {
    reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown>;
    api: import('grammy').Api;
  },
  chatId: bigint,
  staffId: string,
  text: string,
): Promise<boolean> {
  const { notesByTitle } = await import('../notes/service');
  const hits = await notesByTitle(staffId, text).catch(() => []);
  if (hits.length === 0) return false;
  if (hits.length === 1) {
    await ctx.reply(`📌 ${hits[0]!.title}`);
    void deliverNote(ctx, chatId, hits[0]!.id, staffId);
    return true;
  }
  await ctx.reply('📌 Shu nomdagi zametkalar:', {
    reply_markup: notesKeyboard(
      hits.map((h) => ({ id: h.id, title: h.title, shared: h.shared })),
      1,
      1,
    ),
  });
  return true;
}
