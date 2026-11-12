import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «AI so‘raydi», package P-excel, phase 2 (docs/AI-SORAYDI.md §3.2 X2-X4) —
 * the «🤖 AI rastamojka» door END TO END over a real workbook: the file door
 * (`readIntakeFile`), the reading (`analyzeCollected`, the model stood in for
 * and answering NOTHING — every figure below is the sheet's own or the
 * kernel's product) and the table. `ai-soraydi-excel.test.ts` pins the
 * reader and the door's row; this pins that the row's packing survives the
 * collection — the state, the Σ the table draws, the note the card gets —
 * on the diagnosis' own sheets (dg2 `trace-excel-cbm`, `trace-dims`).
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

import { intakeNextStep } from '@/modules/platform/telegram/calc-dialog';
import { readIntakeFile } from '@/modules/platform/telegram/calc-files';
import { activeIntake, analyzeCollected, endIntake, loneFileTotals, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';
import { markIntakesHydrated } from '@/modules/platform/telegram/calc-store';
import { factsVolumeM3, landingItems, type CalcSection } from '@/modules/wms/calc/intake';
import { nameWordFor } from '@/modules/wms/calc/line-address';
import { resetReadingDrive } from '../fixtures/calc-read-drive';
import * as B from '../fixtures/fayl-books';

const BILL = { model: 'm', inputTokens: 1, outputTokens: 1, at: 0 };
let seq = 0;
const chats: bigint[] = [];

beforeAll(async () => {
  await import('@/modules/wms/calc/intake-manual');
  markIntakesHydrated();
});
beforeEach(() => {
  resetReadingDrive();
  model.analyze.mockReset();
  // The model reads the sheet's text and finds nothing to add: no goods, no totals.
  model.analyze.mockImplementation(async () => ({ ok: true, facts: { goods: [], weightKg: null, volumeM3: null }, steps: [], usage: BILL, answered: [BILL], knownCodes: [] }));
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

type R = (string | number | null)[];
const book = (header: (string | null)[], rows: R[]) => B.sheetsBook([['Sheet1', header, rows]]);

/** Files sent to a fresh AI-door collection, read, and the table drawn — as the bot does it. */
async function collect(section: CalcSection, files: [body: Buffer, name: string][]) {
  seq += 1;
  const chatId = BigInt(-9_476_200_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section, { staffId: 'staff-as-excel', ai: true });
  updateIntake(chatId, { stage: 'material' });
  const said: string[] = [];
  for (const [body, name] of files) {
    const live = activeIntake(chatId)!;
    const answer = await readIntakeFile({ isPhoto: false, body, attachmentId: `as-excel-${seq}-${name}` }, name, B.XLSX, live);
    updateIntake(chatId, { ...answer.patch, fileCount: live.fileCount + 1 });
    said.push(answer.say ?? '');
  }
  const held = activeIntake(chatId)!;
  const totals = loneFileTotals(held);
  const read = await analyzeCollected(held);
  updateIntake(chatId, { ...read, answered: undefined } as never);
  const state = activeIntake(chatId)!;
  const intake = await import('@/modules/wms/calc/intake');
  const table = intakeNextStep(state, new Map(), intake, { nameWord: nameWordFor, aiAvailable: true });
  const goods = state.facts.goods ?? [];
  return {
    said,
    totals,
    state,
    goods,
    cube: factsVolumeM3(state.facts as never),
    notes: landingItems(state.facts as never).map((item) => item.note),
    table: table.text,
  };
}

const HEAD = ['No.', 'Description', 'QTY(PCS)', 'CTNS'];
const JACKET: R = [1, 'Ladies jacket', 200, 10];
const TOY: R = [2, 'Kids toy plastic', 480, 20];
const LAMP: R = [3, 'LED lamp 50W', 300, 30];
const TOTAL: R = ['TOTAL', null, 980, 60];
const INVOICE_HEAD = ['No.', 'Description', 'QTY(PCS)', 'Unit price (USD)', 'Amount (USD)'];
const INVOICE_ROWS: R[] = [
  [1, 'Ladies jacket', 200, 6.5, 1300],
  [2, 'Kids toy plastic', 480, 1.2, 576],
  [3, 'LED lamp 50W', 300, 9.9, 2970],
  ['TOTAL', null, 980, null, 4846],
];

describe('one packing list on the AI door: the cartons multiply what one carton measures (XLS-4, DIM-7)', () => {
  it('S1 — «CTNS» beside «CBM/CTN»: every line’s cube, and the shipment’s 3.8 m³ the sheet states nowhere', async () => {
    const got = await collect('podklyuch', [
      [await book([...HEAD, 'G.W.(KGS)', 'CBM/CTN'], [[...JACKET, 120, 0.05], [...TOY, 260, 0.06], [...LAMP, 330, 0.07], [...TOTAL, 710, null]]), 'pl.xlsx'],
    ]);
    // 10 × 0.05 = 0.5, 20 × 0.06 = 1.2, 30 × 0.07 = 2.1; Σ = 3.8 m³. The pieces and the kilos are the sheet's own.
    expect(got.goods.map((g) => [g.name, g.quantity, g.weightKg, g.volumeM3])).toEqual([
      ['Ladies jacket', 200, 120, 0.5],
      ['Kids toy plastic', 480, 260, 1.2],
      ['LED lamp 50W', 300, 330, 2.1],
    ]);
    expect(got.cube).toBe(3.8);
    // The brutto is the sheet's «G.W.» Σ (120 + 260 + 330 = 710), as before; the cube is the rows'.
    expect(got.totals).toMatchObject({ weightKg: 710, volumeM3: null });
    expect(got.table).toContain('✅ Og‘irlik (brutto): 710 kg');
    expect(got.table).toContain('✅ Hajm: 3.8 m³');
    expect(got.table).not.toContain('umumiy hajmi (kub) — yozilmagan');
    // What the VED reads on the card: the factors, and that the product is the bot's.
    expect(got.notes).toEqual([
      '📦 10 karobka · 0.05 m³/karobka — fayldan · hajm hisoblangan: 10 × 0.05 m³ = 0.5 m³',
      '📦 20 karobka · 0.06 m³/karobka — fayldan · hajm hisoblangan: 20 × 0.06 m³ = 1.2 m³',
      '📦 30 karobka · 0.07 m³/karobka — fayldan · hajm hisoblangan: 30 × 0.07 m³ = 2.1 m³',
    ]);
  });

  it('S3 — «CARTON SIZE (CM)»: the size × the cartons, a unit glued to one cell read with it', async () => {
    const got = await collect('podklyuch', [
      [
        await book([...HEAD, 'CARTON SIZE (CM)', 'G.W.(KGS)'], [[...JACKET, '60*40*50', 120], [...TOY, '50*40*30', 260], [...LAMP, '70x50x20cm', 330], [...TOTAL, null, 710]]),
        'pl.xlsx',
      ],
    ]);
    // 0.6×0.4×0.5 = 0.12 × 10 = 1.2; 0.5×0.4×0.3 = 0.06 × 20 = 1.2; 0.7×0.5×0.2 = 0.07 × 30 = 2.1; Σ = 4.5 m³.
    expect(got.goods.map((g) => g.volumeM3)).toEqual([1.2, 1.2, 2.1]);
    expect(got.cube).toBe(4.5);
    expect(got.table).toContain('✅ Hajm: 4.5 m³');
    expect(got.notes[2]).toBe('📦 30 karobka · 70×50×20 sm — fayldan · hajm hisoblangan: 30 × 70×50×20 sm = 2.1 m³');
  });

  it('DIM-8 — an unmarked «CBM» that is ONE carton’s, beside the size: the lines are corrected and the column’s Σ is not the shipment', async () => {
    const got = await collect('podklyuch', [
      [
        await book([...HEAD, 'CARTON SIZE (CM)', 'CBM', 'G.W.(KGS)'], [[...JACKET, '60*40*50', 0.12, 120], [...TOY, '50*40*30', 0.06, 260], [...TOTAL, null, 0.18, 380]]),
        'pl.xlsx',
      ],
    ]);
    // Each «CBM» cell equals its carton (0.12, 0.06): 10 × 0.12 = 1.2 and 20 × 0.06 = 1.2 — 2.4 m³, where the
    // column and its own TOTAL row say 0.18 (thirteen times less).
    expect(got.goods.map((g) => g.volumeM3)).toEqual([1.2, 1.2]);
    expect(got.totals).toMatchObject({ weightKg: 380, volumeM3: null });
    expect(got.state.facts.volumeM3 ?? null).toBeNull();
    expect(got.cube).toBe(2.4);
    expect(got.table).toContain('✅ Hajm: 2.4 m³');
    expect(got.table).not.toContain('0.18');
    expect(got.notes[0]).toBe('📦 10 karobka · 60×40×50 sm — fayldan · hajm bitta karobkaniki edi (0.12): 10 × 60×40×50 sm = 1.2 m³');
  });

  it('a bare «Size» is nobody’s: nothing is multiplied, and the cube is still asked', async () => {
    const got = await collect('podklyuch', [[await book([...HEAD, 'Size (cm)', 'G.W.(KGS)'], [[...JACKET, '60*40*50', 120], [...TOY, '50*40*30', 260]]), 'pl.xlsx']]);
    expect(got.goods.map((g) => g.volumeM3 ?? null)).toEqual([null, null]);
    expect(got.cube).toBeNull();
    expect(got.table).toContain('⚠️ umumiy hajmi (kub) — yozilmagan');
    expect(got.notes).toEqual([
      '📦 10 karobka · o‘lcham (kimniki — aniq emas) 60×40×50 sm — fayldan',
      '📦 20 karobka · o‘lcham (kimniki — aniq emas) 50×40×30 sm — fayldan',
    ]);
  });

  it('U2 — «Karobka soni» alone: ten cartons are not ten jackets', async () => {
    const got = await collect('rastamojka', [
      [
        await book(['Tovar nomi', 'Karobka soni', 'Og‘irligi (kg)', 'Kubi'], [['Ayollar kurtkasi', 10, 120, 0.5], ['Bolalar o‘yinchog‘i', 20, 260, 1.2], ['Jami', 30, 380, 1.7]]),
        'yuk.xlsx',
      ],
    ]);
    expect(got.goods.map((g) => [g.name, g.quantity ?? null, g.weightKg, g.volumeM3, g.packing?.cartons ?? null])).toEqual([
      ['Ayollar kurtkasi', null, 120, 0.5, 10],
      ['Bolalar o‘yinchog‘i', null, 260, 1.2, 20],
    ]);
    // No piece count is drawn on either row, and the card says the cartons once.
    expect(got.table).not.toMatch(/\b(?:10|20) dona\b/);
    expect(got.notes).toEqual(['📦 10 karobka — fayldan', '📦 20 karobka — fayldan']);
  });
});

describe('a packing list beside an invoice: the goods are the invoice’s, and no carton arithmetic lands twice', () => {
  const packingList = () => book([...HEAD, 'G.W./CTN', 'CBM'], [[...JACKET, 12, 0.5], [...TOY, 13, 1.2], [...LAMP, 11, 2.1]]);

  it('the list first, then the invoice: three rows, the list’s cube — and its cartons’ GROSS is never a line’s netto', async () => {
    const got = await collect('podklyuch', [
      [await packingList(), 'pl.xlsx'],
      [await book(INVOICE_HEAD, INVOICE_ROWS), 'ci.xlsx'],
    ]);
    // The list alone read 10 × 12 = 120, 20 × 13 = 260, 30 × 11 = 330 kg — brutto, made of «G.W./CTN». With the
    // invoice holding the goods those are not written into its rows: a line's weight is its netto.
    expect(got.goods.map((g) => [g.name, g.quantity, g.weightKg ?? null])).toEqual([
      ['Ladies jacket', 200, null],
      ['Kids toy plastic', 480, null],
      ['LED lamp 50W', 300, null],
    ]);
    // 0.5 + 1.2 + 2.1 = 3.8 m³, the list's own column.
    expect(got.cube).toBe(3.8);
    expect(got.table).not.toMatch(/\b(?:120|260|330) kg\b/);
  });

  it('the invoice first, then a list with «CBM/CTN»: three rows, the list’s brutto, nothing doubled', async () => {
    const got = await collect('podklyuch', [
      [await book(INVOICE_HEAD, INVOICE_ROWS), 'ci.xlsx'],
      [await book([...HEAD, 'G.W.(KGS)', 'CBM/CTN'], [[...JACKET, 120, 0.05], [...TOY, 260, 0.06], [...LAMP, 330, 0.07], [...TOTAL, 710, null]]), 'pl.xlsx'],
    ]);
    expect(got.goods.map((g) => [g.name, g.quantity])).toEqual([
      ['Ladies jacket', 200],
      ['Kids toy plastic', 480],
      ['LED lamp 50W', 300],
    ]);
    expect(got.table).toContain('✅ Og‘irlik (brutto): 710 kg');
  });
});

describe('X5 — a column the sheet’s own TOTAL row shows to be ONE carton’s, end to end (XLS-1; review JN-12, JR-11)', () => {
  it('W1 — unmarked per-carton «G.W.» and «CBM»: the lines computed, the shipment’s totals the TOTAL row’s, and the receipt says why', async () => {
    const got = await collect('podklyuch', [
      [await book([...HEAD, 'G.W.(KGS)', 'CBM'], [[...JACKET, 12, 0.05], [...TOY, 13, 0.06], [...LAMP, 11, 0.07], [...TOTAL, 710, 3.8]]), 'pl.xlsx'],
    ]);
    // 10 × 12 = 120, 20 × 13 = 260, 30 × 11 = 330 kg (Σ 710); 10 × 0.05 = 0.5, 20 × 0.06 = 1.2, 30 × 0.07 = 2.1 m³ (Σ 3.8).
    expect(got.goods.map((g) => [g.name, g.weightKg, g.volumeM3])).toEqual([
      ['Ladies jacket', 120, 0.5],
      ['Kids toy plastic', 260, 1.2],
      ['LED lamp 50W', 330, 2.1],
    ]);
    expect(got.totals).toMatchObject({ weightKg: 710, volumeM3: 3.8 });
    expect(got.cube).toBe(3.8);
    expect(got.table).toContain('✅ Og‘irlik (brutto): 710 kg');
    expect(got.table).not.toMatch(/\b(?:12|13|11) kg\b/);
    // The receipt says it, once per column — and it stays the file's note for the card.
    expect(got.said[0]).toContain('📄 «pl.xlsx» — «G.W.(KGS)» ustunidagi son bitta karobkaniki: karobkalar soni × shu son = 710 kg, fayldagi jami bilan bir xil — qatorlar shundan hisoblandi.');
    expect(got.said[0]).toContain('📄 «pl.xlsx» — «CBM» ustunidagi son bitta karobkaniki: karobkalar soni × shu son = 3.8 m³, fayldagi jami bilan bir xil — qatorlar shundan hisoblandi.');
    expect(got.state.fileNotes.filter((n) => n.includes('bitta karobkaniki'))).toHaveLength(2);
    // What the VED reads on each row: the factors and that the product is the bot's.
    expect(got.notes[0]).toContain('hajm hisoblangan: 10 × 0.05 m³ = 0.5 m³');
    expect(got.notes[0]).toContain('10 × 12 kg = 120 kg');
  });

  it('the pallet sheet — nothing explains the TOTAL: the lines stand, no brutto is offered, and both sums are said', async () => {
    const got = await collect('podklyuch', [
      [await book(['Description', 'CTN', 'G.W.(kg)', 'CBM'], [['Kurtka', 10, 100, 1.0], ['Shim', 5, 166, 1.1], ['TOTAL', 15, 300, 2.1]]), 'pl.xlsx'],
    ]);
    // 100 + 166 = 266 kg in the lines, 300 in the TOTAL row; the cube agrees (1.0 + 1.1 = 2.1).
    expect(got.goods.map((g) => [g.name, g.weightKg, g.volumeM3])).toEqual([
      ['Kurtka', 100, 1],
      ['Shim', 166, 1.1],
    ]);
    expect(got.totals).toMatchObject({ weightKg: null, volumeM3: 2.1 });
    expect(got.said[0]).toContain('⚠️ «pl.xlsx» — «G.W.(kg)» ustuni: jami qatorida 300 kg, qatorlar yig‘indisi 266 kg — umumiy brutto fayldan olinmadi.');
  });
});
