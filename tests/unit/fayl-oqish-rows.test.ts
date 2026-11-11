import { describe, expect, it } from 'vitest';
import { droppedRowsLine, readGoodsFile, workbookRows } from '@/modules/wms/deals/goods-file';
import { detectColumns, parseGoods, totalRowOf, type Cell, type DroppedRow } from '@/modules/wms/deals/goods-import';
import { read } from '../fixtures/source-shape';
import { pasteItems } from '@/modules/wms/calc/send-rows';
import { buildFile } from './fixtures/intake-corpus';

/**
 * docs/FAYL-OQISH.md §5 (P-reader-B: rows and figures) — what the corpus
 * cases cannot say: the one predicate itself (`totalRowOf`, asked by three
 * readers), the receipt's words for `dropped`, the channels `dropped` and
 * the CSV's comma travel through (the bot's reader, the deal import's JSON),
 * and the VED paste. The readings themselves are pinned in
 * tests/unit/fixtures/intake-corpus.json, c3001-c3118.
 */

describe('§5.4 totalRowOf — the ONE «is this row arithmetic» (#513)', () => {
  it('a label-only total, whatever its figures: «TOTAL», «Итого по счету», «TOTAL 15 CTNS», «Umumiy», «Общий итог», «合计数量»', () => {
    for (const name of ['TOTAL', 'TOTAL:', 'Итого по счету', 'TOTAL 15 CTNS', 'Umumiy', 'Общий итог', 'Jami summa', 'Sum', '合计数量', '总计（箱）', '小计']) {
      expect(totalRowOf({ name, figures: true }), name).toBe('total');
    }
  });

  it('a name that only HOLDS a total word is a good while its figures are its own: a TOTAL Tools drill, an oil, a varnish, a bag, a folder', () => {
    for (const name of ['TOTAL cordless drill TDLI20012', 'TOTAL QUARTZ 9000 5W-40', 'Umumiy maqsadli lak', 'Sumka ayollar', 'Итоговая папка', '小计算器']) {
      expect(totalRowOf({ name, figures: true }), name).toBeNull();
    }
  });

  it('(b) a figure-less footer by a CORE total word only — «SAY TOTAL: …»; never by «umumiy» or «sum»', () => {
    expect(totalRowOf({ name: 'SAY TOTAL: US DOLLARS ONE THOUSAND ONLY', figures: false })).toBe('footer_total');
    expect(totalRowOf({ name: 'SAY TOTAL: US DOLLARS ONE THOUSAND ONLY', figures: true })).toBeNull();
    expect(totalRowOf({ name: 'Umumiy maqsadli lak', figures: false })).toBeNull();
    expect(totalRowOf({ name: 'Sumka ayollar', figures: false })).toBeNull();
    expect(totalRowOf({ name: 'Итоговая папка', figures: false })).toBeNull();
  });

  it('(c) the Σ drops a row only when its name says total too: a word-only name equal to the Σ is a good (the third colour of one jacket)', () => {
    expect(totalRowOf({ name: 'Куртка синяя', figures: true, sum: { rows: 2, twin: false } })).toBeNull();
    expect(totalRowOf({ name: 'Socks grey', figures: true, sum: { rows: 2, twin: false } })).toBeNull();
    expect(totalRowOf({ name: 'Куртка женская Итог', figures: true, sum: { rows: 2, twin: false } })).toBe('subtotal');
    expect(totalRowOf({ name: 'Итого к оплате с НДС', figures: true, sum: { rows: 3, twin: false } })).toBe('total');
  });

  it('(c) by a subtotal’s SHAPE only — the total word last, or opening as 1C’s «Итого по …»; a total word elsewhere is a product’s, whatever the Σ', () => {
    const sum = { rows: 2, twin: false };
    expect(totalRowOf({ name: 'Итого по разделу Одежда', figures: true, sum })).toBe('subtotal');
    expect(totalRowOf({ name: 'Итого по разделу Обувь', figures: true, sum: { rows: 1, twin: false } })).toBe('subtotal');
    expect(totalRowOf({ name: 'Subtotal jackets', figures: true, sum })).toBe('subtotal');
    for (const name of ['Umumiy maqsadli lak', 'TOTAL cordless drill TDLI20012', 'TOTAL QUARTZ 9000 5W-40', 'Sumka ayollar']) {
      expect(totalRowOf({ name, figures: true, sum }), name).toBeNull();
    }
  });

  it('a label: an Incoterm names its place; digits glued to letters are a model number, a unit glued to its number a qualifier', () => {
    for (const name of ['TOTAL FOB NINGBO', 'TOTAL CIF TASHKENT', 'TOTAL 15CTNS', 'TOTAL 300KG', 'Итого по товарам', 'Jami summasi']) {
      expect(totalRowOf({ name, figures: true }), name).toBe('total');
    }
    expect(totalRowOf({ name: 'TOTAL 10W-40', figures: true })).toBeNull();
    expect(totalRowOf({ name: 'TOTAL key fob', figures: true })).toBeNull();
  });

  it('(c) over ONE good only Excel’s subtotal shape counts — the total word last, and never the good’s own name', () => {
    expect(totalRowOf({ name: 'Брюки Итог', figures: true, sum: { rows: 1, twin: false } })).toBe('subtotal');
    expect(totalRowOf({ name: '女士夹克 汇总', figures: true, sum: { rows: 1, twin: false } })).toBe('subtotal');
    expect(totalRowOf({ name: 'Colgate Total', figures: true, sum: { rows: 1, twin: true } })).toBeNull();
    expect(totalRowOf({ name: 'TOTAL QUARTZ 9000', figures: true, sum: { rows: 1, twin: false } })).toBeNull();
  });
});

