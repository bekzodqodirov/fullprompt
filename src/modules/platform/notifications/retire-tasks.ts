import { and, eq, gte, inArray, lt, notInArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import { auditLog, notifications, tasks, users } from '../db/schema';
import { logger } from '../logger';

/**
 * A task's Telegram copies stop offering buttons once the task is no longer
 * the assignee's to act on (docs/TELEGRAM-TOPSHIRIQ.md §4, review
 * telegram-mechanics-2/5/6/7) — the shape of `retireApprovalCopies`.
 *
 * Three moves, in this order:
 *  1. copies still PENDING are muted («closed before it was sent») — the
 *     author's own «🗑 Bekor qilish» seconds after creating a task makes this
 *     the common case, not an edge: the assignee's copy is still in the queue;
 *  2. a sent SINGLE-task copy (`TASK_COPY_TYPES`) is edited to its own text
 *     plus the outcome line, its callback buttons gone and its link kept;
 *  3. a sent `TasksDue` — the 08:00 digest, up to eight tasks' «✅» rows —
 *     keeps its TEXT, and only its keyboard is redrawn from the tasks it
 *     listed that are still open. Stamping it «✅ Bajarildi» would wipe the
 *     buttons of seven other open tasks (the review's blocker).
 * The drain re-checks at send time too (`taskCopyStillLive`): a copy it held
 * in «sending» at this moment is never seen here.
 *
 * Callers run it AFTER their transaction commits (#714), never inside one,
 * and off the request or the poller (`retireTaskCopiesSoon`, #706).
 */
export type TaskCopyOutcome = 'done' | 'cancelled' | 'reassigned';

export interface RetireTaskCopiesInput {
  taskIds: string[];
  outcome: TaskCopyOutcome;
  /** Nothing older can be one of its copies (bounds the scan). */
  since?: Date;
  /** On a reassign: the NEW assignee, whose fresh copy must survive. */
  exceptUserIds?: string[];
  /**
   * Copies made at or after this moment are the change's OWN messages (the
   * new holder's «🆕 Sizga vazifa o‘tkazildi», the author's «boshqaga
   * o‘tdi») and are left alone — A→B→A must not stamp A's fresh copy «given
   * to someone else» (telegram-mechanics-6).
   */
  until?: Date;
  /** The message a press is editing itself — two edits must not race on it. */
  exceptMessages?: { chatId: number; messageId: number }[];
}

/**
 * Every type whose message carries ONE task's buttons. Fenced against the
 * types `buttonsFor` draws a task callback for (retire-tasks.test.ts): a
 * fifth that carries buttons and is missing here keeps them for ever.
 */
export const TASK_COPY_TYPES = [
  'TaskAssigned',
  'TaskReminder',
  'TaskAnswer',
  'TaskQuestion',
  'TaskReassigned',
] as const;

/** The digest: many tasks, one message — redrawn, never stamped. */
export const TASK_LIST_TYPE = 'TasksDue';

/** The line a retired single-task copy gains. */
export const OUTCOME_LINES: Record<TaskCopyOutcome, string> = {
  done: '✅ Bajarildi',
  cancelled: '🗑 Bekor qilindi',
  reassigned: '👤 Boshqaga berildi',
};

/**
 * Telegram refuses to edit a message older than 48 hours, so nothing older is
 * tried: a long-overdue task can have a digest copy for every morning it sat,
 * and dozens of doomed edits, each on a 10-second deadline, are a burst for
 * nothing (telegram-mechanics-7).
 */
export const EDIT_WINDOW_MS = 48 * 3_600_000;

/** `IN (…)` over a JS list — bound one by one, never as one array (CLAUDE.md). */
function oneOf(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
}

/**
 * Everyone who could hold a copy: the author (a question, a «boshqaga o‘tdi»)
 * and EVERY person the task has been assigned to — the current one and each
 * one a reassign moved it from, read off the task's own audit rows. Asking by
 * person is what lets the scan use `notifications_user_idx` instead of reading
 * the whole table for a payload no index covers.
 */
async function holdersOf(taskIds: string[]): Promise<string[]> {
  const people = new Set<string>();
  const rows = await db
    .select({ assigneeId: tasks.assigneeId, createdBy: tasks.createdBy })
    .from(tasks)
    .where(inArray(tasks.id, taskIds));
  for (const row of rows) {
    people.add(row.assigneeId);
    people.add(row.createdBy);
  }
  const moves = await db
    .select({ before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'task'), inArray(auditLog.entityId, taskIds)));
  for (const move of moves) {
    for (const side of [move.before, move.after] as { assigneeId?: unknown }[]) {
      if (side && typeof side.assigneeId === 'string') people.add(side.assigneeId);
    }
  }
  return [...people];
}

