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

import { applyTableAnswer, intakeNextStep, tableEditsSettled } from '@/modules/platform/telegram/calc-dialog';
import { readIntakeFile } from '@/modules/platform/telegram/calc-files';
import { columnAsks } from '@/modules/platform/telegram/file-goods';
import { activeIntake, analyzeCollected, endIntake, loneFileTotals, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';
import { markIntakesHydrated } from '@/modules/platform/telegram/calc-store';
import { factsVolumeM3, landingItems, tableAsksOf, type CalcSection } from '@/modules/wms/calc/intake';
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
async function collect(section: CalcSection, files: [body: Buffer, name: string][], opts: { ai?: boolean } = {}) {
  seq += 1;
  const chatId = BigInt(-9_476_200_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, section, { staffId: 'staff-as-excel', ai: opts.ai ?? true });
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
    chatId,
    said,
    totals,
    state,
    goods,
    cube: factsVolumeM3(state.facts as never),
    notes: landingItems(state.facts as never).map((item) => item.note),
    table: table.text,
  };
}

/**
 * A typed answer at the table, as the bot writes it (`applyTableAnswer`), and the collection as it then
 * stands: what the INSERT would take — the cube (`factsVolumeM3`), the brutto — and the table drawn again.
 */
async function answer(chatId: bigint, text: string) {
  const ctx = {
    async reply() {
      return { message_id: 1 };
    },
    api: {
      async editMessageText() {
        return true;
      },
      async deleteMessage() {
        return true;
      },
      async setMessageReaction() {
        return true;
      },
    },
  };
  await applyTableAnswer(ctx as never, chatId, activeIntake(chatId)!, text, { date: 0, messageId: 77, forwarded: false, replyTo: null });
  await tableEditsSettled();
  const state = activeIntake(chatId)!;
  const intake = await import('@/modules/wms/calc/intake');
  const table = intakeNextStep(state, new Map(), intake, { nameWord: nameWordFor, aiAvailable: true });
  return { state, goods: state.facts.goods ?? [], cube: factsVolumeM3(state.facts as never), weightKg: state.facts.weightKg ?? null, table: table.text };
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
    // The cube is the rows'. The «G.W.» column beside 10, 20, 30 cartons is ASKED (JN-12: its TOTAL 710 is its own
    // Σ and proves nothing), so its Σ is no brutto (review seams-2 — re-anchored: the brutto WAS 710 «✅», drawn
    // beside the very question that doubts it): the brutto is the seller's, the column question his to answer.
    expect(got.state.goodsFiles?.[0]?.asks?.map((a) => a.title)).toEqual(['G.W.(KGS)']);
    expect(got.totals).toMatchObject({ weightKg: null, volumeM3: null, doubted: ['weightKg'] });
    expect(got.table).not.toContain('710 kg');
    expect(got.table).toContain('umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan');
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
    // …and the «G.W.» column beside 10 and 20 cartons is asked (JN-12): its Σ 380 is no brutto (review seams-2 —
    // re-anchored from weightKg 380).
    expect(got.totals).toMatchObject({ weightKg: null, volumeM3: null, doubted: ['weightKg'] });
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
    // The list's «CBM» beside 10, 20, 30 cartons is a column its own question asks (JN-12), and beside the invoice
    // that question is not drawn under the invoice's rows — so its Σ 0.5 + 1.2 + 2.1 = 3.8 m³ is not the shipment's
    // either: the cube is asked and the receipt says which column (review seams-4 — re-anchored from cube 3.8).
    expect(got.cube).toBeNull();
    expect(got.state.fileTotals).toMatchObject({ volumeM3: null, doubted: ['volumeM3'] });
    expect(got.table).toContain('umumiy hajmi (kub) — yozilmagan');
    expect(got.said.join('\n')).toContain('«CBM» ustunidagi son bitta karobkanikimi yoki qatornikimi — aniq emas, shuning uchun kub fayldan olinmadi');
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
    // The list's «G.W.(KGS)» beside 10, 20, 30 cartons is asked (JN-12): its Σ 710 is no brutto beside the invoice
    // either (review seams-4 — re-anchored from «✅ Og‘irlik (brutto): 710 kg»); the receipt names the column.
    expect(got.table).not.toContain('710 kg');
    expect(got.table).toContain('umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan');
    expect(got.said[1]).toContain('«G.W.(KGS)» ustunidagi son bitta karobkanikimi yoki qatornikimi — aniq emas, shuning uchun umumiy brutto fayldan olinmadi');
  });
});

