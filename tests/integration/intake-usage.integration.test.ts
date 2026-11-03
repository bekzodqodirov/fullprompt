import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The intake's model calls, COUNTED (his 2.9 c, docs/SAKKIZ-R2.md §8.2.7):
 * every reading the model answered is billed — a re-read after «➕ Yana
 * ma'lumot» ADDED to the first, a cut or refused one included — and a call
 * with no answer is not. The bills never stand in front of the pass (judge
 * concurrency-8).
 *
 * Re-anchored (docs/SAKKIZ-R3.md §7.2.10, §11, P2): the ledger holds a
 * collection's readings from the moment the model answered — the reading
 * JOB bills each one on the collection's note, and the landing ATTACHES those
 * rows to the request it opened. So every reading here is a press of
 * «Bo‘ldi» and the job, run through the one drive helper.
 *
 * The model and the queue are stand-ins; the ledger, the job and the landing
 * are real.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
const ledger = vi.hoisted(() => ({ throwAttach: false }));
vi.mock('@/modules/wms/calc/ai-cost', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/calc/ai-cost')>();
  return {
    ...real,
    aiCalcBudgetLeft: async () => 100,
    // The real attach, with one way to make it fail outright — a failure the
    // attach's own catch never sees.
    attachIntakePasses: async (noteId: string, requestId: string) => {
      if (ledger.throwAttach) {
        ledger.throwAttach = false;
        throw new Error('ledger down');
      }
      return real.attachIntakePasses(noteId, requestId);
    },
  };
});
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);
const queue = vi.hoisted(() => ({ spy: vi.fn(async () => true) }));
vi.mock('@/modules/wms/calc/prefill-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/prefill-queue')>()),
  queueCalcPrefill: queue.spy,
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  aiCalcPasses,
  calcRequestItems,
  calcRequests,
  crmActivities,
  events,
  leads,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { endIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { landCollectedIntake } from '@/modules/platform/telegram/staff-bot';
import { driveReading, resetReadingDrive } from '../fixtures/calc-read-drive';

const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
let actorId = '';
const madeRequests: string[] = [];
const madeLeads: string[] = [];
const chats: bigint[] = [];
/** Every collection's note: a reading never attached is not taken by a request's CASCADE. */
const notes: string[] = [];

const U1 = { model: 'reader', inputTokens: 40_000, outputTokens: 16_000 };
const U2 = { model: 'reader', inputTokens: 1_200, outputTokens: 300 };

/** A reading as the model would hand it back, and what it cost. */
const read = (usage: typeof U1) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: 150, volumeM3: 1, goods: [{ name: 'Kurtka', quantity: 300 }] },
  steps: [],
  usage,
  answered: [usage],
});

const ctx = { reply: async () => ({ message_id: 1 }) };

/** A collection for a stranger, read (press + job) as many times as `outcomes` says. */
async function collectAndRead(outcomes: unknown[]): Promise<{ chatId: bigint; noteId: string }> {
  seq += 1;
  const chatId = BigInt(-9_800_000_000) - BigInt(seq);
  chats.push(chatId);
  const { noteId } = startIntake(chatId, 'rastamojka', { staffId: actorId });
  notes.push(noteId);
  updateIntake(chatId, {
    stage: 'material',
    clientHintRaw: `R2 usage ${SUFFIX}-${seq} +99891${SUFFIX}${seq}`,
    material: ['Kurtka 300 dona 150 kg'],
  });
  for (const outcome of outcomes) {
    model.analyze.mockResolvedValueOnce(outcome);
    await handleCalcCallback(ctx, chatId, 'done');
    await driveReading(chatId, ctx);
  }
  return { chatId, noteId };
}

/** …and landed. */
async function collectAndLand(outcomes: unknown[]) {
  const { chatId } = await collectAndRead(outcomes);
  const target = await landCollectedIntake(chatId, actorId, 'R2 usage fixture');
  expect(target?.requestId, 'the landing opened a request').toBeTruthy();
  madeRequests.push(target!.requestId!);
  madeLeads.push(target!.id);
  landed = target!;
  return target!.requestId!;
}
let landed: NonNullable<Awaited<ReturnType<typeof landCollectedIntake>>> | null = null;

const intakeRows = (requestId: string) =>
  db
    .select({ inputTokens: aiCalcPasses.inputTokens, outputTokens: aiCalcPasses.outputTokens, createdAt: aiCalcPasses.createdAt })
    .from(aiCalcPasses)
    .where(and(eq(aiCalcPasses.requestId, requestId), eq(aiCalcPasses.kind, 'intake')));

