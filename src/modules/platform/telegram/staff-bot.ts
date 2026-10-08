import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { telegramLinks, users } from '../db/schema';
import { writeAudit } from '../audit/service';
import { actorGrants, userPermissions } from '../rbac/authorize';
import {
  acceptTask,
  answerAboutTask,
  askAboutTask,
  bindingsOf,
  byId as taskById,
  canActOnTask,
  cancelTask,
  completeTask,
  createTask,
  cutOnWord,
  forwardSourcesAgain,
  givenTasks,
  MAX_TASK_SOURCES,
  queueTaskSources,
  remindTask,
  rescheduleTask,
  TaskError,
  type TaskContext,
  type GivenTask,
  type TaskErrorCode,
  type TaskRow,
  telegramDue,
} from '../tasks/service';
import { reachOf, type Reach } from '../notifications/staff';
import type { DraftFile } from './task-draft';
import { DAY_BUTTONS } from '../tasks/digest';
import { logger } from '../logger';
import { approvalVerdictLine, notificationLabels, textLocaleOf } from '../notifications/labels';
import {
  appendLine,
  capStaffText,
  keyboardOf,
  staffTextHtml,
  urlRowsOf,
  withoutCallback,
} from '../notifications/staff-html';
import { allLabelVariants } from './client-labels';
import { buttonLabel } from './limits';
import { editMarkup, editText } from './send';

import { canLogInSql, staffPhonesMatch } from '../users/login';
import { THREAD_PING_TYPES, threadOfPayload } from '../notifications/thread-ref';

/**
 * The cabinet's phone rule (digits only, the last 9) lives in users/login.ts
 * since 0120, so the conversion door can ask the bot's own rule without
 * importing the bot; re-exported here for the bot's existing readers.
 */
export { staffPhonesMatch } from '../users/login';

/**
 * The STAFF side of the bot (owner's round: «endi telegram botni mukammal
 * qilishimiz kerak hodimlar ishlashi uchun»).
 *
 * Everything the bot DECIDES lives here and is integration-tested; the
 * grammy handlers in bot.ts are a thin shell that cannot be exercised
 * without a live Telegram (same split as the tg-import/listener scripts).
 *
 * One bot serves both audiences: a chat linked in `telegram_links` is a
 * member of staff, a chat in `client_telegram_links` is a customer, and an
 * unknown chat is offered the two doors («Hodim» / «Mijoz») — his answer 4:
 * the client door opens the existing cabinet, nothing more.
 */

export interface StaffChat {
  id: string;
  fullName: string;
  locale: string | null;
}

/** The staff member behind a chat — linked and a colleague now (`canLogIn`), or nobody. */
export async function staffForChat(chatId: bigint): Promise<StaffChat | null> {
  const [row] = await db
    .select({ id: users.id, fullName: users.fullName, locale: users.locale, live: canLogInSql() })
    .from(telegramLinks)
    .innerJoin(users, eq(telegramLinks.userId, users.id))
    .where(and(eq(telegramLinks.telegramChatId, chatId), eq(telegramLinks.status, 'linked')))
    .limit(1);
  if (!row || !row.live) return null;
  return { id: row.id, fullName: row.fullName, locale: row.locale };
}

/**
 * The staff member a Telegram-shared phone belongs to — a colleague NOW
 * (`canLogIn`: active AND a login; a payroll-only person's phone is the
 * accountant's note, never a key to the staff bot). The contact button shares
 * the sender's OWN verified number (the cabinet's spoof-proof rule), so
 * matching it against the login phone is the same trust the client link
 * already runs on.
 */
export async function staffByPhone(phone: string): Promise<StaffChat | null> {
  const rows = await db
    .select({ id: users.id, fullName: users.fullName, locale: users.locale, phone: users.phone })
    .from(users)
    .where(canLogInSql());
  const hit = rows.find((u) => u.phone !== null && staffPhonesMatch(phone, u.phone));
  return hit ? { id: hit.id, fullName: hit.fullName, locale: hit.locale } : null;
}

/**
 * Bind a chat to a staff member. Refuses a chat that already belongs to a
 * DIFFERENT colleague — two people cannot share one Telegram, and silently
 * re-pointing the row would move every future notification.
 */
/**
 * Mint a fresh one-time code for the profile's «ulash» / «qayta ulash» button.
 *
 * The rule, and it is the whole reason this is a function rather than three
 * lines in the action: a row that is ALREADY `linked` keeps its status and its
 * chat id. Flipping it to `pending` is what the obvious version does, and it
 * is a notification OUTAGE — every reader demands `status = 'linked'`, so from
 * the press until the person opens Telegram they are not a staff chat at all:
 * `staffForChat` answers null, the drain settles every queued notification
 * terminally `muted / telegram not linked`, and `muted` is excluded from
 * `notificationProblemCount`, so nothing on any screen ever says it happened.
 * Abandon the press and you are off Telegram for ever.
 *
 * Leaving the row alone costs nothing: `/start <code>` looks a code up by
 * `link_code` and refuses only a `revoked` row, so a code on a live link
 * redeems and `linkStaffChat` moves the chat — the old phone keeps working
 * right up to the moment the new one takes over, and then it is told.
 */
export async function mintTelegramLinkCode(userId: string): Promise<string> {
  const code = randomBytes(12).toString('base64url');
  const existing = await db.query.telegramLinks.findFirst({
    where: eq(telegramLinks.userId, userId),
  });
  if (existing?.status === 'linked') {
    await db.update(telegramLinks).set({ linkCode: code }).where(eq(telegramLinks.id, existing.id));
    return code;
  }
  await db
    .insert(telegramLinks)
    .values({ userId, linkCode: code, status: 'pending' })
    .onConflictDoUpdate({
      target: telegramLinks.userId,
      set: { linkCode: code, status: 'pending' },
    });
  return code;
}

export interface StaffLinkResult {
  outcome: 'linked' | 'chat_taken';
  /**
   * The chat this person was on BEFORE, when the link MOVED.
   *
   * The old phone keeps a staff keyboard whose buttons now fall through to the
   * cabinet and answer nothing — a working-looking bot that does nothing is
   * the shape rounds 89 and 97 were spent removing — so the caller, which is
   * the only layer holding a Telegram connection, tells it once.
   */
  previousChatId: bigint | null;
}

export async function linkStaffChat(
  userId: string,
  chatId: bigint,
  via: 'phone' | 'link_code' = 'phone',
): Promise<StaffLinkResult> {
  const holder = await db.query.telegramLinks.findFirst({
    where: eq(telegramLinks.telegramChatId, chatId),
  });
  if (holder && holder.userId !== userId) {
    return { outcome: 'chat_taken', previousChatId: null };
  }

  const own = await db.query.telegramLinks.findFirst({
    where: eq(telegramLinks.userId, userId),
  });
  const previousChatId =
    own?.telegramChatId && own.telegramChatId !== chatId ? own.telegramChatId : null;
  if (own) {
    await db
      .update(telegramLinks)
      .set({ telegramChatId: chatId, status: 'linked', linkedAt: new Date(), linkCode: null })
      .where(eq(telegramLinks.id, own.id));
  } else {
    await db
      .insert(telegramLinks)
      .values({ userId, telegramChatId: chatId, status: 'linked', linkedAt: new Date() });
  }
  await writeAudit(db, { actorId: userId }, {
    entityType: 'user',
    entityId: userId,
    action: 'update',
    // Which door it came through, because the history screen used to print
    // «linked_by_phone» for a link that arrived from the web's deep link.
    after: { telegram: via === 'phone' ? 'linked_by_phone' : 'linked_by_code' },
  });
  return { outcome: 'linked', previousChatId };
}

// ---------------------------------------------------------------------------
// The staff keyboard's labels, and the one predicate that says which of them
// must ESCAPE a live «Hisoblatish» collection.
// ---------------------------------------------------------------------------

export const BUGUN = '📋 Bugun';
export const HISOBLATISH = '🧮 Hisoblatish';
/**
 * The owner's own words, 2026-09-05: «telegramda AI ning o'zi tahminiy
 * hisoblab bersin rastamojka qancha bo'lishini».
 */
export const AI_RASTAMOJKA = '🤖 AI rastamojka';
/**
 * «zametkalarni qoyamiz … tanlaganda bot qayta jonatb berishi kerak» — the
 * library of things the office sends the same customers over and over.
 */
export const ZAMETKALAR = '📌 Zametkalar';
/** The advert lead's one button (0113) — named once, for the push and its tests. */
export const LEAD_CONTACTED_BUTTON = '📞 Bog‘landim';

/** The thread ping's one button (0127) — arms a one-text reply wait. */
export const THREAD_REPLY_BUTTON = '💬 Javob yozish';
/** The VED's bound «Hisoblash: …» task copy: a question to the seller, under that calculation (E3 a). */
export const ASK_SELLER_BUTTON = '❓ Sotuvchidan so‘rash';
/**
 * The owner's evening summary, on demand (his 7a: «har kuni 20:00 faqat
 * sizga»). Drawn only for the person the summary is for — `holatFor` — and
 * re-asked on every press, because a keyboard outlives the grant it was
 * drawn for.
 */
export const HOLAT = '📊 Holat';
/**
 * «hodimlar biriga ish buyura olishi kerak telegram orqali» (2026-10-06, his
 * 1b): the draft's own door. A LABEL is a router — never renamed, only moved.
 */
export const TOPSHIRIQ = '➕ Topshiriq';
/** His 5a: the open tasks this person gave by hand, with «🔔 Eslatish». */
export const MEN_BERGAN = '📤 Men bergan';

