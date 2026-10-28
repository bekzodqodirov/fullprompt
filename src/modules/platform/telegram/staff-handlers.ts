import type { Bot } from 'grammy';
import { randomUUID } from 'node:crypto';
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
  clientCodePrefix,
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
  carryLineDone,
  doneLine,
  intakeClientSummary,
  intakeFileKind,
  mergeLineAnswers,
  mergeTotalsAnswer,
  resolveLineDone,
  sameTotalsAnswer,
  sameRouteAnswer,
  answeredRoute,
  bareTotalsNumber,
  totalsAnswerShape,
  totalsFigureCount,
  totalsQuestion,
  totalsQuestionText,
  unansweredAmbiguity,
  MAX_INTAKE_IMAGES,
  MAX_INTAKE_PDF_BYTES,
  MAX_INTAKE_PDFS,
  type IntakeState,
  type SheetText,
  endIntake,
  mayCollect,
  startIntake,
  updateIntake,
  MAX_OFFERS,
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
          waitDeclined: false,
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
    const saved = await saveIntakeFile(ctx, state.noteId, staff.id).catch((err: unknown) => {
      logger.warn({ err }, 'intake file save failed');
      return null;
    });
    if (!saved) {
      await ctx.reply('Faylni saqlab bo‘lmadi — matn bilan yozib yuboring.');
      return;
    }
    const caption = ctx.message.caption?.trim();
    const fileName = ctx.message.document?.file_name ?? '';
    const read = await readIntakeFile(saved, fileName, ctx.message.document?.mime_type ?? null, state);
    // A file sent BEFORE the customer is named — or before the podklyuch
    // door's «qayerdan?» — is material like any other (his 1.7 b). It used to
    // be refused before the client was named, and in the zone stage it
    // skipped both questions. The question stays open and is asked again.
    const waiting = state.stage === 'client' || state.stage === 'section';
    // An album is ten messages: the open question is asked again once per
    // album, not once per photograph.
    const group = ctx.message.media_group_id ?? null;
    const asked = waiting && group !== null && group === state.reaskedGroup;
    const updated = updateIntake(chatId, {
      ...read.patch,
      stage: waiting ? state.stage : 'material',
      fileCount: state.fileCount + 1,
      material: caption ? [...state.material, caption] : state.material,
      reaskedGroup: group,
    });
    if (read.say) await ctx.reply(read.say, read.keyboard ? { reply_markup: read.keyboard } : undefined);
    if (asked) return;
    if (state.stage === 'section') {
      await ctx.reply('Qabul qilindi. Avval yuk qayerdan chiqishini tanlang:', {
        reply_markup: zoneKeyboard(await pricedZonesNow()),
      });
      return;
    }
    if (state.stage === 'client') {
      await ctx.reply(`Qabul qilindi.\n\n${CLIENT_QUESTION}`, { parse_mode: 'Markdown' });
      return;
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
      // A live calc collection answers these in WORDS (his 1.12 a): a voice
      // note into a collection used to reach the cabinet, which answers a
      // staff chat with nothing — the seller believed it was part of the job.
      if (!late && activeIntake(chatId)) {
        const m = ctx.message;
        const said = m.voice || m.audio || m.video_note
          ? '🎤 Ovozli xabar o‘qilmaydi — yozib yuboring.'
          : m.video
            ? '🎬 Video o‘qilmaydi — rasm yoki matn yuboring.'
            : m.location
              ? '📍 Joylashuv hisoblashda o‘qilmaydi — shahar nomini yozing.'
              : null;
        if (said) await ctx.reply(said);
        return;
      }
      if (!late && activeCapture(chatId)) return next();
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
        // The goods list forwarded where the customer was asked for (his
        // 1.7 b): it is MATERIAL, and the question is asked again. It used to
        // become the lead's name and was never shown to the model. The
        // company's code prefix is read once, here, off any transaction.
        const read = await readCustomerText(ctx.message.text, await clientCodePrefix());
        const answer = clientAnswer(intake, ctx.message.text, read);
        updateIntake(chatId, answer.patch);
        if (answer.kind === 'material') {
          await ctx.reply(answer.say, { parse_mode: 'Markdown' });
          return;
        }
        // Per section (judge UX14): a customs job is asked for the LINES —
        // «300 dona, 150 kg, 120 m², 40 juft» and the code if known — which
        // the old «kub/kg» prompt never said could be sent.
        const { collectPromptText } = await import('../../wms/calc/intake');
        await ctx.reply(collectPromptText(intake.section), { reply_markup: doneKeyboard });
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

    // «/reyting» (0134): this week's podium and the person's own place, in
    // the same slot as «📊 Holat» for the same reasons — below the cabinet
    // pass-through, above both captures and far above the paid model.
    if (ctx.message.text === '/reyting') {
      const staff = await staffForChat(chatId);
      if (!staff) return next();
      answerRating(chatId, staff.id);
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
    let waitDeclined = false;
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
        // Not taken — and already answered by the wait itself («Bu sana
        // emas»): the tail must not add a lost-collection sentence to it.
        waitDeclined = true;
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
      waitDeclined,
    });
  });
}

/** The orphaned totals answer's one sentence (judge concurrency-5). */
export const LOST_TOTALS_ANSWER =
  'Hisoblatish to‘plami topilmadi (bot qayta ishga tushgan bo‘lishi mumkin) — 🧮 ni qayta bosing.';

/** «Nothing by that» — what a lookup the free search could not answer is told. */
const NOT_FOUND_HINT =
  'Topilmadi. Mijoz kodi (GS777), karobka kodi (YW26-000123), yashik (CR-…) yoki partiya kodini yozing.';

/**
 * A bare figure with no collection to answer (review REG-3): «777» is as
 * often a code typed without its letters as a lost «3500», so it is told what
 * a lookup that found nothing is told — plus the one clause for the case it
 * was a totals answer — and is never handed to the paid assistant.
 */
export const BARE_FIGURE_NOT_FOUND = `${NOT_FOUND_HINT}\n(Hisoblatish savoliga javob bo‘lsa — 🧮 ni qayta bosing.)`;

/** «I could not read that» after the totals question — with ITS example. */
const TOTALS_NOT_READ: Record<import('./calc-intake').TotalsAsk, string> = {
  kg: 'Tushunmadim. Brutto og‘irlikni yozing: «3500» yoki «3500 kg».',
  m3: 'Tushunmadim. Umumiy hajmni yozing: «12» yoki «12 kub».',
  both: 'Tushunmadim. «12 kub 3500 kg» ko‘rinishida yozing.',
};

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
 * what it did before the topshiriq round. Exported for the test that proves
 * an orphaned totals answer never reaches the paid assistant.
 */
