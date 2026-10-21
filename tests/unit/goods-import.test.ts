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

/**
 * The round-1 review (2026-10-21): what the reader learned that round read
 * some ordinary files WORSE than before it. Each case is a file shape the
 * business receives.
 */
describe('the round-1 review of the header detective', () => {
  it('«1,200KGS» and «12,500PCS» are ambiguous and stay unread — never 1.2 kg (#10)', () => {
    const rows = [
      ['Description', 'Quantity', 'N.W.', 'CBM'],
      ['LED panel light', '12,500PCS', '1,200KGS', '2.5CBM'],
      ['LED bulb', '300PCS', '1,200.50KGS', '0,125CBM'],
      ['LED strip', '1 200 PCS', '12.500KGS', '1.5 CBM'],
    ];
    expect(parseGoods(rows).goods.map((g) => [g.quantity, g.weightKg, g.volumeM3])).toEqual([
      [null, null, 2.5],
      [300, 1200.5, 0.125],
      [1200, 12.5, 1.5],
    ]);
  });

  it('a per-carton «N.W./CTN» before «TOTAL N.W.» is not the line’s weight (#11)', () => {
    const rows = [
      ['Description', 'CTNS', 'QTY/CTN', 'TOTAL QTY', 'N.W./CTN', 'G.W./CTN', 'TOTAL N.W.', 'TOTAL G.W.', 'MEAS.(CBM)'],
      ['LED panel', 20, 12, 240, 12, 13, 240, 260, 1.2],
    ];
    expect(parseGoods(rows).goods[0]).toMatchObject({ quantity: 240, weightKg: 240, volumeM3: 1.2 });
  });

  it('«Net price», «Net amount», «Цена нетто» are money, never the weight (#11)', () => {
    const price = parseGoods([
      ['Description', 'Qty', 'Net price', 'Amount', 'Gross weight'],
      ['Chair', 10, 25.5, 255, 120],
    ]).goods[0];
    expect(price).toMatchObject({ weightKg: 120, amount: 255 });

    const amount = parseGoods([
      ['Description', 'Qty', 'Unit price', 'Net amount'],
      ['Chair', 10, 25.5, 255],
    ]).goods[0];
    expect(amount).toMatchObject({ weightKg: null, amount: 255 });

    const ru = parseGoods([
      ['Наименование', 'Кол-во', 'Цена нетто', 'Сумма', 'Вес брутто, кг'],
      ['Стул', 10, 25.5, 255, 120],
    ]).goods[0];
    expect(ru).toMatchObject({ weightKg: 120, amount: 255 });

    // A bare «net» is inside words that are no weight at all.
    const cabinet = parseGoods([
      ['Description', 'Cabinet No.', 'Qty', 'Weight (kg)'],
      ['Shelf', 'C-12', 4, 80],
    ]).goods[0];
    expect(cabinet).toMatchObject({ weightKg: 80 });

    // «Суммарный вес» is a weight, not a sum of money.
    const total = parseGoods([
      ['Наименование', 'Кол-во', 'Суммарный вес, кг'],
      ['Стул', 10, 120],
    ]).goods[0];
    expect(total).toMatchObject({ weightKg: 120 });
  });

  it('«Товар» / «Product Name» stay the name beside «Описание» / «Description» (#12)', () => {
    expect(
      detectColumns([
        ['Товар', 'Описание', 'Кол-во'],
        ['Куртка женская', 'Ткань полиэстер, размер S-XL', 100],
      ])!.columns.name,
    ).toBe(0);
    expect(
      detectColumns([
        ['No.', 'Product Name', 'Description', 'Qty'],
        [1, 'Plastic chair', 'Color: white, size 45x45cm', 10],
      ])!.columns.name,
    ).toBe(1);
    // «Item No.» still loses to the description (the round's own case).
    expect(
      detectColumns([
        ['Item No.', 'Description', 'Qty'],
        ['YW-2301', 'Women jacket', 300],
      ])!.columns.name,
    ).toBe(1);
  });

  it('a short name ending in a number is a name, not an article number (#12)', () => {
    expect(
      detectColumns([
        ['Наименование', 'Описание', 'Кол-во'],
        ['Труба 32', 'PPR pipe, 4 m', 10],
        ['Кран 1/2', 'brass ball valve', 5],
        ['Муфта 25', 'coupling', 20],
      ])!.columns.name,
    ).toBe(0);
    // …while capital-letter article numbers still are.
    expect(
      detectColumns([
        ['Код товара', 'Наименование', 'Кол-во'],
        ['A-17', 'Носки', 10],
        ['SKU 0042', 'Футболки', 5],
      ])!.columns.name,
    ).toBe(1);
  });

  it('a one-column list keeps its one-cell header; a one-cell TITLE over a table is still no header (#15)', () => {
    const list = parseGoods([['Наименование товара'], ['Стол'], ['Стул'], ['Шкаф']]);
    expect(list.headerRow).toBe(0);
    expect(list.goods.map((g) => g.description)).toEqual(['Стол', 'Стул', 'Шкаф']);

    expect(detectColumns([['Товарная накладная № 15'], ['№', 'Наименование', 'Кол-во'], [1, 'Носки', 100]])!.headerRow).toBe(1);
  });
});

