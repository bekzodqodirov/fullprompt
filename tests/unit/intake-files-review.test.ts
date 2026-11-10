import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The review of P-files as built (docs/IKKI-ESHIK.md §1.2, his 1a; review
 * findings PF-SPEC-* / PF-ADV-*): what the reader, the file rule and the
 * reading do with the files a seller actually sends — the commonest PI
 * header, a two-row packing-list header, a list past the reader's ceiling, a
 * Chinese subtotal, another factory's no-money list, the same Excel twice,
 * two packing lists that disagree, a photo beside an Excel, a top-up's
 * packing list. The model and the budget are stand-ins.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100, recordAiPass: async () => {} }));

import { MAX_GOODS_ROWS, parseGoods } from '@/modules/wms/deals/goods-import';
import { readGoodsFile } from '@/modules/wms/deals/goods-file';
import { invoiceFacts, type CalcFacts } from '@/modules/wms/calc/intake';
import type { AmendBase } from '@/modules/wms/calc/amend-types';
import {
  activeIntake,
  analyzeCollected,
  endIntake,
  pickGoods,
  startIntake,
  typedCodesOwn,
  updateIntake,
  type IntakeState,
} from '@/modules/platform/telegram/calc-intake';
import { foldInvoice, packingOfHeld, sameFigures, withFileTotals } from '@/modules/platform/telegram/file-goods';
import { readIntakeFile, receiveGoodsSheet } from '@/modules/platform/telegram/staff-handlers';

type Goods = NonNullable<CalcFacts['goods']>;
const line = (name: string, extra: Partial<Goods[number]> = {}): Goods[number] => ({ name, ...extra });

let seq = 0;
const chats: bigint[] = [];
function collection(patch: Partial<IntakeState> = {}, opts: { ai?: boolean; amend?: AmendBase } = {}) {
  seq += 1;
  const chatId = BigInt(-9_400_000_000) - BigInt(seq);
  chats.push(chatId);
  startIntake(chatId, 'rastamojka', { staffId: 'staff-test', ai: opts.ai ?? false, amend: opts.amend ?? null });
  return { chatId, state: updateIntake(chatId, { stage: 'material', material: ['x'], ...patch })! };
}

async function xlsx(rows: (string | number | null)[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Sheet1').addRows(rows);
  return Buffer.from(await book.xlsx.writeBuffer());
}

/** A file forwarded into the collection, through the bot's own door. */
async function forward(chatId: bigint, rows: (string | number | null)[][], name: string) {
  const answer = await readIntakeFile({ isPhoto: false, body: await xlsx(rows), attachmentId: 'a-file' }, name, null, activeIntake(chatId)!);
  updateIntake(chatId, { ...answer.patch, fileCount: activeIntake(chatId)!.fileCount + 1 });
  return answer;
}

/** A mapped sheet handed to the file rule as the reader would hand it. */
const sheet = (label: string, rows: (string | number | null)[][], opts: { text?: string } = {}) => {
  const parsed = parseGoods(rows);
  return {
    goods: invoiceFacts(parsed.goods),
    label,
    text: opts.text ?? '',
    textCut: false,
    cellsCut: false,
    where: '',
    shape: { shape: parsed.shape, weightKind: parsed.weightKind, grossKg: parsed.grossKg, grossColumn: parsed.grossColumn, volumeM3: parsed.volumeM3 },
    ...(parsed.goods.length >= MAX_GOODS_ROWS ? { capped: MAX_GOODS_ROWS } : {}),
  };
};

const reads = (goods: Goods = [], facts: Partial<CalcFacts> = {}) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods, ...facts },
  steps: [],
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
});

beforeEach(() => model.analyze.mockReset());
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

