import { describe, expect, it } from 'vitest';
import { workbookRows } from '@/modules/wms/deals/goods-file';
import { detectColumns, parseGoods, type Cell } from '@/modules/wms/deals/goods-import';
import { buildFile } from './fixtures/intake-corpus';

/**
 * docs/FAYL-OQISH.md §5 (P-reader-A) — what the corpus cases cannot say
 * (they compare lines, not the JSON a name reaches the model in, nor the
 * answer `detectColumns` gives the VED paste). The reading itself is pinned
 * in tests/unit/fixtures/intake-corpus.json, c2601-c2698, c2701-c2747 and
 * (the fix round) c2750-c2821.
 */

/** A lone surrogate, as `JSON.stringify` writes one since ES2019. */
const LONE = /\\ud[89a-f][0-9a-f]{2}/i;

describe('§3.8 a name is cut by UTF-16 units, never through an emoji', () => {
  it('a 299-unit name and then an emoji: the emoji is left out whole, nothing lone reaches the JSON', () => {
    const { goods } = parseGoods([
      ['Наименование', 'Кол-во'],
      [`${'Ж'.repeat(299)}🔥 hot`, 5],
    ]);
    expect(goods[0]!.description).toBe('Ж'.repeat(299));
    expect(JSON.stringify(goods)).not.toMatch(LONE);
  });

  it('a name that fits keeps its emoji, and the budget is still 300 units', () => {
    const { goods } = parseGoods([
      ['Наименование', 'Кол-во'],
      [`${'Ж'.repeat(298)}🔥 hot`, 5],
    ]);
    expect(goods[0]!.description).toBe(`${'Ж'.repeat(298)}🔥`);
    expect(goods[0]!.description).toHaveLength(300);
  });

  it('a card’s name is cut the same way', () => {
    const { goods } = parseGoods([
      ['Tovar nomi', `${'Ж'.repeat(299)}🔥`],
      ['Soni', 300],
    ]);
    expect(goods.map((g) => g.description)).toEqual(['Ж'.repeat(299)]);
    expect(JSON.stringify(goods)).not.toMatch(LONE);
  });
});

describe('§5.6 a label|value card is read by parseGoods, and is no column map', () => {
  const card = [
    ['Tovar nomi', 'Ayollar kurtkasi'],
    ['Soni', 300],
    ['Vazni', 150],
  ];

  it('parseGoods reads the one good, with the name label’s row as its header row (readGoodsFile keeps it)', () => {
    const read = parseGoods(card);
    expect(read.headerRow).toBe(0);
    expect(read.goods).toHaveLength(1);
    expect(read.goods[0]).toMatchObject({ description: 'Ayollar kurtkasi', quantity: 300, weightKg: 150 });
    expect(read.shape).toBe('invoice');
  });

  it('detectColumns answers null for it: the VED paste reads such a paste line by line, as before', () => {
    expect(detectColumns(card)).toBeNull();
  });

  it('a value that is itself a label is no card: «Наименование | Примечание» over nothing names no good', () => {
    const read = parseGoods([
      ['Наименование', 'Примечание'],
      ['Количество', 'Цвет'],
    ]);
    expect(read.goods.map((g) => g.description)).not.toContain('Примечание');
  });
});

describe('§5.8 best-of-ten keeps what first-found answered', () => {
  it('a one-column list refused BELOW a header already found leaves that header standing', () => {
    // First-found returned row 0 before row 2 was ever read; the list
    // refusal row 2 now meets must not take it back.
    const rows = [
      ['Наименование', 'Кол-во'],
      ['Стол', 5],
      ['Перечень'],
      ...Array.from({ length: 6 }, (_, k) => [`Стул модель ${k + 1} 5 шт 10 кг`]),
    ];
    const read = parseGoods(rows);
    expect(read.headerRow).toBe(0);
    expect(read.goods[0]).toMatchObject({ description: 'Стол', quantity: 5 });
  });

  it('a tie keeps the earliest: the Chinese row of a bilingual header, not the English one under it', () => {
    const read = parseGoods([
      ['序号', '品名', '海关编码', '数量', '毛重', '体积'],
      ['No.', 'Description', 'HS Code', 'Qty', 'G.W.', 'CBM'],
      [1, '女士夹克', '6202930000', 300, 165, 1.2],
    ]);
    expect(read.headerRow).toBe(0);
    expect(read.goods.map((g) => g.description)).toEqual(['女士夹克']);
  });
});

