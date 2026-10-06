import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { calcRequests, leads, leadStages, tasks, users } from '@/modules/platform/db/schema';
import {
  calcGhostTasks,
  cancelCalcGhostTasks,
  closeStaleCalcTasks,
  staleCalcTasks,
} from '@/modules/wms/calc/stale-tasks';

/**
 * The owner's item 5, second half: the pile the fix could not reach.
 *
 * Since 2026-09-05 `endRequest` closes the calculation's task by itself. The
 * tasks opened BEFORE that, against requests that were finished the old way,
 * stay open for ever — nothing will finish them again. This is the fixture of
 * that exact state, built the way the old code left it: a completed request
 * still pointing at an open task.
 *
 * Written because the cleanup's first dry run against a real database found
 * ZERO rows, which proves nothing whatever about whether it works (#494).
 */

const SUFFIX = String(Date.now()).slice(-6);
let actorId: string;
let leadId: string;
let stageId: string;
const madeTasks: string[] = [];
const madeRequests: string[] = [];

async function mintPair(over: { completed: boolean; taskStatus?: 'open' | 'done' }) {
  const [task] = await db
    .insert(tasks)
    .values({
      title: `Hisoblash ${SUFFIX} ${madeTasks.length}`,
      assigneeId: actorId,
      status: over.taskStatus ?? 'open',
      // `tasks_done_check`: a done task must carry a done_at, so the fixture
      // for «somebody closed it by hand» has to be a real closed task.
      doneAt: over.taskStatus === 'done' ? new Date('2026-09-09T00:00:00Z') : null,
      dueAt: new Date('2026-08-01T09:00:00Z'),
      createdBy: actorId,
    })
    .returning({ id: tasks.id });
  madeTasks.push(task!.id);
  const [request] = await db
    .insert(calcRequests)
    .values({
      entityType: 'lead',
      entityId: leadId,
      requestedBy: actorId,
      itemCount: 1,
      taskId: task!.id,
      dueAt: new Date('2026-08-01T10:00:00Z'),
      completedAt: over.completed ? new Date('2026-08-02T12:00:00Z') : null,
      completedBy: over.completed ? actorId : null,
      completedVia: over.completed ? 'task' : null,
    })
    .returning({ id: calcRequests.id });
  madeRequests.push(request!.id);
  return { taskId: task!.id, requestId: request!.id };
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  stageId = (
    await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'open'))
  )[0]!.id;
  leadId = (
    await db
      .insert(leads)
      .values({ name: `Eski hisob ${SUFFIX}`, stageId, createdBy: actorId })
      .returning({ id: leads.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
  await db.delete(tasks).where(inArray(tasks.id, madeTasks));
  await db.delete(leads).where(eq(leads.id, leadId));
  await pgClient.end();
});

describe('the calculation backlog', () => {
  it('finds an open task whose calculation is finished, and leaves the live one alone', async () => {
    const stale = await mintPair({ completed: true });
    const live = await mintPair({ completed: false });

    const found = await staleCalcTasks();
    const ids = found.map((row) => row.taskId);
    expect(ids, 'the finished job’s task is not listed').toContain(stale.taskId);
    expect(ids, 'a calculation still open is still somebody’s work').not.toContain(live.taskId);
  });

  it('closes it with the day the WORK finished, not today', async () => {
    const { taskId } = await mintPair({ completed: true });
    // It answers the ids (RETURNING) so the caller can retire their Telegram
    // copies after the statement — deliberate edit, it used to be a count.
    expect(await closeStaleCalcTasks()).toContain(taskId);
    const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(row!.status).toBe('done');
    // The request's own completion, or every report reading `done_at` gets a
    // wrong day for two hundred cards.
    expect(row!.doneAt?.toISOString().slice(0, 10)).toBe('2026-08-02');
    expect(row!.result).toBeTruthy();
  });

  it('is safe to run twice — the second pass finds nothing', async () => {
    await mintPair({ completed: true });
    expect((await closeStaleCalcTasks()).length).toBeGreaterThan(0);
    expect(await closeStaleCalcTasks()).toEqual([]);
    expect((await staleCalcTasks()).length).toBe(0);
  });

  it('never reopens or re-stamps a task somebody already closed', async () => {
    const { taskId } = await mintPair({ completed: true, taskStatus: 'done' });
    await db.update(tasks).set({ result: 'Qo‘lda yopildi' }).where(eq(tasks.id, taskId));
    await closeStaleCalcTasks();
    const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(row!.result, 'a person’s own answer must survive').toBe('Qo‘lda yopildi');
    expect(row!.doneAt?.toISOString().slice(0, 10)).toBe('2026-09-09');
  });
});

/**
 * THE RELEASE GHOSTS (docs/VED-TARIX.md §8, review data-migration-5): open
 * machine calc tasks no request points at. Behind their own flag, cancelled
 * and never «done», and only the machine's own title shape.
 */
describe('the release ghosts', () => {
  async function ghost(over: { title?: string; boundId?: string | null; priority?: number; allDay?: boolean } = {}) {
    const [task] = await db
      .insert(tasks)
      .values({
        title: over.title ?? `Hisoblash: Eski ${SUFFIX} (${madeTasks.length})`,
        assigneeId: actorId,
        status: 'open',
        dueAt: new Date('2026-08-01T09:00:00Z'),
        allDay: over.allDay ?? false,
        priority: over.priority ?? 1,
        entityType: 'lead',
        entityId: leadId,
        createdBy: actorId,
        origin: 'calc',
        boundId: over.boundId ?? null,
      })
      .returning({ id: tasks.id });
    madeTasks.push(task!.id);
    return task!.id;
  }

  it('lists an unbound machine calc task and cancels it — never «done»', async () => {
    const id = await ghost();
    expect((await calcGhostTasks()).map((g) => g.taskId)).toContain(id);
    // The plain stale pass cannot see it (it joins on r.task_id) — which is
    // why the old --apply keeps its meaning.
    expect((await staleCalcTasks()).map((g) => g.taskId)).not.toContain(id);
    expect(await cancelCalcGhostTasks()).toContain(id);
    const row = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
    expect(row!.status).toBe('cancelled');
    expect(row!.doneAt).toBeNull();
    expect(row!.result).toBe('Navbatga qaytarildi');
    expect(await cancelCalcGhostTasks()).not.toContain(id);
  });

  it('a task bound to a CLOSED request is a ghost; one bound to its own OPEN job is not', async () => {
    const live = await mintPair({ completed: false });
    // A live job's task whose pointer UPDATE failed: still that job's.
    await db.update(calcRequests).set({ taskId: null, assigneeId: actorId }).where(eq(calcRequests.id, live.requestId));
    const keep = await ghost({ boundId: live.requestId });
    const done = await mintPair({ completed: true });
    await db.update(calcRequests).set({ taskId: null }).where(eq(calcRequests.id, done.requestId));
    const gone = await ghost({ boundId: done.requestId });
    const ids = (await calcGhostTasks()).map((g) => g.taskId);
    expect(ids).toContain(gone);
    expect(ids, 'the open job keeps its task').not.toContain(keep);
  });

  it('a hand-typed «Hisoblash: …» is not the machine’s and keeps its buttons', async () => {
    const typed = await ghost({ title: `Hisoblash: menga eslatma ${SUFFIX}` });
    const allDay = await ghost({ allDay: true });
    const ids = (await calcGhostTasks()).map((g) => g.taskId);
    expect(ids).not.toContain(typed);
    expect(ids).not.toContain(allDay);
  });
});