export async function answerStaffText(
  ctx: StaffTailCtx,
  chatId: bigint,
  staffId: string,
  text: string,
  // REQUIRED (Q5 a): whether this is a backlog text, the incoming message
  // (null for Door B's «🔍», which replays a forward), and Door B's key —
  // and whether a one-text wait was offered the text first and declined it.
  opts: { backlog: boolean; messageId: number | null; once: OnceKey | null; waitDeclined: boolean },
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
  // A totals answer with no collection to answer (judge concurrency-5): the
  // collection lives in memory until round 3, and a restart or the TTL
  // between the brutto question and «3500» loses it — the answer is said
  // lost, in words, and never handed to the paid assistant, which can make
  // nothing of a bare figure. A live collection never reaches this tail.
  //
  // Only a text the person TYPED here and nothing else claimed (review
  // P3-R1): Door B's «🔍» (no message of its own) replays a forwarded
  // customer message — «12 kub 3500 kg» is a customer's words there, never
  // an answer to the bot — and a «date» the ⏰ wait declined has been
  // answered by that wait already.
  //
  // Only a WORDED figure («3500 kg») says a collection was lost (review
  // REG-3): a bare «777» has the lookup's own answer and the clause.
  const orphan =
    opts.messageId !== null && !opts.waitDeclined && !activeIntake(chatId) ? totalsAnswerShape(text) : null;
  if (orphan !== null) {
    await ctx.reply(orphan === 'worded' ? LOST_TOTALS_ANSWER : BARE_FIGURE_NOT_FOUND);
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
    await ctx.reply(NOT_FOUND_HINT);
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

/**
 * «/reyting» — this week's podium and the person's own place (0134). Off the
 * sequential poller (#706): the read is the KPI's carton aggregate, and a
 * busy Saturday must not hold every customer's cabinet behind it.
 */
function answerRating(chatId: bigint, userId: string): void {
  void (async () => {
    try {
      const { ratingReplyFor } = await import('../../wms/staff/rating');
      await sendText({ chatId, text: await ratingReplyFor(userId) });
    } catch (err) {
      logger.warn({ err }, 'rating reply failed');
      await sendText({ chatId, text: 'Reytingni hisoblab bo‘lmadi — keyinroq urinib ko‘ring.' }).catch(() => {});
    }
  })();
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
 * price a row stating neither only by guessing — and, since 2026-10-09, the
 * figure the row's LAW pins: a 6110 sweater stated in kg still owes its count
 * under «kamida $X/dona» (`lineNeeds`, read with the book's law). Asking the
 * seller now costs one message; not asking costs the VED a request they must
 * hand back.
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
  const { ambiguousTotalText, factsVolumeM3, nextLineToAsk, lineQuestionText, intakeSummaryText, volumeFromLines } =
    await import('../../wms/calc/intake');
  const laws = await intakeLaws(state);
  // The lines dealt with, put onto the goods list as it stands NOW (round-3
  // review, R3-C5): a re-read after «➕ Yana ma'lumot» rebuilds the list, and
  // an index carried over from the old one marked some other line done while
  // the skipped one was asked again. By name, like the per-line answers.
  const skip = resolveLineDone(state.facts.goods, state.lineDone).map((d) => d.index);
  // BOTH doors ask now (P1.3): the plain «🧮 Hisoblatish» used to land a
  // ten-line rastamojka job with seven lines nobody had a figure for, and a
  // summary that named none of them. The same cap holds.
  const line = state.round < MAX_QUESTION_ROUNDS ? nextLineToAsk(state.section, state.facts, laws, { skip }) : null;

  // The lines dealt with are WRITTEN BACK on every way out (round-2 review,
  // C10): every caller hands this function a `lineDone` with the line it just
  // answered or skipped, and it used to be read for the choice below and then
  // dropped — the stored collection kept the old list, so the next answer or
  // ⏭ rebuilt it from that, and a line skipped with ⏭ was asked again. What
  // is written is every entry, placed where this reading has it and kept as
  // it was where it has not (`carryLineDone`, round-4 review C-r2): writing
  // back only the placed ones let one empty reading erase every ⏭.
  const lineDone = carryLineDone(state.facts.goods, state.lineDone);
  if (line) {
    updateIntake(chatId, {
      stage: 'question',
      askingIndex: line.index,
      askingTotalsFor: null,
      round: state.round + 1,
      reasked: false,
      offers: [],
      lineDone,
    });
    await ctx.reply(lineQuestionText(line), { reply_markup: skipKeyboard() });
    return;
  }

  // The road is priced on the shipment's TOTALS (the tariff's density band ×
  // m³), so every freight section is asked them ONCE, after the lines, on
  // every door (his 2.7 b — it was the AI podklyuch door alone, and a plain
  // yolkira landed with no kg). The kilos are BRUTTO and only ever asked;
  // the cube is asked only when the lines cannot give it (`factsVolumeM3`),
  // and the question names exactly what it asks (`totalsQuestion`).
  const volume = factsVolumeM3(state.facts);
  const ask = totalsQuestion(state, volume);
  if (ask) {
    updateIntake(chatId, {
      stage: 'question',
      askingIndex: null,
      askingTotalsFor: ask,
      totalsAsked: true,
      reasked: false,
      offers: [],
      lineDone,
    });
    // A total the seller typed two ways is WHY it is asked — said beside the
    // question, or «I typed it» is the seller's first thought (review P3-R2).
    const why = state.ambiguousTotals.map((a) => `\n⚠️ ${ambiguousTotalText(a)}`).join('');
    await ctx.reply(
      totalsQuestionText(ask, state.facts, { m3: volume, fromLines: volumeFromLines(state.facts) }) + why,
      { reply_markup: skipKeyboard() },
    );
    return;
  }

  const settled =
    updateIntake(chatId, { stage: 'review', askingIndex: null, askingTotalsFor: null, offers: [], lineDone }) ??
    state;
  const { AI_READ_FAILURE } = await import('../../wms/calc/intake');
  const failure = settled.aiUsed ? null : (settled.aiFailure ?? 'not_configured');
  await ctx.reply(
    intakeSummaryText({
      section: settled.section,
      facts: settled.facts,
      laws,
      // Everything the seller typed for the customer, on one line (round-3
      // review, R3-C3): the code or phone the landing finds the customer by
      // is on the one screen checked before «Tasdiqlash» — printed as the
      // lead's name alone, «Ali aka / GS771» could not be caught here.
      clientLabel: intakeClientSummary(settled.clientHintRaw),
      fileCount: settled.fileCount,
      ambiguous: settled.ambiguousTotals,
    }) +
      // The bot's own word on the lines an Excel kept out, each on its own
      // line and never one of the model's three notes (round-4 review, C-r1
      // nit: put first among them, it pushed the third out).
      settled.notes.map((n) => `\n\n${n}`).join('') +
      // Why the model's reading is missing, in words (his 1.6 a) — never one
      // sentence for a dead key, a cut answer and a five-second outage. And
      // what WAS read instead: with an Excel, its lines are the goods, so
      // «faqat yozilganidan» was false (round-4 integration S-a).
      (failure
        ? `\n\n⚠️ ${AI_READ_FAILURE[failure].text}\n` +
          ((settled.invoiceGoods ?? []).length > 0
            ? 'Faqat Excel va yozilganidan o‘qildi.'
            : 'Faqat yozilganidan o‘qildi.')
        : aiStepsText(settled.steps)) +
      (settled.ai
        ? `\n\n📄 Sertifikat: ${settled.hasCertificate ? 'bor' : 'yo‘q'} (o‘zgartirish uchun tugmani bosing)`
        : ''),
    {
      reply_markup: reviewKeyboard(
        settled.ai ? aiConfirmKeyboard(settled.hasCertificate) : confirmKeyboard,
        failure !== null && AI_READ_FAILURE[failure].retry,
      ),
    },
  );
}

/**
 * Two or three of the model's own notes on what it did (his 1.6 a: «AI ning
 * 2-3 izohi»). They used to reach only the card's lenta, so the seller saw a
 * list with no word on where it came from.
 */
export function aiStepsText(steps: readonly string[]): string {
  const shown = steps
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((s) => `· ${s.length > 200 ? `${s.slice(0, 199)}…` : s}`);
  return shown.length ? `\n\n🤖 AI:\n${shown.join('\n')}` : '';
}

/** The confirm keyboard, with «🔄 Qayta o‘qish» on top when a retry can help. */
function reviewKeyboard(
  base: { inline_keyboard: { text: string; callback_data: string }[][] },
  retry: boolean,
): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return retry
    ? { inline_keyboard: [[{ text: '🔄 AI qayta o‘qisin', callback_data: 'c:reread' }], ...base.inline_keyboard] }
    : base;
}

/** «⏭ Bilmayman, o‘tkazib yubor» — under every question, the way out. */
function skipKeyboard() {
  return { inline_keyboard: [[{ text: '⏭ Bilmayman, o‘tkazib yubor', callback_data: 'c:skip' }]] };
}

/**
 * The buttons a bare or ambiguous number is answered with (judge UX4): one
 * tap writes the line. Each button carries its POSITION (`c:pick_N`, a
 * closed CALC_STEPS word) and the figure lives in `IntakeState.offers`, so
 * the callback stays inside the parser's vocabulary (#937) and a stale press
 * picks nothing it was not offered. Pure, so the derived fence can parse
 * every button it draws.
 */
export function lineOfferKeyboard(labels: readonly string[]) {
  const buttons = labels.slice(0, MAX_OFFERS).map((text, i) => ({ text, callback_data: `c:pick_${i}` }));
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));
  return { inline_keyboard: [...rows, ...skipKeyboard().inline_keyboard] };
}

/**
 * The book's law for the collection's codes, read on the pool (#714) —
 * through a dynamic import, because platform never imports wms statically.
 * A failed read answers «no law known»: the line is then asked for a count
 * or a weight, which is the one-measure rule it always had, never a
 * refusal of the whole collection.
 */
async function intakeLaws(state: IntakeState) {
  try {
    const { bookLawsFor } = await import('../../wms/calc/book-laws');
    return await bookLawsFor((state.facts.goods ?? []).map((g) => g.tnvedCode));
  } catch (err) {
    logger.warn({ err }, '[calc-intake] rates book unreadable — asking by the one-measure rule');
    return new Map();
  }
}

/** Why an answer could not be read — in words, for the one re-ask. */
type LineAnswerRefusal = import('../../wms/calc/intake-manual').LineAnswerRefusal;