/** The two labels that open a collection — one list, so every reader agrees. */
export const CALC_ENTRY_LABELS = [HISOBLATISH, AI_RASTAMOJKA];

/**
 * Text that must NOT be filed as collection material.
 *
 * A live collection swallows every message, which is what makes forwarding a
 * packing list work — and it swallowed the buttons on the keyboard the seller
 * is looking at, so pressing one mid-collection answered with silence. The
 * exemption used to be two inline conditions in the handler; it is a NAMED
 * predicate here so the next button joins it in one edit instead of being
 * forgotten, and so a test can assert each escape by BEHAVIOUR rather than by
 * matching an expression that has to be rewritten every time.
 */
export function escapesIntake(text: string): boolean {
  const t = text.trim();
  return (
    CALC_ENTRY_LABELS.includes(t) ||
    t === BUGUN ||
    t === '/bugun' ||
    t === ZAMETKALAR ||
    t === '/zametka' ||
    t === HOLAT ||
    t === '/holat' ||
    t === TOPSHIRIQ ||
    t === '/topshiriq' ||
    t === MEN_BERGAN ||
    t === '/berganlarim' ||
    // A chat that is both staff and client pressing «📦 Yuklarim» in the middle
    // of a collection had it filed as intake material (round C's scouts).
    isCabinetText(t)
  );
}

// ---------------------------------------------------------------------------
// Callback data — kept tiny (Telegram caps callback_data at 64 bytes).
// ---------------------------------------------------------------------------

/**
 * Is this text one of the CLIENT cabinet's buttons, in any language?
 *
 * The cabinet's button labels ARE its router (#264), and a chat that is both
 * staff and client (round 100, 13A) used to type them into the staff
 * catch-all, which answered «Topilmadi» and starved the cabinet for ever.
 * The match derives from the same dictionary as the keyboard, so a new
 * language joins both sides in one edit.
 */
export function isCabinetText(text: string): boolean {
  const wanted = text.trim();
  return (['btnCargo', 'btnBalance', 'btnHistory', 'btnLanguage', 'btnManager'] as const).some((key) =>
    allLabelVariants(key).includes(wanted),
  );
}

/**
 * Which menu /start owes this chat — decided in one testable place (round
 * 100, 13A). 'both' is the owner's own people who also ship cargo: reply
 * keyboards are exclusive in Telegram, so the only way both jobs stay on the
 * phone is ONE merged keyboard.
 */
export function startMenuFor(
  staff: StaffChat | null,
  clientCount: number,
): 'staff' | 'cabinet' | 'both' | 'entry' {
  if (staff && clientCount > 0) return 'both';
  if (staff) return 'staff';
  if (clientCount > 0) return 'cabinet';
  return 'entry';
}

export type BotCallback =
  /**
   * `list` — pressed on a LIST of tasks («📋 Bugun», the morning digest),
   * whose message stays and only loses that task's row; without it the
   * button was the single task's own message, which is closed whole.
   */
  | { kind: 'task_done'; taskId: string; list?: true }
  | { kind: 'approval'; approvalId: string; verdict: 'approved' | 'refused' }
  | { kind: 'entry'; who: 'staff' | 'client' }
  | { kind: 'calc'; step: CalcStep }
  | { kind: 'note'; step: NoteStep; noteId?: string; page?: number }
  /** «📞 Bog'landim» under an advert lead's push (0113). */
  | { kind: 'lead_contacted'; leadId: string }
  /**
   * ✅/❌ on a calc↔prixod guess (0119). `requestTag` is the LAST 8 hex of
   * the request the message named (`linkAskTag`), so a press can never land
   * on a calculation the message did not show.
   */
  | { kind: 'calc_link'; receiptId: string; requestTag: string; verdict: 'confirm' | 'drop' }
  /*
   * The topshiriq round (docs/TELEGRAM-TOPSHIRIQ.md §4). Every kind carrying
   * a task id is anchored on its uuid like `t:`/`tb:` — an unanchored prefix
   * swallows look-alikes (review telegram-mechanics-25).
   */
  /** «👀 Qabul qildim» — `tk:<task>`. */
  | { kind: 'task_accept'; taskId: string }
  /** «⏰ Muddatni surish» — `tw:<task>`, which offers the choices below. */
  | { kind: 'task_wait'; taskId: string }
  /** A choice under ⏰ — `tp:<e|i|w|s>:<task>`: ertaga, indinga, 1 hafta, sana. */
  | { kind: 'task_postpone'; taskId: string; to: PostponeStep }
  /** «💬 Savol» — `tq:<task>`. */
  | { kind: 'task_question'; taskId: string }
  /** «💬 Javob berish», on the author's copy of a question — `tr:<task>`. */
  | { kind: 'task_reply'; taskId: string }
  /** «✅ Natijasiz», on the «write the result» prompt — `tn:<task>`. */
  | { kind: 'task_noresult'; taskId: string }
  /** «🔔 Eslatish», under «📤 Men bergan» — `te:<task>`. */
  | { kind: 'task_remind'; taskId: string }
  /** «🗑 Bekor qilish», under a task the author just made — `tc:<task>`. */
  | { kind: 'task_cancel'; taskId: string }
  /** «📤 Manbani yangi odamga yuborish», the author's after a reassign — `tf:<task>`. */
  | { kind: 'task_sources'; taskId: string }
  /** The draft's own controls — a CLOSED vocabulary, `d:<step>`. */
  | { kind: 'draft'; step: DraftStep }
  /** A colleague picked in «Kimga?» — `dk:<user>`. */
  | { kind: 'draft_pick'; userId: string }
  /** «📌 Topshiriq qilamizmi?» under a forwarded message — `fb:<task|search>`. */
  | { kind: 'forward'; step: ForwardStep }
  /**
   * «💬 Javob yozish» under a thread ping, «❓ Sotuvchidan so‘rash» under the
   * VED's bound calc task (the owner's E answers) — `jy`, carrying NO id: the
   * press resolves its OWN pressed message through the reply door, the same
   * resolver a swipe-reply uses, so nothing can be forged and a deploy between
   * the send and the press loses nothing.
   */
  | { kind: 'thread_reply' };

/** ⏰'s four answers. */
export const POSTPONE_STEPS = ['e', 'i', 'w', 's'] as const;
export type PostponeStep = (typeof POSTPONE_STEPS)[number];

/**
 * The draft's controls: the five due buttons (Bugun, Ertaga, Indinga,
 * Muddatsiz, Sana yozish), «🙋 O'zimga» and «🗑 Bekor qilish». Closed and
 * checked after the regex, like CALC_STEPS.
 */
export const DRAFT_STEPS = ['due_b', 'due_e', 'due_i', 'due_n', 'due_s', 'self', 'cancel'] as const;
export type DraftStep = (typeof DRAFT_STEPS)[number];

export const FORWARD_STEPS = ['task', 'search'] as const;
export type ForwardStep = (typeof FORWARD_STEPS)[number];

/** The uuid-bearing task callbacks: prefix → kind. One table, read by the parser. */
const TASK_PREFIXES = {
  tk: 'task_accept',
  tw: 'task_wait',
  tq: 'task_question',
  tr: 'task_reply',
  tn: 'task_noresult',
  te: 'task_remind',
  tc: 'task_cancel',
  tf: 'task_sources',
} as const;

/**
 * The zametka buttons. `send` is a note id; the rest are the capture's own
 * controls and the list's paging. Every one of them has to be parseable HERE:
 * `parseCallback` is the one door, an unrecognised value falls through to the
 * cabinet's two regexes, matches neither, and then NOBODY calls
 * `answerCallbackQuery` — the button simply spins on the phone for fifteen
 * seconds with no error anywhere.
 */
export type NoteStep = 'send' | 'new' | 'save' | 'cancel' | 'share' | 'page';

/**
 * `go_*` are the RESTART confirmations: a section pressed while a collection
 * is live asks first and only then discards (sub-round C). `cert` flips the
 * certificate answer, `ai` opens the AI-rastamojka door, `skip` moves past a
 * follow-up question the seller cannot answer.
 */
const CALC_STEPS = [
  'yolkira',
  'rastamojka',
  'podklyuch',
  'ai',
  'go_yolkira',
  'go_rastamojka',
  'go_podklyuch',
  'go_ai',
  // Item 13: the AI door asks rastamojka or podklyuch, and a podklyuch job
  // asks where the road starts — the tariff's two zones, as buttons.
  'aipk',
  'go_aipk',
  'zone_cn',
  'zone_kashgar',
  // The Horgos round (2026-09-29): a third zone, drawn only once he has
  // priced it (`zoneKeyboard`), refused in words if an old button is pressed.
  'zone_horgos',
  'cert',
  'skip',
  'done',
  'save',
  'more',
  'cancel',
] as const;

export type CalcStep = (typeof CALC_STEPS)[number];

/** The podklyuch door's «Yuk qayerdan chiqadi?» answers — one per zone the bot can name. */
export type ZoneStep = Extract<CalcStep, `zone_${string}`>;

/**
 * Each zone button: the tariff zone it lands on the request, the road it
 * writes onto the collection, and its label. His two seeded zones plus
 * «horgos», which HE prices on /admin/tarif (answer 22: «uni sistemadan men
 * ozim kirita olamanku») — the button appears once a price exists, never
 * before, because an unpriced zone is silently dropped at landing
 * (`requestCalc`) and the seller would be told «zona tanlanmagan» after
 * choosing one. Yiwu/Guangzhou cargo stays «cn» whichever border its truck
 * takes (his 21a); «horgos» is cargo whose road STARTS at Horgos (15c).
 */