describe('a unit PRICE is never the unit column (PF-SPEC-1)', () => {
  it('«Qty | Unit price | Amount» and «Кол-во | Цена за ед. | Сумма» keep the count and the line’s money', () => {
    for (const head of [
      ['Description', 'Qty', 'Unit price', 'Amount'],
      ['Наименование', 'Кол-во', 'Цена за ед.', 'Сумма'],
      ['品名', '数量', '单价', '金额'],
    ]) {
      const parsed = parseGoods([head, ['Kurtka', 300, 12.5, 3750]]);
      expect(parsed.goods.map((g) => [g.quantity, g.unit, g.amount])).toEqual([[300, null, 3750]]);
      // …and the count stands at the door: never moved to the note as a count of nobody knows what.
      expect(invoiceFacts(parsed.goods).map((g) => g.quantity)).toEqual([300]);
    }
  });

  it('«Qty | Unit price | G.W.» is an invoice: a money header is a money column, claimed or not', () => {
    expect(parseGoods([['Description', 'Qty', 'Unit price', 'G.W.(kg)'], ['Kurtka', 300, 12.5, 165]]).shape).toBe('invoice');
    expect(parseGoods([['Description', 'Qty', 'Value (USD)', 'G.W.(kg)'], ['Kurtka', 300, 3750, 165]]).shape).toBe('invoice');
  });

  it('M1 a with the commonest PI header: the packing list first keeps the invoice’s counts and fills its netto', async () => {
    const { chatId } = collection();
    await forward(chatId, [['Description', 'Qty (pcs)', 'CTN', 'N.W.(kg)', 'G.W.(kg)', 'CBM'], ['Kurtka', 300, 10, 150, 165, 1.2], ['Shim', 100, 4, 40, 46, 0.4]], 'P.xlsx');
    await forward(chatId, [['Description', 'Qty', 'Unit price', 'Amount'], ['Kurtka', 300, 12.5, 3750], ['Shim', 100, 5, 500]], 'I.xlsx');
    const s = activeIntake(chatId)!;
    expect(s.invoiceGoods?.map((g) => [g.name, g.quantity, g.weightKg])).toEqual([
      ['Kurtka', 300, 150],
      ['Shim', 100, 40],
    ]);
    expect(s.fileTotals).toMatchObject({ weightKg: 211, volumeM3: 1.6 });
  });
});

describe('two weight columns of one kind: the line’s is the heaviest (PF-ADV-1)', () => {
  const twoRow = [
    [null, null, null, 'PER CTN', null, 'TOTAL', null, null],
    ['DESCRIPTION', 'CTNS', 'QTY (PCS)', 'N.W.(KG)', 'G.W.(KG)', 'N.W.(KG)', 'G.W.(KG)', 'CBM'],
    ['Kurtka', 10, 300, 15, 16.5, 150, 165, 1.2],
    ['Shim', 4, 100, 10, 11.5, 40, 46, 0.4],
  ];
  it('a «PER CTN» / «TOTAL» two-row header reads the totals: the line’s netto and the shipment’s brutto', () => {
    const parsed = parseGoods(twoRow);
    expect(parsed.goods.map((g) => g.weightKg)).toEqual([150, 40]);
    expect([parsed.shape, parsed.weightKind, parsed.grossKg, parsed.volumeM3]).toEqual(['packing', 'net', 211, 1.6]);
  });

  it('an unmarked «G.W.(KG)» before «TOTAL G.W.» is one carton’s', () => {
    const parsed = parseGoods([
      ['Description', 'Qty', 'N.W.(KG)', 'G.W.(KG)', 'TOTAL N.W.', 'TOTAL G.W.'],
      ['Kurtka', 300, 15, 16.5, 150, 165],
      ['Shim', 100, 10, 11.5, 40, 46],
    ]);
    expect(parsed.goods.map((g) => g.weightKg)).toEqual([150, 40]);
    expect(parsed.grossKg).toBe(211);
  });

  it('after an invoice, the brutto that lands is the Σ of TOTAL G.W. and the fills are the lines’ netto', () => {
    let state = collection().state;
    for (const s of [sheet('«I.xlsx»', [['Description', 'Qty', 'Amount'], ['Kurtka', 300, 3750], ['Shim', 100, 500]]), sheet('«P.xlsx»', twoRow)]) {
      state = { ...state, ...receiveGoodsSheet(state, s).patch, fileCount: state.fileCount + 1 };
    }
    expect(state.fileTotals).toMatchObject({ weightKg: 211, volumeM3: 1.6, weightNetto: false });
    expect(state.invoiceGoods?.map((g) => g.weightKg)).toEqual([150, 40]);
  });

  it('a plain weight beside a gross one stays the line’s weight, whichever stands first', () => {
    const parsed = parseGoods([['Наименование', 'Кол-во', 'Вес брутто, кг', 'Вес, кг'], ['Kurtka', 300, 165, 150]]);
    expect(parsed.goods.map((g) => g.weightKg)).toEqual([150]);
    expect(parsed.grossKg).toBe(165);
  });

  it('a brutto lighter than the lines’ netto is no brutto', () => {
    const parsed = parseGoods([['Description', 'Qty', 'N.W.(kg)', 'G.W.(kg)'], ['Kurtka', 300, 150, 16.5]]);
    expect([parsed.grossKg, parsed.grossColumn]).toEqual([null, true]);
  });
});