const LINE_REFUSAL: Record<LineAnswerRefusal, (detail?: string) => string> = {
  nothing: () => 'Tushunmadim. Masalan: «50 dona», «300 kg», «120 m²» yoki «40 juft».',
  too_large: () => 'Bu son juda katta — miqdorni qayta yozing. TNVED kodi bo‘lsa: «kod 6403990000».',
  code_short: (d) => `«${d ?? ''}» — 9 xonali: boshida 0 tushib qolganmi? Kodni 10 xonada yozing.`,
  cartons: (d) => `${d ?? ''} karobka — karobka soni tovar soni emas. Nechta dona? Masalan: «300 dona».`,
  unknown_unit: (d) => `«${d ?? ''}» — bu birlikni bilmayman. dona, kg, m², juft yoki litrda yozing.`,
  two_pairs: () => 'Bitta qatorda ikki xil o‘lchov — bittasini yozing.',
  unlabelled: () => 'Raqamlarni birlik bilan yozing: «300 dona 150 kg».',
  repeated: () => 'Bitta birlikda ikki xil son — bittasini yozing.',
};

/**
 * The seller's answer to a line question, written onto the row that was
 * asked about.
 *
 * Addressed by INDEX and never by name: two lines of a packing list are
 * routinely called the same thing. An unreadable answer is re-asked ONCE and
 * then kept as material — the VED reads everything the seller sent, so
 * nothing is lost by moving on, and a wrong reading would be a figure nobody
 * stated with a duty computed on it. A BARE number is never a default unit:
 * it is the law's one pinned unit, or buttons (P1.3, judge UX4) — and after
 * the TOTALS question, the unit that question asked (§8.2.5). Exported for
 * the test of that reading alone.
 */
export async function applyLineAnswer(
  ctx: CalcReplyCtx,
  chatId: bigint,
  state: IntakeState,
  text: string,
): Promise<void> {
  const { parseLineAnswer, parseManualFacts } = await import('../../wms/calc/intake-manual');
  const {
    ambiguousTotalText,
    anyMeasureLine,
    bareChoices,
    bareUnitFor,
    figureLabel,
    lineNeeds,
    needFigure,
    numberText,
  } = await import('../../wms/calc/intake');

  if (state.askingTotalsFor !== null) {
    const ask = state.askingTotalsFor;
    // A number that names no unit is what the QUESTION asked (his 2.7 b):
    // «3500» after the brutto question is kilograms, «12» after the volume
    // one is cubic metres — read by the house number reader with the unit
    // word put after it, so its «1,200» rule decides and there is no second
    // reader. After the question for BOTH it is neither, and is refused —
    // and so is a bare answer holding TWO figures to a one-unit question
    // (review P3-R7): «12 3500» after the brutto question was read as
    // 3500 kg and the 12, the cube as often as not, dropped in silence.
    const bare = bareTotalsNumber(text);
    const unitless = bare && (ask === 'both' || totalsFigureCount(text) > 1);
    if (unitless && !state.reasked) {
      // Refused, and still kept for the card (law 11): the VED reads it as typed.
      updateIntake(chatId, { reasked: true, answers: [...state.answers, `Umumiy: ${text}`] });
      await ctx.reply('Kub va kg ni birlik bilan yozing: «12 kub 3500 kg»');
      return;
    }
    const read = parseManualFacts(bare && !unitless ? `${text.trim()} ${ask === 'kg' ? 'kg' : 'kub'}` : text);
    // Whatever of the two the answer states; the other keeps what it had.
    // What was READ is kept apart (`totalsAnswer`) and put back on top of
    // every re-read (judge concurrency-4) — the text goes to the card with
    // the per-line answers, never into the material a re-read parses.
    // `at` is now (review CONC-2): an answer is only ever typed to a question
    // asked after a reading of everything, so the answer has seen it all —
    // and material sent after it may state the figure otherwise.
    const totalsAnswer = {
      weightKg: read.weightKg ?? state.totalsAnswer.weightKg,
      volumeM3: read.volumeM3 ?? state.totalsAnswer.volumeM3,
      at: { material: state.material.length, files: state.fileCount },
    };
    const kept =
      updateIntake(chatId, {
        facts: mergeTotalsAnswer(totalsAnswer, state.facts),
        totalsAnswer,
        // …and its «1.2 mi yoki 1200 mi?» goes with it (review P3-3): the
        // summary asked again about the figure just given, beside «to‘liq».
        ambiguousTotals: unansweredAmbiguity(state.ambiguousTotals, totalsAnswer),
        answers: [...state.answers, `Umumiy: ${text}`],
      }) ?? state;
    if (read.ambiguous.length > 0 && !kept.reasked) {
      updateIntake(chatId, { reasked: true });
      await ctx.reply(read.ambiguous.map((a) => ambiguousTotalText(a)).join('\n'));
      return;
    }
    if (read.weightKg == null && read.volumeM3 == null && !kept.reasked) {
      updateIntake(chatId, { reasked: true });
      await ctx.reply(TOTALS_NOT_READ[ask]);
      return;
    }
    await askNextOrConfirm(ctx, chatId, { ...kept, askingTotalsFor: null, reasked: false });
    return;
  }

  const index = state.askingIndex ?? 0;
  const goods = state.facts.goods ?? [];
  const row = goods[index];
  const answer = row ? parseLineAnswer(text) : parseLineAnswer('');
  // Kept for the card, NOT as material: a re-read takes the shipment's totals
  // from the material, and one line's «150 kg» became the whole truck's
  // weight there (the diagnosis' cause 5).
  const withText = updateIntake(chatId, { answers: [...state.answers, `${index + 1}-qator: ${text}`] }) ?? state;

  if (answer.kind === 'figures') {
    const patch: Partial<NonNullable<IntakeState['facts']['goods']>[number]> = {};
    for (const [key, value] of Object.entries(answer.figures)) {
      if (value !== null) Object.assign(patch, { [key]: value });
    }
    if (answer.code) patch.tnvedCode = answer.code;
    await applyLinePatch(ctx, chatId, withText, index, patch);
    return;
  }

  if (answer.kind === 'bare' || answer.kind === 'ambiguous') {
    // The code that came with it lands first: it may be what pins the unit.
    const coded =
      answer.kind === 'bare' && answer.code
        ? (updateIntake(chatId, {
            facts: {
              ...withText.facts,
              goods: goods.map((g, i) => (i === index ? { ...g, tnvedCode: answer.code } : g)),
            },
          }) ?? withText)
        : withText;
    const laws = await intakeLaws(coded);
    const line =
      lineNeeds(coded.section, coded.facts, laws).find((l) => l.index === index) ??
      // The line owes nothing the law pins and states something already: a
      // bare figure is still offered as a count or a weight.
      anyMeasureLine(index, row!.name);
    if (answer.kind === 'bare') {
      const unit = bareUnitFor(line);
      if (unit) {
        await applyLinePatch(ctx, chatId, coded, index, needFigure(unit, answer.value));
        return;
      }
      const offers = bareChoices(line, row!.unit).map((u) => ({ unit: u, value: answer.value }));
      updateIntake(chatId, { offers });
      await ctx.reply(`${numberText(answer.value)} — qaysi birlikda?`, {
        reply_markup: lineOfferKeyboard(offers.map((o) => figureLabel(o.value, o.unit))),
      });
      return;
    }
    // «1,200 kg» — both readings in the unit it was written in, or in every
    // unit the line could take when it was written bare.
    const written = answer.unit ? needUnitOfSeller(answer.unit) : null;
    const units = answer.unit ? (written ? [written] : []) : bareChoices(line, row!.unit);
    const offers = units.flatMap((u) => [
      { unit: u, value: answer.decimal },
      { unit: u, value: answer.thousands },
    ]);
    if (offers.length === 0) {
      await refuseLine(ctx, chatId, coded, 'cartons');
      return;
    }
    updateIntake(chatId, { offers: offers.slice(0, MAX_OFFERS) });
    await ctx.reply(`${numberText(answer.decimal)} mi yoki ${numberText(answer.thousands)} mi?`, {
      reply_markup: lineOfferKeyboard(offers.slice(0, MAX_OFFERS).map((o) => figureLabel(o.value, o.unit))),
    });
    return;
  }

  await refuseLine(ctx, chatId, withText, answer.reason, answer.detail);
}

/** A unit the seller WROTE, as a figure's unit — a carton is no figure. */
function needUnitOfSeller(
  unit: import('../../wms/calc/units').SellerUnit,
): import('../../wms/calc/needs').NeedUnit | null {
  return unit === 'karobka' ? null : unit;
}

/** One re-ask in words, then the line is passed and the next one asked. */
async function refuseLine(
  ctx: CalcReplyCtx,
  chatId: bigint,
  state: IntakeState,
  reason: LineAnswerRefusal,
  detail?: string,
): Promise<void> {
  if (!state.reasked) {
    updateIntake(chatId, { reasked: true });
    await ctx.reply(LINE_REFUSAL[reason](detail), { reply_markup: skipKeyboard() });
    return;
  }
  const asked = state.askingIndex === null ? null : doneLine(state.facts.goods, state.askingIndex);
  const done = asked ? [...state.lineDone, asked] : state.lineDone;
  await askNextOrConfirm(ctx, chatId, { ...state, lineDone: done, reasked: false, offers: [] });
}