export const AI_ZONE_ROUTES: Record<
  ZoneStep,
  { zone: string; fromCity: string; toCity: string; label: string }
> = {
  zone_cn: {
    zone: 'cn',
    fromCity: 'Xitoy (Yiwu/Guangzhou)',
    toCity: 'O‘zbekiston',
    label: '🇨🇳 Xitoydan (Yiwu, Guangzhou…) → O‘zbekiston',
  },
  zone_kashgar: {
    zone: 'kashgar',
    fromCity: 'Qashg‘ar',
    toCity: 'O‘zbekiston',
    label: '🏔 Qashg‘ardan → O‘zbekiston',
  },
  zone_horgos: {
    zone: 'horgos',
    fromCity: 'Horgos',
    toCity: 'O‘zbekiston',
    label: '📦 Horgos skladidan → O‘zbekiston',
  },
};

/** A pressed step IS a zone button — `hasOwn`, so `toString` is not one. */
export function isZoneStep(step: string): step is ZoneStep {
  return Object.hasOwn(AI_ZONE_ROUTES, step);
}

/**
 * A zone button pressed: the road to write, or the sentence that refuses it.
 * The keyboard draws only priced zones, but a button is a message that
 * outlives the tariff it was drawn from — a price deleted since is refused
 * here, in words, before anything is written (the landing's silent drop
 * stays as the last guard).
 */
export function zonePressAnswer(
  step: ZoneStep,
  priced: readonly string[],
): { ok: true; route: { zone: string; fromCity: string; toCity: string } } | { ok: false; text: string } {
  const r = AI_ZONE_ROUTES[step];
  if (!priced.includes(r.zone)) {
    return { ok: false, text: 'Bu yo‘nalish narxi hali kiritilmagan — boshqasini tanlang yoki bekor qiling.' };
  }
  return { ok: true, route: { zone: r.zone, fromCity: r.fromCity, toCity: r.toCity } };
}

export function parseCallback(data: string): BotCallback | null {
  if (data === 'e:s') return { kind: 'entry', who: 'staff' };
  // The thread reply (0127). Collides with none: `mg` stays the cabinet's.
  if (data === 'jy') return { kind: 'thread_reply' };
  if (data === 'e:c') return { kind: 'entry', who: 'client' };
  const calc = /^c:(\w+)$/.exec(data);
  if (calc && (CALC_STEPS as readonly string[]).includes(calc[1]!)) {
    return { kind: 'calc', step: calc[1] as (typeof CALC_STEPS)[number] };
  }
  const note = /^n:(new|save|cancel|share)$/.exec(data);
  if (note) return { kind: 'note', step: note[1] as NoteStep };
  const notePage = /^n:p(\d{1,3})$/.exec(data);
  if (notePage) return { kind: 'note', step: 'page', page: Number(notePage[1]) };
  const noteSend = /^n:([0-9a-f-]{36})$/.exec(data);
  if (noteSend) return { kind: 'note', step: 'send', noteId: noteSend[1]! };
  const task = /^t:([0-9a-f-]{36})$/.exec(data);
  if (task) return { kind: 'task_done', taskId: task[1]! };
  // Round C: the same «Bajarildi», pressed on a list of the day's tasks.
  const listed = /^tb:([0-9a-f-]{36})$/.exec(data);
  if (listed) return { kind: 'task_done', taskId: listed[1]!, list: true };
  // The topshiriq round's task buttons — two letters and the task's uuid.
  const taskButton = /^(t[a-z]):([0-9a-f-]{36})$/.exec(data);
  if (taskButton && Object.hasOwn(TASK_PREFIXES, taskButton[1]!)) {
    const kind = TASK_PREFIXES[taskButton[1] as keyof typeof TASK_PREFIXES];
    return { kind, taskId: taskButton[2]! };
  }
  const postpone = /^tp:([a-z]):([0-9a-f-]{36})$/.exec(data);
  if (postpone && (POSTPONE_STEPS as readonly string[]).includes(postpone[1]!)) {
    return { kind: 'task_postpone', to: postpone[1] as PostponeStep, taskId: postpone[2]! };
  }
  const draft = /^d:(\w+)$/.exec(data);
  if (draft && (DRAFT_STEPS as readonly string[]).includes(draft[1]!)) {
    return { kind: 'draft', step: draft[1] as DraftStep };
  }
  const pick = /^dk:([0-9a-f-]{36})$/.exec(data);
  if (pick) return { kind: 'draft_pick', userId: pick[1]! };
  const forward = /^fb:(\w+)$/.exec(data);
  if (forward && (FORWARD_STEPS as readonly string[]).includes(forward[1]!)) {
    return { kind: 'forward', step: forward[1] as ForwardStep };
  }
  // 0113: the seller says they reached the advert lead. `lc:` collides with
  // none of the cabinet's own three (`lang:`, `ph:`, `mg`).
  const contacted = /^lc:([0-9a-f-]{36})$/.exec(data);
  if (contacted) return { kind: 'lead_contacted', leadId: contacted[1]! };
  // 0119: the VED's answer about one guess. `cl:` collides with nothing —
  // `c:` is anchored to one word, and `lc:` starts with its own letter.
  const calcLink = /^cl:([01]):([0-9a-f-]{36}):([0-9a-f]{8})$/.exec(data);
  if (calcLink) {
    return {
      kind: 'calc_link',
      receiptId: calcLink[2]!,
      requestTag: calcLink[3]!,
      verdict: calcLink[1] === '1' ? 'confirm' : 'drop',
    };
  }
  const approval = /^a:([01]):([0-9a-f-]{36})$/.exec(data);
  if (approval) {
    return {
      kind: 'approval',
      approvalId: approval[2]!,
      verdict: approval[1] === '1' ? 'approved' : 'refused',
    };
  }
  return null;
}

/**
 * Inline buttons a pending Telegram notification carries, by type. Attached
 * at SEND time so the notification rows stay plain data and a bot-less
 * deployment (no token) changes nothing.
 */
