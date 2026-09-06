import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import {
  permissions,
  rolePermissions,
  telegramLinks,
  userRoles,
  users,
  userWarehouses,
} from '../db/schema';
import { writeAudit } from '../audit/service';
import { loadUserRoles } from '../rbac/authorize';
import { completeTask, TaskError } from '../tasks/service';
import { allLabelVariants } from './client-labels';

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
    t === '/zametka'
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
  return (['btnCargo', 'btnBalance', 'btnHistory', 'btnLanguage'] as const).some((key) =>
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
  | { kind: 'task_done'; taskId: string }
  | { kind: 'approval'; approvalId: string; verdict: 'approved' | 'refused' }
  | { kind: 'entry'; who: 'staff' | 'client' }
  | { kind: 'calc'; step: CalcStep }
  | { kind: 'note'; step: NoteStep; noteId?: string; page?: number };

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
  'cert',
  'skip',
  'done',
  'save',
  'more',
  'cancel',
] as const;

export type CalcStep = (typeof CALC_STEPS)[number];

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
  return null;
}

// ---------------------------------------------------------------------------
// Two-step task completion: the button asks for the result, the next text
// message delivers it. In-memory with a TTL — single-process polling, same
// as the web connect flow's pending logins.
// ---------------------------------------------------------------------------

const PENDING_TTL_MS = 10 * 60_000;
const pendingResults = new Map<string, { taskId: string; expires: number }>();
/** Chats that pressed «Hodim» and were asked for their phone. */
const staffEntryIntents = new Map<string, number>();

export function noteTaskPending(chatId: bigint, taskId: string): void {
  pendingResults.set(String(chatId), { taskId, expires: Date.now() + PENDING_TTL_MS });
}

export function takeTaskPending(chatId: bigint): string | null {
  const key = String(chatId);
  const entry = pendingResults.get(key);
  if (!entry) return null;
  pendingResults.delete(key);
  return entry.expires > Date.now() ? entry.taskId : null;
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

async function permissionsOf(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ code: permissions.code })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(userRoles.userId, userId));
  return new Set(rows.map((r) => r.code));
}

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
  const roleRows = await loadUserRoles(staff.id);
  const whRows = await db
    .select({ warehouseId: userWarehouses.warehouseId })
    .from(userWarehouses)
    .where(eq(userWarehouses.userId, staff.id));
  return {
    ...staff,
    permissions: await permissionsOf(staff.id),
    // The role CODES ride along for the one decision made on a role rather
    // than a grant: whether the AI assistant's analyst tier opens (round 21's
    // shape — supervision breadth is super_admin/admin, not a permission).
    roles: roleRows.map((r) => r.code),
    warehouseScoped: roleRows.some((r) => r.warehouseScoped),
    warehouseIds: whRows.map((w) => w.warehouseId),
  };
}

/**
 * "Where is it?" from the bot. The wms lookup is reached by dynamic import —
 * platform never imports wms statically (the startBoss crossing).
 */
export async function lookupFromBot(chatId: bigint, query: string): Promise<string | null> {
  const actor = await botActorFor(chatId);
  if (!actor) return null;
  const { botLookup } = await import('../../wms/bot/lookup');
  return botLookup(actor, query);
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

export type BotApprovalResult =
  | 'decided'
  | 'not_linked'
  | 'forbidden'
  | 'already_decided'
  | 'not_found';

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
    );
    return 'decided';
  } catch (err) {
    if (err instanceof ApprovalError) {
      if (err.code === 'already_decided') return 'already_decided';
      if (err.code === 'not_found') return 'not_found';
    }
    throw err;
  }
}