/**
 * Write a figure onto the asked line, remember it for a re-analysis, and
 * either ask the SAME line for what it still owes (a clothing line answered
 * «150 kg» still owes its count — same round, judge UX4) or move on.
 */
async function applyLinePatch(
  ctx: CalcReplyCtx,
  chatId: bigint,
  state: IntakeState,
  index: number,
  patch: Partial<NonNullable<IntakeState['facts']['goods']>[number]>,
): Promise<void> {
  const { lineNeeds, lineQuestionText } = await import('../../wms/calc/intake');
  const goods = state.facts.goods ?? [];
  const row = goods[index];
  if (!row) {
    await askNextOrConfirm(ctx, chatId, { ...state, reasked: false, offers: [] });
    return;
  }
  const patched = goods.map((g, i) => (i === index ? { ...g, ...patch } : g));
  const earlier = state.lineAnswers.find((a) => a.index === index);
  const lineAnswers = [
    ...state.lineAnswers.filter((a) => a.index !== index),
    { index, name: row.name, patch: { ...(earlier?.patch ?? {}), ...patch } },
  ];
  const next =
    updateIntake(chatId, {
      facts: { ...state.facts, goods: patched },
      lineAnswers,
      reasked: false,
      offers: [],
    }) ?? state;
  const laws = await intakeLaws(next);
  // Asked again in the SAME round, never as a new one: the seller is still
  // answering the question they were asked. Each re-ask follows an answer
  // they typed or tapped, and «⏭» always leaves.
  const still = lineNeeds(next.section, next.facts, laws).find((l) => l.index === index);
  if (still) {
    updateIntake(chatId, { stage: 'question', askingIndex: index });
    await ctx.reply(`Yozildi. ${lineQuestionText(still)}`, { reply_markup: skipKeyboard() });
    return;
  }
  await askNextOrConfirm(ctx, chatId, { ...next, lineDone: [...next.lineDone, { index, name: row.name }] });
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
  token: string,
): Promise<void> {
  try {
    const analysed = await analyzeCollected(state);
    const outcome = settleAnalysis(activeIntake(chatId), state, analysed, token);
    if (outcome.kind === 'gone') return;
    updateIntake(chatId, outcome.state);
    if (outcome.kind === 'arrived') {
      await ctx.reply(
        `Tahlil paytida yana ${outcome.arrived} ta xabar/fayl keldi — ular hali o‘qilmagan.\n` +
          'Hammasini birga o‘qish uchun «Bo‘ldi» ni yana bosing.',
        { reply_markup: doneKeyboard },
      );
      return;
    }
    // ONE exit from the analysis: ask about the first line that cannot be
    // priced, else offer the confirm. Both shapes are the same function, so
    // the summary the seller reads is identical whichever way they arrive.
    await askNextOrConfirm(ctx, chatId, outcome.state);
  } catch (err) {
    logger.warn({ err }, '[calc-intake] analysis failed');
    const live = activeIntake(chatId);
    if (live?.analysing === token) updateIntake(chatId, { analysing: null, stage: 'material' });
    await ctx.reply('Tahlil qilib bo‘lmadi. «Bo‘ldi» ni qayta bosing.', { reply_markup: doneKeyboard }).catch(() => {});
  }
}

/**
 * What an answer to the customer question looks like, by wms's own readers
 * (a dynamic import: platform never imports wms statically) and the company's
 * code prefix. Two facts, kept apart because they answer different things:
 *  - `material` — `looksLikeMaterial`: is it goods rather than a customer?
 *  - `couldBeCustomer` — could it NAME one at all: no goods evidence
 *    (`goodsEvidence` — the material reader's own first test, round-4
 *    integration defect 1) and either a hint `parseClientHint` finds or one
 *    short line that is not a row of bare figures (`figureRow`). Only such a
 *    text may be insisted on as the customer (round-2 review, C3/C7).
 *  - `why` — when it cannot, which of the two it fails (round-3 review,
 *    R3-C6): `goods` = it states goods; `shape` = no goods in it, but several
 *    lines (or one long one) that no hint reads. The refusal of a repeat says
 *    the one that is TRUE: «Rustam / Andijon» sent twice was told it was a
 *    goods list. Null when it could.
 */
export interface CustomerTextRead {
  material: boolean;
  couldBeCustomer: boolean;
  why: 'goods' | 'shape' | null;
}

export async function readCustomerText(raw: string, prefix: string): Promise<CustomerTextRead> {
  const { figureRow, goodsEvidence, looksLikeMaterial } = await import('../../wms/calc/intake-manual');
  const { parseClientHint } = await import('../../wms/calc/intake');
  const text = raw.trim();
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  // ONE goods test with the material reader's own first test (round-4
  // integration, defect 1): this side kept the old two-part check, so «Tovar:
  // tayyor» was material on the first send AND a believable customer on the
  // repeat — the lead was named «Tovar: tayyor».
  const goods = goodsEvidence(text, { prefix });
  // A word and a row of bare figures («Kurtka 1200 50 3000») is a packing-list
  // row, never a name — asked AFTER the hint, which reads a phone in the same
  // shape («Ali 90 123 45 67»). Which rows refuse the repeat is `figureRow`'s
  // alone: a count of three kept here as well would believe a pair the reader
  // calls a row («Kafel 2400 36,5», «Kurtka 300 1200» — round-5 probe,
  // collector).
  const hint = parseClientHint(text, { prefix });
  const row = hint === null && figureRow(text);
  const couldBeCustomer = text !== '' && !goods && (hint !== null || (!row && lines.length === 1 && text.length <= 60));
  return {
    material: looksLikeMaterial(raw, { prefix }),
    couldBeCustomer,
    why: couldBeCustomer ? null : goods || row ? 'goods' : 'shape',
  };
}

/**
 * The answer to the customer question — pure, so the rule is a test.
 *
 * Text that looks like goods is MATERIAL and the question is asked again (his
 * 1.7 b). But the goods reader is a guess, and a customer it mistook for a
 * line («Ali aka 2», «OOO Asia Trade 2020») used to loop on the question with
 * no way forward (round-1 review, t23). So the re-ask says WHY, and the SAME
 * text sent again is the seller insisting: it is the customer, and it leaves
 * the material it was filed into — a name read as a goods line is an
 * invented product on the card.
 *
 * Insisting is believed only of a text that COULD be a customer (round-2
 * review, C3/C7): a goods list sent twice — a double forward, or re-sent after
 * the re-ask — became the customer, the lead was named with the goods and the
 * only copy of them left what the model reads. Such a repeat is kept ONCE as
 * material, and the question is asked again without the promise it cannot
 * keep.
 */
export function clientAnswer(
  state: IntakeState,
  raw: string,
  read: CustomerTextRead,
):
  | { kind: 'material'; patch: Partial<IntakeState>; say: string }
  | { kind: 'customer'; patch: Partial<IntakeState> } {
  const text = raw.trim();
  const again = state.clientAskedWith !== null && state.clientAskedWith === text;
  if (read.material && !(again && read.couldBeCustomer)) {
    if (again) {
      // Worded by the reason that is true (R3-C6): a goods list, or a text no
      // hint reads — «Rustam / Andijon» has no goods in it.
      return {
        kind: 'material',
        patch: {},
        say:
          '✍️ Bu matn allaqachon olingan — ikkinchi marta qo‘shilmadi. ' +
          (read.why === 'shape'
            ? 'Bir necha qatorli (yoki uzun) matn mijoz bo‘la olmaydi.\nIsm, kod yoki telefonni bitta qatorda yozing.\n\n'
            : 'Tovar ro‘yxati mijoz bo‘la olmaydi.\nMijozni bitta qatorda yozing: kod yoki telefon.\n\n') +
          CLIENT_QUESTION,
      };
    }
    return {
      kind: 'material',
      patch: { material: [...state.material, raw], clientAskedWith: text },
      say:
        (read.why === 'shape'
          ? '✍️ Ma’lumot sifatida olindi — bu matndan mijozni o‘qib bo‘lmadi.\n'
          : '✍️ Ma’lumot sifatida olindi — tovar ro‘yxatiga o‘xshaydi.\n') +
        'Mijozni bitta qatorda yozing: kod yoki telefon.' +
        (read.couldBeCustomer ? ' (Shu matnni yana yuborsangiz — mijoz deb olinadi.)' : '') +
        '\n\n' +
        CLIENT_QUESTION,
    };
  }
  let material = state.material;
  if (again) {
    const at = material.map((m) => m.trim()).lastIndexOf(text);
    if (at >= 0) material = [...material.slice(0, at), ...material.slice(at + 1)];
  }
  return { kind: 'customer', patch: { clientHintRaw: text, stage: 'material', material, clientAskedWith: null } };
}

