import { describe, expect, it } from 'vitest';
import { detectColumns, parseGoods } from '@/modules/wms/deals/goods-import';

/**
 * docs/FAYL-OQISH.md §5 (P-reader-A) — what the corpus cases cannot say
 * (they compare lines, not the JSON a name reaches the model in, nor the
 * answer `detectColumns` gives the VED paste). The reading itself is pinned
 * in tests/unit/fixtures/intake-corpus.json, c2601-c2698 and c2701-c2747.
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
