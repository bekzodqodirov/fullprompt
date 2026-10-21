import * as CFB from 'cfb';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { SHEET_TEXT_BUDGET, csvRows, readGoodsFile, workbookRows, workbookSheets } from '@/modules/wms/deals/goods-file';
import { parseGoods } from '@/modules/wms/deals/goods-import';
import {
  MAX_COLS,
  MAX_MARKUP_CHARS,
  MAX_ROWS,
  MAX_SHEETS,
  htmlTableSheets,
  readXls,
  spreadsheetMlSheets,
} from '@/modules/wms/deals/xls';

/**
 * The spreadsheet door against files built to hurt it, and against the shapes
 * real writers produce that the first version misread (the round-1 review,
 * 2026-10-21). The bot polls inside the app, so a reader that is not bounded
 * and linear is a way to stop every page.
 */

/** One BIFF record: type, size, data. */
function record(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(data.length, 2);
  return Buffer.concat([head, data]);
}

const bof = () => {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(0x0600, 0);
  data.writeUInt16LE(0x0010, 2);
  return record(0x0809, data);
};
const eof = () => record(0x000a, Buffer.alloc(0));

function cellHead(row: number, col: number, size: number): Buffer {
  const data = Buffer.alloc(size);
  data.writeUInt16LE(row, 0);
  data.writeUInt16LE(col, 2);
  return data;
}

/** XLUnicodeString, two bytes a character. */
const unicode = (text: string) => {
  const head = Buffer.alloc(3);
  head.writeUInt16LE(text.length, 0);
  head[2] = 1;
  return Buffer.concat([head, Buffer.from(text, 'utf16le')]);
};
const label = (row: number, col: number, text: string) => record(0x0204, Buffer.concat([cellHead(row, col, 6), unicode(text)]));
const number = (row: number, col: number, value: number) => {
  const data = cellHead(row, col, 14);
  data.writeDoubleLE(value, 6);
  return record(0x0203, data);
};
/** A FORMULA whose cached result is a string — the text comes in a STRING record. */
const formulaString = (row: number, col: number) => {
  const data = cellHead(row, col, 22);
  data[6] = 0;
  data.writeUInt16LE(0xffff, 12);
  return record(0x0006, data);
};
const stringRecord = (text: string) => record(0x0207, unicode(text));

interface Entry {
  at: number;
  name: string;
  hsState?: number;
}

function boundsheet({ at, name, hsState = 0 }: Entry): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt32LE(at, 0);
  head[4] = hsState;
  return record(0x0085, Buffer.concat([head, Buffer.from([name.length, 0]), Buffer.from(name, 'latin1')]));
}

/** The workbook stream: the globals, then `body`; entry offsets are relative to `body`. */
function stream97(entries: Entry[], body: Buffer): Buffer {
  const globals = (list: Entry[]) => Buffer.concat([bof(), ...list.map(boundsheet), eof()]);
  const base = globals(entries).length;
  return Buffer.concat([globals(entries.map((e) => ({ ...e, at: e.at + base }))), body]);
}

/** Sheets laid end to end, one directory entry each. */
function sheets97(list: { name: string; hsState?: number; cells: Buffer[] }[]): Buffer {
  const entries: Entry[] = [];
  const bodies: Buffer[] = [];
  let at = 0;
  for (const sheet of list) {
    const body = Buffer.concat([bof(), ...sheet.cells, eof()]);
    entries.push({ at, name: sheet.name, hsState: sheet.hsState });
    bodies.push(body);
    at += body.length;
  }
  return stream97(entries, Buffer.concat(bodies));
}

function compound(stream: Buffer): Buffer {
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, 'Workbook', stream);
  return Buffer.from(CFB.write(container, { type: 'buffer' }) as Uint8Array);
}

const orderCells = [
  label(0, 0, '№'),
  label(0, 1, 'Наименование'),
  label(0, 2, 'Кол-во'),
  number(1, 0, 1),
  label(1, 1, 'Стол'),
  number(1, 2, 5),
  number(2, 0, 2),
  label(2, 1, 'Стул'),
  number(2, 2, 3),
];
const priceListCells = [label(0, 0, 'Наименование'), label(0, 1, 'Цена')];
for (let r = 1; r <= 10; r += 1) {
  priceListCells.push(label(r, 0, `Товар из прайса ${r}`), number(r, 1, r));
}