/**
 * Where an analysis lands (the diagnosis' cause 7). Pure, so the race is
 * tested without a bot.
 *
 *  - `gone`: the collection was cancelled, restarted (a new note id), or a
 *    newer analysis owns it — the result is thrown away, never written back
 *    over somebody's fresh start;
 *  - `arrived`: messages or files came in while it ran — the reading is kept
 *    for its facts, but the LIVE material stays and the seller is asked to
 *    press «Bo'ldi» again, so nothing the bot answered «Qabul qilindi» to is
 *    erased or left unread;
 *  - `done`: the result replaces the facts, and everything else is the live
 *    collection's own.
 */
export function settleAnalysis(
  live: IntakeState | null,
  snapshot: IntakeState,
  analysed: IntakeState,
  token: string,
):
  | { kind: 'gone' }
  | { kind: 'arrived'; state: IntakeState; arrived: number }
  | { kind: 'done'; state: IntakeState } {
  if (!live || live.noteId !== snapshot.noteId || live.analysing !== token) return { kind: 'gone' };
  const arrived =
    live.material.length - snapshot.material.length + (live.fileCount - snapshot.fileCount);
  // A totals answer typed WHILE the reading ran is newer than everything the
  // reading saw, and goes on top (judge concurrency-4). Otherwise the
  // reading's own verdict on the answer stands — re-merging the snapshot's
  // answer here would put back a figure the reading held open because later
  // material doubts it (review CONC-2).
  const answeredMeanwhile = !sameTotalsAnswer(live.totalsAnswer, snapshot.totalsAnswer);
  // The route answer by the same rule (docs/SAKKIZ-R3.md K15): only a route
  // answered WHILE the reading ran goes on top; otherwise the reading's own
  // verdict on the answer stands.
  const routeMeanwhile = !sameRouteAnswer(live.routeAnswer, snapshot.routeAnswer);
  const facts = {
    ...analysed.facts,
    ...(routeMeanwhile ? answeredRoute(live.routeAnswer, null) : {}),
    goods: mergeLineAnswers(analysed.facts.goods ?? [], live.lineAnswers),
  };
  const state: IntakeState = {
    ...live,
    // The LIVE answers go back on top (round-1 review, c2): the reading was
    // merged with the SNAPSHOT's answers, and a line answered while it ran —
    // into `answers`, not material, so nothing counts it as «arrived» —
    // landed without its figure. Re-applying an answer the snapshot already
    // had is idempotent, so both outcomes take the same merge.
    //
    // The live totals answer too, when it is new (above); `totalsAsked` is
    // the reading's own verdict over it.
    facts: answeredMeanwhile ? mergeTotalsAnswer(live.totalsAnswer, facts) : facts,
    totalsAsked: analysed.totalsAsked,
    steps: analysed.steps,
    notes: analysed.notes,
    aiUsed: analysed.aiUsed,
    aiFailure: analysed.aiFailure,
    // The reading's bills, appended to the snapshot's (2.9 c) — one analysis
    // runs at a time (the token), so the snapshot's are the live ones.
    usages: analysed.usages,
    // The reading's two-way totals, less what the seller answered while it
    // ran — the live answer above is on the facts (review P3-3).
    ambiguousTotals: answeredMeanwhile
      ? unansweredAmbiguity(analysed.ambiguousTotals, live.totalsAnswer)
      : analysed.ambiguousTotals,
    analysing: null,
    stage: arrived > 0 ? 'material' : 'review',
  };
  return arrived > 0 ? { kind: 'arrived', state, arrived } : { kind: 'done', state };
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
    not_configured: NOT_FOUND_HINT,
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
 * A spreadsheet that cannot be read, said per reason (his 1.6 a). Keyed by the
 * reader's OWN union, so a reason it learns tomorrow is a compile error here
 * rather than a seller reading «undefined».
 */
type SheetRefusalReason = Extract<import('../../wms/deals/goods-file').GoodsFileRead, { kind: 'refused' }>['reason'];
const SHEET_REFUSAL: Record<SheetRefusalReason, (label: string) => string> = {
  old_format: (label) => `📄 ${label} — Excel 95 yoki undan eski format, o‘qilmaydi. .xlsx qilib saqlab yuboring.`,
  encrypted: (label) => `📄 ${label} — parol bilan himoyalangan, o‘qilmaydi. Parolsiz yuboring.`,
  broken: (label) => `📄 ${label} — Excel fayl buzilgan yoki o‘qib bo‘lmadi. Qayta saqlab yuboring.`,
  empty: (label) => `📄 ${label} — jadval bo‘sh.`,
};

/** The two answers to «a second invoice arrived» (his 1.13 c). */
function invoiceChoiceKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Qatorlari qo‘shilsin', callback_data: 'c:inv_add' }],
      [{ text: '🔁 Oldingisining o‘rniga', callback_data: 'c:inv_replace' }],
    ],
  };
}

/** The two answers to «a PDF or a sheet the AI reads, beside an Excel list» (round-1 review, c4). */
function otherFilesKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '➕ Ha, boshqa zavod — tovarlari qo‘shilsin', callback_data: 'c:other_add' }],
      [{ text: '📄 Yo‘q, o‘sha tovarlar — faqat jami o‘qilsin', callback_data: 'c:other_same' }],
    ],
  };
}