describe('a list the reader stopped short of its end sums nothing (PF-ADV-2)', () => {
  const rows = (n: number) => [
    ['Description', 'Qty (pcs)', 'G.W.(kg)', 'CBM'],
    ...Array.from({ length: n }, (_, i) => [`Tovar ${i + 1}`, 10, 10, 0.1]),
  ];
  it('past the ceiling the gross and m³ Σ are null; at it they are read', () => {
    expect([parseGoods(rows(700)).grossKg, parseGoods(rows(700)).volumeM3]).toEqual([null, null]);
    expect(parseGoods(rows(MAX_GOODS_ROWS)).grossKg).toBe(MAX_GOODS_ROWS * 10);
  });

  it('a capped packing list writes no fileTotals — not even its lines’ netto Σ — and says it read none', () => {
    const invoice = sheet('«I.xlsx»', [['Description', 'Qty', 'Amount'], ...Array.from({ length: 700 }, (_, i) => [`Tovar ${i + 1}`, 10, 5])]);
    const packing = sheet('«P.xlsx»', [['Description', 'Qty (pcs)', 'CTN', 'N.W.(kg)', 'CBM'], ...Array.from({ length: 700 }, (_, i) => [`Tovar ${i + 1}`, 10, 1, 8, 0.1])]);
    expect(packing.shape.shape).toBe('packing');
    expect(packing.capped).toBe(MAX_GOODS_ROWS);
    let state = collection().state;
    state = { ...state, ...receiveGoodsSheet(state, invoice).patch, fileCount: 1 };
    const answer = receiveGoodsSheet(state, packing);
    expect(answer.patch.fileTotals ?? null).toBeNull();
    expect(answer.say).toContain('jami o‘qilmadi — VED fayldan ko‘radi.');
  });
});

describe('a Chinese subtotal row is arithmetic (PF-ADV-3)', () => {
  it('«小计» is no goods row and no part of the Σ — «小计算器» is a product', () => {
    const parsed = parseGoods([
      ['品名', '数量', '毛重', '体积'],
      ['Kurtka', 300, 165, 1.2],
      ['Shim', 100, 46, 0.4],
      ['小计', 400, 211, 1.6],
      ['小计算器', 50, 5, 0.1],
    ]);
    expect(parsed.goods.map((g) => g.description)).toEqual(['Kurtka', 'Shim', '小计算器']);
    expect([parsed.grossKg, parsed.volumeM3]).toEqual([216, 1.7]);
  });
});

