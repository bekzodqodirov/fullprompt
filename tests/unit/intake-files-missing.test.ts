import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Since K the collection keeps attachment IDS and the reading loads the bytes
 * back from storage (docs/SAKKIZ-R3.md K5). A file storage could not hand over
 * used to be counted and read by nobody: the model went on with text alone,
 * under a prompt that had promised it the photos, and the summary said nothing
 * (K’s review, U2). The count is a note now — on the summary and the lenta.
 *
 * The model and the ledger's count are stand-ins.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100 }));

import {
  analyzeCollected,
  endIntake,
  filesMissingNote,
  startIntake,
  updateIntake,
} from '@/modules/platform/telegram/calc-intake';

const BILL = { model: 'm', inputTokens: 1, outputTokens: 1, at: 0 };
const chats: bigint[] = [];
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
  model.analyze.mockReset();
});

function collection() {
  const chatId = BigInt(-9_920_000_000) - BigInt(chats.length + 1);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-test' });
  return updateIntake(chatId, { stage: 'material', material: ['Kurtka 300 dona'], fileCount: 3 })!;
}

describe('the files a reading could not load are SAID', () => {
  it('two of three unreadable: the note names the count, in §2.6’s words', async () => {
    model.analyze.mockResolvedValueOnce({ ok: true, facts: { goods: [] }, steps: [], usage: BILL, answered: [BILL] });
    const out = await analyzeCollected(collection(), { images: [], pdfs: [], missing: 2 });
    expect(out.notes).toEqual([
      '⚠️ 2 ta fayl o‘qilmadi — saqlangan joydan olib bo‘lmadi. Kerak bo‘lsa qayta yuboring.',
    ]);
  });

  it('every file read: no note', async () => {
    model.analyze.mockResolvedValueOnce({ ok: true, facts: { goods: [] }, steps: [], usage: BILL, answered: [BILL] });
    const out = await analyzeCollected(collection(), { images: [], pdfs: [], missing: 0 });
    expect(out.notes).toEqual([]);
    expect(filesMissingNote(0)).toBeNull();
  });
});
