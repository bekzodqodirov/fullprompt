import { describe, expect, it } from 'vitest';
import { detectColumns, parseGoods, parseNumber } from '@/modules/wms/deals/goods-import';

/**
 * The 50-goods file detective work (DEALS.md answer 6), against the shapes
 * clients actually send: a Russian invoice with a logo row above the header,
 * a Chinese packing list, a bare list with no header at all. Pure functions —
 * the xlsx shell is the route's problem.
 */

describe('goods file parsing', () => {
  it('finds a Russian header below junk rows and maps its columns', () => {
    const rows = [
      ['ООО «Поставщик»', null, null],
      [null, null, null],
      ['№', 'Наименование товара', 'Кол-во', 'Ед.', 'Вес, кг', 'Сумма'],
      [1, 'Носки мужские', 100, 'шт', '25,5', '1 200,50'],
      [2, 'Футболки', 50, 'шт', 30, 800],
      ['', 'Итого', 150, null, 55.5, 2000.5],
    ];
    const detected = detectColumns(rows)!;
    expect(detected.headerRow).toBe(2);
    expect(detected.columns.name).toBe(1);
    expect(detected.columns.quantity).toBe(2);
    expect(detected.columns.weight).toBe(4);
    expect(detected.columns.amount).toBe(5);

    const { goods } = parseGoods(rows);
    // The «Итого» arithmetic row is not a product.
    expect(goods).toHaveLength(2);
    expect(goods[0]).toMatchObject({
      description: 'Носки мужские',
      quantity: 100,
      unit: 'шт',
      weightKg: 25.5,
      amount: 1200.5,
    });
  });

  it('reads a Chinese packing list', () => {
    const rows = [
      ['品名', '数量', '重量', '体积'],
      ['袜子', 500, 120, 0.8],
      ['T恤', 300, 90, 1.2],
    ];
    const { goods, headerRow } = parseGoods(rows);
    expect(headerRow).toBe(0);
    expect(goods).toHaveLength(2);
    expect(goods[1]).toMatchObject({ description: 'T恤', quantity: 300, volumeM3: 1.2 });
  });

  it('prefers the line TOTAL over the unit price when a file carries both', () => {
    const rows = [
      ['Наименование', 'Кол-во', 'Цена', 'Сумма'],
      ['Товар', 10, 5, 50],
    ];
    const { goods } = parseGoods(rows);
    expect(goods[0]!.amount).toBe(50);
  });

  it('a file with no header degrades to one product per row', () => {
    const rows = [
      ['Носки', null],
      [null, null],
      ['Футболки', 3],
    ];
    const { goods, headerRow } = parseGoods(rows);
    expect(headerRow).toBeNull();
    expect(goods.map((g) => g.description)).toEqual(['Носки', 'Футболки']);
    expect(goods[0]!.quantity).toBeNull();
  });

  it('volume does not eat the weight column («вес, кг» next to «объем, м3»)', () => {
    const rows = [
      ['Наименование', 'Объем, м3', 'Вес, кг'],
      ['Товар', '1,5', '200'],
    ];
    const { goods } = parseGoods(rows);
    expect(goods[0]!.volumeM3).toBe(1.5);
    expect(goods[0]!.weightKg).toBe(200);
  });

  it('a «Код ТН ВЭД товара» column is the CODE, never the name (P1.6)', () => {
    // It contains «товар», and the name keys took it: every product was
    // named by its code and the code itself was lost (the audit, reproduced).
    const rows = [
      ['№', 'Код ТН ВЭД товара', 'Наименование', 'Кол-во', 'Ед. изм.'],
      [1, '6907210000', 'Плитка керамическая', 120, 'м2'],
      [2, 6201930000, 'Куртка мужская', 300, 'шт'],
      // Excel stores 0901210000 as a NUMBER and drops the zero; a numeric
      // nine-place cell is padded, typed text of nine places is a question.
      [3, 901210000, 'Кофе', 50, 'кг'],
      [4, '640399000', 'Обувь', 40, 'пар'],
    ];
    const detected = detectColumns(rows)!;
    expect(detected.columns.tnved).toBe(1);
    expect(detected.columns.name).toBe(2);
    expect(detected.columns.quantity).toBe(3);
    expect(detected.columns.unit).toBe(4);
    const { goods } = parseGoods(rows);
    expect(goods.map((g) => [g.description, g.tnvedCode, g.quantity, g.unit])).toEqual([
      ['Плитка керамическая', '6907210000', 120, 'м2'],
      ['Куртка мужская', '6201930000', 300, 'шт'],
      ['Кофе', '0901210000', 50, 'кг'],
      ['Обувь', null, 40, 'пар'],
    ]);
    // The refused code is said, never dropped.
    expect(goods[3]!.note).toContain('640399000');
  });

  it('a «Кол-во, кг» header is a WEIGHT column, never pieces', () => {
    // The header's own unit word decides: «Кол-во, кг» read as a count put
    // 500 kg in the piece column, under a per-piece floor.
    const rows = [
      ['Наименование', 'Кол-во, кг', 'Кол-во мест'],
      ['Гвозди', 500, 20],
    ];
    const detected = detectColumns(rows)!;
    expect(detected.columns.weight).toBe(1);
    const [row] = parseGoods(rows).goods;
    expect(row).toMatchObject({ description: 'Гвозди', weightKg: 500 });
  });

  it('a column whose data are all codes is not the name, whatever its header says', () => {
    const rows = [
      ['Tovar kodi', 'Tovar nomi', 'Soni'],
      ['6907210000', 'Kafel', 10],
      ['6201930000', 'Kurtka', 5],
    ];
    expect(detectColumns(rows)!.columns.name).toBe(1);
  });

  it('a bare «hs» or «kod» header claims nothing (judge MR-19)', () => {
    // Too short to mean a code column: «Kod» is as often an article number.
    const rows = [
      ['Kod', 'Наименование', 'Кол-во'],
      ['A-17', 'Носки', 10],
    ];
    expect(detectColumns(rows)!.columns.tnved).toBeNull();
  });

  it('parses both decimal conventions', () => {
    expect(parseNumber('1 234,56')).toBe(1234.56);
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseNumber('12,5')).toBe(12.5);
    expect(parseNumber(7)).toBe(7);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('шт')).toBeNull();
  });
});