async function xlsxOf(sheets: { name: string; state?: 'visible' | 'hidden' | 'veryHidden'; rows: (string | number)[][] }[]) {
  const workbook = new ExcelJS.Workbook();
  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name, { state: sheet.state ?? 'visible' });
    for (const row of sheet.rows) ws.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('a small file never becomes a huge text (#8)', () => {
  it('cells pointing at one 30,000-character shared string: the text stops at the budget, each cell at 300', async () => {
    const big = 'Ж'.repeat(30_000);
    const body = await xlsxOf([{ name: 'S', rows: Array.from({ length: 10 }, () => Array.from({ length: 100 }, () => big)) }]);
    expect(body.length).toBeLessThan(100_000);
    const read = await readGoodsFile(body, null);
    expect(read?.kind).toBe('text');
    if (read?.kind !== 'text') return;
    expect(read.text.length).toBeLessThanOrEqual(SHEET_TEXT_BUDGET);
    expect(read.textCut).toBe(true);
    // «[S]», then the first row's cells — each cut where a description is cut.
    expect(read.text.split('\n')[1]!.split(' | ')[0]).toHaveLength(300);
  });

  it('several sheets share ONE budget, in workbook order', async () => {
    const row = Array.from({ length: 5 }, (_, i) => `${'x'.repeat(290)} ${i}`);
    const body = await xlsxOf(['A', 'B', 'C'].map((name) => ({ name, rows: Array.from({ length: 10 }, () => row) })));
    const read = await readGoodsFile(body, null);
    expect(read?.kind === 'text' && [read.text.length <= SHEET_TEXT_BUDGET, read.textCut]).toEqual([true, true]);
    expect(read?.kind === 'text' && read.text.startsWith('[A]\n')).toBe(true);
  });

  it('a file that fits is not marked cut', async () => {
    const html = '<table><tr><td>Yiwu Trading</td></tr><tr><td>Invoice</td></tr></table>';
    const read = await readGoodsFile(Buffer.from(html, 'utf8'), null);
    expect(read?.kind === 'text' && read.textCut).toBe(false);
  });

  it('a CSV is bounded like the other shapes — MAX_ROWS lines, MAX_COLS cells', () => {
    const wide = csvRows(`${'a;'.repeat(1_000)}b\nx;y`);
    expect(wide[0]).toHaveLength(MAX_COLS);
    expect(wide[1]).toEqual(['x', 'y']);
    expect(csvRows('Товар;Кол-во\n' + 'Стол;5\n'.repeat(MAX_ROWS + 50))).toHaveLength(MAX_ROWS);
  });

  it('three hundred directory entries pointing at ONE sheet read it once', () => {
    const one = Buffer.concat([bof(), ...orderCells, eof()]);
    const entries = Array.from({ length: 300 }, () => ({ at: 0, name: 'S' }));
    const read = readXls(compound(stream97(entries, one)));
    expect(read.ok && read.sheets.length).toBe(1);
  });

  it('the directory stops at MAX_SHEETS', () => {
    const list = Array.from({ length: MAX_SHEETS + 8 }, (_, i) => ({ name: `S${i}`, cells: [label(0, 0, `x${i}`)] }));
    const read = readXls(compound(sheets97(list)));
    expect(read.ok && read.sheets.length).toBe(MAX_SHEETS);
  });

  it('entries at DISTINCT offsets into one sheet’s records stop once the stream has been walked', () => {
    // Ten BOF records in a row, then one sheet's cells: entry k starts at the
    // k-th BOF and walks every cell again.
    const cells = Array.from({ length: 100 }, (_, i) => number(i, 0, i));
    const body = Buffer.concat([...Array.from({ length: 10 }, bof), ...cells, eof()]);
    const entries = Array.from({ length: 10 }, (_, k) => ({ at: k * 20, name: `S${k}` }));
    const read = readXls(compound(stream97(entries, body)));
    expect(read.ok && read.sheets.length).toBe(1);
  });
});

