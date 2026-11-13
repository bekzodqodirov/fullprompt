import ExcelJS from 'exceljs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «AI so‘raydi», package P-excel, phase 4 — X10's DATA flag (docs/AI-SORAYDI.md
 * §3.2 X10, review CR-3, JS-9): the commonest Chinese quotation is «Picture |
 * Item No. | QTY | CTNS | G.W. | CBM» — the goods are PICTURES and the only
 * name a row has is its article number. Release 1a only CARRIES what the
 * reader knows: each row whose name cell is no word is marked
 * `nameIsArticle`, and the workbook's picture count rides on the goods
 * sheet's block in the collection. No table word and no question come of
 * either here — those are release 1b's, and the table below is pinned to say
 * nothing new.
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
import { activeIntake, analyzeCollected, endIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';
import { markIntakesHydrated } from '@/modules/platform/telegram/calc-store';
import { invoiceFacts, landingItems } from '@/modules/wms/calc/intake';
import { nameWordFor } from '@/modules/wms/calc/line-address';
import { readGoodsFile } from '@/modules/wms/deals/goods-file';
import { parseGoods, type Cell } from '@/modules/wms/deals/goods-import';
import { resetReadingDrive } from '../fixtures/calc-read-drive';
import * as B from '../fixtures/fayl-books';

const BILL = { model: 'm', inputTokens: 1, outputTokens: 1, at: 0 };
/** A 1×1 PNG — what a quotation's picture column holds, as far as a count goes. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let seq = 0;
const chats: bigint[] = [];
beforeAll(async () => {
  await import('@/modules/wms/calc/intake-manual');
  markIntakesHydrated();
});
beforeEach(() => {
  resetReadingDrive();
  model.analyze.mockReset();
  // The model reads nothing: every figure below is the sheet's own.
  model.analyze.mockImplementation(async () => ({ ok: true, facts: { goods: [], weightKg: null, volumeM3: null }, steps: [], usage: BILL, answered: [BILL], knownCodes: [] }));
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
});

/** One sheet with a picture in column A of each listed row (0-based sheet rows). */
async function quotation(rows: Cell[][], pictureRows: readonly number[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Quotation');
  for (const row of rows) ws.addRow(row);
  for (const r of pictureRows) {
    const id = wb.addImage({ buffer: PNG as unknown as ArrayBuffer, extension: 'png' });
    ws.addImage(id, { tl: { col: 0, row: r }, ext: { width: 40, height: 40 } });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const QUOTE: Cell[][] = [
  ['Picture', 'Item No.', 'QTY', 'CTNS', 'G.W.', 'CBM'],
  [null, 'XJ-200', 300, 15, 150, 1.2],
  [null, 'XJ-350', 100, 5, 60, 0.5],
];

describe('the reader marks a row whose name is an article number (parseGoods)', () => {
  it('«Item No.» beside a picture column: both rows keep their number as the name and are marked', () => {
    const goods = parseGoods(QUOTE).goods;
    expect(goods.map((g) => [g.description, g.nameIsArticle ?? null])).toEqual([
      ['XJ-200', true],
      ['XJ-350', true],
    ]);
    // The flag is a word about the NAME only: the figures read as they always did.
    expect(goods.map((g) => [g.quantity, g.weightKg, g.volumeM3])).toEqual([
      [300, 150, 1.2],
      [100, 60, 0.5],
    ]);
  });

  it('per row: a list naming one good in words and one by its number marks the number alone', () => {
    const goods = parseGoods([
      ['Description', 'QTY', 'G.W.'],
      ['Office chair', 40, 300],
      ['XJ-200', 300, 150],
    ]).goods;
    expect(goods.map((g) => [g.description, g.nameIsArticle ?? null])).toEqual([
      ['Office chair', null],
      ['XJ-200', true],
    ]);
  });

  it('names in words are never marked — a number inside a name is still a name («Труба 32», «LED lamp 50W»)', () => {
    const goods = parseGoods([
      ['Наименование', 'Кол-во', 'Вес, кг'],
      ['Труба 32', 100, 50],
      ['LED lamp 50W', 300, 120],
      ['Kafel 600x600', 20, 400],
    ]).goods;
    expect(goods.map((g) => g.nameIsArticle ?? null)).toEqual([null, null, null]);
  });

  it('the door keeps the mark on the goods fact (invoiceFacts), and nothing else about the row moves', () => {
    const [fact] = invoiceFacts(parseGoods(QUOTE).goods);
    expect(fact).toMatchObject({ name: 'XJ-200', quantity: 300, weightKg: 150, volumeM3: 1.2, nameIsArticle: true });
    // …and the landed item knows nothing of it: no column, no note — the flag is the table's (1b).
    const [item] = landingItems({ goods: [fact!] } as never);
    expect(item!.note ?? null).toBe('📦 15 karobka — fayldan');
  });
});

describe('the workbook’s picture count beside its mapped goods (readGoodsFile)', () => {
  it('two pictures in column A: the goods read is counted 2', async () => {
    const read = await readGoodsFile(await quotation(QUOTE, [1, 2]), B.XLSX);
    expect(read?.kind).toBe('goods');
    expect(read?.kind === 'goods' ? [read.goods.length, read.pictures] : null).toEqual([2, 2]);
  });

  it('no picture: 0 — and a CSV has none to count', async () => {
    const plain = await readGoodsFile(await quotation(QUOTE, []), B.XLSX);
    expect(plain?.kind === 'goods' ? plain.pictures : null).toBe(0);
    const csv = await readGoodsFile(Buffer.from('Item No.,QTY,G.W.\nXJ-200,300,150\n'), 'text/csv');
    expect(csv?.kind === 'goods' ? csv.pictures : null).toBe(0);
  });
});

describe('the collection carries both (the file door and the reading)', () => {
  async function collect(body: Buffer, name: string) {
    seq += 1;
    const chatId = BigInt(-9_476_400_000) - BigInt(seq);
    chats.push(chatId);
    startIntake(chatId, 'rastamojka', { staffId: 'staff-as-x10', ai: true });
    updateIntake(chatId, { stage: 'material' });
    const live = activeIntake(chatId)!;
    const answer = await readIntakeFile({ isPhoto: false, body, attachmentId: `as-x10-${seq}` }, name, B.XLSX, live);
    updateIntake(chatId, { ...answer.patch, fileCount: live.fileCount + 1 });
    const arrived = activeIntake(chatId)!;
    const read = await analyzeCollected(arrived);
    updateIntake(chatId, { ...read, answered: undefined } as never);
    const state = activeIntake(chatId)!;
    const intake = await import('@/modules/wms/calc/intake');
    const table = intakeNextStep(state, new Map(), intake, { nameWord: nameWordFor, aiAvailable: true });
    return { said: answer.say ?? '', arrived, state, table: table.text };
  }

  it('the goods sheet’s block keeps the book’s 2 pictures, and every row its mark through the reading', async () => {
    const { said, arrived, state } = await collect(await quotation(QUOTE, [1, 2]), 'quote.xlsx');
    expect(said).toBe('📄 «quote.xlsx» — 2 ta tovar o‘qildi.');
    expect(arrived.goodsFiles?.map((f) => [f.label, f.rows, f.pictures ?? 0])).toEqual([['«quote.xlsx»', 2, 2]]);
    expect(arrived.invoiceGoods?.map((g) => g.nameIsArticle ?? null)).toEqual([true, true]);
    // The model said nothing: the table's rows are the sheet's, still marked.
    expect(state.facts.goods?.map((g) => [g.name, g.nameIsArticle ?? null])).toEqual([
      ['XJ-200', true],
      ['XJ-350', true],
    ]);
  });

  it('a book with no picture writes no count on its block (absent = none, as a block from before reads)', async () => {
    const { arrived } = await collect(await quotation(QUOTE, []), 'quote.xlsx');
    expect(arrived.goodsFiles?.[0] && 'pictures' in arrived.goodsFiles[0]).toBe(false);
  });

  it('release 1a draws nothing of either: the table is the one a worded quotation of the same figures gets, the names apart', async () => {
    const marked = await collect(await quotation(QUOTE, [1, 2]), 'quote.xlsx');
    const worded = await collect(
      await quotation(
        [
          ['Picture', 'Item No.', 'QTY', 'CTNS', 'G.W.', 'CBM'],
          [null, 'Folding chair', 300, 15, 150, 1.2],
          [null, 'Camping table', 100, 5, 60, 0.5],
        ],
        [1, 2],
      ),
      'quote.xlsx',
    );
    const unnamed = (text: string) => text.replace('Folding chair', 'XJ-200').replace('Camping table', 'XJ-350');
    expect(marked.table).toBe(unnamed(worded.table));
  });
});