beforeAll(async () => {
  // A requester of this file's own (the per-requester open cap, #653).
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99897${String(Date.now()).slice(-7)}`,
      fullName: `R2 usage fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
});

beforeEach(() => {
  model.analyze.mockReset();
  queue.spy.mockClear();
  ledger.throwAttach = false;
  resetReadingDrive();
});

afterAll(async () => {
  for (const id of chats) endIntake(id);
  if (madeRequests.length > 0) {
    // The ledger rows go with their request (ON DELETE CASCADE).
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  if (madeLeads.length > 0) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeLeads));
    await db.delete(leads).where(inArray(leads.id, madeLeads));
  }
  // `intake_note_id` has no FK: a reading never attached stays on its note.
  if (notes.length > 0) await db.delete(aiCalcPasses).where(inArray(aiCalcPasses.intakeNoteId, notes));
  // An audited fixture is deactivated, never deleted (audit_log FK).
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('every answered reading is billed against the request', () => {
  it('a cut reading and a re-read are TWO rows — the second never replaces the first', async () => {
    const requestId = await collectAndLand([
      { ok: false, failure: 'truncated', usage: U1, answered: [U1] },
      read(U2),
    ]);
    const rows = await intakeRows(requestId);
    expect(rows.map((r) => [r.inputTokens, r.outputTokens]).sort((a, b) => a[0]! - b[0]!)).toEqual([
      [1_200, 300],
      [40_000, 16_000],
    ]);
    expect(queue.spy).toHaveBeenCalledTimes(1);
  });

  it('the landing says whether the machine’s reply was queued — the ✅ promises it only then (judge concurrency-8)', async () => {
    await collectAndLand([read(U2)]);
    expect(landed?.replyQueued).toBe(true);
    queue.spy.mockResolvedValueOnce(false);
    await collectAndLand([read(U2)]);
    expect(landed?.replyQueued).toBe(false);
  });

  it('billed by the job on the day the model ANSWERED (concurrency-11), on the note — then attached at the landing', async () => {
    // Re-anchored (SAKKIZ-R3 §11, P2): the bill is the JOB's, written the
    // moment the model answered (`createdAt = at`), on the collection's note
    // with no request yet; the landing hands it to the request. A day ago:
    // the 23:58 reading that lands at 00:03, made unmistakable.
    const spent = new Date(Date.now() - 24 * 3_600_000);
    const { chatId, noteId } = await collectAndRead([{ ...read(U2), answered: [{ ...U2, at: spent.getTime() }] }]);
    const onNote = await db
      .select({ requestId: aiCalcPasses.requestId, createdAt: aiCalcPasses.createdAt })
      .from(aiCalcPasses)
      .where(eq(aiCalcPasses.intakeNoteId, noteId));
    expect(onNote.map((r) => [r.requestId, r.createdAt.toISOString()])).toEqual([[null, spent.toISOString()]]);
    const target = await landCollectedIntake(chatId, actorId, 'R2 usage fixture');
    madeRequests.push(target!.requestId!);
    madeLeads.push(target!.id);
    const rows = await intakeRows(target!.requestId!);
    expect(rows.map((r) => r.createdAt.toISOString())).toEqual([spent.toISOString()]);
  });

  it('a reading the model never answered (the network) bills nothing', async () => {
    const requestId = await collectAndLand([{ ok: false, failure: 'network' }]);
    expect(await intakeRows(requestId)).toEqual([]);
  });

  it('a failing attach never skips the queue — the readings stay on the note, still counted', async () => {
    // Re-anchored (SAKKIZ-R3 §11, P2): «a bill that cannot be written…» —
    // the bill is no longer written at the landing; what the landing does is
    // ATTACH, and an attach that throws must not cost the pass (judge
    // concurrency-8).
    ledger.throwAttach = true;
    const requestId = await collectAndLand([read(U1), read(U2)]);
    expect(queue.spy).toHaveBeenCalledTimes(1);
    expect(queue.spy).toHaveBeenCalledWith(expect.objectContaining({ requestId }));
    expect(await intakeRows(requestId)).toEqual([]);
    const onNote = await db
      .select({ inputTokens: aiCalcPasses.inputTokens })
      .from(aiCalcPasses)
      .where(inArray(aiCalcPasses.intakeNoteId, notes.slice(-1)));
    expect(onNote.map((r) => r.inputTokens).sort((a, b) => a - b)).toEqual([1_200, 40_000]);
  });
});
