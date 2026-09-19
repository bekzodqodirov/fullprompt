import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcRequests, tasks } from '../../platform/db/schema';

/**
 * The calculation tasks whose job is already finished.
 *
 * The owner, 2026-09-14: «hsoblashga berilganda vazifa ochilyabti va hsoblab
 * topshirgandan keyin vazifani qolda yopishga majbur bolyabti». The automatic
 * half SHIPPED on 2026-09-05 — `endRequest` closes the task whenever a
 * request is finished, returned or sealed — so every calculation since then
 * clears itself. What no deploy can fix is the PILE from before: tasks opened
 * by the old code whose requests were finished the old way, sitting open on
 * somebody's day screen for ever, because nothing will ever finish them
 * again.
 *
 * A module and not just a script, for the usual reason: a rule that lives in
 * `scripts/` can only be proven by running it against whatever the database
 * happens to hold, and the first dry run here found ZERO rows — which proves
 * nothing at all (#494). The test builds the old code's state and watches it
 * clear.
 */

export interface StaleCalcTask {
  taskId: string;
  title: string;
  assigneeId: string | null;
  dueAt: Date | null;
  completedAt: Date | null;
}

/** Open tasks pointing at a CLOSED calculation — nothing else. */
export async function staleCalcTasks(): Promise<StaleCalcTask[]> {
  return db
    .select({
      taskId: tasks.id,
      title: tasks.title,
      assigneeId: tasks.assigneeId,
      dueAt: tasks.dueAt,
      completedAt: calcRequests.completedAt,
    })
    .from(tasks)
    .innerJoin(calcRequests, eq(calcRequests.taskId, tasks.id))
    .where(and(eq(tasks.status, 'open'), isNotNull(calcRequests.completedAt)))
    .orderBy(tasks.dueAt);
}

/**
 * Close them, stamping the time the WORK finished rather than the time this
 * ran — a task closed today against a calculation delivered in August would
 * put a wrong day into every report that reads `done_at`.
 *
 * Idempotent by construction: it only ever touches an OPEN task whose request
 * is CLOSED, so a second run finds nothing. No audit row per task, for the
 * same reason `purgeAttachment` writes none — this is the machine tidying up
 * after itself, and two hundred rows would bury the real history of the cards.
 */
export async function closeStaleCalcTasks(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE tasks t
       SET status = 'done',
           done_at = r.completed_at,
           result = coalesce(t.result, 'Hisoblandi'),
           updated_at = now()
      FROM calc_requests r
     WHERE r.task_id = t.id
       AND t.status = 'open'
       AND r.completed_at IS NOT NULL
  `);
  return Number((result as unknown as { count?: number }).count ?? 0);
}