describe('the markup readers are linear and keep spanned columns in place (#9)', () => {
  const header = '<tr><th>Наименование<th>Кол-во<th>Вес, кг';

  it('an HTML table with its closers left out reads every row — the way a browser does', async () => {
    const html = `<table>${header}<tr><td>Стол<td>5<td>100<tr><td>Стул<td>3<td>60</table>`;
    expect(htmlTableSheets(html)![0]!.rows).toEqual([
      ['Наименование', 'Кол-во', 'Вес, кг'],
      ['Стол', '5', '100'],
      ['Стул', '3', '60'],
    ]);
    const read = await readGoodsFile(Buffer.from(html, 'utf8'), null);
    expect(read?.kind === 'goods' && read.goods.map((g) => [g.description, g.quantity, g.weightKg])).toEqual([
      ['Стол', 5, 100],
      ['Стул', 3, 60],
    ]);
  });

  it('thirty thousand unclosed rows read in linear time, capped at MAX_ROWS', () => {
    const html = `<table>${header}${'<tr><td>Стол<td>5<td>100'.repeat(30_000)}</table>`;
    const started = Date.now();
    const rows = htmlTableSheets(html)![0]!.rows;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(rows).toHaveLength(MAX_ROWS);
    expect(rows[MAX_ROWS - 1]).toEqual(['Стол', '5', '100']);
  });

  it('a cell of a hundred thousand «<» and no «>» is read in linear time', () => {
    const html = `<table><tr><td>Наименование</td></tr><tr><td>Стол ${'<'.repeat(100_000)}</td></tr></table>`;
    const started = Date.now();
    const rows = htmlTableSheets(html)![0]!.rows;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(String(rows[1]![0]).startsWith('Стол <<<')).toBe(true);
  });

  it('a two-row header — «Вес, кг» over «нетто | брутто» — keeps every column where the header put it', async () => {
    const html = `<table>
      <tr><th rowspan="2">Наименование</th><th rowspan="2">Кол-во</th><th colspan="2">Вес, кг</th><th rowspan="2">Сумма</th></tr>
      <tr><th>нетто</th><th>брутто</th></tr>
      <tr><td>Стол</td><td>5</td><td>100</td><td>110</td><td>2500</td></tr>
      <tr><td>Стул</td><td>3</td><td>55</td><td>60</td><td>900</td></tr>
    </table>`;
    // The sub-header row repeats the header's merged WORDS (S8, the second
    // review: a merged text names every row it covers) — every column still
    // where the header put it.
    expect(htmlTableSheets(html)![0]!.rows.slice(0, 2)).toEqual([
      ['Наименование', 'Кол-во', 'Вес, кг', null, 'Сумма'],
      ['Наименование', 'Кол-во', 'нетто', 'брутто', 'Сумма'],
    ]);
    const read = await readGoodsFile(Buffer.from(html, 'utf8'), null);
    // No «нетто» product — the row naming the header is the header again —
    // the net weight and the line's money where they stand.
    expect(read?.kind === 'goods' && read.goods.map((g) => [g.description, g.quantity, g.weightKg, g.amount])).toEqual([
      ['Стол', 5, 100, 2500],
      ['Стул', 3, 55, 900],
    ]);
  });

  it('a colspan in the header no longer shifts the columns after it', async () => {
    const html = `<table>
      <tr><td>Наименование</td><td colspan="2">Кол-во</td><td>Вес, кг</td><td>Сумма</td></tr>
      <tr><td>Стол</td><td>5</td><td>шт</td><td>100</td><td>2500</td></tr>
    </table>`;
    const read = await readGoodsFile(Buffer.from(html, 'utf8'), null);
    expect(read?.kind === 'goods' && read.goods[0]).toMatchObject({ description: 'Стол', weightKg: 100, amount: 2500 });
  });

  it('a rowspan in the data keeps the next row’s figures in their columns, stated once', () => {
    // One carton's gross weight merged over the two lines packed in it.
    const html = `<table>
      <tr><td>Наименование</td><td>Вес, кг</td><td>Кол-во</td></tr>
      <tr><td>Стол</td><td rowspan="2">160</td><td>5</td></tr>
      <tr><td>Стул</td><td>3</td></tr>
    </table>`;
    expect(htmlTableSheets(html)![0]!.rows.slice(1)).toEqual([
      ['Стол', '160', '5'],
      ['Стул', null, '3'],
    ]);
  });

  const xmlCell = (text: string, attrs = '') => `<Cell${attrs}><Data ss:Type="String">${text}</Data></Cell>`;
  const xml = (rows: string) => `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="Лист1"><Table>${rows}</Table></Worksheet>
</Workbook>`;

  it('SpreadsheetML: MergeAcross covers the cells to its right', () => {
    const merged = spreadsheetMlSheets(
      xml(`<Row>${xmlCell('Наименование')}${xmlCell('Вес, кг', ' ss:MergeAcross="1"')}${xmlCell('Сумма')}</Row>`),
    )!;
    expect(merged[0]!.rows[0]).toEqual(['Наименование', 'Вес, кг', null, 'Сумма']);
  });

  it('SpreadsheetML: thirty thousand unclosed <Row> read in linear time', () => {
    const cell = xmlCell;
    const started = Date.now();
    const rows = spreadsheetMlSheets(xml(`<Row>${cell('Наименование')}`.repeat(30_000)))![0]!.rows;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(rows).toHaveLength(MAX_ROWS);
    expect(rows[1]).toEqual(['Наименование']);
  });

  it('a markup text past MAX_MARKUP_CHARS is refused in words, never read', async () => {
    const html = `<table><tr><td>Наименование</td><td>Кол-во</td></tr><tr><td>Стол</td><td>5</td></tr></table>`;
    const body = Buffer.from(html + ' '.repeat(MAX_MARKUP_CHARS), 'utf8');
    expect(await readGoodsFile(body, null)).toEqual({ kind: 'refused', reason: 'broken' });
  });
});