describe('the deal card’s import reads what the bot reads (the fix round’s reader-a-break-deal-import-untested)', () => {
  // The route takes parseGoods' goods whatever headerRow says
  // (src/app/api/deals/[id]/lines/import/route.ts): a header refused there is
  // its own text landed as the first deal line and every figure dropped. So
  // these run the route's own two steps — workbookRows, then parseGoods.
  const routeLines = async (rows: Cell[][]) => {
    const built = await buildFile({ kind: 'xlsx', sheets: [{ name: 'Sheet1', rows }] });
    const sheet = await workbookRows(built.body);
    return parseGoods(sheet!.rows, sheet!.covered ?? null);
  };
  const shapes: [string, Cell[][], string[]][] = [
    ['a size run', [['Наименование', 'Цвет', 38, 40, 42, 'Всего', 'Цена', 'Сумма'], ['Платье', 'красный', 10, 20, 10, 40, 5, 200]], ['Платье']],
    ['a one-cell heading', [['Наименование продукции'], ['Куртка женская'], ['Брюки мужские']], ['Куртка женская', 'Брюки мужские']],
    ['a count column', [['Наименование', 'Шт'], ['Куртка женская', 300], ['Брюки мужские', 200]], ['Куртка женская', 'Брюки мужские']],
    ['articles beside a colour', [['Item No.', 'Color', 'Qty', 'Unit Price', 'Amount'], ['LJ-2023', 'Black', 300, 5, 1500]], ['LJ-2023']],
    ['packaging goods', [['Tovar nomi', 'Soni', 'Vazni'], ['Karobka', 500, 100], ['Quti', 300, 60]], ['Karobka', 'Quti']],
  ];
  it.each(shapes)('%s: the header is found, and its own text is no deal line', async (_, rows, names) => {
    const read = await routeLines(rows);
    expect(read.headerRow).toBe(0);
    expect(read.goods.map((g) => g.description)).toEqual(names);
  });
  it('the size run keeps its figures through the route’s steps', async () => {
    const read = await routeLines(shapes[0]![1]);
    expect(read.goods[0]).toMatchObject({ description: 'Платье', amount: 200 });
  });
});

describe('a sheet of long shared strings costs what one header does (the fix round’s reader-a-break-candidate-cost)', () => {
  it('2,000 × 100 cells of two 30,000-character strings taking turns: read in seconds, not a minute', () => {
    const x = 'x'.repeat(30_000);
    const a = `Наименование товара Кол-во ${x}`;
    const b = `Описание Вес ${x}`;
    const rows: Cell[][] = Array.from({ length: 2000 }, (_, r) => Array.from({ length: 100 }, () => (r % 2 ? b : a)));
    const started = performance.now();
    const read = parseGoods(rows);
    // 0.7 s here; 60 s at 95cac4c, 7 s with only the repeated-row skip.
    expect(performance.now() - started).toBeLessThan(5000);
    expect(read.headerRow).toBe(0);
  });

  it('2,000 × 100 cells of one long «Customer name …»: no header anywhere, and no row judged twice', () => {
    const cell = `Customer name ${'x'.repeat(30_000)}`;
    const rows: Cell[][] = Array.from({ length: 2000 }, () => Array.from({ length: 100 }, () => cell));
    const started = performance.now();
    const read = parseGoods(rows);
    // 0.1 s here; 3.8 s when every row of the top ten and the deep fifty was judged anew.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(read.headerRow).toBeNull();
  });
});
