import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The as-built review of docs/FAYL-OQISH.md, the second fix pass (B): a cut
 * reading and the presses after it. WORDS-8 — the PRESS obeys «🔄 once per
 * material mark», not only the table that draws it. CRITIC-1 — a re-read of
 * the same material that reads LESS keeps the earlier reading.
 *
 * The model, pg-boss and Telegram are stand-ins; the collection, the press and
 * the reading are the real ones.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/ai-cost')>()),
  aiCalcBudgetLeft: async () => 100,
  aiCalcAvailable: async () => true,
  recordAiPass: async () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);

import { activeIntake, analyzeCollected, endIntake, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import { settleAnalysis } from '@/modules/platform/telegram/calc-read';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { readingsEnqueued, resetReadingDrive } from '../fixtures/calc-read-drive';

const BILL = { model: 'm', inputTokens: 1, outputTokens: 1, at: 0 };
const good = (n: number) => ({ name: `Tovar ${n}`, quantity: n * 10, weightKg: null, volumeM3: null, tnvedCode: null, note: null });
const goods = (n: number) => Array.from({ length: n }, (_, k) => good(k + 1));
const cutAt = (n: number, why: 'clock' | 'size' = 'clock') => ({
  ok: true,
  facts: { goods: goods(n) },
  steps: [],
  usage: BILL,
  answered: [BILL],
  cut: { goods: n, why },
});

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState> = {}): bigint {
  seq += 1;
  const chatId = BigInt(-9_343_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-fayl-asb-b', ai: true });
  updateIntake(chatId, { stage: 'material', clientHintRaw: 'GS777', material: ['erkin matn'], ...patch });
  return chatId;
}

function fakeCtx() {
  const replies: { text: string; extra?: Record<string, unknown> }[] = [];
  return {
    replies,
    texts: () => replies.map((r) => r.text),
    async reply(text: string, extra?: Record<string, unknown>) {
      replies.push({ text, extra });
      return { message_id: 100 + replies.length };
    },
  };
}

/** One reading of the live collection, settled onto it as the job does. */
async function readAndSettle(chatId: bigint, answer: unknown): Promise<IntakeState> {
  model.analyze.mockResolvedValueOnce(answer);
  const token = `t-${Math.random()}`;
  const snapshot = updateIntake(chatId, { analysing: token })!;
  const analysed = await analyzeCollected(snapshot);
  const settled = settleAnalysis(activeIntake(chatId), snapshot, analysed, token);
  if (settled.kind !== 'done') throw new Error(`settle: ${settled.kind}`);
  return updateIntake(chatId, settled.state)!;
}

beforeAll(async () => {
  await import('@/modules/wms/calc/intake-manual');
  await import('@/modules/wms/calc/intake');
  const { markIntakesHydrated } = await import('@/modules/platform/telegram/calc-store');
  markIntakesHydrated();
});
beforeEach(() => {
  resetReadingDrive();
  model.analyze.mockReset();
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

describe('a re-read that reads less keeps the earlier reading (CRITIC-1)', () => {
  it('cut after 7 → «🔄» → cut after 2: the seven stay, and it is said', async () => {
    const chatId = collection();
    await readAndSettle(chatId, cutAt(7));
    // The press's own mark: the same material, re-read (`pressAnalyse`).
    updateIntake(chatId, { aiCutRetried: true });
    const after = await readAndSettle(chatId, cutAt(2));
    expect((after.facts.goods ?? []).map((g) => g.name)).toEqual(goods(7).map((g) => g.name));
    expect(after.aiCut).toEqual({ goods: 7, why: 'clock' });
    expect(after.notes).toContain('⚠️ Qayta o‘qishda AI avvalgidan kam o‘qidi — avvalgi o‘qishdagi 7 ta tovar qoldi.');
  });

  it('cut after 7 → «🔄» → a timeout before any good: the seven stay', async () => {
    const chatId = collection();
    await readAndSettle(chatId, cutAt(7));
    updateIntake(chatId, { aiCutRetried: true });
    const after = await readAndSettle(chatId, { ok: false, failure: 'timeout', answered: [BILL] });
    expect(after.facts.goods).toHaveLength(7);
    expect(after.aiCut).toEqual({ goods: 7, why: 'clock' });
    expect(after.aiFailure ?? null).toBeNull();
  });

  it('cut after 7 → «🔄» → a whole answer of 12, or a cut after 9: the better reading replaces it', async () => {
    const chatId = collection();
    await readAndSettle(chatId, cutAt(7));
    updateIntake(chatId, { aiCutRetried: true });
    const longer = await readAndSettle(chatId, cutAt(9));
    expect(longer.facts.goods).toHaveLength(9);
    updateIntake(chatId, { aiCutRetried: true });
    const whole = await readAndSettle(chatId, { ok: true, facts: { goods: goods(12) }, steps: [], usage: BILL, answered: [BILL] });
    expect(whole.facts.goods).toHaveLength(12);
    expect(whole.aiCut ?? null).toBeNull();
  });

  it('new material is a new reading: a shorter cut over MORE material replaces it', async () => {
    const chatId = collection();
    await readAndSettle(chatId, cutAt(7));
    // New material clears the retry mark (`pressAnalyse`'s `fresh`).
    updateIntake(chatId, { aiCutRetried: false, material: ['erkin matn', 'yana bir fayl matni'] });
    const after = await readAndSettle(chatId, cutAt(2));
    expect(after.facts.goods).toHaveLength(2);
  });
});

describe('the press obeys «🔄 once per material mark» (WORDS-8)', () => {
  const WALL =
    '⚠️ AI bu materialni yana o‘qisa ham shu yerda to‘xtaydi — «👤 VED hisoblasin» ni bosing, yoki «✖️ Bekor qilish» ni bosib, faylni kichikroq (yoki Excel) qilib qaytadan yuboring.';

  it('a clock cut already re-read: «🔄» on the older table enqueues nothing, and says why', async () => {
    const chatId = collection();
    await readAndSettle(chatId, cutAt(7));
    updateIntake(chatId, { aiCutRetried: true, stage: 'review' });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'reread');
    expect(readingsEnqueued(chatId)).toHaveLength(0);
    expect(ctx.texts()).toContain(WALL);
    expect(activeIntake(chatId)!.analysing ?? null).toBeNull();
    // …and an older prompt's «Bo‘ldi» the same.
    const again = fakeCtx();
    await handleCalcCallback(again, chatId, 'done');
    expect(readingsEnqueued(chatId)).toHaveLength(0);
    expect(again.texts()).toContain(WALL);
  });

  it('a size cut: no re-read of the same material at all', async () => {
    const chatId = collection();
    await readAndSettle(chatId, cutAt(7, 'size'));
    updateIntake(chatId, { stage: 'review' });
    const ctx = fakeCtx();
    await handleCalcCallback(ctx, chatId, 'done');
    expect(readingsEnqueued(chatId)).toHaveLength(0);
    expect(ctx.texts().some((t) => t.includes('kamroq sahifa yoki Excel qilib qaytadan yuboring'))).toBe(true);
  });

  it('the one retry a clock cut earns still runs; new material earns it again', async () => {
    const chatId = collection();
    await readAndSettle(chatId, cutAt(7));
    updateIntake(chatId, { stage: 'review' });
    await handleCalcCallback(fakeCtx(), chatId, 'reread');
    expect(readingsEnqueued(chatId)).toHaveLength(1);
    expect(activeIntake(chatId)!.aiCutRetried).toBe(true);
  });
});