describe('review seams-4: a packing list beside its invoice — its column questions are not dropped, its asked Σ is no brutto or cube', () => {
  // The finding's pair: an invoice with the lines' netto, and a packing list of the same goods whose «G.W.(KGS)» and
  // «CBM» beside 10, 20, 30 cartons are asked on their own (TOTAL 36 / 0.18 is each column's Σ — JN-12).
  const CI_HEAD = ['No.', 'Description', 'QTY', 'Unit price', 'Amount', 'N.W.(KGS)'];
  const CI_ROWS: R[] = [[1, 'Ladies jacket', 200, 6.5, 1300, 100], [2, 'Kids toy plastic', 480, 1.5, 720, 240], [3, 'LED lamp 50W', 300, 3, 900, 300]];
  const PL_HEAD = ['No.', 'Description', 'QTY', 'CTNS', 'G.W.(KGS)', 'CBM'];
  const PL_ROWS: R[] = [[1, 'Ladies jacket', 200, 10, 12, 0.05], [2, 'Kids toy plastic', 480, 20, 13, 0.06], [3, 'LED lamp 50W', 300, 30, 11, 0.07], ['TOTAL', null, 980, 60, 36, 0.18]];
  const RECEIPT = '«G.W.(KGS)» va «CBM» ustunlaridagi sonlar bitta karobkanikimi yoki qatornikimi — aniq emas, shuning uchun umumiy brutto va kub fayldan olinmadi';

  it('pl.xlsx alone asks both columns (the control)', async () => {
    const got = await collect('podklyuch', [[await book(PL_HEAD, PL_ROWS), 'pl.xlsx']]);
    expect(got.state.goodsFiles?.[0]?.asks?.map((a) => a.title)).toEqual(['G.W.(KGS)', 'CBM']);
  });

  for (const order of ['ci then pl', 'pl then ci', 'one workbook'] as const) {
    it(`${order}: no «✅ brutto 36 kg / kub 0.18» — both asked, and the receipt names the columns`, async () => {
      const ci = () => book(CI_HEAD, CI_ROWS);
      const pl = () => book(PL_HEAD, PL_ROWS);
      const files: [Buffer, string][] =
        order === 'ci then pl'
          ? [[await ci(), 'ci.xlsx'], [await pl(), 'pl.xlsx']]
          : order === 'pl then ci'
            ? [[await pl(), 'pl.xlsx'], [await ci(), 'ci.xlsx']]
            : [[await B.sheetsBook([['Invoice', CI_HEAD, CI_ROWS], ['Packing', PL_HEAD, PL_ROWS]]), 'docs.xlsx']];
      const got = await collect('podklyuch', files);
      // The goods are the invoice's three rows, with their netto.
      expect(got.goods.map((g) => [g.name, g.weightKg])).toEqual([
        ['Ladies jacket', 100],
        ['Kids toy plastic', 240],
        ['LED lamp 50W', 300],
      ]);
      expect(got.state.fileTotals).toMatchObject({ weightKg: null, volumeM3: null, doubted: ['weightKg', 'volumeM3'] });
      expect(got.state.facts.weightKg ?? null).toBeNull();
      expect(got.cube).toBeNull();
      expect(got.table).not.toContain('36 kg');
      expect(got.table).not.toContain('0.18');
      expect(got.table).toContain('umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan');
      expect(got.table).toContain('umumiy hajmi (kub) — yozilmagan');
      expect(got.said.join('\n')).toContain(RECEIPT);
      expect(got.said.join('\n')).not.toContain('bundan faqat umumiy brutto va kub olindi');
    });
  }

  it('…and the model reading the list’s TOTAL row does not stand for the shipment either', async () => {
    model.analyze.mockImplementation(async () => ({ ok: true, facts: { goods: [], weightKg: 36, volumeM3: 0.18 }, steps: [], usage: BILL, answered: [BILL], knownCodes: [] }));
    const got = await collect('podklyuch', [[await book(CI_HEAD, CI_ROWS), 'ci.xlsx'], [await book(PL_HEAD, PL_ROWS), 'pl.xlsx']]);
    expect(got.state.facts.weightKg ?? null).toBeNull();
    expect(got.state.facts.volumeM3 ?? null).toBeNull();
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
    // Both columns beside 10 and 5 cartons are asked (JN-12, JR-11 «the line figures STAY, the Σ stays null»): the
    // cube is the rows' own 2.1 «qatorlardan», never the file's stated Σ (review seams-2 — re-anchored from
    // volumeM3 2.1 in the lone totals).
    expect(got.totals).toMatchObject({ weightKg: null, volumeM3: null, doubted: ['weightKg', 'volumeM3'] });
    expect(got.cube).toBe(2.1);
    expect(got.table).toContain('✅ Hajm: 2.1 m³ (qatorlardan)');
    expect(got.said[0]).toContain('⚠️ «pl.xlsx» — «G.W.(kg)» ustuni: jami qatorida 300 kg, qatorlar yig‘indisi 266 kg — umumiy brutto fayldan olinmadi.');
  });
});