describe('§5.5 the receipt’s words for what was not taken as goods (`droppedRowsLine`, the collector prints it)', () => {
  const footer = (text: string): DroppedRow => ({ text, name: text, why: 'footer' });
  it('a footer under the goods: «ostidagi N ta qator tovar deb olinmadi: …»', () => {
    expect(droppedRowsLine([footer('Made in China'), footer('Remarks: 30 cartons')])).toBe(
      'ostidagi 2 ta qator tovar deb olinmadi: «Made in China», «Remarks: 30 cartons»',
    );
  });

  it('«ostidagi» only when every row said is a footer: a figure-less «Total station Leica» may stand mid-list and says why', () => {
    expect(droppedRowsLine([{ text: 'Total station Leica', name: 'Total station Leica', why: 'footer_total' }])).toBe(
      '1 ta qator tovar deb olinmadi: «Total station Leica» (izoh qatori)',
    );
    expect(droppedRowsLine([{ text: 'SAY TOTAL: US DOLLARS ONE THOUSAND ONLY', name: 'SAY TOTAL: US DOLLARS ONE THOUSAND ONLY', why: 'footer_total' }, footer('Made in China')])).toBe(
      '2 ta qator tovar deb olinmadi: «SAY TOTAL: US DOLLARS ONE THOUSAND ONLY» (izoh qatori), «Made in China» (jadval ostida)',
    );
  });

  it('a label-only total row is no news and says nothing; nothing to say is null', () => {
    expect(droppedRowsLine([{ text: 'TOTAL | 300 | 150', name: 'TOTAL', why: 'total' }])).toBeNull();
    expect(droppedRowsLine([])).toBeNull();
  });

  it('a subtotal says why, a long row is cut on a whole unit, and past three the rest is counted', () => {
    const line = droppedRowsLine([
      { text: 'Куртка женская Итог | 300 | 150 | 1.2', name: 'Куртка женская Итог', why: 'subtotal' },
      footer('YIWU HUAXIN IMPORT & EXPORT CO., LTD, No. 88 Futian Road'),
      footer('Signature:'),
      footer('Stamp'),
    ]);
    expect(line).toBe(
      '4 ta qator tovar deb olinmadi: «Куртка женская Итог | 300 | 150 | 1.2» (jami qatori), «YIWU HUAXIN IMPORT & EXPORT CO., LTD, No…» (jadval ostida), «Signature:» (jadval ostida) va yana 1 ta',
    );
  });
});

