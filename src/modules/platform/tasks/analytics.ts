import { and, eq, gte, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { tasks, users } from '../db/schema';

/**
 * How the work is going — the whole company, one screen (round 47, owner's
 * item 12: «umumiy zadachalar qanday bo'lyabti analiz qiladigan page bormi
 * bizda … ha qurib ber (bu kun analizi uchun kerak)»).
 *
 * `/bugun` answers "what is on ME today". Nothing answered "is the team on
 * top of it" — who is buried, whose deadlines slipped, whether today closed
 * more than it opened. That is a different question and it belongs to whoever
 * runs the day, so this reads every person's tasks.
 *
 * Deliberately about the day and the week. A quarter's average is a report
 * nobody acts on; «three of Aziz's four are late» is a phone call.
 *
 * DAYS ARE UTC DAYS, on purpose and not by oversight. `parseDue` has stored an
 * all-day deadline as 23:59:59.999Z since phase 3 and `/bugun` measures
 * «overdue» against `endOfToday()`, which is UTC — so counting local days here
 * would make this screen disagree with the one people actually work from, for
 * five hours every evening. Moving the whole convention to Tashkent time is a
 * real decision, but it has to move both screens at once.
 *
 * `now` is passed in rather than read here, so a test can state a moment
 * instead of waiting for midnight.
 */

export interface TaskPulse {
  /** Open, not yet due (or with no deadline at all). */
  open: number;
  /** Open and past its deadline — the number that means somebody must act. */
  overdue: number;
  /** Open and due before the end of today. */
  dueToday: number;
  /** Finished since midnight. */
  doneToday: number;
  /** Opened since midnight. */
  createdToday: number;
}

export interface PersonPulse extends TaskPulse {
  userId: string;
  fullName: string;
  /** Finished in the last seven days. */
  doneWeek: number;
  /**
   * Median hours from creation to completion over those seven days, or null
   * when the person finished nothing. The MEDIAN, not the mean: one task
   * somebody left open over a holiday moves a mean by days and says nothing
   * about how the week actually went.
   */
  medianHours: number | null;
}

/** Midnight to midnight, UTC — see the note at the top of the file. */
function dayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/** The company's day in five numbers. */
export async function taskPulse(now: Date): Promise<TaskPulse> {
  const { start, end } = dayBounds(now);
  const [row] = await db
    .select({
      open: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'open')`,
      overdue: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'open' AND ${tasks.dueAt} < ${now.toISOString()}::timestamptz)`,
      dueToday: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'open' AND ${tasks.dueAt} >= ${start.toISOString()}::timestamptz AND ${tasks.dueAt} < ${end.toISOString()}::timestamptz)`,
      doneToday: sql<number>`count(*) FILTER (WHERE ${tasks.doneAt} >= ${start.toISOString()}::timestamptz AND ${tasks.doneAt} < ${end.toISOString()}::timestamptz)`,
      createdToday: sql<number>`count(*) FILTER (WHERE ${tasks.createdAt} >= ${start.toISOString()}::timestamptz AND ${tasks.createdAt} < ${end.toISOString()}::timestamptz)`,
    })
    .from(tasks)
    .where(ne(tasks.status, 'cancelled'));
  return {
    open: Number(row?.open ?? 0),
    overdue: Number(row?.overdue ?? 0),
    dueToday: Number(row?.dueToday ?? 0),
    doneToday: Number(row?.doneToday ?? 0),
    createdToday: Number(row?.createdToday ?? 0),
  };
}

/**
 * The same numbers per person, plus the week.
 *
 * Everyone who currently HOLDS a task or finished one this week appears; a
 * user with nothing to do is not a row on a workload screen. Ordered by the
 * number that matters — late first, then busiest.
 */
export async function peoplePulse(now: Date): Promise<PersonPulse[]> {
  const { start, end } = dayBounds(now);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db
    .select({
      userId: tasks.assigneeId,
      fullName: users.fullName,
      open: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'open')`,
      overdue: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'open' AND ${tasks.dueAt} < ${now.toISOString()}::timestamptz)`,
      dueToday: sql<number>`count(*) FILTER (WHERE ${tasks.status} = 'open' AND ${tasks.dueAt} >= ${start.toISOString()}::timestamptz AND ${tasks.dueAt} < ${end.toISOString()}::timestamptz)`,
      doneToday: sql<number>`count(*) FILTER (WHERE ${tasks.doneAt} >= ${start.toISOString()}::timestamptz AND ${tasks.doneAt} < ${end.toISOString()}::timestamptz)`,
      createdToday: sql<number>`count(*) FILTER (WHERE ${tasks.createdAt} >= ${start.toISOString()}::timestamptz AND ${tasks.createdAt} < ${end.toISOString()}::timestamptz)`,
      doneWeek: sql<number>`count(*) FILTER (WHERE ${tasks.doneAt} >= ${weekAgo.toISOString()}::timestamptz)`,
      medianHours: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (${tasks.doneAt} - ${tasks.createdAt})) / 3600
      ) FILTER (WHERE ${tasks.doneAt} >= ${weekAgo.toISOString()}::timestamptz)`,
    })
    .from(tasks)
    .innerJoin(users, eq(tasks.assigneeId, users.id))
    .where(
      and(
        ne(tasks.status, 'cancelled'),
        // Everything that is still work, plus everything finished this week.
        or(eq(tasks.status, 'open'), gte(tasks.doneAt, weekAgo)),
      ),
    )
    .groupBy(tasks.assigneeId, users.fullName);

  return rows
    .map((row) => ({
      userId: row.userId,
      fullName: row.fullName,
      open: Number(row.open),
      overdue: Number(row.overdue),
      dueToday: Number(row.dueToday),
      doneToday: Number(row.doneToday),
      createdToday: Number(row.createdToday),
      doneWeek: Number(row.doneWeek),
      medianHours: row.medianHours === null ? null : Math.round(Number(row.medianHours) * 10) / 10,
    }))
    .sort((a, b) => b.overdue - a.overdue || b.open - a.open || a.fullName.localeCompare(b.fullName));
}

