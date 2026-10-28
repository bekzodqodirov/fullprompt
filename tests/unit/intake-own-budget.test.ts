import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The day's AI budget, read before a reading, counts the collection's OWN
 * earlier readings (judge concurrency-11). They are billed only when the job
 * lands, so the ledger cannot see them yet — and a collection re-read after
 * every «➕ Yana ma’lumot» used to pass the cap it was spending.
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

function collection(usages: number) {
  const chatId = BigInt(-9_910_000_000) - BigInt(chats.length + 1);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-test' });
  return updateIntake(chatId, { stage: 'material', material: ['Kurtka 300 dona'], usages: Array(usages).fill(BILL) })!;
}

describe('the budget a reading is read against', () => {
  it('two unlanded readings spend the last two calls the ledger says are left', async () => {
    ledger.left = 2;
    const out = await analyzeCollected(collection(2));
    expect(model.analyze).not.toHaveBeenCalled();
    expect(out.aiFailure).toBe('budget');
    // Nothing billed for a call never made.
    expect(out.usages).toHaveLength(2);
  });

  it('…while one call still left past them is made', async () => {
    ledger.left = 3;
    model.analyze.mockResolvedValueOnce({
      ok: true,
      facts: { goods: [] },
      steps: [],
      usage: BILL,
      answered: [BILL],
    });
    const out = await analyzeCollected(collection(2));
    expect(model.analyze).toHaveBeenCalledTimes(1);
    expect(out.aiFailure).toBeNull();
    expect(out.usages).toHaveLength(3);
  });
});