describe('a formula’s cached string survives the records between it and its STRING (#13)', () => {
  it.each([
    ['SHRFMLA', 0x04bc],
    ['ARRAY', 0x0221],
    ['TABLE', 0x0236],
  ])('FORMULA → %s → STRING: the first product of a filled-down block is read', async (_name, between) => {
    const xls = compound(
      sheets97([
        {
          name: 'S',
          cells: [
            label(0, 0, 'Description'),
            label(0, 1, 'Qty'),
            formulaString(1, 0),
            record(between, Buffer.alloc(10)),
            stringRecord('Chair'),
            number(1, 1, 10),
            formulaString(2, 0),
            stringRecord('Table'),
            number(2, 1, 20),
          ],
        },
      ]),
    );
    const read = readXls(xls);
    expect(read.ok && read.sheets[0]!.rows).toEqual([
      ['Description', 'Qty'],
      ['Chair', 10],
      ['Table', 20],
    ]);
    const goods = await readGoodsFile(xls, null);
    expect(goods?.kind === 'goods' && goods.goods.map((g) => [g.description, g.quantity])).toEqual([
      ['Chair', 10],
      ['Table', 20],
    ]);
  });
});

describe('a hidden sheet is never chosen over a visible one (#14)', () => {
  const order = [
    ['№', 'Наименование', 'Кол-во'],
    [1, 'Стол', 5],
    [2, 'Стул', 3],
  ];
  const priceList = [['Наименование', 'Цена'], ...Array.from({ length: 10 }, (_, i) => [`Товар из прайса ${i + 1}`, i + 1])];

  it.each(['hidden', 'veryHidden'] as const)('XLSX: a %s price list does not out-count the order', async (state) => {
    const body = await xlsxOf([
      { name: 'Заказ', rows: order },
      { name: 'Справочник', state, rows: priceList },
    ]);
    const read = await readGoodsFile(body, null);
    expect(read?.kind === 'goods' && [read.sheet, read.goods.map((g) => g.description), read.sheets]).toEqual([
      'Заказ',
      ['Стол', 'Стул'],
      1,
    ]);
    // …and the catalogue is not handed to the model as shipment material.
    expect(read?.kind === 'goods' && read.text).toBe('');
  });

  it('Excel 97: hsState hides the sheet', async () => {
    const xls = compound(
      sheets97([
        { name: 'Order', cells: orderCells },
        { name: 'Prices', hsState: 1, cells: priceListCells },
      ]),
    );
    const read = readXls(xls);
    expect(read.ok && read.sheets.map((s) => [s.name, s.hidden ?? false])).toEqual([
      ['Order', false],
      ['Prices', true],
    ]);
    const goods = await readGoodsFile(xls, null);
    expect(goods?.kind === 'goods' && [goods.sheet, goods.goods.length]).toEqual(['Order', 2]);
  });

  it('SpreadsheetML: <Visible>SheetHidden</Visible> hides the sheet; a workbook of nothing else is still read', async () => {
    const sheet = (name: string, hidden: boolean, rows: (string | number)[][]) =>
      `<Worksheet ss:Name="${name}"><Table>${rows
        .map((row) => `<Row>${row.map((c) => `<Cell><Data ss:Type="String">${c}</Data></Cell>`).join('')}</Row>`)
        .join('')}</Table>${
        hidden ? '<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><Visible>SheetHidden</Visible></WorksheetOptions>' : ''
      }</Worksheet>`;
    const xml = (sheets: string) =>
      `<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">${sheets}</Workbook>`;

    const both = await readGoodsFile(Buffer.from(xml(sheet('Заказ', false, order) + sheet('Справочник', true, priceList))), null);
    expect(both?.kind === 'goods' && [both.sheet, both.goods.length]).toEqual(['Заказ', 2]);

    const onlyHidden = await readGoodsFile(Buffer.from(xml(sheet('Заказ', true, order))), null);
    expect(onlyHidden?.kind === 'goods' && [onlyHidden.sheet, onlyHidden.goods.length]).toEqual(['Заказ', 2]);
  });
});

