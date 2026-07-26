import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Db, type Tx } from '../db/client';
import { taskTypes, tasks, users } from '../db/schema';
import { writeAudit, type AuditContext } from '../audit/service';
import { entitySpec } from '../fields/registry';

/**
 * Work one person gives another (owner: "tasklar calendarlar").
 *
 * A task is NOT the CRM follow-up. A follow-up is a reminder a sales manager
 * sets for themselves on a lead; a task is assigned, has an owner who is not
 * necessarily its author, and is closed with a result. Both appear on `/bugun`;
 * neither was rewritten into the other, because the follow-up works and is used
 * every day.
 *
 * A task can point at any object the entity registry knows — a client, a
 * receipt, a batch — or at nothing at all.
 */

export class TaskError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export const taskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  note: z.string().trim().max(4000).optional().or(z.literal('')),
  typeId: z.string().uuid().nullable().default(null),
  assigneeId: z.string().uuid(),
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`; empty = no deadline. */
  dueAt: z.string().trim().max(40).optional().or(z.literal('')),
  priority: z.number().int().min(1).max(3).default(2),
  entityType: z.string().trim().max(40).nullable().default(null),
  entityId: z.string().uuid().nullable().default(null),
});
export type TaskInput = z.infer<typeof taskSchema>;

/**
 * Turn what a form typed into a moment, and say whether it named a time.
 *
 * A date alone means the whole day, which matters twice: the calendar must not
 * print "09:00" for a deadline nobody set, and "is it due today" has to compare
 * days rather than instants or every all-day task looks overdue from midnight.
 */
export function parseDue(raw: string | undefined | null): { dueAt: Date | null; allDay: boolean } {
  const value = (raw ?? '').trim();
  if (!value) return { dueAt: null, allDay: true };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // End of that day: a task due "Friday" is not late at 00:01 on Friday.
    return { dueAt: new Date(`${value}T23:59:59.999Z`), allDay: true };
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TaskError('bad_due_date');
  return { dueAt: parsed, allDay: false };
}

export interface TaskRow {
  id: string;
  title: string;
  note: string | null;
  typeId: string | null;
  typeName: string | null;
  typeIcon: string | null;
  assigneeId: string;
  assigneeName: string | null;
  createdBy: string;
  authorName: string | null;
  dueAt: Date | null;
  allDay: boolean;
  status: string;
  doneAt: Date | null;
  result: string | null;
  entityType: string | null;
  entityId: string | null;
  priority: number;
  createdAt: Date;
}

const assignee = users;

function selection() {
  return {
    id: tasks.id,
    title: tasks.title,
    note: tasks.note,
    typeId: tasks.typeId,
    typeName: taskTypes.name,
    typeIcon: taskTypes.icon,
    assigneeId: tasks.assigneeId,
    assigneeName: assignee.fullName,
    createdBy: tasks.createdBy,
    authorName: sql<string | null>`(SELECT full_name FROM users WHERE id = ${tasks.createdBy})`,
    dueAt: tasks.dueAt,
    allDay: tasks.allDay,
    status: tasks.status,
    doneAt: tasks.doneAt,
    result: tasks.result,
    entityType: tasks.entityType,
    entityId: tasks.entityId,
    priority: tasks.priority,
    createdAt: tasks.createdAt,
  };
}

function base() {
  return db
    .select(selection())
    .from(tasks)
    .leftJoin(taskTypes, eq(tasks.typeId, taskTypes.id))
    .leftJoin(assignee, eq(tasks.assigneeId, assignee.id));
}

export async function createTask(input: TaskInput, ctx: AuditContext): Promise<TaskRow> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  if (input.entityType && !entitySpec(input.entityType)) throw new TaskError('unknown_entity');
  // A pointer is whole or absent; the database says so too, but a caller
  // deserves a coded error rather than a constraint violation.
  if (Boolean(input.entityType) !== Boolean(input.entityId)) throw new TaskError('half_pointer');

  const person = await db.query.users.findFirst({ where: eq(users.id, input.assigneeId) });
  if (!person) throw new TaskError('no_assignee');
  // Giving work to someone who has left is how a task disappears: nobody sees
  // it on a screen they no longer open.
  if (!person.active) throw new TaskError('assignee_inactive');

  const { dueAt, allDay } = parseDue(input.dueAt);
  const [row] = await db
    .insert(tasks)
    .values({
      title: input.title,
      note: input.note || null,
      typeId: input.typeId,
      assigneeId: input.assigneeId,
      createdBy: ctx.actorId,
      dueAt,
      allDay,
      priority: input.priority,
      entityType: input.entityType,
      entityId: input.entityId,
    })
    .returning();
  if (!row) throw new TaskError('not_created');

  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: row.id,
    action: 'create',
    after: {
      title: input.title,
      assigneeId: input.assigneeId,
      dueAt: dueAt?.toISOString() ?? null,
      about: input.entityType ? `${input.entityType}:${input.entityId}` : null,
    },
  });
  return (await byId(row.id))!;
}

export async function byId(id: string): Promise<TaskRow | null> {
  const [row] = await base().where(eq(tasks.id, id)).limit(1);
  return row ?? null;
}

/** Close a task with what actually happened. */
export async function completeTask(
  id: string,
  result: string,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const before = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!before) throw new TaskError('not_found');
  if (before.status !== 'open') throw new TaskError('already_closed');

  await db
    .update(tasks)
    .set({
      status: 'done',
      doneAt: new Date(),
      doneBy: ctx.actorId,
      result: result.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id));
  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: id,
    action: 'status_change',
    before: { status: before.status },
    after: { status: 'done', result: result.trim() || null },
  });
}

/**
 * Cancel rather than delete.
 *
 * A task somebody was given and then told to drop is a fact about how the work
 * went; deleting it removes the evidence that it was ever asked for.
 */
export async function cancelTask(id: string, reason: string, ctx: AuditContext): Promise<void> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const before = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!before) throw new TaskError('not_found');
  if (before.status !== 'open') throw new TaskError('already_closed');
  await db
    .update(tasks)
    .set({ status: 'cancelled', result: reason.trim() || null, updatedAt: new Date() })
    .where(eq(tasks.id, id));
  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: id,
    action: 'status_change',
    before: { status: 'open' },
    after: { status: 'cancelled', reason: reason.trim() || null },
  });
}

/** Hand a task to somebody else — the everyday move in a small company. */
export async function reassignTask(
  id: string,
  assigneeId: string,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const before = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!before) throw new TaskError('not_found');
  if (before.status !== 'open') throw new TaskError('already_closed');
  const person = await db.query.users.findFirst({ where: eq(users.id, assigneeId) });
  if (!person?.active) throw new TaskError('assignee_inactive');

  await db.update(tasks).set({ assigneeId, updatedAt: new Date() }).where(eq(tasks.id, id));
  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: id,
    action: 'update',
    before: { assigneeId: before.assigneeId },
    after: { assigneeId },
  });
}

export async function updateTask(
  id: string,
  input: Pick<TaskInput, 'title' | 'note' | 'typeId' | 'dueAt' | 'priority'>,
  ctx: AuditContext,
): Promise<void> {
  if (!ctx.actorId) throw new TaskError('unauthenticated');
  const before = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  if (!before) throw new TaskError('not_found');
  if (before.status !== 'open') throw new TaskError('already_closed');
  const { dueAt, allDay } = parseDue(input.dueAt);
  await db
    .update(tasks)
    .set({
      title: input.title,
      note: input.note || null,
      typeId: input.typeId,
      dueAt,
      allDay,
      priority: input.priority,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id));
  await writeAudit(db, ctx, {
    entityType: 'task',
    entityId: id,
    action: 'update',
    before: { title: before.title, dueAt: before.dueAt?.toISOString() ?? null },
    after: { title: input.title, dueAt: dueAt?.toISOString() ?? null },
  });
}

/** Everything outstanding on one record — the panel on a card. */
export async function tasksFor(entityType: string, entityId: string): Promise<TaskRow[]> {
  return base()
    .where(and(eq(tasks.entityType, entityType), eq(tasks.entityId, entityId)))
    .orderBy(
      // Open first, then by deadline, then newest.
      sql`CASE WHEN ${tasks.status} = 'open' THEN 0 ELSE 1 END`,
      sql`${tasks.dueAt} NULLS LAST`,
      desc(tasks.createdAt),
    )
    .limit(200);
}

export interface DayFilter {
  /** Whose tasks; omit for everyone (only for people allowed to see that). */
  assigneeId?: string;
  /** Inclusive day boundaries. */
  from?: Date;
  to?: Date;
  status?: 'open' | 'done' | 'cancelled' | 'all';
}

export async function listTasks(filter: DayFilter): Promise<TaskRow[]> {
  const where = [];
  if (filter.assigneeId) where.push(eq(tasks.assigneeId, filter.assigneeId));
  if (filter.status && filter.status !== 'all') where.push(eq(tasks.status, filter.status));
  else if (!filter.status) where.push(eq(tasks.status, 'open'));
  if (filter.from) where.push(gte(tasks.dueAt, filter.from));
  if (filter.to) where.push(lte(tasks.dueAt, filter.to));

  return base()
    .where(where.length ? and(...where) : undefined)
    .orderBy(sql`${tasks.dueAt} NULLS LAST`, asc(tasks.priority), desc(tasks.createdAt))
    .limit(500);
}

/**
 * What one person has to deal with today: overdue first, then today, then
 * anything with no deadline at all.
 *
 * "Today" is compared against the END of the day, so an all-day task set for
 * today is not reported as late from one minute past midnight.
 */
export async function myDay(
  assigneeId: string,
  endOfToday: Date,
): Promise<{ overdue: TaskRow[]; today: TaskRow[]; undated: TaskRow[] }> {
  const rows = await base()
    .where(
      and(
        eq(tasks.assigneeId, assigneeId),
        eq(tasks.status, 'open'),
        or(lte(tasks.dueAt, endOfToday), isNull(tasks.dueAt)),
      ),
    )
    .orderBy(sql`${tasks.dueAt} NULLS LAST`, asc(tasks.priority))
    .limit(300);

  const startOfToday = new Date(endOfToday);
  startOfToday.setUTCHours(0, 0, 0, 0);

  return {
    overdue: rows.filter((row) => row.dueAt !== null && row.dueAt < startOfToday),
    today: rows.filter((row) => row.dueAt !== null && row.dueAt >= startOfToday),
    undated: rows.filter((row) => row.dueAt === null),
  };
}

/** How many open tasks each person is carrying — for the assignment picker. */
export async function openCounts(): Promise<Map<string, number>> {
  const rows = await db
    .select({ assigneeId: tasks.assigneeId, n: sql<number>`count(*)` })
    .from(tasks)
    .where(eq(tasks.status, 'open'))
    .groupBy(tasks.assigneeId);
  return new Map(rows.map((row) => [row.assigneeId, Number(row.n)]));
}

/**
 * Tasks due in a window, for the calendar.
 *
 * The window is widened to WHOLE DAYS. A caller asking for "the 1st to the
 * 31st" means the whole of the 31st, and an all-day task is stored at 23:59 on
 * its day — so comparing against the caller's own clock silently dropped every
 * all-day task on the last day of the month. Found by the test.
 */
export async function calendarTasks(
  from: Date,
  to: Date,
  assigneeId?: string,
): Promise<TaskRow[]> {
  const start = new Date(from);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(23, 59, 59, 999);
  const where = [gte(tasks.dueAt, start), lte(tasks.dueAt, end), ne(tasks.status, 'cancelled')];
  if (assigneeId) where.push(eq(tasks.assigneeId, assigneeId));
  return base()
    .where(and(...where))
    .orderBy(asc(tasks.dueAt), asc(tasks.priority))
    .limit(1000);
}

/**
 * Open tasks that went past their deadline — the nudge the digest sends.
 *
 * Grouped by assignee, because one message listing three tasks beats three
 * messages, and a person who ignores a stream of pings ignores all of them.
 */
export async function overdueByAssignee(now: Date): Promise<Map<string, TaskRow[]>> {
  const rows = await base()
    .where(and(eq(tasks.status, 'open'), lt(tasks.dueAt, now)))
    .orderBy(asc(tasks.dueAt))
    .limit(1000);
  const out = new Map<string, TaskRow[]>();
  for (const row of rows) out.set(row.assigneeId, [...(out.get(row.assigneeId) ?? []), row]);
  return out;
}

export async function listTaskTypes(includeInactive = false) {
  return db
    .select()
    .from(taskTypes)
    .where(includeInactive ? undefined : eq(taskTypes.active, true))
    .orderBy(asc(taskTypes.sortOrder), asc(taskTypes.name));
}

/** Titles for the records tasks point at, so a list can say what it is about. */
export async function aboutLabels(rows: TaskRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byType = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.entityType || !row.entityId) continue;
    byType.set(row.entityType, [...(byType.get(row.entityType) ?? []), row.entityId]);
  }
  for (const [type, ids] of byType) {
    const spec = entitySpec(type)?.lookup;
    if (!spec) continue;
    const found = await db.execute<{ id: string; label: string | null; secondary: string | null }>(
      sql`SELECT id::text AS id,
                 ${sql.identifier(spec.label)}::text AS label,
                 ${spec.secondary ? sql.identifier(spec.secondary) : sql`NULL`}::text AS secondary
          FROM ${sql.identifier(spec.table)}
          WHERE id IN (${sql.join([...new Set(ids)].map((id) => sql`${id}::uuid`), sql`, `)})`,
    );
    for (const row of found) {
      out.set(`${type}:${row.id}`, [row.secondary, row.label].filter(Boolean).join(' · '));
    }
  }
  return out;
}

/** Cancel every open task on a record — for when the record itself goes. */
export async function cancelTasksFor(
  dbOrTx: Db | Tx,
  entityType: string,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  await dbOrTx
    .update(tasks)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(
      and(
        eq(tasks.entityType, entityType),
        inArray(tasks.entityId, entityIds),
        eq(tasks.status, 'open'),
      ),
    );
}