describe('X8 — the TOTAL row and a summary line as the sheet’s totals, end to end (XLS-6; review JR-3)', () => {
  it('S2 — the cube only in the TOTAL row of a packing list: the shipment’s 3.8 m³, the lines asking none', async () => {
    const got = await collect('podklyuch', [
      [await book([...HEAD, 'G.W.(KGS)', 'CBM'], [[...JACKET, 120, null], [...TOY, 260, null], [...LAMP, 330, null], [...TOTAL, 710, 3.8]]), 'pl.xlsx'],
    ]);
    // The cube no line states is the TOTAL row's 3.8. The «G.W.» column beside 10, 20, 30 cartons is asked (JN-12),
    // so its Σ 120 + 260 + 330 = 710 is no brutto (review seams-2 — re-anchored from weightKg 710 «✅»).
    expect(got.totals).toMatchObject({ weightKg: null, volumeM3: 3.8, doubted: ['weightKg'] });
    expect(got.table).not.toContain('710 kg');
    expect(got.table).toContain('umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan');
    expect(got.table).toContain('✅ Hajm: 3.8');
    expect(got.table).not.toContain('umumiy hajmi (kub) — yozilmagan');
  });

  it('V1 — «TOTAL: 60 CTNS / G.W. 710 KGS / 3.8 CBM» under an invoice: its brutto is the shipment’s', async () => {
    const got = await collect('rastamojka', [[await B.sheetsBook([['Sheet1', INVOICE_HEAD, [...INVOICE_ROWS, [], ['TOTAL: 60 CTNS / G.W. 710 KGS / 3.8 CBM']]]]), 'ci.xlsx']]);
    expect(got.totals).toMatchObject({ weightKg: 710, weightNetto: false });
    expect(got.table).not.toContain('umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan');
    // X8's third sentence (review excel-spec-3): the invoice's own text — its TOTAL line with it — is handed
    // to the model under the totals heading, as a packing sheet's is.
    const handed = model.analyze.mock.calls.at(-1)?.[0] as { goodsSheetText?: { text: string } } | undefined;
    expect(handed?.goodsSheetText?.text).toContain('TOTAL: 60 CTNS / G.W. 710 KGS / 3.8 CBM');
    // The reader reads the cube too (3.8), and the lone invoice's totals now carry it (the lead's call on
    // the fixer's «open» excel-spec-3, `loneFileTotals`): with the model silent the table states the
    // file's own 3.8 instead of asking a cube the seller's file already wrote.
    expect(got.state.goodsFiles?.[0]).toMatchObject({ shape: 'invoice', volumeM3: 3.8 });
    expect(got.totals).toMatchObject({ volumeM3: 3.8 });
    expect(got.table).toContain('✅ Hajm: 3.8');
    expect(got.table).not.toContain('umumiy hajmi (kub) — yozilmagan');
  });

  it('…an invoice whose every line states its cube: no stated cube — the CURRENT lines’ Σ «qatorlardan», which a row corrected at the table moves (review seams-3)', async () => {
    const head = [...INVOICE_HEAD, 'CBM'];
    const rows: R[] = [[1, 'Ladies jacket', 200, 6.5, 1300, 1.2], [2, 'Kids toy plastic', 480, 1.5, 720, 1.1], [3, 'LED lamp 50W', 300, 3, 900, 1.5]];
    const got = await collect('podklyuch', [[await B.sheetsBook([['Sheet1', head, rows]]), 'ci.xlsx']]);
    // 1.2 + 1.1 + 1.5 = 3.8, by hand — the lines' Σ, never a figure the file stated: the lone totals give no cube.
    expect(got.totals).toBeNull();
    expect(got.state.facts.volumeM3 ?? null).toBeNull();
    expect(got.cube).toBe(3.8);
    expect(got.table).toContain('✅ Hajm: 3.8 m³ (qatorlardan)');
    // The seller corrects the toy's cube: 1.2 + 2.1 + 1.5 = 4.8 is what the road is priced on now.
    const after = await answer(got.chatId, '2: 2.1 m3');
    expect(after.goods.map((g) => g.volumeM3)).toEqual([1.2, 2.1, 1.5]);
    expect(after.cube).toBe(4.8);
    expect(after.table).toContain('✅ Hajm: 4.8 m³ (qatorlardan)');
    expect(after.table).not.toContain('3.8');
  });

  it('review seams-1: «TOTAL: 60 CTNS  G.W. 710  CBM 3.8» — the 710 is the weight label’s: no 710 m³, and the model’s 3.8 stands', async () => {
    model.analyze.mockImplementation(async () => ({ ok: true, facts: { goods: [], weightKg: 710, volumeM3: 3.8 }, steps: [], usage: BILL, answered: [BILL], knownCodes: [] }));
    const got = await collect('podklyuch', [[await B.sheetsBook([['Sheet1', INVOICE_HEAD, [...INVOICE_ROWS, [], ['TOTAL: 60 CTNS  G.W. 710  CBM 3.8']]]]), 'ci.xlsx']]);
    expect(got.state.goodsFiles?.[0]).toMatchObject({ volumeM3: null });
    expect(got.state.facts.volumeM3).toBe(3.8);
    expect(got.table).toContain('✅ Hajm: 3.8');
    expect(got.table).not.toContain('710 kub');
  });

  it('…an invoice whose TOTAL row states only the count and the money keeps no text of its own: nothing new under the totals heading', async () => {
    await collect('rastamojka', [[await B.sheetsBook([['Sheet1', INVOICE_HEAD, INVOICE_ROWS]]), 'ci.xlsx']]);
    const handed = model.analyze.mock.calls.at(-1)?.[0] as { goodsSheetText?: { text: string } } | undefined;
    expect(handed?.goodsSheetText ?? null).toBeNull();
  });

  it('a sectioned list with one blank weight: the sections added — never the last one’s 166 as the shipment', async () => {
    const got = await collect('podklyuch', [
      [await book(['Description', 'CTN', 'G.W.(kg)', 'CBM'], [['Kurtka', 10, 100, 1.0], ['TOTAL', 10, 100, 1.0], ['Shim', 5, null, 1.1], ['TOTAL', 5, 166, 1.1]]), 'pl.xlsx'],
    ]);
    // 100 + 166 = 266 kg. The «CBM» column beside 10 and 5 cartons is asked (JN-12): the cube is the rows' own
    // 1.0 + 1.1 = 2.1 «qatorlardan», never the file's stated Σ (review seams-2 — re-anchored from volumeM3 2.1).
    expect(got.totals).toMatchObject({ weightKg: 266, volumeM3: null, doubted: ['volumeM3'] });
    expect(got.table).toContain('✅ Og‘irlik (brutto): 266 kg');
    expect(got.cube).toBe(2.1);
    expect(got.table).toContain('✅ Hajm: 2.1 m³ (qatorlardan)');
  });
});

