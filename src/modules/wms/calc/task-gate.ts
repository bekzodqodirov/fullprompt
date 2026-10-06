import { and, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcRequests, paymentPromises } from '../../platform/db/schema';
import type { TaskBinding, TaskBindingInput } from '../../platform/tasks/service';

/**
 * Whose clock a task carries — the wms half of the task doors' «bound»
 * pre-check (docs/VED-TARIX.md §8, docs/TOPSHIRIQ-VED-REVIEW.md
 * telegram-mechanics-9, data-migration-3).
 *
 * A calc job is an ordinary task, so every task door (the web ✅, the dock,
 * the Telegram ✅ and «Natijasiz», the reassign select, ⏰, the ✏️ form's
 * date) could close or move it with no price and no note, or hand the task
 * to somebody while the QUEUE still names the old holder. The doors live in
 * platform and the requests in wms; platform reaches this file by dynamic
 * import, as it reaches `completeCalcForTask`.
 *
 * Bound means ONE of:
 *  - `origin` names the kind and `bound_id` names the record (0124 writes
 *    both for every calc and promise task since the deploy);
 *  - `origin` is NULL and a request or a promise POINTS at the task by its
 *    `task_id` — the rows the OLD app made while 0124 deployed, which the
 *    backfill ran too early to see. Calc beats promise when both point
 *    (the backfill's own order).
 * An origin-`calc` task with NO `bound_id` (a release ghost) is NOT bound: it
 * keeps its ordinary ✅, or nobody could ever close it.
 *
 * `open` is the record's own state: a request with no `completed_at`, a
 * promise still `open`. A bound task whose record has closed is an ordinary
 * task again — that is the stale-task path.
 *
 * One query per kind for a whole list (#432), none at all for a list of hand
 * tasks. A missing record reads as closed: the task is history and must stay
 * closable.
 */
export async function taskBindings(rows: TaskBindingInput[]): Promise<Map<string, TaskBinding>> {
  const out = new Map<string, TaskBinding>();
  const calcBound = rows.filter((r) => r.origin === 'calc' && r.boundId);
  const promiseBound = rows.filter((r) => r.origin === 'promise' && r.boundId);
  const unknown = rows.filter((r) => r.origin === null);

  if (calcBound.length > 0) {
    const found = await db
      .select({ id: calcRequests.id, completedAt: calcRequests.completedAt })
      .from(calcRequests)
      .where(inArray(calcRequests.id, [...new Set(calcBound.map((r) => r.boundId!))]));
    const state = new Map(found.map((r) => [r.id, r.completedAt === null]));
    for (const row of calcBound) {
      out.set(row.id, { kind: 'calc', recordId: row.boundId!, open: state.get(row.boundId!) ?? false });
    }
  }

  if (promiseBound.length > 0) {
    const found = await db
      .select({ id: paymentPromises.id, status: paymentPromises.status })
      .from(paymentPromises)
      .where(inArray(paymentPromises.id, [...new Set(promiseBound.map((r) => r.boundId!))]));
    const state = new Map(found.map((r) => [r.id, r.status === 'open']));
    for (const row of promiseBound) {
      out.set(row.id, { kind: 'promise', recordId: row.boundId!, open: state.get(row.boundId!) ?? false });
    }
  }

  if (unknown.length > 0) {
    const ids = unknown.map((r) => r.id);
    const requests = await db
      .select({ id: calcRequests.id, taskId: calcRequests.taskId, completedAt: calcRequests.completedAt })
      .from(calcRequests)
      .where(and(isNotNull(calcRequests.taskId), inArray(calcRequests.taskId, ids)));
    for (const r of requests) {
      // An OPEN pointer wins over a closed one: «the job is still being done»
      // is the answer that refuses, and refusing is the safe side.
      const seen = out.get(r.taskId!);
      if (seen && seen.open) continue;
      out.set(r.taskId!, { kind: 'calc', recordId: r.id, open: r.completedAt === null });
    }
    const left = ids.filter((id) => !out.has(id));
    if (left.length > 0) {
      const promises = await db
        .select({ id: paymentPromises.id, taskId: paymentPromises.taskId, status: paymentPromises.status })
        .from(paymentPromises)
        .where(and(isNotNull(paymentPromises.taskId), inArray(paymentPromises.taskId, left)));
      for (const p of promises) {
        const seen = out.get(p.taskId!);
        if (seen && seen.open) continue;
        out.set(p.taskId!, { kind: 'promise', recordId: p.id, open: p.status === 'open' });
      }
    }
  }
  return out;
}
