import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { calcRequests, leads, leadStages, tasks, users } from '@/modules/platform/db/schema';
import { closeStaleCalcTasks, staleCalcTasks } from '@/modules/wms/calc/stale-tasks';

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
    expect(await closeStaleCalcTasks()).toBeGreaterThan(0);
    const row = await db.query.tasks.findFirst({ where: eq(tasks.id, taskId) });
    expect(row!.status).toBe('done');
    // The request's own completion, or every report reading `done_at` gets a
    // wrong day for two hundred cards.
    expect(row!.doneAt?.toISOString().slice(0, 10)).toBe('2026-08-02');
    expect(row!.result).toBeTruthy();
  });

  it('is safe to run twice — the second pass finds nothing', async () => {
    await mintPair({ completed: true });
    expect(await closeStaleCalcTasks()).toBeGreaterThan(0);
    expect(await closeStaleCalcTasks()).toBe(0);
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