describe('a bare carton header is a packing list’s sign (PF-ADV-4)', () => {
  const invoice = [['Description', 'Qty', 'Weight kg', 'Amount'], ['Kurtka', 300, 150, 3750], ['Shim', 100, 40, 500]];
  for (const [title, packing] of [
    ['«Cartons»', [['Description', 'Qty', 'Cartons', 'Weight (kg)', 'CBM'], ['Kurtka', 300, 10, 165, 1.2], ['Shim', 100, 4, 46, 0.4]]],
    ['«Мест»', [['Наименование', 'Кол-во, шт', 'Мест', 'Вес (кг)', 'Объем м3'], ['Kurtka', 300, 10, 165, 1.2], ['Shim', 100, 4, 46, 0.4]]],
    ['«CTNS»', [['DESCRIPTION', 'QTY', 'CTNS', 'N.W.(KG)', 'CBM'], ['Kurtka', 300, 10, 150, 1.2], ['Shim', 100, 4, 35, 0.4]]],
  ] as const) {
    it(`an invoice and its own packing list headed ${title}: no row lands twice`, () => {
      expect(parseGoods(packing.map((r) => [...r])).shape).toBe('packing');
      let state = collection().state;
      for (const s of [sheet('«I.xlsx»', invoice), sheet('«P.xlsx»', packing.map((r) => [...r]))]) {
        state = { ...state, ...receiveGoodsSheet(state, s).patch, fileCount: state.fileCount + 1 };
      }
      expect(state.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    });
  }
});

describe('a packing-shaped list gives totals only when its rows ARE the held goods (PF-ADV-5)', () => {
  it('another factory’s no-money list with a gross column: its goods are added, its brutto is not the shipment’s', () => {
    let state = collection({}, {}).state;
    state = { ...state, ...receiveGoodsSheet(state, sheet('«A.xlsx»', [['Description', 'Qty', 'Weight kg', 'Amount'], ['Kurtka', 300, 150, 3750], ['Shim', 100, 40, 500]])).patch, fileCount: 1 };
    const b = receiveGoodsSheet(state, sheet('«B.xlsx»', [['Наименование', 'Кол-во', 'Вес брутто, кг', 'Объем, м3'], ['Кроссовки', 200, 300, 2], ['Сумки', 100, 80, 1]]));
    expect(b.patch.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim', 'Кроссовки', 'Сумки']);
    expect(b.patch.fileTotals ?? null).toBeNull();
    expect(b.say).not.toContain('o‘sha tovarlar');
    expect(b.say).toContain('📄 «B.xlsx» — 2 ta yangi tovar qo‘shildi.');
  });

  it('the same shipment broken down otherwise (S/M/L packed, one line invoiced) is its packing list', () => {
    expect(packingOfHeld([line('Kurtka', { quantity: 300 })], [null], [line('Kurtka S', { quantity: 100 }), line('Kurtka M', { quantity: 100 }), line('Kurtka L', { quantity: 100 })], 'gross')).toBe(true);
    // …and a Chinese list beside a Russian invoice, by its counts.
    expect(packingOfHeld([line('Куртка', { quantity: 300 }), line('Брюки', { quantity: 100 })], [null, null], [line('女士夹克', { quantity: 300 }), line('裤子', { quantity: 100 })], 'gross')).toBe(true);
    // One count in two coinciding is no packing list of the held goods.
    expect(packingOfHeld([line('Kurtka', { quantity: 300 }), line('Shim', { quantity: 100 })], [null, null], [line('Кроссовки', { quantity: 200 }), line('Сумки', { quantity: 100 })], 'gross')).toBe(false);
  });

  it('a packing-shaped first file of ANOTHER factory keeps its goods when an invoice follows', () => {
    let state = collection().state;
    state = { ...state, ...receiveGoodsSheet(state, sheet('«A.xlsx»', [['Наименование', 'Кол-во', 'Вес брутто, кг'], ['Кроссовки', 200, 300]])).patch, fileCount: 1 };
    const b = receiveGoodsSheet(state, sheet('«B.xlsx»', [['Description', 'Qty', 'Amount'], ['Kurtka', 300, 3750]]));
    expect(b.patch.invoiceGoods?.map((g) => g.name)).toEqual(['Кроссовки', 'Kurtka']);
    expect(b.patch.fileTotals ?? null).toBeNull();
  });
});

describe('the same Excel twice (PF-ADV-6)', () => {
  for (const [title, rows] of [
    ['a names-only list', [['Наименование', 'Код ТН ВЭД'], ['Kurtka', '6201930000'], ['Shim', '6203420000']]],
    ['an amounts-only list', [['Description', 'Amount'], ['Kurtka', 3750], ['Shim', 500]]],
    ['cartons and an amount', [['Description', 'Кол-во мест', 'Amount'], ['Kurtka', 10, 3750], ['Shim', 4, 500]]],
  ] as const) {
    it(`${title} sent again adds nothing, and says so`, () => {
      let state = collection().state;
      const s = sheet('«A.xlsx»', rows.map((r) => [...r]));
      state = { ...state, ...receiveGoodsSheet(state, s).patch, fileCount: 1 };
      const again = receiveGoodsSheet(state, { ...s, label: '«A (1).xlsx»' });
      expect(again.patch.invoiceGoods).toBeUndefined();
      expect(again.say).toBe('📄 «A (1).xlsx» — bu fayl avval yuborilgan: qatorlari bir marta olindi.');
    });
  }

  it('a different workbook with one same bare name is still another factory’s line (§1.2.2)', () => {
    let state = collection().state;
    state = { ...state, ...receiveGoodsSheet(state, sheet('«A.xlsx»', [['Наименование', 'Кол-во'], ['Kurtka', null]], { text: 'A totals' })).patch, fileCount: 1 };
    const b = receiveGoodsSheet(state, sheet('«B.xlsx»', [['Наименование', 'Кол-во'], ['Kurtka', null]], { text: 'B totals' }));
    expect(b.patch.invoiceGoods?.map((g) => g.name)).toEqual(['Kurtka', 'Kurtka']);
  });
});

describe('two names are one row by their figures only when the weight is the same weight (PF-ADV-7)', () => {
  it('within 0.5 % or to the gram, never «under 1 kg apart»', () => {
    expect(sameFigures(line('Phone case', { quantity: 100, weightKg: 5 }), line('Защитное стекло', { quantity: 100, weightKg: 5.4 }))).toBe(false);
    expect(sameFigures(line('USB cable', { quantity: 50, weightKg: 2 }), line('Charger', { quantity: 50, weightKg: 2.9 }))).toBe(false);
    expect(sameFigures(line('Ladies jacket', { quantity: 300, weightKg: 1234.5 }), line('Куртка женская', { quantity: 300, weightKg: 1234 }))).toBe(true);
  });

  it('two Excels: the glass is not dropped as the case', () => {
    const fold = foldInvoice([line('Phone case', { quantity: 100, weightKg: 5 })], [null], [line('Защитное стекло', { quantity: 100, weightKg: 5.4 })], null, '«B.xlsx»');
    expect(fold.goods.map((g) => g.name)).toEqual(['Phone case', 'Защитное стекло']);
  });
});

describe('a figure two packing lists disagree on is the VED’s (PF-ADV-8)', () => {
  it('the clash is kept, a third file does not settle it, and the model’s figure does not land', async () => {
    const at = { material: 1, files: 2 };
    const first = withFileTotals(null, { weightKg: 165, volumeM3: 1.2, weightNetto: false, label: '«p1.xlsx»', at });
    const second = withFileTotals(first.fileTotals, { weightKg: 200, volumeM3: 1.2, weightNetto: false, label: '«p2.xlsx»', at: { material: 1, files: 3 } });
    expect([second.clash, second.fileTotals?.weightKg, second.fileTotals?.clash]).toEqual([true, null, ['weightKg']]);
    const third = withFileTotals(second.fileTotals, { weightKg: 180, volumeM3: null, weightNetto: false, label: '«p3.xlsx»', at: { material: 1, files: 4 } });
    expect([third.fileTotals?.weightKg, third.fileTotals?.clash]).toEqual([null, ['weightKg']]);
    const { state } = collection({ invoiceGoods: [line('Kurtka', { quantity: 300 })], fileCount: 3, fileTotals: second.fileTotals });
    model.analyze.mockResolvedValueOnce(reads([], { weightKg: 365, volumeM3: 9 }));
    const read = await analyzeCollected(state);
    expect([read.facts.weightKg ?? null, read.facts.volumeM3]).toEqual([null, 1.2]);
  });
});

describe('a packing list that came first hands over its OWN mark (PF-ADV-9)', () => {
  it('a brutto the seller answered with the packing list in front of him is not doubted', async () => {
    const { chatId } = collection();
    await forward(chatId, [['Description', 'Qty (pcs)', 'CTN', 'N.W.(kg)', 'G.W.(kg)', 'CBM'], ['Kurtka', 300, 10, 150, 165, 1.2], ['Shim', 100, 4, 40, 46, 0.4]], 'packing.xlsx');
    updateIntake(chatId, { totalsAnswer: { weightKg: 3600, volumeM3: null, at: { material: 1, files: 1 } } });
    await forward(chatId, [['Description', 'Qty', 'Amount'], ['Kurtka', 300, 3750], ['Shim', 100, 500]], 'invoice.xlsx');
    const s = activeIntake(chatId)!;
    expect(s.fileTotals?.at).toEqual({ material: 1, files: 1 });
    model.analyze.mockResolvedValueOnce(reads([]));
    const read = await analyzeCollected(s);
    expect(read.facts.weightKg).toBe(3600);
    expect(read.ambiguousTotals).toEqual([]);
  });
});

describe('a model line read off a PHOTO beside an Excel is named, never added (PF-SPEC-3, PF-ADV-10)', () => {
  it('pickGoods names it when photos were shown, and only then', () => {
    const input = { invoice: [line('Kurtka', { quantity: 300 })], aiGoods: null, model: [line('Sumka', { quantity: 50, weightKg: 20 })], typed: [], typedLabelled: [] };
    const shown = pickGoods({ ...input, modelSawImages: true });
    expect(shown.goods.map((g) => g.name)).toEqual(['Kurtka']);
    expect(shown.sameAsInvoice.map((g) => [g.name, g.why])).toEqual([['Sumka', 'typed']]);
    expect(pickGoods(input).sameAsInvoice).toEqual([]);
    // A photo of the Excel's own goods, read in another script, is that row by its figures.
    expect(
      pickGoods({ ...input, model: [line('Куртка', { quantity: 300, weightKg: 150 })], invoice: [line('Kurtka', { quantity: 300, weightKg: 150 })], modelSawImages: true }).sameAsInvoice,
    ).toEqual([]);
  });

  it('the reading says it on the card, in the spec’s words', async () => {
    const { state } = collection({ invoiceGoods: [line('Kurtka', { quantity: 300 })], fileCount: 2, images: [{ attachmentId: 'img-1', mediaType: 'image/jpeg' }] });
    model.analyze.mockResolvedValueOnce(reads([line('Sumka', { quantity: 50, weightKg: 20 })]));
    const read = await analyzeCollected(state, { images: [{ data: Buffer.from('x'), mediaType: 'image/jpeg' }], pdfs: [], missing: 0 });
    expect(read.facts.goods?.map((g) => g.name)).toEqual(['Kurtka']);
    expect(read.notes).toContain('Rasmda/yozuvda Excel’da yo‘q tovar: «Sumka» — VED tekshiradi');
  });
});

describe('a code the seller typed lands as his own (PF-ADV-11)', () => {
  it('a row the model coded, corrected in the table, is the row’s own at the landing — the model’s, untouched, stays the model’s', () => {
    const goods = [
      line('Сумка', { tnvedCode: '4202210000', tnvedSource: 'model' }),
      line('Kurtka', { tnvedCode: '6201930000', tnvedSource: 'model' }),
    ];
    const answers = [{ index: 0, name: 'Сумка', patch: { tnvedCode: '4202210000' } }];
    expect(typedCodesOwn(goods, answers).map((g) => g.tnvedSource)).toEqual(['row', 'model']);
    // An answer that was undone (the model's code back on the row) leaves it the model's.
    expect(typedCodesOwn([line('Сумка', { tnvedCode: '4202920000', tnvedSource: 'model' })], answers)[0]!.tnvedSource).toBe('model');
  });

  it('the landing hands the INSERT the marked rows — a wire a test of the pure half cannot see (#531)', () => {
    const src = readFileSync('src/modules/platform/telegram/staff-bot.ts', 'utf8').replace(/\/\/.*$/gm, '');
    const land = src.slice(src.indexOf('export async function landCollectedIntake'));
    // Anchored on the landing's own call (docs/FAYL-OQISH.md §1.3 a put the
    // door's derivation above it; `return landIntake(` was never the shape,
    // so the window had been the function's first 2 000 characters).
    expect(land.indexOf('await landIntake('), 're-anchor: the landing call moved').toBeGreaterThan(0);
    expect(land.slice(0, land.indexOf('await landIntake(') + 2_000)).toMatch(/facts:\s*state\.facts\.goods\s*\?\s*\{\s*\.\.\.state\.facts,\s*goods:\s*typedCodesOwn\(state\.facts\.goods,\s*state\.lineAnswers\)/);
  });
});

describe('a top-up’s packing list is a NOTED file (PF-SPEC-2, PF-SPEC-5)', () => {
  // Re-anchored by docs/FAYL-OQISH.md §4.5 (known-2, 2026-11-10): the rule is
  // about a request that HAS rows for the packing list to be the totals of —
  // here one stored row. On a request with none it is the goods list
  // (fayl-sheets.test.ts pins that): noting it priced nothing twice and
  // withheld the only goods there were.
  const amend: AmendBase = {
    requestId: '00000000-0000-4000-8000-000000000099',
    cardLabel: 'B-000067',
    entityType: 'deal',
    entityId: '00000000-0000-4000-8000-000000000098',
    leadOpen: null,
    section: 'rastamojka',
    clientLabel: 'GS777',
    openedRev: 0,
    items: [
      { itemId: '00000000-0000-4000-8000-000000000097', seq: 1, name: 'Ladies jacket', quantity: 300, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: null, law: null, confirmed: false },
    ],
    weightKg: null,
    volumeM3: null,
    fromCity: null,
    toCity: null,
  };
  it('its rows change no row and become no line; its totals go on the note once; an invoice after it is the goods list', () => {
    let state = collection({}, { amend }).state;
    const packing = receiveGoodsSheet(state, sheet('«P.xlsx»', [['Description', 'Qty (pcs)', 'CTN', 'G.W.(kg)', 'CBM'], ['Ladies jacket', 300, 10, 165, 1.2]]));
    expect(packing.patch.invoiceGoods).toBeUndefined();
    expect(packing.patch.goodsFiles).toBeUndefined();
    expect(packing.say).toBe('📄 «P.xlsx» — packing list jami: brutto 165 kg, 1.2 m³ — so‘rovga yozilmadi, VED fayldan ko‘radi.');
    state = { ...state, ...packing.patch, fileCount: 1 };
    const invoice = receiveGoodsSheet(state, sheet('«I.xlsx»', [['Description', 'Qty', 'Amount'], ['Ladies jacket', 300, 3750]]));
    state = { ...state, ...invoice.patch };
    expect(state.invoiceGoods?.map((g) => g.name)).toEqual(['Ladies jacket']);
    expect(state.fileNotes.filter((n) => n.includes('packing list jami'))).toHaveLength(1);
    expect(state.fileTotals ?? null).toBeNull();
  });
});

describe('the add collection’s own Excel rows are coded on the AI door (PF-SPEC-6)', () => {
  // The request's DOOR decides (as-built review DOORS-1): re-anchored from a
  // base with no door — which is a NULL request, today's table, that never
  // asked the model for codes (§0.2) — onto an 'ai' request's.
  const addBase = (door: AmendBase['door']): AmendBase => ({
    requestId: '00000000-0000-4000-8000-000000000099',
    cardLabel: 'B-000067',
    entityType: 'deal',
    entityId: '00000000-0000-4000-8000-000000000098',
    leadOpen: null,
    section: 'rastamojka',
    clientLabel: 'GS777',
    openedRev: 0,
    items: [
      {
        itemId: '00000000-0000-4000-8000-000000000001',
        seq: 1,
        name: 'Kurtka',
        quantity: 300,
        weightKg: null,
        volumeM3: null,
        measureUnit: null,
        measureQty: null,
        tnvedCode: null,
        law: null,
        confirmed: false,
      },
    ],
    weightKg: null,
    volumeM3: null,
    fromCity: null,
    toCity: null,
    ...(door === undefined ? {} : { door }),
  });
  const addCollection = (base: AmendBase) =>
    collection(
      {
        fileCount: 1,
        invoiceGoods: [line('Sumka', { quantity: 50 })],
        facts: { goods: [{ name: 'Kurtka', quantity: 300, itemId: base.items[0]!.itemId, seq: 1 }], lineWeightsStated: true },
      },
      // The add door opens a NULL request's collection with the legacy flag
      // set (`collectionAiOf(null, true)`) — the flag alone said «AI door».
      { ai: true, amend: base },
    ).state;

  it('shown numbered beside the request’s rows; the code lands on the new line only', async () => {
    const state = addCollection(addBase('ai'));
    model.analyze.mockResolvedValueOnce({ ...reads([]), knownCodes: [{ index: 0, code: '4202920000' }] });
    const read = await analyzeCollected(state);
    expect(model.analyze.mock.calls[0]![0]).toMatchObject({ knownGoods: ['Sumka'], codeKnown: true, requestGoods: ['Kurtka'] });
    const sumka = read.facts.goods?.find((g) => g.name === 'Sumka');
    expect([sumka?.tnvedCode, sumka?.tnvedSource]).toEqual(['4202920000', 'model']);
    expect(read.facts.goods?.find((g) => g.name === 'Kurtka')?.tnvedCode ?? null).toBeNull();
  });

  it('a NULL request’s add collection reads as today: no codes asked, the new row uncoded (§0.2, as-built DOORS-1)', async () => {
    for (const door of [undefined, null, 'plain'] as const) {
      model.analyze.mockReset();
      const state = addCollection(addBase(door));
      model.analyze.mockResolvedValueOnce({ ...reads([]), knownCodes: [{ index: 0, code: '4202920000' }] });
      const read = await analyzeCollected(state);
      const call = model.analyze.mock.calls[0]![0] as Record<string, unknown>;
      expect(call.codeKnown, String(door)).toBeUndefined();
      expect(call.knownCoded, String(door)).toBeUndefined();
      const sumka = read.facts.goods?.find((g) => g.name === 'Sumka');
      expect(sumka?.tnvedCode ?? null, String(door)).toBeNull();
    }
  });
});

describe('a packing list’s own text tells the model when it stops (PF-ADV-14)', () => {
  it('a sheet past the reader’s budget carries its cut onto the model’s totals-only sheets', async () => {
    const big = [['Description', 'Qty (pcs)', 'G.W.(kg)', 'CBM'], ...Array.from({ length: 400 }, (_, i) => [`Ayollar kurtkasi qora rang model ${i + 1}`, 10, 10, 0.1]), ['TOTAL', 4000, 4000, 40]];
    const read = await readGoodsFile(await xlsx(big), null);
    expect(read && read.kind === 'goods' ? read.ownText?.cut : null).toBe(true);
    const { chatId } = collection();
    await forward(chatId, [['Description', 'Qty', 'Amount'], ...Array.from({ length: 400 }, (_, i) => [`Ayollar kurtkasi qora rang model ${i + 1}`, 10, 5])], 'I.xlsx');
    await forward(chatId, big, 'P.xlsx');
    const own = activeIntake(chatId)!.invoiceTexts.find((t) => t.label === '«P.xlsx»');
    expect(own?.cut).toBe(true);
  });
});

describe('one count stated in two units is stated once (PF-ADV-15)', () => {
  it('«120» here and «120 пар» there: the row carries 120 juft and no 120 pieces', () => {
    const fold = foldInvoice(
      [line('Кроссовки', { quantity: 120, weightKg: 60 })],
      [null],
      invoiceFacts([{ description: 'Кроссовки', quantity: 120, unit: 'пар', weightKg: 60, volumeM3: null, amount: null, tnvedCode: null, note: null }]),
      null,
      '«B.xlsx»',
    );
    expect(fold.goods.map((g) => [g.quantity ?? null, g.measureUnit, g.measureQty])).toEqual([[null, 'juft', 120]]);
  });
});