/** What a file is worth to the collection, and what the seller is told — pure. */
export interface FileAnswer {
  patch: Partial<IntakeState>;
  say: string | null;
  keyboard?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

/**
 * «Boshqa zavodning tovarlarimi?» — asked when a file the MODEL reads (a PDF,
 * a header-less sheet) meets an Excel list the reader mapped, in either order
 * (round-1 review, c4). The Excel list answers for the goods, so the model's
 * lines were thrown away whatever the file was — after the bot had said «AI
 * o'qiydi». A second factory's invoice is the commonest reason to send two
 * documents (his 1.13), and the same invoice twice is the second commonest:
 * only the seller knows which, and merging blind would double the order.
 * Asked again for each new such file, because one answer about the first PDF
 * says nothing about the next — and the LAST answer then stands for all of
 * them: the model reads the files together and its list names no file per
 * line, so «A's own PDF beside B's» has no right answer (round-2 review, C2;
 * stated, not built — see `IntakeState.aiGoods`). The question says so.
 */
function otherFilesQuestion(invoiceLines: number): string {
  return (
    `\nExcel ro‘yxatida ${invoiceLines} ta tovar bor. AI o‘qiydigan fayl — boshqa zavodning tovarlarimi?` +
    '\n(Javob AI o‘qiydigan hamma fayllarga tegishli; javobgacha tahlil boshlanmaydi.)'
  );
}

/**
 * How spreadsheet texts fit what the model reads, in ROWS — `fitSheetRows` at
 * the reader's cap (round-3 review, R3-C2: counted in lines, a sheet's
 * «[name]» heading was a row, and a 20-row file read «birinchi 21 qator»).
 */
export type SheetFit = (texts: readonly string[]) => { kept: number[]; total: number[] };

/**
 * A PDF: shown to the model, within the count and byte caps — and asked about
 * when an Excel list already answers for the goods.
 */
export function receivePdf(state: IntakeState, pdf: { data: Buffer; name: string }, label: string): FileAnswer {
  if (pdf.data.length > MAX_PDF_BYTES) {
    return { patch: {}, say: `📄 ${label} — PDF juda katta (10 MB dan ortiq), AI o‘qimaydi. Kartada saqlandi.` };
  }
  const bytes = state.pdfs.reduce((n, p) => n + p.data.length, 0);
  if (state.pdfs.length >= MAX_INTAKE_PDFS || bytes + pdf.data.length > MAX_INTAKE_PDF_BYTES) {
    return {
      patch: {},
      say: `📄 ${label} — bitta so‘rovga ${MAX_INTAKE_PDFS} tadan ortiq PDF o‘qilmaydi. Kartada saqlandi.`,
    };
  }
  const invoice = (state.invoiceGoods ?? []).length;
  return {
    patch: { pdfs: [...state.pdfs, pdf], ...(invoice > 0 ? { aiGoods: 'ask' as const } : {}) },
    say: `📄 ${label} — AI o‘qiydi.` + (invoice > 0 ? otherFilesQuestion(invoice) : ''),
    ...(invoice > 0 ? { keyboard: otherFilesKeyboard() } : {}),
  };
}

/**
 * A spreadsheet with no header the reader knows: its text goes to the model
 * (his 1.2 b) — and the seller is told NOW when the model will not read all
 * of it (round-1 review, a17), rather than the job landing short.
 *
 * Two cuts, both said: the READER's (`sheet.cut` — it stops every file at its
 * own budget, so one oversized file reached this fit already short and passed
 * it whole: «AI o‘qiydi» and nothing more, round-2 review C1/C4/C5), and this
 * fit's, when the files together outgrow what the model reads. Both are ROWS
 * missing. A file whose rows are all there and only some long cells were
 * shortened (`sheet.cellsCut`) is told nothing: «faqat boshini o‘qiydi» about
 * a table the model reads in full was false, and the seller cannot act on it
 * (round-3 review, R3-C2 — the model is told, `sheetsPromptText`).
 */
export function receiveSheetText(state: IntakeState, label: string, sheet: SheetText, fit: SheetFit): FileAnswer {
  const sheetTexts = [...state.sheetTexts, { ...sheet, label }];
  // The new file's place in what the model is shown (`analyzeCollected`):
  // after the separate files before it, ahead of any workbook's other sheets.
  const at = sheetTexts.length - 1;
  const texts = (list: readonly SheetText[]) => list.map((s) => s.text.trim());
  const fitted = fit(texts([...sheetTexts, ...state.invoiceTexts]));
  const kept = fitted.kept[at] ?? 0;
  const total = fitted.total[at] ?? 0;
  const cut =
    kept === 0
      ? '\n⚠️ Bu jadval AI ga sig‘madi (oldingi jadvallar bilan birga juda katta) — VED faylni kartadan o‘qiydi.'
      : sheet.cut
        ? `\n⚠️ Jadval katta: AI faqat boshini o‘qiydi (birinchi ${kept} qator) — qolganini VED fayldan ko‘radi.`
        : kept < total
          ? `\n⚠️ Jadval katta: AI faqat birinchi ${kept} / ${total} qatorini o‘qiydi — qolganini VED fayldan ko‘radi.`
          : '';
  // The budget is SHARED and this file stands ahead of the workbooks' other
  // sheets, so it can push THEIR rows out — the packing list the shipment's
  // totals are read from. The model is told under the sheet; the seller was
  // told nothing (round-4 integration S-d: 192 rows of «A.xlsx» fell to 49).
  const before = fit(texts([...state.sheetTexts, ...state.invoiceTexts]));
  const squeezed = state.invoiceTexts.flatMap((t, j) => {
    const was = before.kept[state.sheetTexts.length + j] ?? 0;
    const now = fitted.kept[sheetTexts.length + j] ?? 0;
    const of = fitted.total[sheetTexts.length + j] ?? 0;
    if (now >= was) return [];
    const whose = t.label ? `${t.label} ning` : 'oldingi Excel faylning';
    return [
      now === 0
        ? `\n⚠️ Shu jadval tufayli ${whose} boshqa varaqlari AI ga sig‘madi — u yerdagi jami (kub/kg) o‘qilmaydi.`
        : `\n⚠️ Shu jadval tufayli AI ${whose} boshqa varaqlaridan endi faqat ${now} / ${of} qatorini o‘qiydi.`,
    ];
  });
  const invoice = (state.invoiceGoods ?? []).length;
  return {
    patch: { sheetTexts, ...(invoice > 0 ? { aiGoods: 'ask' as const } : {}) },
    say:
      `📄 ${label} — jadval sarlavhasini topa olmadim, AI o‘qiydi.` +
      cut +
      squeezed.join('') +
      (invoice > 0 ? otherFilesQuestion(invoice) : ''),
    ...(invoice > 0 ? { keyboard: otherFilesKeyboard() } : {}),
  };
}

/**
 * A spreadsheet the reader MAPPED: its lines are exact (P1.6).
 *
 *  - the first one IS the goods list, and its other sheets ride with it as
 *    `invoiceTexts`; when the model already holds a separate PDF or sheet,
 *    the «boshqa zavod?» question is asked here — the same pair in the
 *    other order (round-1 review, c4);
 *  - a further one is ASKED about (his 1.13 c), and while that question is
 *    open every further file FOLDS into it — a third used to overwrite the
 *    second, whose lines then reached nobody (round-1 review, c1). Its other
 *    sheets wait with it, so a replace can drop them (c7).
 *
 * The goods rows are exact whatever the size; the OTHER sheets' text is what
 * the reader cuts (`textCut`), and that is said too — those sheets are where
 * the shipment's totals are read from (round-2 review, C1). Only when ROWS are
 * missing: shortened cells (`cellsCut`) travel to the model and say nothing
 * here (round-3 review, R3-C2).
 */
export function receiveGoodsSheet(
  state: IntakeState,
  sheet: {
    goods: NonNullable<IntakeState['invoiceGoods']>;
    label: string;
    text: string;
    textCut: boolean;
    cellsCut: boolean;
    where: string;
    /**
     * The reader's ceiling on goods rows, when this file reached it
     * (`MAX_GOODS_ROWS`): a 6,000-line list answered «500 ta tovar o‘qildi»
     * and nothing about the rest (round-4 integration S-b).
     */
    capped?: number;
  },
): FileAnswer {
  const { goods, label, where } = sheet;
  const texts: SheetText[] = sheet.text
    ? [{ text: sheet.text, cut: sheet.textCut, cellsCut: sheet.cellsCut, label }]
    : [];
  const cut =
    (sheet.capped
      ? `\n⚠️ Bitta fayldan ko‘pi bilan ${sheet.capped} ta tovar qatori o‘qiladi — fayl uzunroq bo‘lsa, qolganini VED fayldan ko‘radi.`
      : '') +
    (sheet.text && sheet.textCut
      ? '\n⚠️ Jadval katta: AI boshqa varaqlarning faqat boshini o‘qiydi' +
        // «the goods list was read in full» is false of a capped one.
        (sheet.capped ? '.' : ' (tovarlar ro‘yxati to‘liq olindi).')
      : '');
  const invoice = state.invoiceGoods ?? [];
  if (invoice.length > 0) {
    const waiting = state.pendingInvoice;
    const pending = waiting
      ? {
          goods: [...(waiting.goods ?? []), ...goods],
          label: `${waiting.label}, ${label}`,
          texts: [...waiting.texts, ...texts],
        }
      : { goods, label, texts };
    return {
      patch: { pendingInvoice: pending },
      say:
        `📄 ${label} — ${goods.length} ta tovar${where}.${cut}\n` +
        (waiting ? `Javob kutayotgan fayllar: ${pending.label} — jami ${pending.goods.length} ta tovar.\n` : '') +
        `Oldingi faylda ${invoice.length} ta tovar bor. Nima qilamiz?`,
      keyboard: invoiceChoiceKeyboard(),
    };
  }
  const ask = state.aiGoods === null && (state.pdfs.length > 0 || state.sheetTexts.length > 0);
  return {
    patch: { invoiceGoods: goods, invoiceTexts: texts, ...(ask ? { aiGoods: 'ask' as const } : {}) },
    say: `📄 ${label} — ${goods.length} ta tovar o‘qildi${where}.` + cut + (ask ? otherFilesQuestion(goods.length) : ''),
    ...(ask ? { keyboard: otherFilesKeyboard() } : {}),
  };
}

/**
 * The answer to «a second invoice arrived» (his 1.13 c), as a patch — pure.
 *
 * A collection still waiting for the customer (or the podklyuch door's
 * «qayerdan?») KEEPS waiting: the answer used to move it to 'material', so the
 * open question was never asked again, a code typed next was filed as
 * material, and the job landed as a nameless lead with no road (round-1
 * review, c0). `reask` names the question to ask again. Null = nothing waits:
 * the button is stale.
 */
export function invoiceChoice(
  state: IntakeState,
  step: 'inv_add' | 'inv_replace',
): { patch: Partial<IntakeState>; said: string; reask: 'client' | 'section' | null } | null {
  const pending = state.pendingInvoice;
  if (!pending) return null;
  const add = step === 'inv_add';
  const goods = add ? [...(state.invoiceGoods ?? []), ...(pending.goods ?? [])] : (pending.goods ?? []);
  const reask = state.stage === 'client' || state.stage === 'section' ? state.stage : null;
  return {
    patch: {
      invoiceGoods: goods,
      // The replaced workbook's other sheets leave with its goods (c7).
      invoiceTexts: add ? [...state.invoiceTexts, ...pending.texts] : pending.texts,
      pendingInvoice: null,
      stage: reask ?? 'material',
    },
    said: add
      ? `➕ ${pending.label} qo‘shildi: endi fayllarda ${goods.length} ta tovar.`
      : `🔁 ${pending.label} oldingisining o‘rniga olindi: ${goods.length} ta tovar.`,
    reask,
  };
}

/** The answer to «boshqa zavodning tovarlarimi?» (round-1 review, c4) — pure, like `invoiceChoice`. */
export function otherFilesChoice(
  state: IntakeState,
  step: 'other_add' | 'other_same',
): { patch: Partial<IntakeState>; said: string; reask: 'client' | 'section' | null } | null {
  if (state.aiGoods !== 'ask') return null;
  const reask = state.stage === 'client' || state.stage === 'section' ? state.stage : null;
  return {
    patch: { aiGoods: step === 'other_add' ? 'add' : 'context', stage: reask ?? 'material' },
    said:
      step === 'other_add'
        ? '➕ Boshqa zavod: AI o‘qigan tovarlar Excel ro‘yxatiga qo‘shiladi.'
        : '📄 O‘sha tovarlar: ro‘yxat Excel fayldan olinadi, qolgan fayllardan faqat jami (kub/kg) o‘qiladi.',
    reask,
  };
}

/**
 * What a forwarded file is worth to the calculation, and the one sentence the
 * seller is told about it — every file is ANSWERED (the diagnosis' cause 3:
 * an .xls, a second PDF, a seventh photo, a photo sent as a file were all
 * dropped in silence).
 *
 *  - a PHOTO, or a picture sent as a FILE, is downscaled and shown to the
 *    model — up to `MAX_INTAKE_IMAGES` (his 1.4 b: twelve); a HEIC this
 *    server cannot decode is refused in words;
 *  - a PDF is shown to the model as a document — up to `MAX_INTAKE_PDFS`,
 *    read together;
 *  - a SPREADSHEET is read by `readGoodsFile`: the reader's rows when it finds
 *    the header, the model when it does not (his 1.2 b); a second goods file
 *    is ASKED about (his 1.13 c);
 *  - a DOCX is refused in words — it is a zip like an xlsx and would read as
 *    «no goods».
 *
 * Exported for the test: the reader's `textCut` reaching the collection is a
 * wire through THIS function, and a test of the two pure halves beside it
 * cannot see a wire that drops it (round-2 review, C1 — #531's shape).
 */
export async function readIntakeFile(
  saved: { isPhoto: boolean; body: Buffer },
  fileName: string,
  mime: string | null,
  state: IntakeState,
): Promise<FileAnswer> {
  const label = fileName ? `«${fileName}»` : 'Fayl';
  const kind = intakeFileKind(saved.body, saved.isPhoto, fileName, mime);
  if (kind === 'image' || kind === 'isomedia') {
    // Counted, never silent: the prompt says how many will not be read.
    if (state.images.length >= MAX_INTAKE_IMAGES) return { patch: { imagesSkipped: state.imagesSkipped + 1 }, say: null };
    const reduced = await reduceForModel(saved.body).catch(() => null);
    if (!reduced) {
      return {
        patch: { imagesSkipped: state.imagesSkipped + 1 },
        say:
          kind === 'isomedia'
            ? `📷 ${label} — HEIC rasm, o‘qib bo‘lmaydi. JPG yoki skrinshot qilib yuboring.`
            : `📷 ${label} — rasmni o‘qib bo‘lmadi (buzilgan yoki juda katta).`,
      };
    }
    return {
      patch: { images: [...state.images, { data: reduced, mediaType: 'image/jpeg' }] },
      say: saved.isPhoto ? null : `🖼 ${label} — rasm sifatida o‘qiladi.`,
    };
  }
  if (kind === 'pdf') return receivePdf(state, { data: saved.body, name: fileName || 'invoice.pdf' }, label);
  if (kind === 'docx') return { patch: {}, say: `📄 ${label} — Word fayl o‘qilmaydi. PDF yoki Excel qilib yuboring.` };
  if (kind === 'video') return { patch: {}, say: `🎬 ${label} — video o‘qilmaydi. Rasm yoki matn yuboring.` };
  if (kind === 'archive') {
    return { patch: {}, say: `🗜 ${label} — arxiv o‘qilmaydi. Ichidagi fayllarni alohida yuboring.` };
  }

  const { readGoodsFile, SHEET_TEXT_BUDGET } = await import('../../wms/deals/goods-file');
  const sheet = await readGoodsFile(saved.body, mime).catch((err: unknown) => {
    logger.warn({ err }, '[calc-intake] spreadsheet unreadable');
    return { kind: 'refused', reason: 'broken' } as const;
  });
  if (!sheet) {
    return { patch: {}, say: `📎 ${label} kartada saqlandi, lekin o‘qilmaydi: faqat rasm, PDF va Excel/CSV o‘qiladi.` };
  }
  if (sheet.kind === 'refused') return { patch: {}, say: SHEET_REFUSAL[sheet.reason](label) };
  // The reader's own two words travel with the text (round-2 review,
  // C1/C4/C5; round-3, R3-C2): `textCut` = rows are missing — the seller and
  // the model are told; `cellsCut` = every row is there, some cells shortened
  // — the model is told, the seller nothing.
  if (sheet.kind === 'text') {
    const { fitSheetRows } = await import('../../wms/calc/intake-ai');
    return receiveSheetText(state, label, { text: sheet.text, cut: sheet.textCut, cellsCut: sheet.cellsCut }, (texts) =>
      fitSheetRows(texts, SHEET_TEXT_BUDGET),
    );
  }
  // Everything the file states reaches the landing (2026-10-09, P1.6) —
  // through the one mapping the landing's own test reads.
  const { invoiceFacts } = await import('../../wms/calc/intake');
  const { MAX_GOODS_ROWS } = await import('../../wms/deals/goods-import');
  const where = sheet.sheets > 1 ? ` («${sheet.sheet}» varag‘idan; boshqa varaqlarni AI o‘qiydi)` : '';
  return receiveGoodsSheet(state, {
    goods: invoiceFacts(sheet.goods),
    label,
    text: sheet.text,
    textCut: sheet.textCut,
    cellsCut: sheet.cellsCut,
    where,
    // The reader stops at its ceiling and says nothing; reaching it is the
    // one sign the file may hold more (round-4 integration S-b).
    ...(sheet.goods.length >= MAX_GOODS_ROWS ? { capped: MAX_GOODS_ROWS } : {}),
  });
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
    state.pdfs.length ? `📄 ${state.pdfs.length} ta PDF o‘qiladi` : '',
    (state.invoiceGoods ?? []).length ? `📊 fayldan ${(state.invoiceGoods ?? []).length} ta tovar` : '',
    state.imagesSkipped
      ? `⚠️ ${state.imagesSkipped} ta rasm o‘qilmaydi${state.images.length >= MAX_INTAKE_IMAGES ? ` (${MAX_INTAKE_IMAGES} tadan ortig‘i)` : ''}`
      : '',
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
export async function handleCalcCallback(
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
    // A «Saqlash» redelivered after a restart lands here too: never «type it
    // by hand» about a job that may already be on its card (judge conc-13).
    await ctx.reply('Bu so‘rov yopilgan — saqlangan bo‘lsa, kartada turibdi. Yangisini «🧮 Hisoblatish» tugmasidan boshlang.');
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
    // Only the question that is OPEN, like `pick_N` (round-1 review, c5): a ⏭
    // under an old question used to run the next-or-confirm step from the
    // facts as they stood — so material sent since, or a collection not yet
    // read at all, reached 'review' with no analysis, and the confirm guard
    // below («only what the seller was SHOWN») trusted that stage.
    if (state.stage !== 'question' || state.analysing) {
      await ctx.reply('Bu tugma eskirgan.');
      return;
    }
    // The skipped line is DONE for this collection — never asked again, not
    // even after «➕ Yana ma'lumot» re-reads the material (P1.3).
    const skipped =
      state.stage === 'question' && state.askingIndex !== null && state.askingTotalsFor === null
        ? doneLine(state.facts.goods, state.askingIndex)
        : null;
    const lineDone = skipped ? [...state.lineDone, skipped] : state.lineDone;
    await askNextOrConfirm(ctx, chatId, { ...state, lineDone, reasked: false, offers: [] });
    return;
  }

  if (step.startsWith('pick_')) {
    // A button under a bare or ambiguous figure (judge UX4). Only the
    // pending question's own offers can be picked: a press from an older
    // message, or after the line moved on, finds nothing and says so.
    const offer = state.offers[Number(step.slice('pick_'.length))];
    if (state.stage !== 'question' || state.askingIndex === null || state.askingTotalsFor !== null || !offer) {
      await ctx.reply('Bu tugma eskirgan.');
      return;
    }
    const { needFigure } = await import('../../wms/calc/intake');
    await applyLinePatch(ctx, chatId, state, state.askingIndex, needFigure(offer.unit, offer.value));
    return;
  }

  if (step === 'inv_add' || step === 'inv_replace' || step === 'other_add' || step === 'other_same') {
    // His 1.13 c: the second invoice waits for this answer — and, beside an
    // Excel list, a file the AI reads waits for «boshqa zavodmi?» (c4).
    const choice =
      step === 'inv_add' || step === 'inv_replace' ? invoiceChoice(state, step) : otherFilesChoice(state, step);
    if (!choice) {
      await ctx.reply('Bu tugma eskirgan.');
      return;
    }
    const next = updateIntake(chatId, choice.patch);
    await ctx.reply(choice.said);
    // The question the collection is still waiting on is asked again — the
    // file handler's own words (round-1 review, c0).
    if (choice.reask === 'section') {
      await ctx.reply('Avval yuk qayerdan chiqishini tanlang:', { reply_markup: zoneKeyboard(await pricedZonesNow()) });
      return;
    }
    if (choice.reask === 'client') {
      await ctx.reply(CLIENT_QUESTION, { parse_mode: 'Markdown' });
      return;
    }
    if (next) await showIntakePrompt(ctx as Parameters<typeof showIntakePrompt>[0], chatId, next);
    return;
  }

  if (step === 'more') {
    updateIntake(chatId, { stage: 'material' });
    await ctx.reply('Yana ma’lumot yuboring, tugagach «Bo‘ldi» ni bosing.', {
      reply_markup: doneKeyboard,
    });
    return;
  }

  if (step === 'done' || step === 'reread') {
    // One analysis at a time: a second press used to start a second paid
    // call whose result overwrote the first (cause 7).
    if (state.analysing) {
      await ctx.reply('⏳ Tahlil davom etmoqda — natijani kuting.');
      return;
    }
    if (state.stage === 'client' || state.stage === 'section') {
      await ctx.reply(
        state.stage === 'client' ? CLIENT_QUESTION : 'Avval yuk qayerdan chiqishini tanlang.',
        state.stage === 'client' ? { parse_mode: 'Markdown' } : { reply_markup: zoneKeyboard(await pricedZonesNow()) },
      );
      return;
    }
    if (state.pendingInvoice) {
      await ctx.reply('Avval ikkinchi fayl haqida javob bering:', { reply_markup: invoiceChoiceKeyboard() });
      return;
    }
    if (state.aiGoods === 'ask') {
      await ctx.reply('Avval javob bering: AI o‘qiydigan fayl — boshqa zavodning tovarlarimi?', {
        reply_markup: otherFilesKeyboard(),
      });
      return;
    }
    if (state.material.length === 0 && state.fileCount === 0) {
      await ctx.reply('Hali hech narsa yuborilmadi.');
      return;
    }
    const token = randomUUID();
    const owned = updateIntake(chatId, { analysing: token }) ?? state;
    // The notice must not decide whether the analysis runs (round-1 review,
    // c3): the token is already written, only the analysis releases it, and
    // a refused notice — a 429 past `briefRetry`'s five seconds, a blip to
    // api.telegram.org — used to throw before the dispatch, leaving every
    // later «Bo'ldi» and «Tasdiqlash» answering «Tahlil davom etmoqda» for an
    // analysis that never started, until the seller threw the collection away.
    await ctx.reply('⏳ AI o‘qiyapti… (3 daqiqagacha)').catch((err: unknown) =>
      logger.warn({ err }, '[calc-intake] analysing notice not sent'),
    );
    // OFF the middleware chain, exactly like the assistant's answer (#706):
    // grammy's poller is sequential and the same bot serves every customer,
    // so awaiting an Opus call over twenty thousand characters here freezes
    // every cabinet tap, every /start and every «yukingiz keldi» until it
    // returns.
    void analyseIntakeAndReply(ctx, chatId, owned, token);
    return;
  }

  // save — only what the seller was SHOWN. An old «Tasdiqlash» pressed
  // after «➕ Yana ma'lumot», or while the analysis runs, used to land facts
  // that never included the newest material.
  if (state.analysing) {
    await ctx.reply('⏳ Tahlil davom etmoqda — natijani kuting.');
    return;
  }
  // A reading the seller was shown is 'review', or 'question' while a line is
  // asked about; anything else holds material nobody has read yet.
  if (state.stage !== 'review' && state.stage !== 'question') {
    await ctx.reply('Yangi ma’lumot hali o‘qilmagan — avval «Bo‘ldi» ni bosing.', { reply_markup: doneKeyboard });
    return;
  }
  const staff = await staffForChat(chatId);
  if (!staff) {
    await ctx.reply('Ulanmagan.');
    return;
  }
  // A coded client's card is refused BEFORE it is minted when the queue
  // would refuse the job (`calcOpenRefusal`): the code travels back so the
  // person reads WHY, and nothing was written.
  let refused: string | null = null;
  const target = await landCollectedIntake(chatId, staff.id, staff.fullName).catch(
    (err: unknown) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && code in QUEUE_REFUSAL) {
        refused = code;
        return null;
      }
      logger.error({ err }, 'calc intake landing failed');
      return null;
    },
  );
  if (!target) {
    if (refused) {
      // A job too big for the queue never fits; twenty open requests clear
      // when the VED answers, so that collection waits for the next press.
      if (refused === 'too_many_items' || refused === 'note_taken') endIntake(chatId);
      await ctx.reply(`⚠️ Saqlanmadi: ${queueRefusal(refused)}`, { reply_markup: await replyKeyboardFor(chatId) });
      return;
    }
    // The card and its note are one commit and a retry finds them through the
    // note, so pressing again finishes the SAME card (judge conc-1).
    await ctx.reply('Saqlab bo‘lmadi — «Saqlash»ni qayta bosing.');
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
  // A section with no customs half is answered from the tariff table on its
  // own fast queue (judge concurrency-8): that reply can land ABOVE this
  // message, so the sentence says it comes separately — true in either order
  // — rather than «VED javob beradi» under a figure already in the chat.
  const { sectionParts } = await import('../../wms/calc/pricing');
  const tariffFollows = target.replyQueued === true && !sectionParts(state.section).customs;
  await ctx.reply(
    `✅ Saqlandi — ${landedWords(target)}\n` +
      (link ? `${link}\n` : '') +
      '\n' +
      // Honest about which half landed: the material is on the card either
      // way, but only a queued request will be calculated by anybody.
      (target.queued
        ? tariffFollows
          ? TARIFF_FOLLOWS
          : '🧮 Hisoblash navbatiga tushdi — VED xodimi javob beradi.'
        : `⚠️ Hisoblash navbatiga tushmadi: ${queueRefusal(target.queueError)}`),
    // Re-derived, not named (round 100, 13A): naming staffKeyboard() here
    // took the cabinet buttons off a both-chat's phone.
    { reply_markup: await replyKeyboardFor(chatId) },
  );
}

