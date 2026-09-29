import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { telegramLinks, users } from '../db/schema';
import { writeAudit } from '../audit/service';
import { actorGrants, userPermissions } from '../rbac/authorize';
import { completeTask, TaskError } from '../tasks/service';
import { DAY_BUTTONS } from '../tasks/digest';
import { logger } from '../logger';
import { approvalVerdictLine } from '../notifications/labels';
import {
  appendLine,
  keyboardOf,
  staffTextHtml,
  urlRowsOf,
  withoutCallback,
} from '../notifications/staff-html';
import { allLabelVariants } from './client-labels';
import { buttonLabel } from './limits';
import { editMarkup, editText } from './send';

/**
 * The cabinet's phone rule, restated here because platform must never import
 * wms: digits only, compare the last 9 — "+998 90…" and "90…" are the same
 * person, and anything under 7 digits is too short to trust.
 */
export function staffPhonesMatch(a: string, b: string): boolean {
  const da = a.replace(/\D/g, '');
  const db2 = b.replace(/\D/g, '');
  if (da.length < 7 || db2.length < 7) return false;
  const n = Math.min(9, da.length, db2.length);
  return da.slice(-n) === db2.slice(-n);
}

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

/** The staff member behind a chat — linked and still employed, or nobody. */
export async function staffForChat(chatId: bigint): Promise<StaffChat | null> {
  const [row] = await db
    .select({ id: users.id, fullName: users.fullName, locale: users.locale, active: users.active })
    .from(telegramLinks)
    .innerJoin(users, eq(telegramLinks.userId, users.id))
    .where(and(eq(telegramLinks.telegramChatId, chatId), eq(telegramLinks.status, 'linked')))
    .limit(1);
  if (!row || !row.active) return null;
  return { id: row.id, fullName: row.fullName, locale: row.locale };
}

/**
 * The ACTIVE staff member a Telegram-shared phone belongs to. The contact
 * button shares the sender's OWN verified number (the cabinet's spoof-proof
 * rule), so matching it against the login phone is the same trust the client
 * link already runs on.
 */
export async function staffByPhone(phone: string): Promise<StaffChat | null> {
  const rows = await db
    .select({ id: users.id, fullName: users.fullName, locale: users.locale, phone: users.phone })
    .from(users)
    .where(eq(users.active, true));
  const hit = rows.find((u) => staffPhonesMatch(phone, u.phone));
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
/**
 * The owner's evening summary, on demand (his 7a: «har kuni 20:00 faqat
 * sizga»). Drawn only for the person the summary is for — `holatFor` — and
 * re-asked on every press, because a keyboard outlives the grant it was
 * drawn for.
 */
export const HOLAT = '📊 Holat';

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
   * ✅/❌ on a calc↔prixod guess (0119). `requestPrefix` is the first 8 hex
   * of the request the message named, so a press can never land on a
   * calculation the message did not show.
   */
  | { kind: 'calc_link'; receiptId: string; requestPrefix: string; verdict: 'confirm' | 'drop' };

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
      requestPrefix: calcLink[3]!,
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
export function buttonsFor(
  type: string,
  payload: Record<string, unknown>,
): { text: string; callback_data: string }[][] | null {
  if (type === 'TaskAssigned' && typeof payload.taskId === 'string') {
    return [[{ text: '✅ Bajarildi', callback_data: `t:${payload.taskId}` }]];
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

/** How many prixods one «Bu prixodlar hisobingizga tegishlimi?» carries buttons for. */
export const LINK_ASK_BUTTONS = 5;

/**
 * Settle one row of a «tegishlimi?» message (0119): the text keeps what it
 * said and gains the answer; the pressed row goes, every other row and any
 * link row stay — `withoutCallback` takes out exactly the row it names.
 */
export async function settleLinkAskRow(
  chatId: bigint,
  origin: { messageId: number; text: string; markup: unknown },
  data: string,
  line: string,
): Promise<void> {
  const res = await editText({
    chatId,
    messageId: origin.messageId,
    html: appendLine(staffTextHtml(origin.text, 'CalcLinkAsk'), line),
    replyMarkup: keyboardOf(withoutCallback(origin.markup, data)),
  });
  if (!res.ok) logger.warn({ description: res.description }, 'calc link ask not updated');
}

/** A task a day list offers to close — its id and the words on the button. */
export interface DayTask {
  id: string;
  title: string;
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
export function dayButtons(tasks: DayTask[]): { text: string; callback_data: string }[][] | null {
  const rows = tasks
    .filter((task) => typeof task?.id === 'string' && /^[0-9a-f-]{36}$/.test(task.id))
    .slice(0, DAY_BUTTONS)
    .map((task) => [
      { text: `✅ ${buttonLabel(String(task.title ?? ''), 'Vazifa')}`, callback_data: `tb:${task.id}` },
    ]);
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
export interface TaskOrigin {
  messageId: number;
  /** The message's plain text as Telegram holds it (callbackQuery.message). */
  text: string;
  /** Its keyboard at the moment of the press. */
  markup: unknown;
  kind: 'single' | 'list';
}

export interface PendingTask {
  taskId: string;
  origin: TaskOrigin | null;
}

const pendingResults = new Map<string, PendingTask & { expires: number }>();
/** Chats that pressed «Hodim» and were asked for their phone. */
const staffEntryIntents = new Map<string, number>();

export function noteTaskPending(chatId: bigint, taskId: string, origin: TaskOrigin | null = null): void {
  pendingResults.set(String(chatId), { taskId, origin, expires: Date.now() + PENDING_TTL_MS });
}

export function takeTaskPending(chatId: bigint): PendingTask | null {
  const key = String(chatId);
  const entry = pendingResults.get(key);
  if (!entry) return null;
  pendingResults.delete(key);
  return entry.expires > Date.now() ? { taskId: entry.taskId, origin: entry.origin } : null;
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
 */
export async function closeTaskMessage(
  chatId: bigint,
  pending: PendingTask,
  result: string,
): Promise<void> {
  const origin = pending.origin;
  if (!origin) return;
  const res =
    origin.kind === 'list'
      ? await editMarkup({
          chatId,
          messageId: origin.messageId,
          replyMarkup: keyboardOf(withoutCallback(origin.markup, `tb:${pending.taskId}`)),
        })
      : await editText({
          chatId,
          messageId: origin.messageId,
          html: appendLine(
            staffTextHtml(origin.text, 'TaskAssigned'),
            result ? `✅ Yopildi — ${result}` : '✅ Yopildi',
          ),
          replyMarkup: keyboardOf(urlRowsOf(origin.markup)),
        });
  if (!res.ok) logger.warn({ description: res.description }, 'task message not updated');
}

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

export type BotTaskResult = 'done' | 'not_linked' | 'not_yours' | 'already_closed' | 'not_found';

/**
 * Close a task from the bot, as the person the CHAT belongs to. The service
 * enforces whose task it is (`canActOnTask`) — the bot only supplies an
 * honestly-identified actor, never a synthetic admin.
 */
export async function completeTaskFromBot(
  chatId: bigint,
  taskId: string,
  result: string,
): Promise<BotTaskResult> {
  const staff = await staffForChat(chatId);
  if (!staff) return 'not_linked';
  try {
    await completeTask(taskId, result, {
      actorId: staff.id,
      actor: { id: staff.id, permissions: await permissionsOf(staff.id) },
    });
    return 'done';
  } catch (err) {
    if (err instanceof TaskError) {
      if (err.code === 'not_yours') return 'not_yours';
      if (err.code === 'already_closed') return 'already_closed';
      if (err.code === 'not_found') return 'not_found';
    }
    throw err;
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
