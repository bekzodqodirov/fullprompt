import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The reading WRITES what it left unread, as state (docs/FAYL-OQISH.md §10):
 * `aiCut`, `aiInputCut`, `filesMissing` and `unreadPdfs`, on every reading —
 * so the table, the save branch, the landing and the sweep ask
 * `aiReadingWhole` of the collection, never of the job's locals that are gone
 * by then (judge door-whole-inputs). And §2.5: a stored file that did not load
 * is `files_missing`, said once.
 *
 * The model and the ledger's count are stand-ins: the reading's outcome is
 * scripted, the collection is the real one.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100 }));

import { analyzeCollected, endIntake, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import { settleAnalysis } from '@/modules/platform/telegram/calc-read';
import { aiReadingWhole } from '@/modules/platform/telegram/reading-whole';

const BILL = { model: 'm', inputTokens: 1, outputTokens: 1, at: 0 };
const GOOD = { name: 'Kurtka', quantity: 300, weightKg: null, volumeM3: null, tnvedCode: null, note: null };
const read = (over: Record<string, unknown> = {}) => ({ ok: true, facts: { goods: [GOOD] }, steps: [], usage: BILL, answered: [BILL], ...over });
const NO_FILES = { images: [], pdfs: [], missing: 0 };
const chats: bigint[] = [];
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
  model.analyze.mockReset();
});

function collection(patch: Partial<IntakeState> = {}, ai = true): IntakeState {
  const chatId = BigInt(-9_933_000_000) - BigInt(chats.length + 1);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { ai, staffId: 'staff-test' });
  return updateIntake(chatId, { stage: 'material', material: ['Kurtka 300 dona'], fileCount: 1, ...patch })!;
}

describe('a cut, and the whole re-read after it', () => {
  it('the reading’s cut is the collection’s; a whole re-read clears it — through the settle too', async () => {
    const state = collection();
    model.analyze.mockResolvedValueOnce(read({ cut: { goods: 1, why: 'clock' } }));
    const cut = await analyzeCollected(state);
    expect(cut.aiCut).toEqual({ goods: 1, why: 'clock' });
    expect(aiReadingWhole(cut, 1).blocking).toEqual(['cut']);
    model.analyze.mockResolvedValueOnce(read());
    const whole = await analyzeCollected({ ...cut, analysing: null });
    expect(whole.aiCut).toBeNull();
    // The settle carries both ways — `...live` would keep the cut a whole
    // «🔄» cleared, or drop the cut a reading found.
    const token = 't-1';
    const live = { ...cut, analysing: token };
    const settled = settleAnalysis(live, live, whole, token);
    expect(settled.kind === 'done' && settled.state.aiCut).toBeNull();
    const settledCut = settleAnalysis({ ...state, analysing: token }, { ...state, analysing: token }, cut, token);
    expect(settledCut.kind === 'done' && settledCut.state.aiCut).toEqual({ goods: 1, why: 'clock' });
  });
});

describe('a sheet the model was not shown whole (§1.1 f)', () => {
  it('the reader’s own cut is an input cut; a whole sheet is none; the totals-only sheets never count', async () => {
    model.analyze.mockResolvedValue(read());
    const cut = await analyzeCollected(collection({ sheetTexts: [{ text: '1 | Kurtka\n2 | Shim', cut: true, cellsCut: false, label: '«A.xlsx»' }] }));
    expect(cut.aiInputCut).toBe(true);
    const whole = await analyzeCollected(collection({ sheetTexts: [{ text: '1 | Kurtka', cut: false, cellsCut: true, label: '«A.xlsx»' }] }));
    expect(whole.aiInputCut).toBe(false);
    const context = await analyzeCollected(collection({ invoiceTexts: [{ text: '[Packing]\nTOTAL | 9', cut: true, cellsCut: false, label: '«B.xlsx»' }] }));
    expect(context.aiInputCut).toBe(false);
  });
});

describe('a stored file that did not load (§2.5, pdfimg-3)', () => {
  it('with nothing else read it is the failure `files_missing`, said once — never «nothing to read»', async () => {
    model.analyze.mockResolvedValueOnce({ ok: false, failure: 'nothing_to_read' });
    const out = await analyzeCollected(collection({ material: [] }), { ...NO_FILES, missing: 2 });
    expect(out.aiFailure).toBe('files_missing');
    expect(out.filesMissing).toBe(2);
    expect(out.notes).toEqual([]);
  });

  it('beside other material read: the AI door’s note IS the 🔄 sentence; the plain door keeps its words', async () => {
    model.analyze.mockResolvedValue(read());
    const ai = await analyzeCollected(collection(), { ...NO_FILES, missing: 1 });
    expect(ai.aiFailure).toBeNull();
    expect(ai.filesMissing).toBe(1);
    expect(ai.notes).toEqual(['⚠️ 1 ta fayl saqlangan joydan olinmadi — «🔄 AI qayta o‘qisin» ni bosing.']);
    expect(aiReadingWhole(ai, 1).blocking).toEqual(['files_missing']);
    const plain = await analyzeCollected(collection({}, false), { ...NO_FILES, missing: 1 });
    expect(plain.notes).toEqual(['⚠️ 1 ta fayl o‘qilmadi — saqlangan joydan olib bo‘lmadi. Kerak bo‘lsa qayta yuboring.']);
    // …and a reading where every file loaded leaves nothing behind.
    const healed = await analyzeCollected({ ...ai, analysing: null }, NO_FILES);
    expect(healed.filesMissing).toBe(0);
  });
});