/**
 * The second review (2026-10-21, S1-S10): the first fix round's own reading
 * of these headers, measured against files the business receives. Each case
 * read correctly before round 1 or is a shape the round set out to read.
 */
describe('the second review of the header detective', () => {
  const names = (rows: (string | number | null)[][]) => parseGoods(rows).goods.map((g) => g.description);

  it('a 1C «Код товара» column of ЦБ-/УТ- codes is not the name of a Russian УПД (S1)', () => {
    const upd = [
      [
        '№ п/п',
        'Код товара/ работ, услуг',
        'Наименование товара (описание выполненных работ, оказанных услуг), имущественного права',
        'Код вида товара',
        'Единица измерения',
        'Количество (объем)',
        'Цена (тариф) за единицу измерения',
        'Стоимость товаров без налога - всего',
      ],
      [1, 'ЦБ-00012345', 'Кресло офисное', '9401300000', 'шт', 10, 50, 500],
      [2, 'ЦБ-00012346', 'Стол письменный', '9403301100', 'шт', 5, 120, 600],
      [3, 'УТ-00000077', 'Шкаф', '9403301900', 'шт', 2, 300, 600],
    ];
    expect(parseGoods(upd).goods.map((g) => [g.description, g.quantity, g.amount])).toEqual([
      ['Кресло офисное', 10, 500],
      ['Стол письменный', 5, 600],
      ['Шкаф', 2, 600],
    ]);
  });

  it('article numbers in any script, in any case, with a joining mark, lose to the name column (S1)', () => {
    expect(names([['Код товара', 'Наименование товара', 'Кол-во'], ['АБ-1201', 'Носки', 10], ['АБ-1202', 'Футболки', 5]])).toEqual([
      'Носки',
      'Футболки',
    ]);
    expect(names([['Tovar kodi', 'Tovar nomi', 'Soni'], ['gs-1201', 'Kafel', 10], ['gs-1202', 'Kurtka', 5]])).toEqual(['Kafel', 'Kurtka']);
    expect(names([['Goods code', 'Goods name', 'Qty'], ['Art. 2301', 'Women jacket', 10], ['Art. 2302', 'Men shoes', 5]])).toEqual([
      'Women jacket',
      'Men shoes',
    ]);
  });

  it('a code, an article, a trade mark, a brand or a party is not the goods’ name; the name is (S5)', () => {
    expect(names([['Код товара', 'Наименование', 'Кол-во'], ['УТ-00012345', 'Стол', 5]])).toEqual(['Стол']);
    expect(names([['Артикул товара', 'Наименование', 'Кол-во'], ['АР-1234', 'Стол', 5]])).toEqual(['Стол']);
    expect(
      names([
        ['Товарный знак', 'Наименование товара', 'Кол-во'],
        ['Xiaomi', 'Пылесос робот', 5],
        ['Haier', 'Холодильник', 2],
      ]),
    ).toEqual(['Пылесос робот', 'Холодильник']);
    expect(names([['Brand name', 'Product description', 'Qty'], ['XIAOMI', 'Robot vacuum cleaner', 5]])).toEqual(['Robot vacuum cleaner']);
    expect(names([['Customer name', 'Product name', 'Qty'], ['Alisher', 'Plastic chair', 5]])).toEqual(['Plastic chair']);
    expect(names([['Mijoz nomi', 'Tovar nomi', 'Soni'], ['Alisher', 'Stul', 5]])).toEqual(['Stul']);
    expect(names([['品牌名称', '品名', '数量'], ['小米', '扫地机器人', 5]])).toEqual(['扫地机器人']);
  });

  it('a name header that LISTS what it holds — «(марка, модель)» — is still the name (S5)', () => {
    expect(
      names([
        ['Код товара', 'Наименование товара (марка, модель)', 'Кол-во'],
        ['ЦБ-00012345', 'Кресло офисное Metta SU-1', 10],
      ]),
    ).toEqual(['Кресло офисное Metta SU-1']);
    expect(names([['Product name, brand, model', 'Qty'], ['Robot vacuum Xiaomi S10', 5]])).toEqual(['Robot vacuum Xiaomi S10']);
  });

  it('«毛重/箱» and «净重/件» are one package’s weight, never the line’s (S3)', () => {
    expect(parseGoods([['品名', '数量', '毛重/箱', '总毛重'], ['椅子', 10, 12, 120]]).goods[0]!.weightKg).toBe(120);
    expect(parseGoods([['品名', '数量', '净重/件', '总净重'], ['椅子', 10, 12, 120]]).goods[0]!.weightKg).toBe(120);
  });

  it('a word-bounded «Net» beside a gross column, or with its kilos, is the net weight (S6)', () => {
    const weight = (header: string[]) => parseGoods([header, ['Chair', 10, 110, 100]]).goods[0]!.weightKg;
    expect(weight(['Description', 'Qty', 'Gross, kg', 'Net, kg'])).toBe(100);
    expect(weight(['Description', 'Qty', 'GROSS (KG)', 'NET (KG)'])).toBe(100);
    expect(weight(['Description', 'Qty', 'Gross', 'Net'])).toBe(100);
    // …and a «Net» standing for money on an invoice with no weight at all is
    // not one: no kilo in it, no gross column beside it.
    expect(parseGoods([['Description', 'Qty', 'Price', 'Net'], ['Chair', 10, 11, 110]]).goods[0]!.weightKg).toBeNull();
    expect(parseGoods([['Description', 'Qty', 'Gross amount', 'Net'], ['Chair', 10, 120, 110]]).goods[0]!.weightKg).toBeNull();
  });

  it('a one-cell TITLE over typed lines with figures is no header — the sheet goes to the model (S7)', () => {
    const typed = parseGoods([['Товарная накладная № 15 от 01.10.2026'], ['Стол офисный 5 шт 100 кг'], ['Стул 30 шт 150 кг']]);
    expect(typed.headerRow).toBeNull();
    // Lines with their figures typed in are never a list under a header.
    expect(detectColumns([['Наименование товара'], ['Стол офисный 5 шт 100 кг'], ['Стул 30 шт 150 кг']])).toBeNull();
    // A title — a number in it — over lines with numbers: the model reads them.
    expect(detectColumns([['Товарная накладная № 15'], ['Стол 5'], ['Стул 30']])).toBeNull();
    // A list of NAMES keeps its header, a name ending in a number included…
    expect(parseGoods([['Наименование'], ['Труба 32'], ['Кран 1/2'], ['Муфта 25']]).headerRow).toBe(0);
    // …and is read exactly under a title too.
    expect(names([['Товарная накладная № 15'], ['Стол'], ['Стул']])).toEqual(['Стол', 'Стул']);
  });

  it('an article column under a header that names NO code still loses to the names (S1)', () => {
    // Capitals in any script, any case with a joining mark: «ЦБ-00012345»,
    // «gs-1201», «Art. 2302» are article numbers wherever they stand.
    expect(
      detectColumns([
        ['Товар', 'Описание', 'Кол-во'],
        ['ЦБ-00012345', 'Кресло офисное', 10],
        ['УТ-00000077', 'Шкаф', 2],
      ])!.columns.name,
    ).toBe(1);
    expect(
      detectColumns([
        ['Product name', 'Description', 'Qty'],
        ['gs-1201', 'Women jacket', 10],
        ['Art. 2302', 'Men shoes', 5],
      ])!.columns.name,
    ).toBe(1);
  });

  it('a data row that repeats the header’s name cell is no product — a header repeated at a page break (S8)', () => {
    expect(
      names([
        ['Наименование', 'Кол-во'],
        ['Стол', 5],
        ['Наименование', 'Кол-во'],
        ['Стул', 3],
      ]),
    ).toEqual(['Стол', 'Стул']);
  });

  it('a weight, volume or package column is never the line’s money (S10)', () => {
    const amount = (rows: (string | number)[][]) => parseGoods(rows).goods[0]!.amount;
    expect(amount([['Item', 'Qty', 'Total G.W.', 'Total amount'], ['Chair', 10, 120, 500]])).toBe(500);
    expect(amount([['Item', 'Qty', 'TOTAL G.W.'], ['Chair', 10, 120]])).toBeNull();
    expect(amount([['Description', 'Qty', 'TOTAL N.W.', 'TOTAL G.W.', 'TOTAL CBM'], ['Chair', 10, 100, 120, 1.5]])).toBeNull();
    expect(
      amount([
        ['Description', 'CTNS', 'QTY/CTN', 'TOTAL QTY', 'N.W./CTN', 'G.W./CTN', 'TOTAL N.W.', 'TOTAL G.W.', 'MEAS.(CBM)'],
        ['LED panel', 20, 12, 240, 12, 13, 240, 260, 1.2],
      ]),
    ).toBeNull();
    expect(amount([['Description', 'Qty', 'TOTAL CTNS'], ['Chair', 10, 2]])).toBeNull();
    // A money word keeps a money column money, whatever else it says.
    const gross = parseGoods([['Description', 'Qty', 'Gross weight', 'Gross amount'], ['Chair', 10, 120, 500]]).goods[0];
    expect(gross).toMatchObject({ weightKg: 120, amount: 500 });
  });
});