describe('`dropped` reaches every caller of the reader', () => {
  const rows: Cell[][] = [
    ['Description', 'Qty', 'G.W. (kg)', 'CBM'],
    ['Ladies jacket', 300, 150, 1.2],
    ['TOTAL', 300, 150, 1.2],
    ['Made in China', null, null, null],
  ];
  const DROPPED = [
    { text: 'TOTAL | 300 | 150 | 1.2', name: 'TOTAL', why: 'total' },
    { text: 'Made in China', name: 'Made in China', why: 'footer' },
  ];

  it('the bot’s reader: a goods read carries the rows it did not take', async () => {
    const built = await buildFile({ kind: 'xlsx', sheets: [{ name: 'Sheet1', rows }] });
    const sheet = await readGoodsFile(built.body, built.contentType);
    expect(sheet?.kind).toBe('goods');
    expect(sheet?.kind === 'goods' && sheet.dropped).toEqual(DROPPED);
    expect(sheet?.kind === 'goods' && sheet.grossKg).toBe(150);
  });

  it('the deal card’s import: its own two steps give `dropped`, and the route returns it on both answers', async () => {
    const built = await buildFile({ kind: 'xlsx', sheets: [{ name: 'Sheet1', rows }] });
    const sheet = await workbookRows(built.body);
    expect(parseGoods(sheet!.rows, sheet!.covered ?? null).dropped).toEqual(DROPPED);
    const route = read('src/app/api/deals/[id]/lines/import/route.ts');
    expect(route).toMatch(/const \{ goods, dropped \} = parseGoods\(/);
    expect(route).toMatch(/NextResponse\.json\(\{ error: 'no_goods', dropped \}/);
    expect(route).toMatch(/NextResponse\.json\(\{ goods, groups, aiError, dropped \}\)/);
  });
});

describe('§5.5 a door that cannot say `dropped` keeps the rows, or shows them', () => {
  it('the VED paste lands every line it was given — a figure-less tail is his, never a footer (his B-round answer)', () => {
    const items = pasteItems('Наименование\tКол-во\tВес\nКуртка\t100\t50\nБрюки\t200\t\nШапка\t\t\nШарф\t\t');
    expect(items.map((i) => i.name)).toEqual(['Куртка', 'Брюки', 'Шапка', 'Шарф']);
  });

  it('the deal card’s import reads `dropped` and offers each row a «＋» that makes it a line (no label-only total)', () => {
    const ui = read('src/app/(protected)/bitimlar/import-lines.tsx');
    expect(ui).toMatch(/setDropped\(\(json\.dropped \?\? \[\]\)\.filter\(\(row\) => row\.why !== 'total'\)\)/);
    expect(ui).toMatch(/data-testid="import-dropped-add"/);
    expect(ui).toMatch(/description: row\.name,/);
  });
});

describe('§5.5 a list at the reader’s ceiling: a footer past it is no line left unread', () => {
  const list = (n: number): Cell[][] => [
    ['Description', 'Qty', 'G.W. (kg)'],
    ...Array.from({ length: n }, (_, k): Cell[] => [`Item ${k + 1}`, 10, 2]),
  ];
  it('500 lines and a «Made in China» under them: the 500 lines’ brutto stands', () => {
    const parsed = parseGoods([...list(500), ['Made in China', null, null]]);
    expect(parsed.goods).toHaveLength(500);
    expect(parsed.grossKg).toBe(1000);
  });
  it('…while a 501st line with figures still says the list was cut, and its Σ is no total (PF-ADV-2)', () => {
    const parsed = parseGoods(list(501));
    expect(parsed.goods).toHaveLength(500);
    expect(parsed.grossKg).toBeNull();
  });
});

describe('§5.9 the comma a CSV’s delimiter implies, through the bot’s reader', () => {
  const sheetOf = async (text: string) => {
    const built = await buildFile({ kind: 'csv', text });
    const read = await readGoodsFile(built.body, built.contentType);
    return read?.kind === 'goods' ? read.goods : [];
  };
  it('a «;» CSV is written with a decimal comma, a «,» CSV quotes a thousands one — the same «1,250» kg either way', async () => {
    expect((await sheetOf('Наименование;Кол-во;Вес, кг\r\nКабель;100;1,250')).map((g) => g.weightKg)).toEqual([1.25]);
    expect((await sheetOf('Description,Qty,N.W.(KG)\r\nCable,100,"1,250"')).map((g) => g.weightKg)).toEqual([1250]);
  });

  it('a tab says nothing: the evidence-less «1,250» is asked', async () => {
    const [cable] = await sheetOf('Наименование\tКол-во\tВес, кг\r\nКабель\t100\t1,250');
    expect(cable).toMatchObject({ weightKg: null, note: 'vazn «1,250» — aniq emas' });
  });
});

describe('§5.10, §5.11 the VED paste reads the same columns (detectColumns is the paste’s door)', () => {
  it('«CTN QTY | TOTAL QTY»: the count is TOTAL QTY; «Всего шт» beside cartons is the count', () => {
    expect(detectColumns([['DESCRIPTION', 'QTY/CTN', 'CTN QTY', 'TOTAL QTY'], ['Jacket', 20, 15, 300]])!.columns.quantity).toBe(3);
    expect(detectColumns([['Наименование', 'Кол-во коробок', 'Всего шт'], ['Куртка', 15, 300]])!.columns.quantity).toBe(2);
  });
});
