import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { notifications, tasks, telegramLinks, users } from '@/modules/platform/db/schema';
import {
  acceptTask,
  completeTask,
  reassignTask,
  rescheduleTask,
  TaskError,
  type TaskContext,
  updateTask,
} from '@/modules/platform/tasks/service';
import { composeMyDay } from '@/modules/platform/tasks/digest';
import { toTaskViews } from '@/modules/platform/tasks/view';
import { byId } from '@/modules/platform/tasks/service';
import { taskPressCheck } from '@/modules/platform/telegram/staff-bot';

/**
 * The bound pre-check fails CLOSED (docs/VED-TARIX.md §13, review
 * ved-correctness-11): a gate that THREW is not a gate that said «not
 * bound». Every door refuses in words — `bound_check_failed` — instead of
 * closing a calc job with no price because the database blinked; the LISTS,
 * which only draw, degrade to the plain row and let the door decide.
 *
 * Its own file because the gate is replaced for the whole module graph.
 */
vi.mock('@/modules/wms/calc/task-gate', () => ({
  taskBindings: vi.fn(async () => {
    throw new Error('connection terminated unexpectedly');
  }),
}));

const STAMP = String(Date.now()).slice(-7);
const people: string[] = [];
const made: string[] = [];
let author: string;
let doer: string;
let other: string;
let chat: bigint;

async function mint(name: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({
      phone: `+99898${String(Number(STAMP) + 500 + people.length).padStart(7, '0').slice(-7)}`,
      fullName: `${name} ${STAMP}`,
      passwordHash: 'x',
      locale: 'uz',
      active: true,
    })
    .returning({ id: users.id });
  people.push(row!.id);
  return row!.id;
}

const ctx = (id: string): TaskContext => ({ actorId: id, actor: { id, permissions: new Set() } });

async function refusal(run: Promise<unknown>): Promise<string> {
  try {
    await run;
    return 'resolved';
  } catch (err) {
    if (err instanceof TaskError) return err.code;
    throw err;
  }
}

async function mintTask(over: Partial<typeof tasks.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(tasks)
    .values({ title: `Tekshirilmaydigan ${STAMP}-${made.length}`, assigneeId: doer, createdBy: author, origin: null, ...over })
    .returning({ id: tasks.id });
  made.push(row!.id);
  return row!.id;
}

beforeAll(async () => {
  author = await mint('Muallif');
  doer = await mint('Bajaruvchi');
  other = await mint('Boshqa');
  chat = BigInt(750_000_000 + Number(STAMP));
  await db.insert(telegramLinks).values({ userId: doer, telegramChatId: chat, status: 'linked', linkedAt: new Date() });
});

afterAll(async () => {
  await db.delete(notifications).where(inArray(notifications.userId, people));
  await db.delete(tasks).where(inArray(tasks.id, made));
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, people));
  await db.update(users).set({ active: false }).where(inArray(users.id, people));
  await pgClient.end();
});

describe('a gate that cannot answer refuses, and nothing moves', () => {
  it('every door that asks — ✅, 👀, the reassign, ⏰ and the ✏️ date — says bound_check_failed', async () => {
    // A NULL origin is exactly the row that MUST be asked (a pointer may name it).
    const id = await mintTask({ dueAt: new Date('2027-01-01T10:00:00Z') });
    expect(await refusal(completeTask(id, '', ctx(doer)))).toBe('bound_check_failed');
    expect(await refusal(acceptTask(id, ctx(doer)))).toBe('bound_check_failed');
    expect(await refusal(reassignTask(id, other, ctx(doer)))).toBe('bound_check_failed');
    expect(await refusal(rescheduleTask(id, { dueAt: new Date('2027-02-01T00:00:00Z'), allDay: true }, ctx(doer)))).toBe(
      'bound_check_failed',
    );
    expect(
      await refusal(updateTask(id, { title: 'x', note: '', typeId: null, dueAt: '2027-03-01', priority: 2, tzOffsetMin: null }, ctx(doer))),
    ).toBe('bound_check_failed');
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row).toMatchObject({ status: 'open', assigneeId: doer, acceptedAt: null });
    expect(row!.dueAt!.toISOString()).toBe('2027-01-01T10:00:00.000Z');
  });

  it('the bot’s press says so at the press', async () => {
    const id = await mintTask();
    expect(await taskPressCheck(chat, id, 'act')).toEqual({ ok: false, result: 'bound_check_failed' });
  });

  it('a HAND task never asks the gate, so its doors still work', async () => {
    const id = await mintTask({ origin: 'hand' });
    await completeTask(id, 'qildim', ctx(doer));
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    expect(row!.status).toBe('done');
  });

  it('the lists only DRAW: they fall back to plain rows and still render', async () => {
    const today = new Date();
    today.setUTCHours(23, 59, 59, 999);
    const id = await mintTask({ dueAt: today });
    const day = await composeMyDay(doer);
    expect(day!.tasks).toContainEqual({ id, title: expect.any(String) });
    const [view] = await toTaskViews([(await byId(id))!], { id: doer, permissions: new Set() });
    expect(view).toMatchObject({ calc: null, canReassign: true });
  });
});
