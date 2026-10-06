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
 *
 * Answers the ids it closed (`RETURNING`, review telegram-mechanics-7): the
 * caller retires their Telegram copies AFTER this statement, never inside it.
 */
export async function closeStaleCalcTasks(): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE tasks t
       SET status = 'done',
           done_at = r.completed_at,
           result = coalesce(t.result, 'Hisoblandi'),
           updated_at = now()
      FROM calc_requests r
     WHERE r.task_id = t.id
       AND t.status = 'open'
       AND r.completed_at IS NOT NULL
    RETURNING t.id::text AS id
  `);
  return rows.map((row) => row.id);
}

/**
 * THE GHOSTS — open machine calc tasks no request points at (docs/VED-TARIX.md
 * §8, review data-migration-5).
 *
 * Every «Bo'shatish» before the release fix left one: the request let go of
 * its task (`task_id = NULL`) and the cancel that should have followed read
 * the NEW row's NULL back from `RETURNING`, so the old holder kept a timed
 * priority-1 «Hisoblash: …» on his /bugun and in the 08:00 digest for a job he
 * no longer holds. `closeStaleCalcTasks` joins on `r.task_id` and cannot see
 * them.
 *
 * A ghost is, all at once:
 *   - open, `origin = 'calc'`, and NO `calc_requests.task_id` points at it;
 *   - unbound, or bound to a request that is CLOSED or held by somebody else
 *     — a live job's task whose pointer UPDATE failed after `createTask`
 *     succeeded is still that job's, and stays;
 *   - the machine's own title SHAPE (0124's rule: `Hisoblash: <label> (<n>)`,
 *     priority 1, timed, on a lead or a deal) — a person may type a title that
 *     starts «Hisoblash: » too, and their task is not the machine's.
 *
 * Behind its OWN flag (`--ghosts`) and its own dry run, so the plain
 * `--apply` keeps the meaning the owner was told on 2026-09-19 («a second run
 * does nothing»). A ghost becomes CANCELLED, «Navbatga qaytarildi» — never
 * done, because nobody did the work and every report reading `done_at` would
 * say they had.
 */
function ghostWhereSql() {
  return sql`
        t.status = 'open'
    AND t.origin = 'calc'
    AND NOT EXISTS (SELECT 1 FROM calc_requests p WHERE p.task_id = t.id)
    AND (
          t.bound_id IS NULL
       OR EXISTS (
            SELECT 1 FROM calc_requests b
             WHERE b.id = t.bound_id
               AND (b.completed_at IS NOT NULL OR b.assignee_id IS DISTINCT FROM t.assignee_id)
          )
       OR NOT EXISTS (SELECT 1 FROM calc_requests b WHERE b.id = t.bound_id)
    )
    AND t.title ~ '^Hisoblash: .* \\(\\d+\\)$'
    AND t.priority = 1
    AND t.all_day = false
    AND t.entity_type IN ('lead', 'deal')`;
}

export interface CalcGhostTask {
  taskId: string;
  title: string;
  authorName: string | null;
  assigneeName: string | null;
  createdAt: Date;
}

/** The dry run's list — author, assignee, created date and title. */
export async function calcGhostTasks(): Promise<CalcGhostTask[]> {
  const rows = await db.execute<{
    id: string;
    title: string;
    author: string | null;
    assignee: string | null;
    created_at: string;
  }>(sql`
    SELECT t.id::text AS id, t.title, au.full_name AS author, asg.full_name AS assignee, t.created_at
      FROM tasks t
      LEFT JOIN users au ON au.id = t.created_by
      LEFT JOIN users asg ON asg.id = t.assignee_id
     WHERE ${ghostWhereSql()}
     ORDER BY t.created_at
  `);
  return rows.map((row) => ({
    taskId: row.id,
    title: row.title,
    authorName: row.author,
    assigneeName: row.assignee,
    // Raw-execute timestamps are TEXT (#923).
    createdAt: new Date(row.created_at),
  }));
}

/** Cancel them — «Navbatga qaytarildi», the release's own word. Answers the ids. */
export async function cancelCalcGhostTasks(): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE tasks t
       SET status = 'cancelled',
           result = coalesce(t.result, 'Navbatga qaytarildi'),
           updated_at = now()
     WHERE ${ghostWhereSql()}
    RETURNING t.id::text AS id
  `);
  return rows.map((row) => row.id);
}