export async function retireTaskCopies(input: RetireTaskCopiesInput): Promise<number> {
  const taskIds = [...new Set(input.taskIds)];
  if (taskIds.length === 0) return 0;
  const people = await holdersOf(taskIds);
  if (people.length === 0) return 0;
  const except = input.exceptUserIds ?? [];
  const bounds = (from: Date) =>
    and(
      eq(notifications.channel, 'telegram'),
      inArray(notifications.userId, people),
      except.length > 0 ? notInArray(notifications.userId, except) : undefined,
      gte(notifications.createdAt, from),
      input.until ? lt(notifications.createdAt, input.until) : undefined,
    );

  // 1. Not sent yet: muted, terminal, not a delivery problem.
  await db
    .update(notifications)
    .set({ status: 'muted', error: 'closed before it was sent' })
    .where(
      and(
        bounds(input.since ?? new Date(0)),
        eq(notifications.status, 'pending'),
        inArray(notifications.type, [...TASK_COPY_TYPES]),
        sql`${notifications.payload}->>'taskId' IN (${oneOf(taskIds)})`,
      ),
    );

  // No bot, no copies were ever sent — the drain's own first line.
  if (!process.env.TELEGRAM_BOT_TOKEN) return 0;
  const windowStart = new Date(Math.max(input.since?.getTime() ?? 0, Date.now() - EDIT_WINDOW_MS));
  const rows = await db
    .select({ id: notifications.id, type: notifications.type, payload: notifications.payload, locale: users.locale })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(
      and(
        bounds(windowStart),
        eq(notifications.status, 'sent'),
        sql`${notifications.payload}->'tg' IS NOT NULL`,
        sql`(
          (${notifications.type} IN (${oneOf([...TASK_COPY_TYPES])})
            AND ${notifications.payload}->>'taskId' IN (${oneOf(taskIds)}))
          OR (${notifications.type} = ${TASK_LIST_TYPE}
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(${notifications.payload}->'tasks') = 'array'
                       THEN ${notifications.payload}->'tasks' ELSE '[]'::jsonb END) e
                 WHERE e->>'id' IN (${oneOf(taskIds)}))))`,
      ),
    );
  if (rows.length === 0) return 0;

  const { composeStaffMessage } = await import('./service');
  const { appendLine, keyboardOf } = await import('./staff-html');
  const { editMarkup, editText } = await import('../telegram/send');
  const { dayButtons } = await import('../telegram/staff-bot');

  // The digests' other tasks, in ONE status query.
  const listed = new Set<string>();
  for (const row of rows) {
    if (row.type !== TASK_LIST_TYPE) continue;
    for (const entry of listEntries(row.payload)) listed.add(entry.id);
  }
  const stillOpen = new Set<string>();
  if (listed.size > 0) {
    const open = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(inArray(tasks.id, [...listed]), eq(tasks.status, 'open')));
    for (const row of open) stillOpen.add(row.id);
  }

  const skip = new Set((input.exceptMessages ?? []).map((m) => `${m.chatId}:${m.messageId}`));
  let edited = 0;
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    const tg = payload.tg as { chatId?: unknown; messageId?: unknown } | undefined;
    const chatId = Number(tg?.chatId);
    const messageId = Number(tg?.messageId);
    if (!Number.isFinite(chatId) || !Number.isInteger(messageId)) continue;
    const key = `${chatId}:${messageId}`;
    if (skip.has(key)) continue;
    skip.add(key);
    const message = composeStaffMessage(row.type, payload, row.locale);
    const linkRow = message.urlRow ? [message.urlRow] : [];
    const res =
      row.type === TASK_LIST_TYPE
        ? await editMarkup({
            chatId,
            messageId,
            // Nothing left open: no markup at all, which Telegram reads as
            // «remove the keyboard» (an empty one it refuses).
            replyMarkup: keyboardOf([
              ...(dayButtons(listEntries(payload).filter((entry) => stillOpen.has(entry.id))) ?? []),
              ...linkRow,
            ]),
          })
        : await editText({
            chatId,
            messageId,
            html: appendLine(message.html, OUTCOME_LINES[input.outcome]),
            replyMarkup: keyboardOf(linkRow),
          });
    if (res.ok) edited += 1;
    else logger.warn({ notificationId: row.id, description: res.description }, '[tasks] task copy not retired');
  }
  return edited;
}

/** A digest's listed tasks, read defensively — jsonb has no type. */
function listEntries(payload: unknown): { id: string; title: string; calc?: string | null }[] {
  const list = (payload as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (entry): entry is { id: string; title: string; calc?: string | null } =>
      typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string',
  );
}

/**
 * The fire-and-forget form for a request path or the bot's sequential poller
 * (#706): a slow Telegram edit must never hold either.
 */
export function retireTaskCopiesSoon(input: RetireTaskCopiesInput): void {
  if (input.taskIds.length === 0) return;
  void retireTaskCopies(input).catch((err: unknown) => {
    logger.error({ err, taskIds: input.taskIds }, '[tasks] retiring Telegram copies failed');
  });
}
