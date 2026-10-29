import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readGoodsFile } from '@/modules/wms/deals/goods-file';
import { parseGoods, readsAsFigure, type Cell } from '@/modules/wms/deals/goods-import';

/**
 * The fifth review of the spreadsheet door (the round-4 probers'
 * regressions, c1894-c1942 in the intake corpus): what each fix decides
 * beyond the corpus's own inputs. The corpus pins the probers' sentences;
 * these pin the rule each fix states, one step past them.
 */

const names = (rows: string[]) => parseGoods(rows.map((r) => [r])).goods.map((g) => g.description);
const first = (rows: Cell[][]) => parseGoods(rows).goods[0]!;

async function xlsx(rows: Cell[][], merges: string[]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('PL');
  rows.forEach((row) => sheet.addRow(row));
  for (const range of merges) sheet.mergeCells(range);
  return Buffer.from(await book.xlsx.writeBuffer());
}

describe('a figure under a merge is said once in the model’s text; a word that counts nothing repeats', () => {
  it('a currency or a unit before or after the number is a figure — a spec with a number in it is not', () => {
    for (const cell of ['USD 1 200', '¥ 3,600', '1 200 000 сум', '15 m3', '120 KGS/CTN']) expect(readsAsFigure(cell), cell).toBe(true);
    for (const cell of ['USB 3.0', 'LED 50W', '12V', '42 размер', 'Тройник 20/16/20', 'Model 2301']) expect(readsAsFigure(cell), cell).toBe(false);
  });

  it('on a sheet the reader cannot map, a merged spec repeats on every line and a merged sum is written once', async () => {
    const body = await xlsx(
      [
        ['Marka', 'Spec', 'Dona', 'Pul'],
        ['GS777', 'USB 3.0', 10, 'USD 1 200'],
        ['GS777', null, 10, null],
      ],
      ['B2:B3', 'D2:D3'],
    );
    const read = await readGoodsFile(body, null);
    expect(read?.kind).toBe('text');
    expect(read && read.kind !== 'refused' ? read.text : '').toBe('[PL]\nMarka | Spec | Dona | Pul\nGS777 | USB 3.0 | 10 | USD 1 200\nGS777 | USB 3.0 | 10');
  });
});

describe('a bare total is the line’s money on an invoice', () => {
  it('a tax column alone makes the header an invoice — with no unit price at all', () => {
    expect(first([['Наименование', 'Кол-во', 'Net total', 'НДС', 'Gross total'], ['Стул', 10, 250, 30, 280]])).toMatchObject({
      amount: 250,
      weightKg: null,
    });
  });

  it('without a price, a tax or a discount the same totals are a packing list’s kilos', () => {
    expect(first([['Наименование', 'Кол-во', 'Net total', 'Gross total'], ['Стул', 10, 100, 110]])).toMatchObject({
      amount: null,
      weightKg: 100,
    });
  });
});

describe('«Meas» / «Vol» is the line’s m³ only when it names no unit of its own', () => {
  it('«TOTAL MEAS.» and «Total Vol.» are the volume; «MEAS (CM)» and «Vol, l» are not', () => {
    expect(first([['Description', 'Qty', 'TOTAL MEAS.'], ['Chair', 10, 1.5]]).volumeM3).toBe(1.5);
    expect(first([['Description', 'Qty', 'Total Vol.'], ['Chair', 10, 1.5]]).volumeM3).toBe(1.5);
    expect(first([['Description', 'Qty', 'MEAS (CM)'], ['Chair', 10, 60]])).toMatchObject({ volumeM3: null, amount: null });
    expect(first([['Description', 'Qty', 'Vol, l'], ['Oil', 10, 4]])).toMatchObject({ volumeM3: null, amount: null });
  });
});

describe('the name column outranks a description only when it names the PRODUCT', () => {
  it('a naming header in any case form wins over a description on its LEFT', () => {
    const rows = (header: string): Cell[][] => [['Описание', header, 'Кол-во'], ['сталь, чёрный', 'Стеллаж', 5]];
    expect(first(rows('Наименование продукции')).description).toBe('Стеллаж');
    expect(first(rows('Name of goods')).description).toBe('Стеллаж');
    expect(first(rows('商品名称')).description).toBe('Стеллаж');
  });

  it('a goods word qualified by anything else names something else, and the description stays the name', () => {
    const rows = (header: string): Cell[][] => [['Описание', header, 'Кол-во'], ['Стеллаж металлический', 'сталь', 5]];
    for (const header of ['Материал товара', 'Goods material', '产品材质', 'Brand name']) {
      expect(first(rows(header)).description, header).toBe('Стеллаж металлический');
    }
  });
});

describe('a one-column list’s head: titles and headings from the top, each with at most one line before it', () => {
  const figures = ['Стол 5 шт 100 кг', 'Стул 30 шт 150 кг'];

  it('a heading that says what the list is for, or announces it with a colon, is no product', () => {
    // A colon announces the lines under it whatever its words: «Tovarlar:»
    // would be a heading of list words anyway.
    expect(names(['Yuboriladigan yuk:', ...figures])).toEqual(figures);
    expect(names(['Перечень товаров на склад', ...figures])).toEqual(figures);
    expect(names(['商品清单（第一批）', ...figures])).toEqual(figures);
  });

  it('one list word opens a product as often as a heading', () => {
    expect(names(['Товары народного потребления', ...figures])).toEqual(['Товары народного потребления', ...figures]);
  });

  it('a sender, a title and a heading go together; a heading under products stays a product', () => {
    expect(names(['Yiwu Trading Co.', 'Заказ № 15', 'Товары:', ...figures])).toEqual(figures);
    expect(names(['Куртка', 'Шапка', 'Заказ № 15', ...figures])).toEqual(['Куртка', 'Шапка', 'Заказ № 15', ...figures]);
  });

  it('a title names its document or carries a real date; a size written with «№» or three numbers is a product', () => {
    expect(names(['Заявка от 15.10.2026', ...figures])).toEqual(figures);
    expect(names(['Packing list', ...figures])).toEqual(figures);
    expect(names(['Тройник 20.16.20', ...figures])).toEqual(['Тройник 20.16.20', ...figures]);
    expect(names(['Ключ № 17', ...figures])).toEqual(['Ключ № 17', ...figures]);
  });
});