export function buttonsFor(type: string, payload: Record<string, unknown>): BotButton[][] | null {
  const taskId = typeof payload.taskId === 'string' && UUID.test(payload.taskId) ? payload.taskId : null;
  // The assignee's own copies: a fresh or handed-on task, a reminder, an
  // answer to their question — one set of buttons, chosen by ORIGIN.
  if ((type === 'TaskAssigned' || type === 'TaskReminder' || type === 'TaskAnswer') && taskId) {
    return assigneeButtons(taskId, payload);
  }
  // A staff thread's ping (the owner's E answers): one button that arms a
  // one-text wait — the same answer a swipe-reply gives, for whoever prefers
  // a button. Only a ping that names its thread: one sent before 0127 has no
  // `payload.thread` and could not be landed anywhere.
  // Its word in the language the ping's text was written in (`textLocaleOf`,
  // 0129 — a cargo ping's frame follows its recipient; every other ping is
  // Uzbek, and the uz word IS `THREAD_REPLY_BUTTON`, pinned by a test).
  if ((THREAD_PING_TYPES as readonly string[]).includes(type) && threadOfPayload(payload)) {
    return [[{ text: notificationLabels(textLocaleOf(payload)).threadReplyButton, callback_data: 'jy' }]];
  }
  // The author's copy of a question carries the one way to answer it.
  if (type === 'TaskQuestion' && taskId) {
    return [[{ text: '💬 Javob berish', callback_data: `tr:${taskId}` }]];
  }
  // A colleague moved the author's task: the sources go on only if the AUTHOR
  // says so (access-money-12).
  if (type === 'TaskReassigned' && taskId && payload.offerSources === true) {
    return [[{ text: '📤 Manbani yangi odamga yuborish', callback_data: `tf:${taskId}` }]];
  }
  if (type === 'DebtApprovalRequested' && typeof payload.approvalId === 'string') {
    return [
      [
        { text: '✅ Ruxsat', callback_data: `a:1:${payload.approvalId}` },
        { text: '⛔ Yo‘q', callback_data: `a:0:${payload.approvalId}` },
      ],
    ];
  }
  // An advert lead (0113): the one press that says «I reached them» from a
  // phone the system cannot see — a personal Telegram, a call with no app.
  if (type === 'InboundLeadArrived' && typeof payload.leadId === 'string') {
    return [[{ text: LEAD_CONTACTED_BUTTON, callback_data: `lc:${payload.leadId}` }]];
  }
  // The 08:00 digest carries the same buttons «📋 Bugun» draws (round C), from
  // the tasks it listed — so the push and the pull stay one thing.
  if (type === 'TasksDue' && Array.isArray(payload.tasks)) {
    return dayButtons(payload.tasks as DayTask[]);
  }
  // 0119: one row per prixod the VED is asked about, ✅ with its number, ❌
  // beside it. Only rows the parser will accept are drawn — an unparsed
  // callback is answered by nobody and spins for fifteen seconds (#939).
  if (type === 'CalcLinkAsk' && Array.isArray(payload.asks)) {
    const rows = (payload.asks as { receiptId?: unknown; req8?: unknown; number?: unknown }[])
      .filter(
        (ask): ask is { receiptId: string; req8: string; number?: unknown } =>
          typeof ask.receiptId === 'string' &&
          /^[0-9a-f-]{36}$/.test(ask.receiptId) &&
          typeof ask.req8 === 'string' &&
          /^[0-9a-f]{8}$/.test(ask.req8),
      )
      .slice(0, LINK_ASK_BUTTONS)
      .map((ask) => [
        {
          text: `✅ ${typeof ask.number === 'string' && ask.number ? ask.number : 'Prixod'}`.slice(0, 40),
          callback_data: `cl:1:${ask.receiptId}:${ask.req8}`,
        },
        { text: '❌', callback_data: `cl:0:${ask.receiptId}:${ask.req8}` },
      ]);
    return rows.length > 0 ? rows : null;
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CallbackButton = { text: string; callback_data: string };
export type UrlButton = { text: string; url: string };
export type BotButton = CallbackButton | UrlButton;

/**
 * The assignee's buttons, by where the task came from (spec §2, review
 * telegram-mechanics-20/21) — read off the payload contract
 * (`taskButtonPayload`), because this function is pure and cannot ask the
 * row:
 *
 *   hand / NULL     [👀 Qabul qildim] [✅ Bajarildi] / [⏰ Muddatni surish] [💬 Savol]
 *   calc, bound     [❓ Sotuvchidan so‘rash] — a question to the seller under
 *                   that calculation (E3 a), never a task action; the URL row
 *                   the drain lifts off the 🔗 line stays beside it
 *   calc, unbound   [✅ Bajarildi] — a release ghost or a closed job closes normally
 *   calc_return     [👀] [✅] / [💬]
 *   promise         [👀] [✅] / [💬] — no ⏰: the date IS the client's promise
 *   automation      [✅] [⏰] — the author wrote a rule, not this task: no 👀,
 *                   no 💬 to somebody who knows nothing about it
 *
 * 👀 is gone once accepted, ⏰ on a repeating task (it would move the
 * series). Every press is re-checked on the server: a payload queued before
 * this round has no origin and reads as hand.
 */
export function assigneeButtons(taskId: string, payload: Record<string, unknown>): BotButton[][] | null {
  const origin = typeof payload.origin === 'string' ? payload.origin : null;
  if (origin === 'calc') {
    return payload.bound === true
      ? [[{ text: ASK_SELLER_BUTTON, callback_data: 'jy' }]]
      : [[{ text: '✅ Bajarildi', callback_data: `t:${taskId}` }]];
  }
  const accept = payload.accepted !== true && origin !== 'automation';
  const wait = payload.repeats !== true && origin !== 'promise' && origin !== 'calc_return';
  const ask = origin !== 'automation';
  const first: BotButton[] = [
    ...(accept ? [{ text: '👀 Qabul qildim', callback_data: `tk:${taskId}` }] : []),
    { text: '✅ Bajarildi', callback_data: `t:${taskId}` },
  ];
  const second: BotButton[] = [
    ...(wait ? [{ text: '⏰ Muddatni surish', callback_data: `tw:${taskId}` }] : []),
    ...(ask ? [{ text: '💬 Savol', callback_data: `tq:${taskId}` }] : []),
  ];
  return second.length > 0 ? [first, second] : [first];
}

/** ⏰'s choices, as the reply under the press. */
export function postponeKeyboard(taskId: string): CallbackButton[][] {
  return [
    [
      { text: 'Ertaga', callback_data: `tp:e:${taskId}` },
      { text: 'Indinga', callback_data: `tp:i:${taskId}` },
    ],
    [
      { text: '1 haftaga', callback_data: `tp:w:${taskId}` },
      { text: '📅 Sana yozish', callback_data: `tp:s:${taskId}` },
    ],
  ];
}

/** How many prixods one «Bu prixodlar hisobingizga tegishlimi?» carries buttons for. */
export const LINK_ASK_BUTTONS = 5;

/**
 * Which prixod a pressed «tegishlimi?» row was about — the receipt number on
 * its ✅ button, read off the keyboard BEFORE the row is removed. The row is
 * the only place the message named it; without this, three presses leave
 * three anonymous verdicts under a list whose rows have gone.
 */
export function pressedLinkAskLabel(markup: unknown, data: string): string | null {
  const rows = (markup as { inline_keyboard?: { text?: string; callback_data?: string }[][] })?.inline_keyboard ?? [];
  const row = rows.find((r) => r.some((button) => button.callback_data === data));
  const label = row?.find((button) => button.callback_data?.startsWith('cl:1:'))?.text ?? '';
  const number = label.replace(/^✅\s*/u, '').trim();
  return number || null;
}

/**
 * Settle one row of a «tegishlimi?» message (0119): the text keeps what it
 * said and gains the answer, NAMED — «✅ Tasdiqlandi — R-00123»; the pressed
 * row goes, every other row and any link row stay — `withoutCallback` takes
 * out exactly the row it names.
 */
export async function settleLinkAskRow(
  chatId: bigint,
  origin: { messageId: number; text: string; markup: unknown },
  data: string,
  line: string,
): Promise<void> {
  const number = pressedLinkAskLabel(origin.markup, data);
  const res = await editText({
    chatId,
    messageId: origin.messageId,
    html: appendLine(staffTextHtml(origin.text, 'CalcLinkAsk'), number ? `${line} — ${number}` : line),
    replyMarkup: keyboardOf(withoutCallback(origin.markup, data)),
  });
  if (!res.ok) logger.warn({ description: res.description }, 'calc link ask not updated');
}

/** A task a day list offers to close — its id and the words on the button. */
export interface DayTask {
  id: string;
  title: string;
  /**
   * The OPEN calc request this task carries the clock of, when it does
   * (telegram-mechanics-3): such a row is a link to the job's screen, never a
   * «✅» — a VED's calc jobs are priority 1 and timed, so they head the list,
   * and every press on them was a refusal.
   */
  calc?: string | null;
}

/** How many «✅» buttons a day list carries — one number, the digest's. */
export { DAY_BUTTONS };

/**
 * «✅ <title>» per task, one per row, overdue first (the caller's order).
 *
 * A NEW prefix, `tb:`, and not the task message's `t:`: the press on a list
 * must shrink the list (remove that one row) where the press on a task's own
 * message closes the message — and the handler learns which from the button
 * itself. Null when there is nothing to offer, so the caller sends no empty
 * keyboard (Telegram refuses one).
 */
export function dayButtons(
  tasks: DayTask[],
  appUrl: string | null | undefined = process.env.APP_URL,
): BotButton[][] | null {
  // A URL button only to an https origin: Telegram refuses anything else, and
  // a refused keyboard takes the whole message with it (staff-html's rule).
  const base = /^https:\/\//.test((appUrl ?? '').trim()) ? appUrl!.trim().replace(/\/$/, '') : null;
  const rows: BotButton[][] = [];
  for (const task of tasks) {
    if (rows.length >= DAY_BUTTONS) break;
    if (typeof task?.id !== 'string' || !/^[0-9a-f-]{36}$/.test(task.id)) continue;
    const label = buttonLabel(String(task.title ?? ''), 'Vazifa');
    if (typeof task.calc === 'string' && task.calc) {
      if (base && /^[0-9a-f-]{36}$/.test(task.calc)) {
        rows.push([{ text: `🧮 ${label}`, url: `${base}/hisoblash/${task.calc}` }]);
      }
      continue;
    }
    rows.push([{ text: `✅ ${label}`, callback_data: `tb:${task.id}` }]);
  }
  return rows.length > 0 ? rows : null;
}

// ---------------------------------------------------------------------------
// Two-step task completion: the button asks for the result, the next text
// message delivers it. In-memory with a TTL — single-process polling, same
// as the web connect flow's pending logins.
// ---------------------------------------------------------------------------

const PENDING_TTL_MS = 10 * 60_000;

/**
 * The message the «✅» was pressed on — what the close rewrites once the
 * result arrives (round C). Pressing changes NOTHING on it: the task is not
 * closed until the result is typed, and a message that said «Yopildi» while
 * the prompt was still waiting would be the lie this replaces.
 */
export interface PressedMessage {
  messageId: number;
  /** The message's plain text as Telegram holds it (callbackQuery.message). */
  text: string;
  /** Its keyboard at the moment of the press. */
  markup: unknown;
  kind: 'single' | 'list';
}

/**
 * What the next typed text IS, for a chat that pressed a task button
 * (docs/TELEGRAM-TOPSHIRIQ.md §4): the result of «✅ Bajarildi», the
 * assignee's «💬 Savol», the author's «💬 Javob berish», or a date typed
 * after «⏰ → 📅 Sana yozish» (telegram-mechanics-14). ONE map behind ONE
 * reader (`takeTaskPending`) — a second map for any of them would either
 * collide with the single-capture fence or sit below it and have the typed
 * date eaten as a result.
 */
export type PendingKind = 'result' | 'question' | 'answer' | 'reschedule' | 'reply';

export interface PendingTask {
  taskId: string;
  kind: PendingKind;
  /**
   * Was `origin` until 0124 gave a TASK an origin of its own (tasks/service.ts:
   * where the task came from). This is the MESSAGE the button was pressed on,
   * and two meanings under one name in one file read as one thing.
   */
  pressed: PressedMessage | null;
  /** The «write the result» prompt itself, whose «✅ Natijasiz» goes once used. */
  promptMessageId?: number | null;
  /**
   * A `'reply'` wait (the thread's «💬 Javob yozish»): the bot message the
   * press was on — the thread the next text lands in. `taskId` is then ''
   * (no task uuid is empty, so `takeTaskPendingFor` can never match it).
   */
  replyToMessageId?: number | null;
}

const pendingResults = new Map<string, PendingTask & { expires: number }>();
/** Chats that pressed «Hodim» and were asked for their phone. */
const staffEntryIntents = new Map<string, number>();

export function noteTaskPending(
  chatId: bigint,
  taskId: string,
  pressed: PressedMessage | null = null,
  kind: PendingKind = 'result',
): void {
  pendingResults.set(String(chatId), { taskId, kind, pressed, expires: Date.now() + PENDING_TTL_MS });
}

/**
 * «💬 Javob yozish» pressed: the next text is a reply to `replyToMessageId`.
 * In the SAME map as every other wait — the one-map law: a second map would
 * collide with the single-capture fence — so it replaces whatever was armed,
 * exactly as `tq:` does.
 */
export function noteReplyPending(chatId: bigint, replyToMessageId: number): void {
  pendingResults.set(String(chatId), {
    taskId: '',
    kind: 'reply',
    pressed: null,
    replyToMessageId,
    expires: Date.now() + PENDING_TTL_MS,
  });
}

/**
 * A PEEK at the armed wait — the reply door's question «is this reply the one
 * a wait was armed for?». Never deletes: only `takeTaskPending`,
 * `takeTaskPendingFor` and `dropTaskPending` change the map.
 */
export function peekTaskPending(chatId: bigint): PendingTask | null {
  const entry = pendingResults.get(String(chatId));
  if (!entry || entry.expires <= Date.now()) return null;
  return pendingOf(entry);
}

/** The prompt was sent — remember where its «✅ Natijasiz» sits. */
export function notePendingPrompt(chatId: bigint, taskId: string, promptMessageId: number): void {
  const entry = pendingResults.get(String(chatId));
  if (entry && entry.taskId === taskId) entry.promptMessageId = promptMessageId;
}

/**
 * The text ladder's ONE door to a waiting answer. Deletes on read — which is
 * exactly why every keyboard label and every collector sits ABOVE its caller.
 */
export function takeTaskPending(chatId: bigint): PendingTask | null {
  const key = String(chatId);
  const entry = pendingResults.get(key);
  if (!entry) return null;
  pendingResults.delete(key);
  return entry.expires > Date.now() ? pendingOf(entry) : null;
}

/**
 * «✅ Natijasiz»'s door, NAMED and second on purpose (telegram-mechanics-13):
 * the press is on the PROMPT, but what it closes is the ORIGINAL message,
 * whose id, text and markup only the wait holds. It takes the wait only when
 * the wait is for THAT task — so a later «GS777» is a lookup again and not
 * the result of a task that is already closed.
 */
export function takeTaskPendingFor(chatId: bigint, taskId: string): PendingTask | null {
  const key = String(chatId);
  const entry = pendingResults.get(key);
  if (!entry || entry.taskId !== taskId) return null;
  pendingResults.delete(key);
  return entry.expires > Date.now() ? pendingOf(entry) : null;
}

/** Starting a task draft discards a waiting answer (spec §3): a draft's text is never a result. */
export function dropTaskPending(chatId: bigint): void {
  pendingResults.delete(String(chatId));
}

function pendingOf(entry: PendingTask): PendingTask {
  return {
    taskId: entry.taskId,
    kind: entry.kind,
    pressed: entry.pressed,
    promptMessageId: entry.promptMessageId ?? null,
    // Rebuilt field by field — a field not copied here arrives as nothing.
    replyToMessageId: entry.replyToMessageId ?? null,
  };
}

/**
 * The pressed message, once the task is closed (round C).
 *
 * A task's own message becomes its record: its text, «✅ Yopildi — <result>»
 * under it, the «Bajarildi» button gone and its «↗️ Ochish» kept. A LIST
 * («📋 Bugun», the morning digest) keeps its text and loses only that task's
 * row, so the next press on it is the next task. Both are edits, and both are
 * best-effort — Telegram will not edit a message older than 48 hours, and a
 * button that outlives its task only answers «allaqachon yopilgan».
 *
 * The markup and text are a SNAPSHOT from the press, up to ten minutes old,
 * and the after-commit retire is told to skip this message so the two edits
 * do not race (review tasks-3). So a list is redrawn from what STANDS — every
 * other `tb:` row whose task closed or moved in those minutes goes too, or
 * the snapshot brings back a ✅ the retire had just taken off — and a task's
 * own message that another door closed first is left alone: that door's
 * retire already wrote the real outcome on it, and «✅ Yopildi» over a
 * «🗑 Bekor qilindi» is a lie.
 */
export async function closeTaskMessage(
  chatId: bigint,
  pending: Pick<PendingTask, 'taskId' | 'pressed'>,
  result: string,
  outcome: 'done' | 'already_closed',
): Promise<void> {
  const pressed = pending.pressed;
  if (!pressed) return;
  if (pressed.kind !== 'list' && outcome === 'already_closed') return;
  const res =
    pressed.kind === 'list'
      ? await editMarkup({
          chatId,
          messageId: pressed.messageId,
          replyMarkup: keyboardOf(
            await listRowsStanding(chatId, withoutCallback(pressed.markup, `tb:${pending.taskId}`)),
          ),
        })
      : await editText({
          chatId,
          messageId: pressed.messageId,
          html: appendLine(
            staffTextHtml(pressed.text, 'TaskAssigned'),
            result ? `✅ Yopildi — ${result}` : '✅ Yopildi',
          ),
          replyMarkup: keyboardOf(urlRowsOf(pressed.markup)),
        });
  if (!res.ok) logger.warn({ description: res.description }, 'task message not updated');
}

/**
 * A day list's rows as they stand NOW: a `tb:` row stays while its task is
 * open and still this chat's person's (the digest is their own list — the
 * retire's rule, review tasks-4); every other row (a link, the 🧮 to a job)
 * is kept as it was. ONE query over the ids the markup names.
 */
async function listRowsStanding(chatId: bigint, rows: InlineRows): Promise<InlineRows> {
  const idOf = (row: InlineRows[number]) => {
    for (const button of row) {
      const m = typeof button.callback_data === 'string' ? /^tb:([0-9a-f-]{36})$/.exec(button.callback_data) : null;
      if (m) return m[1]!;
    }
    return null;
  };
  const ids = [...new Set(rows.map(idOf).filter((id): id is string => id !== null))];
  if (ids.length === 0) return rows;
  const staff = await staffForChat(chatId);
  if (!staff) return rows.filter((row) => idOf(row) === null);
  const open = (await db.execute(sql`
    SELECT id FROM tasks
     WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
       AND status = 'open' AND assignee_id = ${staff.id}`)) as unknown as { id: string }[];
  const standing = new Set(open.map((row) => row.id));
  return rows.filter((row) => {
    const id = idOf(row);
    return id === null || standing.has(id);
  });
}

type InlineRows = ReturnType<typeof withoutCallback>;

/**
 * Settle the advert-lead push a «📞 Bog'landim» was pressed on (0113): the
 * text keeps what it said and gains who reached the lead; the pressed button
 * goes and the «↗️ Ochish» link row STAYS — an edit must never leave a
 * message with less to open than it had (`urlRowsOf`'s rule, via
 * `withoutCallback`, which removes exactly that one row).
 */
export async function closeLeadMessage(
  chatId: bigint,
  origin: { messageId: number; text: string; markup: unknown },
  leadId: string,
  line: string,
): Promise<void> {
  const res = await editText({
    chatId,
    messageId: origin.messageId,
    html: appendLine(staffTextHtml(origin.text, 'InboundLeadArrived'), line),
    replyMarkup: keyboardOf(withoutCallback(origin.markup, `lc:${leadId}`)),
  });
  if (!res.ok) logger.warn({ description: res.description }, 'lead message not updated');
}

export function noteStaffEntry(chatId: bigint): void {
  staffEntryIntents.set(String(chatId), Date.now() + PENDING_TTL_MS);
}

export function takeStaffEntry(chatId: bigint): boolean {
  const key = String(chatId);
  const expires = staffEntryIntents.get(key);
  if (expires === undefined) return false;
  staffEntryIntents.delete(key);
  return expires > Date.now();
}

/** The grants alone — `userPermissions`, the one home of the join `actorGrants` reads. */
const permissionsOf = userPermissions;

/**
 * `getActor` for a chat instead of a session — the SAME three answers
 * (permissions union, warehouse scope from the roles COLUMN per #199/0049,
 * assigned warehouses), because a bot read that is wider than the screen's
 * read is a back door. Never invents an admin: no chat, no actor.
 */
export async function botActorFor(chatId: bigint): Promise<
  | (StaffChat & {
      permissions: Set<string>;
      roles: string[];
      warehouseScoped: boolean;
      warehouseIds: string[];
    })
  | null
> {
  const staff = await staffForChat(chatId);
  if (!staff) return null;
  // The role CODES ride along for the decisions made on a role rather than a
  // grant: whether the AI assistant's analyst tier opens (round 21's shape —
  // supervision breadth is super_admin/admin, not a permission) and whether
  // «📊 Holat» is this person's (the owner's evening summary). `actorGrants`
  // is `getActor`'s own body, so the chat is exactly the person on the screen.
  return { ...staff, ...(await actorGrants(staff.id)) };
}

/**
 * "Where is it?" from the bot. The wms lookup is reached by dynamic import —
 * platform never imports wms statically (the startBoss crossing).
 */
export async function lookupFromBot(
  chatId: bigint,
  query: string,
): Promise<{ text: string; mapClientCode?: string; phones?: string[] } | null> {
  const actor = await botActorFor(chatId);
  if (!actor) return null;
  const { botLookupAnswer } = await import('../../wms/bot/lookup');
  return botLookupAnswer(actor, query);
}

/**
 * Is «📊 Holat» this chat's? The ONE door (`readsOwnerSummary`: the super_admin
 * role and the company's money sight) asked by the keyboard, the command
 * menu and the handler alike. The predicate lives in wms and is reached by
 * dynamic import — platform never imports wms statically (the startBoss
 * crossing). False for a chat that is not a linked member of staff.
 */
export async function holatFor(chatId: bigint): Promise<boolean> {
  const actor = await botActorFor(chatId);
  if (!actor) return false;
  const { readsOwnerSummary } = await import('../../wms/reports/owner-summary-door');
  return readsOwnerSummary(actor);
}

/**
 * The evening summary for the chat that pressed «📊 Holat» — the door and the
 * compose in wms (`ownerSummaryForActor` asks it before a single figure is
 * read). `not_linked` for a stranger, `refused` for a member of staff the door
 * does not admit; the text for the owner, the same words the 20:00 push sends.
 */
export async function ownerSummaryFromBot(
  chatId: bigint,
): Promise<{ status: 'ok'; text: string } | { status: 'not_linked' | 'refused' }> {
  const actor = await botActorFor(chatId);
  if (!actor) return { status: 'not_linked' };
  const { ownerSummaryForActor } = await import('../../wms/reports/owner-summary');
  const summary = await ownerSummaryForActor(actor);
  return summary ? { status: 'ok', text: summary.text } : { status: 'refused' };
}

/**
 * A staff question the free paths could not answer, put to the AI assistant
 * under the chat's honest actor. Null when the chat is not a linked member of
 * staff — a customer's text must never reach the model or the question
 * ledger (their AI is the cabinet, and there deliberately is none).
 */
export async function assistantFromBot(
  chatId: bigint,
  question: string,
): Promise<import('../ai/assistant').AskOutcome | null> {
  const actor = await botActorFor(chatId);
  if (!actor) return null;
  const { askAssistant } = await import('../ai/assistant');
  return askAssistant({ actor, question, surface: 'bot' });
}

/**
 * Land a confirmed «Hisoblatish» on a card. Everything it decides — which
 * client the typed hint names, deal or lead, what the note says — lives in
 * wms and is tested there; this is the crossing.
 */
export async function landCollectedIntake(
  chatId: bigint,
  staffId: string,
  staffName: string,
): Promise<{
  kind: 'deal' | 'lead';
  id: string;
  label: string;
  queued?: boolean;
  requestId?: string | null;
  /** Why not, when it did not (audit A38) — the bot turns it into a sentence. */
  queueError?: string | null;
} | null> {
  const { activeIntake } = await import('./calc-intake');
  const state = activeIntake(chatId);
  if (!state) return null;
  const { parseClientHint } = await import('../../wms/calc/intake');
  const { landIntake, resolveIntakeClient } = await import('../../wms/calc/intake-land');

  const hint = parseClientHint(state.clientHintRaw);
  const client = hint ? await resolveIntakeClient(hint) : null;
  return landIntake({
    noteId: state.noteId,
    section: state.section,
    facts: state.facts,
    steps: state.steps,
    // Law 11: the words themselves go onto the card, not only what the
    // parser made of them.
    material: state.material,
    fileCount: state.fileCount,
    collectedBy: staffId,
    collectedByName: staffName,
    client,
    // A prospect's card is named by whatever staff typed; the phone, when
    // one was typed, is what a second request will find it by.
    leadName: state.clientHintRaw.trim() || 'Hisoblatish (nomsiz)',
    leadPhone: hint?.phone ?? null,
    // Only the AI door offers the toggle; every other collection lands the
    // column's own default, which is what it landed before this round.
    hasCertificate: state.hasCertificate,
    // The AI podklyuch door's «qayerdan?» answer; every other door has none.
    freightZone: state.route?.zone ?? null,
    // What the reading cost, so the day's AI budget counts the most
    // expensive call on this path rather than the two cheap ones.
    usage: state.usage,
  });
}

/**
 * Every answer a task door can give the bot, in words — a `Record` over the
 * service's closed list, so a code nobody wrote a sentence for is a compile
 * error HERE and never a throw into `bot.catch` after a person typed their
 * result (the review's blocker, telegram-mechanics-1).
 */
export type BotTaskResult = 'done' | 'not_linked' | TaskErrorCode;

export const TASK_ANSWERS: Record<BotTaskResult, string> = {
  done: '✅ Bajarildi.',
  not_linked: 'Ulanmagan.',
  unauthenticated: 'Ulanmagan.',
  validation: 'Ma’lumot to‘g‘ri emas.',
  bad_bound: 'Vazifa noto‘g‘ri bog‘langan.',
  unknown_entity: 'Vazifa noma’lum yozuvga bog‘langan.',
  half_pointer: 'Vazifa yozuvga to‘liq bog‘lanmagan.',
  no_assignee: 'Bunday hodim topilmadi.',
  assignee_no_login: 'Bu hodim tizimga kirmaydi — unga vazifa berib bo‘lmaydi.',
  assignee_inactive: 'Bu hodim ishdan ketgan.',
  repeat_needs_due: 'Takrorlanadigan vazifaga muddat kerak.',
  not_created: 'Vazifa yaratilmadi — qaytadan urinib ko‘ring.',
  bad_due_date: 'Sanani tushunmadim.',
  not_found: 'Vazifa topilmadi.',
  not_yours: 'Bu vazifa sizniki emas.',
  already_closed: 'Bu vazifa yopilgan.',
  calc_use_screen: 'Bu hisoblash ishi — hisoblash sahifasida yakunlang.',
  bound_check_failed: 'Tekshirib bo‘lmadi — birozdan keyin qaytadan urinib ko‘ring.',
  bound_clock: 'Bu muddat mijozning to‘lov va’dasi — uni surib bo‘lmaydi.',
  repeat_series: 'Takrorlanadigan vazifa muddatini saytda o‘zgartiring — butun qator suriladi.',
  not_assignee: 'Bu vazifa endi sizda emas.',
  already_accepted: 'Allaqachon qabul qilingan.',
  not_author: 'Bu vazifani siz bermagansiz.',
  remind_too_soon: 'Yaqinda eslatilgan — 30 daqiqadan keyin qayta urinib ko‘ring.',
  not_remindable: 'Bu vazifaga eslatma yuborib bo‘lmaydi.',
  not_askable: 'Bu vazifa bo‘yicha savol yuborib bo‘lmaydi.',
  empty_text: 'Bo‘sh xabar.',
  nothing_to_send: 'Yuboradigan narsa yo‘q — vazifa hozir sizda yoki unda xabar yo‘q.',
};

/** The chat's honest actor, as the task service wants it — never a synthetic admin. */
async function taskCtxFor(chatId: bigint): Promise<TaskContext | null> {
  const staff = await staffForChat(chatId);
  if (!staff) return null;
  return { actorId: staff.id, actor: { id: staff.id, permissions: await permissionsOf(staff.id) } };
}

/** One door, run as the chat's person; every refusal comes back as its code. */
async function asChat<T>(chatId: bigint, door: (ctx: TaskContext) => Promise<T>): Promise<
  { result: 'done'; value: T } | { result: Exclude<BotTaskResult, 'done'>; value?: undefined }
> {
  const ctx = await taskCtxFor(chatId);
  if (!ctx) return { result: 'not_linked' };
  try {
    return { result: 'done', value: await door(ctx) };
  } catch (err) {
    if (err instanceof TaskError) return { result: err.code };
    throw err;
  }
}

/** The pressed message, as the after-commit retire must skip it. */
function pressedRef(chatId: bigint, pressed: { messageId: number } | null | undefined) {
  return pressed ? { chatId: Number(chatId), messageId: pressed.messageId } : null;
}

/**
 * Close a task from the bot, as the person the CHAT belongs to. The service
 * enforces whose task it is (`canActOnTask`) — the bot only supplies an
 * honestly-identified actor, never a synthetic admin.
 */
export async function completeTaskFromBot(
  chatId: bigint,
  taskId: string,
  result: string,
  pressed?: { messageId: number } | null,
): Promise<BotTaskResult> {
  return (await asChat(chatId, (ctx) => completeTask(taskId, result, ctx, { pressed: pressedRef(chatId, pressed) })))
    .result;
}

export async function acceptTaskFromBot(chatId: bigint, taskId: string): Promise<BotTaskResult> {
  return (await asChat(chatId, (ctx) => acceptTask(taskId, ctx))).result;
}

export async function rescheduleTaskFromBot(
  chatId: bigint,
  taskId: string,
  due: { dueAt: Date; allDay: boolean },
): Promise<BotTaskResult> {
  return (await asChat(chatId, (ctx) => rescheduleTask(taskId, due, ctx))).result;
}

export async function cancelTaskFromBot(
  chatId: bigint,
  taskId: string,
  pressed?: { messageId: number } | null,
): Promise<BotTaskResult> {
  return (await asChat(chatId, (ctx) => cancelTask(taskId, '', ctx, { pressed: pressedRef(chatId, pressed) })))
    .result;
}

/** «📤 Manbani yangi odamga yuborish» — and whether the holder will hear it (review bot-13). */
export async function sourcesFromBot(chatId: bigint, taskId: string): Promise<ReachedResult> {
  const out = await asChat(chatId, (ctx) => forwardSourcesAgain(taskId, ctx));
  return out.result === 'done' ? { result: 'done', ...out.value } : { result: out.result };
}

/** A door that also says whether the other side will hear it, and who that is. */
export interface ReachedResult {
  result: BotTaskResult;
  reach?: Reach;
  name?: string | null;
}

export async function remindTaskFromBot(chatId: bigint, taskId: string): Promise<ReachedResult> {
  const out = await asChat(chatId, (ctx) => remindTask(taskId, ctx));
  return out.result === 'done' ? { result: 'done', ...out.value } : { result: out.result };
}

export async function askFromBot(chatId: bigint, taskId: string, text: string): Promise<ReachedResult> {
  const out = await asChat(chatId, (ctx) => askAboutTask(taskId, text, ctx));
  return out.result === 'done' ? { result: 'done', ...out.value } : { result: out.result };
}

export async function answerFromBot(chatId: bigint, taskId: string, text: string): Promise<ReachedResult> {
  const out = await asChat(chatId, (ctx) => answerAboutTask(taskId, text, ctx));
  return out.result === 'done' ? { result: 'done', ...out.value } : { result: out.result };
}

/**
 * The checks a task button's PRESS makes before anything waits for typing
 * (the review's blocker, telegram-mechanics-1): the old `t:` ✅ on a calc
 * job asked for a result, the person typed one, and only then did the
 * service refuse — into a rethrow, so they heard silence. Now the press loads
 * the task and refuses at once, in words, with the job's link when it is an
 * open calc request.
 *
 * `who` is the press's own question: anybody who may act on the task (✅),
 * its assignee (💬 Savol), or its author (💬 Javob berish).
 */
export type PressCheck =
  | { ok: true; task: TaskRow }
  | { ok: false; result: Exclude<BotTaskResult, 'done'>; requestId?: string };

export async function taskPressCheck(
  chatId: bigint,
  taskId: string,
  who: 'act' | 'assignee' | 'author',
): Promise<PressCheck> {
  const ctx = await taskCtxFor(chatId);
  if (!ctx) return { ok: false, result: 'not_linked' };
  const task = await taskById(taskId);
  if (!task) return { ok: false, result: 'not_found' };
  if (task.status !== 'open') return { ok: false, result: 'already_closed' };
  if (who === 'act' && !canActOnTask(task, ctx.actor)) return { ok: false, result: 'not_yours' };
  if (who === 'assignee' && task.assigneeId !== ctx.actorId) return { ok: false, result: 'not_assignee' };
  if (who === 'author' && task.createdBy !== ctx.actorId) return { ok: false, result: 'not_author' };
  let binding;
  try {
    binding = (await bindingsOf([task])).get(task.id) ?? null;
  } catch (err) {
    logger.warn({ err, taskId }, '[staff-bot] bound check at press failed — refusing');
    return { ok: false, result: 'bound_check_failed' };
  }
  if (binding?.kind === 'calc' && binding.open) {
    return { ok: false, result: 'calc_use_screen', requestId: binding.recordId };
  }
  return { ok: true, task };
}

/** The refusal of a press, as the sentence under the button — with the job's door when there is one. */
export function pressRefusalText(check: Extract<PressCheck, { ok: false }>, appUrl = process.env.APP_URL): string {
  const words = TASK_ANSWERS[check.result];
  if (check.result === 'calc_use_screen' && check.requestId) {
    const base = (appUrl ?? '').replace(/\/$/, '');
    return `${words}\n${base}/hisoblash/${check.requestId}`;
  }
  return words;
}

/**
 * A task door's refusal as the sentence under the press or the typed answer —
 * with the job's own page when the refusal is an open calc job (review
 * bot-12): «hisoblash sahifasida yakunlang» without the page is half an
 * answer, and only the ✅ press used to carry it. The binding is read ONLY on
 * that refusal; a read that fails still says the words.
 */
export async function refusalFor(taskId: string, result: Exclude<BotTaskResult, 'done'>): Promise<string> {
  if (result !== 'calc_use_screen') return TASK_ANSWERS[result];
  try {
    const task = await taskById(taskId);
    const binding = task ? (await bindingsOf([task])).get(task.id) : undefined;
    return pressRefusalText({ ok: false, result, requestId: binding?.kind === 'calc' ? binding.recordId : undefined });
  } catch (err) {
    logger.warn({ err, taskId }, '[staff-bot] calc job of a refusal not read');
    return TASK_ANSWERS[result];
  }
}

/**
 * How a request stands, in the words its deciders read — for the button that
 * was pressed on it. Null while it is still pending (or not found).
 */
export async function approvalOutcomeLine(
  approvalId: string,
  locale?: string | null,
): Promise<string | null> {
  const { approvalVerdict } = await import('../../wms/issue/approvals');
  const verdict = await approvalVerdict(approvalId);
  if (!verdict) return null;
  return approvalVerdictLine(verdict, locale);
}

/**
 * The approval message a decider pressed, settled in place (round C): its
 * text, the verdict under it, the «Ruxsat / Yo‘q» gone and the link kept.
 * Done on `already_decided` too — that press is exactly the one that proves a
 * stale copy was still asking.
 */
export async function settlePressedApproval(
  chatId: bigint,
  pressed: { messageId: number; text: string; markup: unknown },
  approvalId: string,
  locale?: string | null,
): Promise<void> {
  const line = await approvalOutcomeLine(approvalId, locale);
  if (!line) return;
  const res = await editText({
    chatId,
    messageId: pressed.messageId,
    html: appendLine(staffTextHtml(pressed.text, 'DebtApprovalRequested'), line),
    replyMarkup: keyboardOf(urlRowsOf(pressed.markup)),
  });
  if (!res.ok) logger.warn({ description: res.description }, 'approval message not updated');
}

export type BotApprovalResult =
  | 'decided'
  | 'not_linked'
  | 'forbidden'
  | 'already_decided'
  | 'not_found'
  // 0114: the presser holds the grant but this client is not in his book (a
  // seller pressing on a colleague's client, from an old copy) — refused by
  // the service, answered in words.
  | 'not_your_client';

/**
 * Decide a debtor-issue request from the button. The permission is checked
 * HERE because the service trusts its callers to have authorized (the web
 * action does) — a chat id is not a session, so the bot must ask the grants
 * itself before lending the chat a decision.
 */
export async function decideApprovalFromBot(
  chatId: bigint,
  approvalId: string,
  verdict: 'approved' | 'refused',
): Promise<BotApprovalResult> {
  const staff = await staffForChat(chatId);
  if (!staff) return 'not_linked';
  const grants = await permissionsOf(staff.id);
  if (!grants.has('finance.debt_override')) return 'forbidden';
  const { decideIssueApproval, ApprovalError } = await import('../../wms/issue/approvals');
  try {
    await decideIssueApproval(
      { approvalId, verdict, note: 'Telegram bot orqali' },
      { actorId: staff.id },
      // WHICH clients this chat's person may decide is the service's answer
      // (0114): the same grants, as the actor the web page passes.
      { id: staff.id, permissions: grants },
    );
    return 'decided';
  } catch (err) {
    if (err instanceof ApprovalError) {
      if (err.code === 'already_decided') return 'already_decided';
      if (err.code === 'not_found') return 'not_found';
      if (err.code === 'not_your_client') return 'not_your_client';
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Topshiriq — the draft's decisions (docs/TELEGRAM-TOPSHIRIQ.md §3-6). The
// collection itself is task-draft.ts (pure, in memory); what it READS and
// WRITES is here, where an integration test reaches it.
// ---------------------------------------------------------------------------

/** One colleague in «Kimga?». */
export interface DraftPerson {
  id: string;
  name: string;
  /** Given a task by this author by hand in the last 90 days — sorted first. */
  recent: boolean;
  /**
   * «📵»: the bot cannot reach them at all (no linked chat). ONLY that: a
   * person's MUTE is their own setting, and this list is read by every
   * colleague (review access-money-24) — a mute is told to the author after
   * the pick, in the ⚠ line, and nowhere else.
   */
  noChat: boolean;
}

/** How many colleagues «Kimga?» draws before a typed name has to narrow it. */
export const PEOPLE_SHOWN = 40;

/**
 * «Kimga?» — every colleague who can sign in (`canLogIn`, his 2a: everybody
 * to everybody; a person who never signs in cannot be given work, as on the
 * web), the author's recent assignees first, then alphabetically, the author
 * themself left to «🙋 O'zimga». A typed name in this stage narrows it.
 */
export async function draftPeople(authorId: string, filter: string | null = null): Promise<DraftPerson[]> {
  const rows = (await db.execute(sql`
    SELECT u.id, u.full_name AS name,
           (SELECT max(t.created_at) FROM tasks t
             WHERE t.created_by = ${authorId} AND t.assignee_id = u.id
               AND t.origin = 'hand' AND t.created_at > now() - interval '90 days') AS last_given,
           EXISTS (SELECT 1 FROM telegram_links l
                    WHERE l.user_id = u.id AND l.status = 'linked' AND l.telegram_chat_id IS NOT NULL) AS linked
      FROM users u
     WHERE ${canLogInSql('u')} AND u.id <> ${authorId}
     ORDER BY last_given DESC NULLS LAST, u.full_name`)) as unknown as {
    id: string;
    name: string;
    last_given: string | Date | null;
    linked: boolean;
  }[];
  const needle = (filter ?? '').trim().toLocaleLowerCase();
  return rows
    .filter((row) => !needle || row.name.toLocaleLowerCase().includes(needle))
    .slice(0, PEOPLE_SHOWN)
    .map((row) => ({ id: row.id, name: row.name, recent: row.last_given !== null, noChat: !row.linked }));
}

/** «Kimga?», as buttons: two per row, «🙋 O‘zimga» and «🗑 Bekor qilish» last. */
export function peopleKeyboard(people: DraftPerson[]): CallbackButton[][] {
  const rows: CallbackButton[][] = [];
  for (let i = 0; i < people.length; i += 2) {
    rows.push(
      people.slice(i, i + 2).map((person) => ({
        text: buttonLabel(`${person.noChat ? '📵 ' : ''}${person.name}`, 'Hodim'),
        callback_data: `dk:${person.id}`,
      })),
    );
  }
  rows.push([{ text: '🙋 O‘zimga', callback_data: 'd:self' }]);
  rows.push([{ text: '🗑 Bekor qilish', callback_data: 'd:cancel' }]);
  return rows;
}

/** The due buttons (spec §3) — pressing one CREATES the task, no extra confirm. */
export function dueKeyboard(): CallbackButton[][] {
  return [
    [
      { text: 'Bugun', callback_data: 'd:due_b' },
      { text: 'Ertaga', callback_data: 'd:due_e' },
    ],
    [
      { text: 'Indinga', callback_data: 'd:due_i' },
      { text: 'Muddatsiz', callback_data: 'd:due_n' },
    ],
    [{ text: '📅 Sana yozish', callback_data: 'd:due_s' }],
    [{ text: '🗑 Bekor qilish', callback_data: 'd:cancel' }],
  ];
}

/** Door B's question under a forwarded message (spec §3). */
export function forwardKeyboard(): CallbackButton[][] {
  return [
    [
      { text: '📌 Topshiriq qilish', callback_data: 'fb:task' },
      { text: '🔍 Qidirish', callback_data: 'fb:search' },
    ],
  ];
}

/** The pick, checked: a colleague who can sign in — never a stranger's id from a forged press. */
export async function draftAssignee(userId: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: users.id, name: users.fullName, live: canLogInSql() })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row && row.live ? { id: row.id, name: row.name } : null;
}

export type DraftCreated =
  | {
      ok: true;
      taskId: string;
      title: string;
      assigneeId: string;
      assigneeName: string;
      reach: Reach;
      self: boolean;
    }
  | { ok: false; result: Exclude<BotTaskResult, 'done'> };

/**
 * The draft becomes a task — through the ONE writer, `createTask`, under the
 * chat's honest actor, `origin: 'hand'` (spec §4): title and note from what
 * was typed, the author's own messages as the sources, no entity pointer
 * (his 6b: a GS777 in the text is text, nothing is guessed), and the audit
 * row says it came through Telegram. The files are queued for the web AFTER
 * the task exists, as a job (telegram-mechanics-26), so a deploy mid-download
 * leaves a retry and not a task whose voice note never arrived.
 */
export async function createTaskFromDraft(
  chatId: bigint,
  draft: {
    assigneeId: string;
    title: string;
    note: string;
    sources: { chatId: number; messageId: number }[];
    files: DraftFile[];
  },
  due: { dueAt: string; tzOffsetMin: number | null },
): Promise<DraftCreated> {
  const ctx = await taskCtxFor(chatId);
  if (!ctx) return { ok: false, result: 'not_linked' };
  let task: TaskRow;
  try {
    task = await createTask(
      {
        title: draft.title,
        note: draft.note,
        typeId: null,
        assigneeId: draft.assigneeId,
        dueAt: due.dueAt,
        tzOffsetMin: due.tzOffsetMin,
        priority: 2,
        entityType: null,
        entityId: null,
        repeatUnit: null,
        repeatEvery: 1,
      },
      { actorId: ctx.actorId },
      { origin: 'hand', sourceMessages: draft.sources, via: 'telegram' },
    );
  } catch (err) {
    if (err instanceof TaskError) return { ok: false, result: err.code };
    throw err;
  }
  if (draft.files.length > 0) await queueTaskFiles(task.id, ctx.actorId!, draft.files);
  const self = task.assigneeId === ctx.actorId;
  const reach: Reach = self
    ? 'ok'
    : ((await reachOf([task.assigneeId], 'TaskAssigned')).get(task.assigneeId) ?? 'no_chat');
  return {
    ok: true,
    taskId: task.id,
    title: task.title,
    assigneeId: task.assigneeId,
    assigneeName: task.assigneeName ?? '—',
    reach,
    self,
  };
}

/** A task's files, handed to the download worker (tasks/files-job.ts). */
async function queueTaskFiles(taskId: string, uploadedBy: string, files: DraftFile[]): Promise<void> {
  const { enqueue } = await import('../jobs/boss');
  const { JOB_TASK_FILES } = await import('../tasks/files-job');
  await enqueue(JOB_TASK_FILES, { taskId, uploadedBy, files }).catch((err: unknown) => {
    // The task stands and its Telegram copy carries the forwards; only the
    // web copy of the bytes is missing, and the log says which.
    logger.error({ err, taskId, files: files.length }, '[tasks] file download not queued');
  });
}

/** What became of a late album part: taken, refused at the source cap, or the task is no longer open. */
export type LatePart = 'added' | 'cap' | 'closed';

/**
 * A late album part, after the task was made (telegram-mechanics-17): it
 * joins the task's sources (so a reassign by the author forwards it too), is
 * queued for the web, and goes to the task's holder — the drain's `forwards`
 * carried only the parts that had arrived. Only the AUTHOR's own open task,
 * and never past the source cap; a refusal is answered by its reason so the
 * author can be told (review bot-11).
 *
 * THROUGH THE DRAIN, as a `TaskSources` row to the holder the UPDATE itself
 * returns (review bot-11): a direct forward could reach the assignee before
 * the assignment's own text, which is often still queued, and went to the
 * holder the task had when it was MADE — after a reassign, the wrong person.
 */
export async function appendLatePart(
  chatId: bigint,
  linger: { taskId: string },
  part: { messageId: number; file: DraftFile | null },
): Promise<LatePart> {
  const staff = await staffForChat(chatId);
  if (!staff) return 'closed';
  const source = { chatId: Number(chatId), messageId: part.messageId };
  const appended = (await db.execute(sql`
    UPDATE tasks
       SET source_messages = coalesce(source_messages, '[]'::jsonb) || ${JSON.stringify([source])}::jsonb,
           updated_at = now()
     WHERE id = ${linger.taskId} AND created_by = ${staff.id} AND status = 'open'
       AND jsonb_array_length(coalesce(source_messages, '[]'::jsonb)) < ${MAX_TASK_SOURCES}
    RETURNING id, title, assignee_id, origin, bound_id, entity_type, entity_id`)) as unknown as {
    id: string;
    title: string;
    assignee_id: string;
    origin: string | null;
    bound_id: string | null;
    entity_type: string | null;
    entity_id: string | null;
  }[];
  const task = appended[0];
  if (!task) {
    const [row] = (await db.execute(sql`
      SELECT (status = 'open' AND created_by = ${staff.id}
              AND jsonb_array_length(coalesce(source_messages, '[]'::jsonb)) >= ${MAX_TASK_SOURCES}) AS full
        FROM tasks WHERE id = ${linger.taskId}`)) as unknown as { full: boolean }[];
    return row?.full ? 'cap' : 'closed';
  }
  if (part.file) await queueTaskFiles(linger.taskId, staff.id, [part.file]);
  if (task.assignee_id !== staff.id) {
    await queueTaskSources(
      {
        id: task.id,
        title: task.title,
        assigneeId: task.assignee_id,
        origin: task.origin,
        boundId: task.bound_id,
        entityType: task.entity_type,
        entityId: task.entity_id,
      },
      [source],
      '📎 Albomning qolgan qismi',
    );
  }
  return 'added';
}

/** How many «🔔» buttons «📤 Men bergan» carries — the rest are on the web. */
export const GIVEN_BUTTONS = 8;

/**
 * «📤 Men bergan» (his 5a): the open tasks this person gave by hand,
 * newest first, «🔴» late, «👀» accepted, «⏳» not yet seen — on deploy day
 * every one reads «⏳», which is true: nobody has pressed 👀 yet.
 */
export function givenListText(list: { rows: GivenTask[]; total: number }, now: Date = new Date()): string {
  if (list.total === 0) return '📤 Siz bergan ochiq vazifa yo‘q.';
  const lines = list.rows.map((row) => {
    const late = row.dueAt !== null && row.dueAt.getTime() < now.getTime();
    const mark = late ? '🔴' : row.accepted ? '👀' : '⏳';
    const due = row.dueAt ? telegramDue(row.dueAt, row.allDay, now) : 'muddatsiz';
    // A web title may be 200 characters, and twenty of them passed Telegram's
    // 4 096: the reply threw into bot.catch and the person heard silence
    // (review bot-9). A list line is a reminder, the title is on the site.
    return `${mark} ${row.assigneeName ?? '—'} · ${due} · ${cutOnWord(row.title, GIVEN_TITLE_MAX, '…')}`;
  });
  const more = list.total > list.rows.length ? `\n… va yana ${list.total - list.rows.length} ta (saytda)` : '';
  // …and the whole is capped too: a long name per row must not undo the cut.
  return capStaffText(
    `📤 Siz bergan ochiq vazifalar (${list.total})\n\n${lines.join('\n')}${more}\n\n` +
      '🔴 kechikkan · 👀 qabul qilingan · ⏳ hali ko‘rilmagan',
  );
}

/** How much of a title one «📤 Men bergan» line carries. */
export const GIVEN_TITLE_MAX = 80;

export function givenButtons(rows: GivenTask[]): CallbackButton[][] | null {
  const out = rows
    .slice(0, GIVEN_BUTTONS)
    .map((row) => [{ text: `🔔 ${buttonLabel(row.title, 'Vazifa')}`, callback_data: `te:${row.id}` }]);
  return out.length > 0 ? out : null;
}

export async function givenFromBot(
  chatId: bigint,
): Promise<{ text: string; buttons: CallbackButton[][] | null } | null> {
  const staff = await staffForChat(chatId);
  if (!staff) return null;
  const list = await givenTasks(staff.id);
  return { text: givenListText(list), buttons: givenButtons(list.rows) };
}