describe('X5 — a line column nothing settles is ASKED once, by the rows it is about (review JN-12, excel-spec-1)', () => {
  // The reviewer's sheet: a TOTAL that is each column's own Σ — 12 + 13 + 11 = 36 kg, 0.05 + 0.06 + 0.07 =
  // 0.18 m³ — beside 10, 20 and 30 cartons. As one carton's the shipment would be 10 × 12 + 20 × 13 + 30 × 11 =
  // 710 kg and 0.5 + 1.2 + 2.1 = 3.8 m³, about 20 × more. Nothing on the sheet says which.
  const SHEET = () =>
    book([...HEAD, 'G.W.(KGS)', 'CBM'], [[...JACKET, 12, 0.05], [...TOY, 13, 0.06], [...LAMP, 11, 0.07], [...TOTAL, 36, 0.18]]);

  it('the file’s block keeps the two column questions; the table’s asks hold «to‘liq» with them (`columnAsks`)', async () => {
    const got = await collect('rastamojka', [[await SHEET(), 'pl.xlsx']]);
    // The lines stand as the file wrote them (JN-12: an unexplained column never nulls them).
    expect(got.goods.map((g) => [g.weightKg, g.volumeM3])).toEqual([
      [12, 0.05],
      [13, 0.06],
      [11, 0.07],
    ]);
    expect(got.state.goodsFiles?.[0]?.asks?.map((a) => [a.field, a.title, a.rows.length])).toEqual([
      ['weightKg', 'G.W.(KGS)', 3],
      ['volumeM3', 'CBM', 3],
    ]);
    const asks = columnAsks(got.state.goodsFiles, got.goods);
    expect(asks).toEqual([
      { id: 'col:0:weightKg', row: null, holds: true, text: '«G.W.(KGS)» ustuni — bitta karobkanikimi yoki qatornikimi? Har qatorning umumiy og‘irligini (kg) yozing: «1: …».' },
      { id: 'col:0:volumeM3', row: null, holds: true, text: '«CBM» ustuni — bitta karobkanikimi yoki qatornikimi? Har qatorning umumiy hajmini (m³) yozing: «1: …».' },
    ]);
    // …and handed to the table's ONE list of asks, they are drawn with the table's own.
    const all = tableAsksOf({ section: got.state.section, facts: got.state.facts, laws: new Map(), amend: null, plain: false, aiQuestions: [], asks });
    expect(all.filter((a) => a.id.startsWith('col:')).every((a) => a.holds)).toBe(true);
  });

  it('review seams-2: the asked column’s Σ is not the shipment’s — the cube follows the rows the seller answers, the brutto is asked', async () => {
    const got = await collect('podklyuch', [[await SHEET(), 'pl.xlsx']]);
    // Nothing the file built from the asked columns stands: not its Σ 36 kg / 0.18 m³ as the shipment's.
    expect(got.totals).toMatchObject({ weightKg: null, volumeM3: null, doubted: ['weightKg', 'volumeM3'] });
    expect(got.state.facts.weightKg ?? null).toBeNull();
    expect(got.state.facts.volumeM3 ?? null).toBeNull();
    expect(got.table).not.toContain('36 kg');
    expect(got.table).toContain('umumiy brutto og‘irligi (kg, qadoq bilan) — yozilmagan');
    // The seller answers every row as the question tells him: 120 + 260 + 330 = 710 kg, 0.5 + 1.2 + 2.1 = 3.8 m³.
    let after = await answer(got.chatId, '1: 120 kg 0.5 m3');
    after = await answer(got.chatId, '2: 260 kg 1.2 m3');
    after = await answer(got.chatId, '3: 330 kg 2.1 m3');
    expect(after.goods.map((g) => [g.weightKg, g.volumeM3])).toEqual([
      [120, 0.5],
      [260, 1.2],
      [330, 2.1],
    ]);
    expect(columnAsks(after.state.goodsFiles, after.goods)).toEqual([]);
    expect(after.cube).toBe(3.8);
    expect(after.table).toContain('✅ Hajm: 3.8 m³ (qatorlardan)');
    expect(after.table).not.toContain('0.18');
    // The brutto is still the seller's to give — never the column's 36.
    expect(after.weightKg).toBeNull();
    expect(after.table).not.toContain('36 kg');
  });

  it('…on the plain door, frozen, the file’s totals stand as they always did (nothing there asks the column)', async () => {
    const got = await collect('podklyuch', [[await SHEET(), 'pl.xlsx']], { ai: false });
    expect(got.totals).toMatchObject({ weightKg: 36, volumeM3: 0.18 });
    expect(got.totals?.doubted).toBeUndefined();
  });

  it('…and the model reading the same sheet’s TOTAL row does not stand for it either', async () => {
    model.analyze.mockImplementation(async () => ({ ok: true, facts: { goods: [], weightKg: 36, volumeM3: 0.18 }, steps: [], usage: BILL, answered: [BILL], knownCodes: [] }));
    const got = await collect('podklyuch', [[await SHEET(), 'pl.xlsx']]);
    expect(got.state.facts.weightKg ?? null).toBeNull();
    expect(got.state.facts.volumeM3 ?? null).toBeNull();
    const after = await answer(got.chatId, '1: 120 kg 0.5 m3\n2: 260 kg 1.2 m3\n3: 330 kg 2.1 m3');
    expect(after.cube).toBe(3.8);
  });

  it('…on an invoice with the same columns (no TOTAL row): the cube follows the answered rows — 3.8, never 0.18', async () => {
    const head = ['No.', 'Description', 'QTY(PCS)', 'CTNS', 'Unit price (USD)', 'Amount (USD)', 'CBM'];
    const rows: R[] = [[1, 'Ladies jacket', 200, 10, 6.5, 1300, 0.05], [2, 'Kids toy plastic', 480, 20, 1.5, 720, 0.06], [3, 'LED lamp 50W', 300, 30, 3, 900, 0.07]];
    const got = await collect('podklyuch', [[await book(head, rows), 'ci.xlsx']]);
    expect(got.state.goodsFiles?.[0]?.asks?.map((a) => a.field)).toEqual(['volumeM3']);
    let after = await answer(got.chatId, '1: 0.5 m3');
    after = await answer(got.chatId, '2: 1.2 m3');
    after = await answer(got.chatId, '3: 2.1 m3');
    expect(after.cube).toBe(3.8);
    expect(after.table).toContain('✅ Hajm: 3.8 m³ (qatorlardan)');
  });

  it('review seams-5: two rows of one name are two rows — answering the first does not close the second', async () => {
    const got = await collect('rastamojka', [
      [await book([...HEAD, 'G.W.(KGS)', 'CBM'], [[1, 'Office chair', 200, 10, 12, 0.05], [2, 'Office chair', 480, 20, 13, 0.06], [3, 'Desk', 300, 30, 11, 0.07], [...TOTAL, 36, 0.18]]), 'pl.xlsx'],
    ]);
    expect(columnAsks(got.state.goodsFiles, got.goods).map((a) => a.id)).toEqual(['col:0:weightKg', 'col:0:volumeM3']);
    await answer(got.chatId, '1: 120 kg 0.5 m3');
    let after = await answer(got.chatId, '3: 330 kg 2.1 m3');
    // Row 2 still carries the file's 13 kg / 0.06 m³: both questions stand, and nothing reads «to‘liq».
    expect(after.goods[1]).toMatchObject({ name: 'Office chair', weightKg: 13, volumeM3: 0.06 });
    expect(columnAsks(after.state.goodsFiles, after.goods).map((a) => a.id)).toEqual(['col:0:weightKg', 'col:0:volumeM3']);
    expect(after.table).not.toContain('Ma’lumot to‘liq');
    after = await answer(got.chatId, '2: 260 kg 1.2 m3');
    expect(columnAsks(after.state.goodsFiles, after.goods)).toEqual([]);
  });

  it('…by its PLACE: a same-named row the question never asked (one carton) does not hold the column open', async () => {
    const got = await collect('rastamojka', [
      [await book([...HEAD, 'G.W.(KGS)'], [[1, 'Office chair', 200, 10, 12], [2, 'Office chair', 20, 1, 12], [3, 'Desk', 300, 30, 11], [...TOTAL, 35]]), 'pl.xlsx'],
    ]);
    // Rows 1 and 3 are asked (10 and 30 cartons); row 2 is one carton, never asked, and states the same 12 kg.
    expect(got.state.goodsFiles?.[0]?.asks?.[0]?.rows.map((r) => [r.name, r.value, r.at])).toEqual([
      ['Office chair', 12, 0],
      ['Desk', 11, 2],
    ]);
    await answer(got.chatId, '1: 120 kg');
    const after = await answer(got.chatId, '3: 330 kg');
    expect(columnAsks(after.state.goodsFiles, after.goods)).toEqual([]);
  });

  it('…and an ask stored before the place was kept is judged over EVERY row of its name — never the first alone', () => {
    const files = [{ label: '«pl.xlsx»', shape: 'packing' as const, weightKind: 'gross' as const, grossKg: null, grossColumn: true, volumeM3: null, rows: 3, text: null,
      asks: [{ field: 'weightKg' as const, title: 'G.W.(KGS)', rows: [{ name: 'Office chair', value: 12 }, { name: 'Office chair', value: 13 }, { name: 'Desk', value: 11 }] }] }];
    const person = { person: ['weightKg' as const] };
    const goods = [
      { name: 'Office chair', weightKg: 120, derived: person },
      { name: 'Office chair', weightKg: 13 },
      { name: 'Desk', weightKg: 330, derived: person },
    ];
    expect(columnAsks(files, goods).map((a) => a.id)).toEqual(['col:0:weightKg']);
    expect(columnAsks(files, goods.map((g) => ({ ...g, derived: person })))).toEqual([]);
  });

  it('a row a person answered — or whose figure is no longer the file’s — is answered; the column stands while one row is not', async () => {
    const got = await collect('rastamojka', [[await SHEET(), 'pl.xlsx']]);
    const answer = (field: 'weightKg' | 'volumeM3', upTo: number, how: 'person' | 'changed') =>
      got.goods.map((g, i) =>
        i >= upTo ? g : how === 'person' ? { ...g, derived: { ...(g.derived ?? {}), person: [...(g.derived?.person ?? []), field] } } : { ...g, [field]: (g[field] ?? 0) * 10 },
      );
    // Two of three weights given by a person: the weight column still stands, the lamp's 11 kg unanswered.
    expect(columnAsks(got.state.goodsFiles, answer('weightKg', 2, 'person')).map((a) => a.id)).toEqual(['col:0:weightKg', 'col:0:volumeM3']);
    // All three: the weight column is answered.
    expect(columnAsks(got.state.goodsFiles, answer('weightKg', 3, 'person')).map((a) => a.id)).toEqual(['col:0:volumeM3']);
    // Every cube now another figure than the file's (0.5, 0.6, 0.7): answered too.
    expect(columnAsks(got.state.goodsFiles, answer('volumeM3', 3, 'changed')).map((a) => a.id)).toEqual(['col:0:weightKg']);
  });
});
