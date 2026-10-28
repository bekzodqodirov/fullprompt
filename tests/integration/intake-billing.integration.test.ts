import 'dotenv/config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A reading is billed when the MODEL ANSWERED, not when the collection lands
 * (docs/SAKKIZ-R3.md §7.2.4 step 5, §7.2.9). R2 billed at the landing, so a
 * collection abandoned after its paid reading — cancelled, expired, killed by
 * a deploy — was never counted against the day's budget (R2 §8.2.7's stated
 * hole). The reading job now writes one `'intake'` row per answered call on
 * the collection's NOTE, on the day the model answered; the landing only
 * ATTACHES those rows to the request it opened — and does so on both of its
 * «already queued» exits too, or a landing cut short left them unattached for
 * ever.
 *
 * The model, the queue and Telegram are stand-ins; the ledger, the job and
 * the landing are real.
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
    attachIntakePasses: async (noteId: string, requestId: string) => {
      if (ledger.throwAttach) {
        ledger.throwAttach = false;
        throw new Error('ledger down');
      }
      return real.attachIntakePasses(noteId, requestId);
    },
  };
});
const queue = vi.hoisted(() => ({ spy: vi.fn(async () => true) }));
vi.mock('@/modules/wms/calc/prefill-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/prefill-queue')>()),
  queueCalcPrefill: queue.spy,
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);

import { db, pgClient } from '@/modules/platform/db/client';
import { aiCalcPasses, calcRequestItems, calcRequests, crmActivities, events, leads, tasks, users } from '@/modules/platform/db/schema';
import { aiCalcBudgetLeft } from '@/modules/wms/calc/ai-cost';
import type { AmendBase } from '@/modules/wms/calc/amend-types';
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
/** Every collection's note: `intake_note_id` has no FK, so a row never attached is not taken by a CASCADE. */
const notes: string[] = [];

const USAGE = { model: 'reader', inputTokens: 40_000, outputTokens: 16_000 };
const ctx = { reply: async () => ({ message_id: 1 }) };

/** A collection, read once by the job — the model answered `at`, cut short (a paid failure). */
async function readOnce(opts: { at: number; amend?: AmendBase | null }): Promise<{ chatId: bigint; noteId: string }> {
  seq += 1;
  const chatId = BigInt(-9_830_000_000) - BigInt(seq);
  chats.push(chatId);
  const { noteId } = startIntake(chatId, 'rastamojka', { staffId: actorId, amend: opts.amend ?? null });
  notes.push(noteId);
  updateIntake(chatId, {
    stage: 'material',
    clientHintRaw: `R3 billing ${SUFFIX}-${seq} +99892${SUFFIX}${seq}`,
    material: ['Kurtka 300 dona 150 kg'],
  });
  model.analyze.mockResolvedValueOnce({ ok: false, failure: 'truncated', usage: USAGE, answered: [{ ...USAGE, at: opts.at }] });
  await handleCalcCallback(ctx, chatId, 'done');
  await driveReading(chatId, ctx);
  return { chatId, noteId };
}

const rowsOfNote = (noteId: string) =>
  db
    .select({
      kind: aiCalcPasses.kind,
      requestId: aiCalcPasses.requestId,
      staffId: aiCalcPasses.staffId,
      inputTokens: aiCalcPasses.inputTokens,
      createdAt: aiCalcPasses.createdAt,
    })
    .from(aiCalcPasses)
    .where(eq(aiCalcPasses.intakeNoteId, noteId));

async function land(chatId: bigint) {
  const target = await landCollectedIntake(chatId, actorId, 'R3 billing fixture');
  expect(target?.requestId, 'the landing opened a request').toBeTruthy();
  if (!madeRequests.includes(target!.requestId!)) madeRequests.push(target!.requestId!);
  if (!madeLeads.includes(target!.id)) madeLeads.push(target!.id);
  return target!;
}

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99895${String(Date.now()).slice(-7)}`, fullName: `R3 billing fixture ${SUFFIX}`, passwordHash: 'x' })
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
  if (notes.length > 0) await db.delete(aiCalcPasses).where(inArray(aiCalcPasses.intakeNoteId, notes));
  if (madeRequests.length > 0) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
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

describe('billed when the model answered, on the note', () => {
  it('a reading that answered (cut, with usage): one `intake` row on the note, no request yet, dated the answer', async () => {
    const at = Date.now() - 5 * 60_000;
    const { noteId } = await readOnce({ at });
    const rows = await rowsOfNote(noteId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'intake', requestId: null, staffId: actorId, inputTokens: 40_000 });
    expect(rows[0]!.createdAt.toISOString()).toBe(new Date(at).toISOString());
  });

  it('an abandoned collection’s reading stays billed: the day’s budget counts it', async () => {
    const before = await aiCalcBudgetLeft();
    const { chatId, noteId } = await readOnce({ at: Date.now() });
    endIntake(chatId);
    expect(await rowsOfNote(noteId)).toHaveLength(1);
    expect(await aiCalcBudgetLeft()).toBe(before - 1);
  });

  it('a collection that lands: its rows gain the request', async () => {
    const { chatId, noteId } = await readOnce({ at: Date.now() });
    const target = await land(chatId);
    expect((await rowsOfNote(noteId)).map((r) => r.requestId)).toEqual([target.requestId]);
    expect(queue.spy).toHaveBeenCalledTimes(1);
  });

  it('an add collection’s reading is billed to its request at once', async () => {
    const first = await readOnce({ at: Date.now() });
    const target = await land(first.chatId);
    const amend = { requestId: target.requestId! } as AmendBase;
    const { noteId } = await readOnce({ at: Date.now(), amend });
    expect((await rowsOfNote(noteId)).map((r) => r.requestId)).toEqual([target.requestId]);
  });

  it('a landing cut after the request committed (the attach failed): «Saqlash» again attaches them', async () => {
    const { chatId, noteId } = await readOnce({ at: Date.now() });
    ledger.throwAttach = true;
    const target = await land(chatId);
    // The attach failed and was logged; the pass was queued all the same.
    expect(queue.spy).toHaveBeenCalledTimes(1);
    expect(await db.select().from(aiCalcPasses).where(and(eq(aiCalcPasses.intakeNoteId, noteId), isNull(aiCalcPasses.requestId)))).toHaveLength(1);
    // The same collection pressed again: Uch band's «already queued» exit.
    const again = await land(chatId);
    expect(again.requestId).toBe(target.requestId);
    expect((await rowsOfNote(noteId)).map((r) => r.requestId)).toEqual([target.requestId]);
    expect(queue.spy).toHaveBeenCalledTimes(1);
  });
});