export interface StaleTask {
  id: string;
  title: string;
  assigneeName: string;
  dueAt: Date | null;
  /** Whole days past the deadline. */
  lateDays: number;
  entityType: string | null;
  entityId: string | null;
}

/**
 * The worst of it, by name.
 *
 * A count tells the owner there is a problem; this tells him which one to
 * pick up. Ordered by how long it has been late, because the oldest late task
 * is almost always the one everybody has stopped seeing.
 */
export async function stalestTasks(now: Date, limit = 10): Promise<StaleTask[]> {
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      assigneeName: users.fullName,
      dueAt: tasks.dueAt,
      entityType: tasks.entityType,
      entityId: tasks.entityId,
    })
    .from(tasks)
    .innerJoin(users, eq(tasks.assigneeId, users.id))
    .where(and(eq(tasks.status, 'open'), isNotNull(tasks.dueAt), lt(tasks.dueAt, now)))
    .orderBy(tasks.dueAt)
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    lateDays: row.dueAt
      ? Math.floor((now.getTime() - row.dueAt.getTime()) / 86_400_000)
      : 0,
  }));
}

/**
 * Open work that nobody has put a date on.
 *
 * Not a defect — «sometime» is a real answer (the task form says so) — but a
 * pile of undated tasks is where work goes to be forgotten, and it is the one
 * number on this screen that no other screen can show: an undated task never
 * appears on anybody's «bugun».
 */
export async function undatedOpen(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.status, 'open'), isNull(tasks.dueAt)));
  return Number(row?.n ?? 0);
}

/**
 * Opened vs finished, day by day, for the last two weeks.
 *
 * The one thing a snapshot cannot say: whether the pile is growing. Two
 * numbers a day for fourteen days is small enough to read at a glance and
 * long enough to show a trend.
 */
export interface TaskDay {
  day: string;
  created: number;
  done: number;
}

export async function taskTrend(now: Date, days = 14): Promise<TaskDay[]> {
  const { end } = dayBounds(now);
  const from = new Date(end.getTime() - days * 86_400_000);
  const rows = await db
    .select({
      day: sql<string>`to_char(${tasks.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      created: sql<number>`count(*)`,
    })
    .from(tasks)
    .where(and(ne(tasks.status, 'cancelled'), gte(tasks.createdAt, from), lt(tasks.createdAt, end)))
    .groupBy(sql`to_char(${tasks.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);
  const doneRows = await db
    .select({
      day: sql<string>`to_char(${tasks.doneAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      done: sql<number>`count(*)`,
    })
    .from(tasks)
    .where(and(gte(tasks.doneAt, from), lt(tasks.doneAt, end)))
    .groupBy(sql`to_char(${tasks.doneAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);

  const createdBy = new Map(rows.map((row) => [row.day, Number(row.created)]));
  const doneBy = new Map(doneRows.map((row) => [row.day, Number(row.done)]));
  const out: TaskDay[] = [];
  for (let i = days; i >= 1; i -= 1) {
    const key = new Date(end.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day: key, created: createdBy.get(key) ?? 0, done: doneBy.get(key) ?? 0 });
  }
  return out;
}

/** Everything the screen draws, in one round trip's worth of queries. */
export async function taskAnalytics(now: Date) {
  const [pulse, people, stale, undated, trend] = await Promise.all([
    taskPulse(now),
    peoplePulse(now),
    stalestTasks(now),
    undatedOpen(),
    taskTrend(now),
  ]);
  return { pulse, people, stale, undated, trend };
}