/**
 * The second review (2026-10-21, S2/S9, S4, S7, S8, S11): what the first fix
 * round's door did with an empty visible sheet, a long sheet's last row and a
 * merged cell — the same table now reads the same from every format.
 */
describe('the second review of the spreadsheet door', () => {
  it('an empty visible sheet does not hide the order on a hidden one (S2, S9)', async () => {
    const body = await xlsxOf([
      { name: 'Sheet1', rows: [] },
      { name: 'Data', state: 'hidden', rows: [['Наименование', 'Кол-во'], ['Стол', 5]] },
    ]);
    const read = await readGoodsFile(body, null);
    expect(read?.kind === 'goods' && [read.sheet, read.goods.map((g) => [g.description, g.quantity])]).toEqual(['Data', [['Стол', 5]]]);
  });

  it('a long header-less sheet is cut on a WHOLE row and says so (S4)', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `PL-${i};LED panel light 600x600 40W, ${i} PCS;12.5 kg;0.125 cbm;carton ${i}`);
    const read = await readGoodsFile(Buffer.from(lines.join('\n'), 'utf8'), 'text/csv');
    expect(read?.kind).toBe('text');
    if (read?.kind !== 'text') return;
    expect(read.text.length).toBeLessThanOrEqual(SHEET_TEXT_BUDGET);
    expect(read.textCut).toBe(true);
    const shown = read.text.split('\n').slice(1);
    // Every line handed over is a whole source row, the last one included.
    shown.forEach((line, i) => expect(line).toBe(lines[i]!.replace(/;/g, ' | ')));
    expect(shown.length).toBeGreaterThan(100);
    expect(shown.length).toBeLessThan(300);
  });

  it('one huge row cannot empty the text: a row is capped first, whole cells only (S4)', async () => {
    const row = Array.from({ length: 100 }, (_, i) => `${'Ж'.repeat(290)} ${i}`);
    const read = await readGoodsFile(await xlsxOf([{ name: 'S', rows: [row, ['Стол 5 шт']] }]), null);
    expect(read?.kind).toBe('text');
    if (read?.kind !== 'text') return;
    expect(read.textCut).toBe(true);
    const [, first, second] = read.text.split('\n');
    expect(first!.length).toBeLessThanOrEqual(2_000);
    expect(first!.split(' | ').every((cell, i) => cell === row[i])).toBe(true);
    expect(second).toBe('Стол 5 шт');
  });

  it('a cell’s own line break is not a row: the text keeps one line per row (S4)', async () => {
    const read = await readGoodsFile(await xlsxOf([{ name: 'S', rows: [['Yiwu Trading'], ['Куртка\nженская', 'синяя']] }]), null);
    expect(read?.kind === 'text' && read.text).toBe('[S]\nYiwu Trading\nКуртка женская | синяя');
    expect(read?.kind === 'text' && read.textCut).toBe(false);
  });

  it('a cell cut at its 300 characters is something left out (S4)', async () => {
    const read = await readGoodsFile(await xlsxOf([{ name: 'S', rows: [['Yiwu Trading'], ['Ж'.repeat(400)]] }]), null);
    expect(read?.kind === 'text' && read.textCut).toBe(true);
  });

  it('the S7 gate reads a one-column list in linear time — five cells of thirty thousand digits', () => {
    // Measured: the figure scan over one such cell unbounded took 2 s.
    const digits = '1'.repeat(30_000);
    const started = Date.now();
    parseGoods([['Наименование'], ...Array.from({ length: 5 }, () => [digits])]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('a TITLE over typed lines with figures goes to the model, never as goods with no figures (S7)', async () => {
    const csv = 'Товарная накладная № 15 от 01.10.2026\nСтол офисный 5 шт 100 кг\nСтул 30 шт 150 кг\n';
    const read = await readGoodsFile(Buffer.from(csv, 'utf8'), 'text/csv');
    expect(read?.kind).toBe('text');
    expect(read?.kind === 'text' && read.text).toContain('Стол офисный 5 шт 100 кг');
  });

  it('HTML: a name merged down over two lines names both; its figures stay in their columns (S8)', async () => {
    const html = `<table><tr><td>Наименование</td><td>Кол-во</td><td>Вес, кг</td></tr>
      <tr><td rowspan="2">Стол</td><td>5</td><td>100</td></tr><tr><td>3</td><td>60</td></tr></table>`;
    expect(htmlTableSheets(html)![0]!.rows.slice(1)).toEqual([
      ['Стол', '5', '100'],
      ['Стол', '3', '60'],
    ]);
    const read = await readGoodsFile(Buffer.from(html, 'utf8'), null);
    expect(read?.kind === 'goods' && read.goods.map((g) => [g.description, g.quantity, g.weightKg])).toEqual([
      ['Стол', 5, 100],
      ['Стол', 3, 60],
    ]);
  });

  /**
   * One table, three formats: a title merged ACROSS, a name and a carton's
   * amount merged DOWN over two lines. Measured before the fix: the XLSX
   * read the title as the header (four «goods» with no figures, «Наименование»
   * among them), the HTML dropped the second line.
   */
  const table = { title: 'Товарная накладная', header: ['Наименование', 'Кол-во', 'Вес, кг', 'Сумма'] };
  const expected = [
    ['Стол', 5, 100, 900],
    ['Стол', 3, 60, null],
    ['Стул', 2, 10, 50],
  ];
  const goodsOf = (read: Awaited<ReturnType<typeof readGoodsFile>>) =>
    read?.kind === 'goods' && read.goods.map((g) => [g.description, g.quantity, g.weightKg, g.amount]);

  it('XLSX: a covered cell repeats a merged TEXT down its column, a merged FIGURE is counted once (S11)', async () => {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet('S');
    ws.addRow([table.title, null, null, null]);
    ws.mergeCells('A1:D1');
    ws.addRow(table.header);
    ws.addRow(['Стол', 5, 100, 900]);
    ws.addRow([null, 3, 60, null]);
    ws.mergeCells('A3:A4');
    ws.mergeCells('D3:D4');
    ws.addRow(['Стул', 2, 10, 50]);
    const body = Buffer.from(await workbook.xlsx.writeBuffer());
    const sheets = await workbookSheets(body);
    expect(sheets![0]!.rows).toEqual([
      [table.title, null, null, null],
      table.header,
      ['Стол', 5, 100, 900],
      ['Стол', 3, 60, null],
      ['Стул', 2, 10, 50],
    ]);
    expect(goodsOf(await readGoodsFile(body, null))).toEqual(expected);
    // The deal import's own reader follows the same rule.
    expect(await workbookRows(body)).toEqual(sheets![0]!.rows);
  });

  it('HTML: the same table reads the same goods (S11)', async () => {
    const html = `<table><tr><td colspan="4">${table.title}</td></tr>
      <tr>${table.header.map((h) => `<td>${h}</td>`).join('')}</tr>
      <tr><td rowspan="2">Стол</td><td>5</td><td>100</td><td rowspan="2">900</td></tr>
      <tr><td>3</td><td>60</td></tr>
      <tr><td>Стул</td><td>2</td><td>10</td><td>50</td></tr></table>`;
    expect(goodsOf(await readGoodsFile(Buffer.from(html, 'utf8'), null))).toEqual(expected);
  });

  it('SpreadsheetML: MergeDown reads the same goods (S11)', async () => {
    const cell = (v: string | number, attrs = '') =>
      `<Cell${attrs}><Data ss:Type="${typeof v === 'number' ? 'Number' : 'String'}">${v}</Data></Cell>`;
    const xml = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="S"><Table>
  <Row>${cell(table.title, ' ss:MergeAcross="3"')}</Row>
  <Row>${table.header.map((h) => cell(h)).join('')}</Row>
  <Row>${cell('Стол', ' ss:MergeDown="1"')}${cell(5)}${cell(100)}${cell(900, ' ss:MergeDown="1"')}</Row>
  <Row>${cell(3, ' ss:Index="2"')}${cell(60)}</Row>
  <Row>${cell('Стул')}${cell(2)}${cell(10)}${cell(50)}</Row>
 </Table></Worksheet>
</Workbook>`;
    expect(spreadsheetMlSheets(xml)![0]!.rows[3]).toEqual(['Стол', '3', '60']);
    expect(goodsOf(await readGoodsFile(Buffer.from(xml, 'utf8'), null))).toEqual(expected);
  });
});
