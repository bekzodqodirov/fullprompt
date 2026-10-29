import { describe, expect, it } from 'vitest';
import { parseGoods, type Cell } from '@/modules/wms/deals/goods-import';

/**
 * The sixth review of the spreadsheet door (the round-5 probers'
 * regressions, c2028-c2038 in the intake corpus): what each narrowed rule
 * decides beyond the corpus's own inputs. The corpus pins the probers'
 * sentences; these pin where each rule now stops, on both sides.
 */

const names = (rows: string[]) => parseGoods(rows.map((r) => [r])).goods.map((g) => g.description);
const first = (rows: Cell[][]) => parseGoods(rows).goods[0]!;

describe('«Meas» / «Vol» with a unit of its own is the line’s m³ only when that unit spells cubic metres', () => {
  const volume = (header: string) => first([['Description', 'Qty', header], ['Chair', 10, 0.72]]).volumeM3;

  it('cubic metres written out are read, in every spelling a packing list uses', () => {
    for (const header of ['Measurement (cu.m.)', 'MEAS（CU.M）', 'Meas, cu.m', 'MEAS (CU.MTS)', 'Total Measurement (Cubic Metres)']) {
      expect(volume(header), header).toBe(0.72);
    }
  });

  it('a cubic foot, a cubic centimetre, a carton’s size or a word that is no unit stays no volume', () => {
    for (const header of ['MEAS (CU.FT)', 'Vol (cubic feet)', 'Meas (cu.cm)', 'Meas (cubic cm)', 'MEAS(L*W*H CM)', 'Measurement (Total)']) {
      expect(volume(header), header).toBeNull();
    }
  });

  it('beside a carton’s centimetres, the cubic-metre column is the line’s — wherever it stands', () => {
    const rows = (a: string, b: string, x: Cell, y: Cell): Cell[][] => [['Description', 'Qty', a, b], ['Chair', 10, x, y]];
    expect(first(rows('Measurement (CM)', 'Measurement (CU.M)', '60*40*30', 0.72)).volumeM3).toBe(0.72);
    expect(first(rows('Measurement (CU.M)', 'Measurement (CM)', 0.72, '60*40*30')).volumeM3).toBe(0.72);
  });
});

describe('the name rung: which name, and where it is written, qualify nothing about the goods', () => {
  const named = (header: string) => first([['Описание', header, 'Кол-во'], ['сталь, чёрный', 'Стеллаж', 5]]).description;

  it('a name said in a language, a length or for the customs outranks the description on its left', () => {
    for (const header of ['报关品名', '中文报关品名', '俄文名称', 'Полное наименование', 'Customs name', 'Name of the goods', 'Tovar nomi rus tilida', 'Mahsulot nomi oʻzbekcha', 'Товар на русском языке']) {
      expect(named(header), header).toBe('Стеллаж');
    }
  });

  it('after the word for NAME, a preposition and all it governs say where that name is written', () => {
    for (const header of ['Наименование по накладной', 'Name as per invoice', 'Наименование для таможни', 'Name on label']) {
      expect(named(header), header).toBe('Стеллаж');
    }
  });

  it('after a goods word the same words say where the goods are, and another thing stays another thing in any language', () => {
    for (const header of ['Товар в наличии', 'Товар на складе', 'Наименование группы на русском', 'Factory name in English', '中文颜色', '报关单号']) {
      expect(named(header), header).toBe('сталь, чёрный');
    }
  });

  it('a party named by the cargo word is still a party', () => {
    expect(first([['Наименование грузополучателя', 'Описание', 'Кол-во'], ['ООО Ромашка', 'Пылесос', 5]]).description).toBe('Пылесос');
  });
});

describe('«Накладн…» heads a one-column list only in the waybill’s own phrase', () => {
  const figures = ['Стол 5 шт 100 кг', 'Стул 30 шт 150 кг'];

  it('the waybill by the adjective that says which, or opening the line with its number, date or purpose', () => {
    for (const title of ['Расходная накладная № 5', 'Приходная накладная', 'Возвратная накладная от 12.10.2026', 'Накладная', 'Накладная на отпуск товара', 'Накладные № 3, 4']) {
      expect(names([title, ...figures]), title).toEqual(figures);
    }
  });

  it('a product that is surface-mounted or false keeps its line, before or after a real title', () => {
    for (const product of ['Розетка двойная накладная', 'Накладная петля', 'Накладные карманы', 'Накладные на ногти', 'Накладной замок']) {
      expect(names([product, ...figures]), product).toEqual([product, ...figures]);
      expect(names(['Заявка', product, ...figures]), product).toEqual([product, ...figures]);
    }
  });
});