/** The ✅'s queue line when the tariff reply is on its way (judge concurrency-8). */
export const TARIFF_FOLLOWS =
  '🧮 Hisoblash navbatiga tushdi — tarif bo‘yicha javob alohida xabarda keladi, rasmiy narxni VED beradi.';

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
  lead_closed: 'lid yopilgan — unga yangi hisob-kitob qo‘shilmaydi; yutilgan bo‘lsa, uning bitimidan yuboring.',
  unauthenticated: 'siz tizimda emassiz.',
  server_behind: 'server yangilanmoqda — biroz keyinroq urinib ko‘ring.',
};

function queueRefusal(code: string | null | undefined): string {
  return (code && QUEUE_REFUSAL[code]) ?? 'kartadan qo‘lda yuboring.';
}

/**
 * What the landing DID, in words (judge product-16): «yangi» only for a card
 * that was minted — a joined lead, the client's empty deal taken over and a
 * retried press's earlier card each say so. Exported for the unit test.
 */
export function landedWords(target: {
  kind: 'deal' | 'lead';
  label: string;
  outcome?: string;
  about?: { clientCode: string; sellerName: string | null } | null;
}): string {
  const card = target.kind === 'deal' ? 'bitim' : 'lid';
  switch (target.outcome) {
    case 'deal':
      return `yangi bitim: ${target.label}`;
    case 'adopted':
      return `bitim: ${target.label} (mijozning bo‘sh bitimiga yozildi)`;
    case 'about':
      return `yangi lid: ${target.label} (${target.about?.clientCode ?? '—'} — ${target.about?.sellerName ? `${target.about.sellerName}ning mijozi` : 'sotuvchisi yo‘q'})`;
    case 'about_joined':
      return `lid: ${target.label} (shu mijoz haqidagi lidingizga qo‘shildi)`;
    case 'lead':
      return `yangi lid: ${target.label}`;
    case 'lead_joined':
      return `lid: ${target.label} (shu raqamdagi lidga qo‘shildi)`;
    case 'retried':
      return `oldingi urinishda ochilgan ${card}: ${target.label}`;
    default:
      return `${card}: ${target.label}`;
  }
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
