import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The day's AI budget, read before a reading (judge concurrency-11).
 *
 * Re-anchored (docs/SAKKIZ-R3.md §7.2.10, P2): a collection's readings were
 * billed only when the job landed, so the ledger could not see them and the
 * collection counted its own (`usages`) on top. The reading JOB now bills
 * each one the moment the model answered, so the ledger alone counts them —
 * subtracting the collection's own as well would count every reading twice.
 *
 * The model and the ledger's count are stand-ins.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
const ledger = vi.hoisted(() => ({ left: 0 }));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => ledger.left }));

import { analyzeCollected, endIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';

const BILL = { model: 'm', inputTokens: 1, outputTokens: 1, at: 0 };
const chats: bigint[] = [];
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
  model.analyze.mockReset();
});

/** A collection that was already read `readings` times — each one billed in the ledger. */
function collection(readings: number) {
  const chatId = BigInt(-9_910_000_000) - BigInt(chats.length + 1);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-test' });
  // A collection from before this round still LISTS its readings (`usages`,
  // kept optional and unread for one release); they are in the ledger.
  return updateIntake(chatId, { stage: 'material', material: ['Kurtka 300 dona'], usages: Array(readings).fill(BILL) })!;
}

describe('the budget a reading is read against', () => {
  it('a collection with one billed reading and the ledger saying 1 left reads once more', async () => {
    ledger.left = 1;
    model.analyze.mockResolvedValueOnce({
      ok: true,
      facts: { goods: [] },
      steps: [],
      usage: BILL,
      answered: [BILL],
    });
    const out = await analyzeCollected(collection(1));
    expect(model.analyze).toHaveBeenCalledTimes(1);
    expect(out.aiFailure).toBeNull();
    // What the job bills: this reading alone.
    expect(out.answered).toHaveLength(1);
  });

  it('…and the ledger saying 0 left refuses it, billing nothing for a call never made', async () => {
    ledger.left = 0;
    const out = await analyzeCollected(collection(1));
    expect(model.analyze).not.toHaveBeenCalled();
    expect(out.aiFailure).toBe('budget');
    expect(out.answered).toEqual([]);
  });
});
