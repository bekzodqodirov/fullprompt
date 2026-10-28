import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The intake's model calls, COUNTED (his 2.9 c, docs/SAKKIZ-R2.md §8.2.7):
 * every reading the model answered is billed against the request once it
 * exists — a re-read after «➕ Yana ma'lumot» ADDED to the first, a cut or
 * refused one included — and a call with no answer is not. The bills never
 * stand in front of the pass (judge concurrency-8): a ledger insert that
 * throws costs that one row, never the queue.
 *
 * The model and the queue are stand-ins; the ledger and the landing are real.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
const ledger = vi.hoisted(() => ({ throwNext: false }));
vi.mock('@/modules/wms/calc/ai-cost', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/calc/ai-cost')>();
  return {
    ...real,
    aiCalcBudgetLeft: async () => 100,
    // The real ledger, with one way to make an insert fail outright — a
    // failure the ledger's own catch never sees.
    recordAiPass: async (input: Parameters<typeof real.recordAiPass>[0]) => {
      if (ledger.throwNext) {
        ledger.throwNext = false;
        throw new Error('ledger down');
      }
      return real.recordAiPass(input);
    },
  };
});
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
import {
  activeIntake,
  analyzeCollected,
  endIntake,
  startIntake,
  updateIntake,
} from '@/modules/platform/telegram/calc-intake';
import { landCollectedIntake } from '@/modules/platform/telegram/staff-bot';

const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
let actorId = '';
const madeRequests: string[] = [];
const madeLeads: string[] = [];
const chats: bigint[] = [];

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

/** A collection for a stranger, read as many times as `outcomes` says, then landed. */
async function collectAndLand(outcomes: unknown[]) {
  seq += 1;
  const chatId = BigInt(-9_800_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-test' });
  updateIntake(chatId, {
    clientHintRaw: `R2 usage ${SUFFIX}-${seq} +99891${SUFFIX}${seq}`,
    material: ['Kurtka 300 dona 150 kg'],
  });
  for (const outcome of outcomes) {
    model.analyze.mockResolvedValueOnce(outcome);
    updateIntake(chatId, await analyzeCollected(activeIntake(chatId)!));
  }
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
  ledger.throwNext = false;
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

  it('a reading is billed on the day the model ANSWERED it, not the day the collection landed (judge concurrency-11)', async () => {
    // A day ago: a collection read then and landed now — the 23:58 reading
    // that lands at 00:03, made unmistakable.
    const spent = new Date(Date.now() - 24 * 3_600_000);
    const requestId = await collectAndLand([{ ...read(U2), answered: [{ ...U2, at: spent.getTime() }] }]);
    const rows = await intakeRows(requestId);
    expect(rows.map((r) => r.createdAt.toISOString())).toEqual([spent.toISOString()]);
  });

  it('a reading the model never answered (the network) bills nothing', async () => {
    const requestId = await collectAndLand([{ ok: false, failure: 'network' }]);
    expect(await intakeRows(requestId)).toEqual([]);
  });

  it('a bill that cannot be written costs that row alone — the pass is still queued, the next bill still written', async () => {
    ledger.throwNext = true;
    const requestId = await collectAndLand([read(U1), read(U2)]);
    expect(queue.spy).toHaveBeenCalledTimes(1);
    expect(queue.spy).toHaveBeenCalledWith(expect.objectContaining({ requestId }));
    const rows = await intakeRows(requestId);
    expect(rows.map((r) => r.inputTokens)).toEqual([1_200]);
  });
});