describe('PDFs the API refused (§3.4)', () => {
  it('named by the outcome, kept across re-reads that no longer send them, and only while the PDF is in the collection', async () => {
    const pdfs = [
      { attachmentId: 'p-bad', name: 'bad.pdf', bytes: 10 },
      { attachmentId: 'p-ok', name: 'ok.pdf', bytes: 10 },
    ];
    model.analyze.mockResolvedValueOnce(read({ unreadPdfs: ['p-bad'] }));
    const first = await analyzeCollected(collection({ pdfs }));
    expect(first.unreadPdfs).toEqual(['p-bad']);
    // The next reading does not send it (loadIntakeFiles skips it), so its
    // outcome names nothing — the refusal still stands.
    model.analyze.mockResolvedValueOnce(read());
    const again = await analyzeCollected({ ...first, analysing: null });
    expect(again.unreadPdfs).toEqual(['p-bad']);
    expect(aiReadingWhole(again, 1).blocking).toEqual(['pdf_refused']);
    // An id the collection does not hold is never written.
    model.analyze.mockResolvedValueOnce(read({ unreadPdfs: ['p-gone'] }));
    expect((await analyzeCollected(collection({ pdfs }))).unreadPdfs).toEqual([]);
  });

  it('each PDF reaches the model WITH its attachment, so a refusal can name it', async () => {
    model.analyze.mockResolvedValueOnce(read());
    await analyzeCollected(collection(), { images: [], pdfs: [{ data: Buffer.from('%PDF'), name: 'a.pdf', attachmentId: 'p1' }], missing: 0 });
    const call = model.analyze.mock.calls[0]![0] as { pdf: { attachmentId?: string }; salvage: boolean };
    expect(call.pdf.attachmentId).toBe('p1');
    expect(call.salvage).toBe(true);
  });
});

describe('the goods sheet’s own rows beside the codes asked (§3.7)', () => {
  it('a packing-shaped goods file’s text goes to the model only on the AI door, never into the totals sheets', async () => {
    const goodsFiles = [{ label: '«PL.xlsx»', shape: 'packing' as const, weightKind: null, grossKg: null, grossColumn: true, volumeM3: null, rows: 1, text: '[PL]\n1 | Kurtka | 300 | 150', at: { material: 0, files: 1 } }];
    model.analyze.mockResolvedValue(read());
    const ai = collection({ material: [], invoiceGoods: [GOOD], goodsFiles });
    await analyzeCollected(ai);
    const call = model.analyze.mock.calls[0]![0] as { goodsSheetText?: { text: string }; contextSheets: unknown[] };
    expect(call.goodsSheetText?.text).toBe('[PL]\n1 | Kurtka | 300 | 150');
    expect(call.contextSheets).toEqual([]);
    await analyzeCollected(collection({ material: [], invoiceGoods: [GOOD], goodsFiles }, false));
    expect((model.analyze.mock.calls[1]![0] as { goodsSheetText?: unknown }).goodsSheetText).toBeUndefined();
  });
});

describe('the add door’s reading writes them too (§1.6)', () => {
  it('a ➕ collection over a stored request: the cut and the refused PDF are the collection’s, as on a first one', async () => {
    const id = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
    const amend = {
      requestId: id(99),
      cardLabel: 'B-000067',
      entityType: 'deal' as const,
      entityId: id(98),
      leadOpen: null,
      section: 'rastamojka' as const,
      clientLabel: 'GS777',
      openedRev: 0,
      items: [{ itemId: id(1), seq: 1, name: 'Sumka', quantity: 10, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: null, law: null, confirmed: false }],
      weightKg: null,
      volumeM3: null,
      fromCity: null,
      toCity: null,
    };
    const chatId = BigInt(-9_934_000_000) - BigInt(chats.length + 1);
    chats.push(chatId);
    startIntake(chatId, 'rastamojka', { ai: true, staffId: 'staff-test', amend });
    const state = updateIntake(chatId, {
      stage: 'material',
      material: ['Kurtka 300 dona'],
      fileCount: 1,
      pdfs: [{ attachmentId: 'p-add', name: 'add.pdf', bytes: 4 }],
    })!;
    model.analyze.mockResolvedValueOnce(read({ cut: { goods: 1, why: 'size' }, unreadPdfs: ['p-add'] }));
    const out = await analyzeCollected(state, { ...NO_FILES, missing: 1 });
    expect(out.aiCut).toEqual({ goods: 1, why: 'size' });
    expect(out.unreadPdfs).toEqual(['p-add']);
    expect(out.filesMissing).toBe(1);
    // An add collection draws no «🔄» for a missing file (its keyboard is
    // `amendKeyboard`), so its note keeps today's words.
    expect(out.notes).toContain('⚠️ 1 ta fayl o‘qilmadi — saqlangan joydan olib bo‘lmadi. Kerak bo‘lsa qayta yuboring.');
  });
});
