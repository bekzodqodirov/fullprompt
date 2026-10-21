import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as CFB from 'cfb';
import { describe, expect, it } from 'vitest';
import { decodeText, readGoodsFile } from '@/modules/wms/deals/goods-file';
import { detectColumns, parseGoods } from '@/modules/wms/deals/goods-import';
import { htmlTableSheets, readXls, rkValue, spreadsheetMlSheets } from '@/modules/wms/deals/xls';

/**
 * The bot's spreadsheet door (his 1.2 b, 1.3 b, 2026-10-21).
 *
 * `invoice-97.xls` is a REAL Excel 97 file, not a hand-built one: a workbook
 * made with exceljs (two sheets, a title row, «Item No.» to the left of the
 * name, Cyrillic and Chinese names, decimals, a formula column, a TNVED
 * column on every third line, an «Итого» row) and saved by LibreOffice's
 * «MS Excel 97» filter. Its shared-string table runs over a CONTINUE record,
 * so the width flag at a record boundary is exercised by a real writer.
 */

const FIXTURE = readFileSync(path.join(__dirname, '..', 'fixtures', 'invoice-97.xls'));
const NAMES = ['Куртка женская', '女士夹克 winter', 'Кроссовки мужские', '儿童玩具 plastic toy', 'Синтетическое компрессорное масло'];
const nameOf = (i: number) =>
  `${NAMES[i % NAMES.length]} ${i} ${'ж'.repeat(i % 7)}${'中'.repeat(i % 5)} модель-${1000 + i}`;

/** A compound file holding one stream, as an old or a broken workbook would. */
function compound(stream: string, body: Buffer): Buffer {
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, stream, body);
  return Buffer.from(CFB.write(container, { type: 'buffer' }) as Uint8Array);
}

/** One BIFF record: type, size, data. */
function record(type: number, data: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(data.length, 2);
  return Buffer.concat([head, data]);
}

function bof(version: number): Buffer {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(version, 0);
  data.writeUInt16LE(0x0005, 2);
  return record(0x0809, data);
}

describe('Excel 97 (BIFF8), read from a file LibreOffice wrote', () => {
  it('every cell of every row comes back exactly — strings, numbers, decimals, formula results', () => {
    const read = readXls(FIXTURE);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.sheets.map((s) => s.name)).toEqual(['Invoice', 'Packing']);
    const rows = read.sheets[0]!.rows;
    expect(rows[0]).toEqual(['COMMERCIAL INVOICE / 商业发票']);
    expect(rows[2]![2]).toBe('Наименование товара');
    for (let i = 0; i < 150; i += 1) {
      const row = rows[i + 3]!;
      expect(row[1]).toBe(`YW-${2300 + i}`);
      expect(row[2]).toBe(nameOf(i));
      expect(row[3]).toBe(10 + i);
      expect(row[4]).toBe(12.5 + i / 4);
      expect(row[5]).toBe(0.125 * (i % 9));
      expect(row[6], 'a formula reads as its cached result').toBe((10 + i) * 2);
      expect(row[7] ?? null).toBe(i % 3 === 0 ? '6201930000' : null);
    }
    expect(read.sheets[1]!.rows[1]).toEqual(['Масло', 3, 240]);
  });

  it('the bot reads the goods off the right column of the busiest sheet, and hands the rest to the model', async () => {
    const read = await readGoodsFile(FIXTURE, 'application/vnd.ms-excel');
    expect(read?.kind).toBe('goods');
    if (read?.kind !== 'goods') return;
    expect(read.sheet).toBe('Invoice');
    // «Итого» is arithmetic, not a product.
    expect(read.goods).toHaveLength(150);
    // The NAME, not «Item No.» — the diagnosis' cause 1.
    expect(read.goods[0]).toMatchObject({
      description: nameOf(0),
      quantity: 10,
      weightKg: 12.5,
      volumeM3: 0,
      tnvedCode: '6201930000',
    });
    // The packing sheet is the SAME goods; it is text for the model, never a
    // second set of lines.
    expect(read.text).toContain('[Packing]');
    expect(read.text).toContain('Масло | 3 | 240');
  });

  it('refuses an Excel 95 workbook, a password and a broken stream — in kinds the bot words', async () => {
    const old = compound('Book', Buffer.concat([bof(0x0500), record(0x000a, Buffer.alloc(0))]));
    expect(readXls(old)).toEqual({ ok: false, reason: 'old_format' });
    expect(await readGoodsFile(old, null)).toEqual({ kind: 'refused', reason: 'old_format' });

    const locked = compound('Workbook', Buffer.concat([bof(0x0600), record(0x002f, Buffer.alloc(6)), record(0x000a, Buffer.alloc(0))]));
    expect(readXls(locked)).toEqual({ ok: false, reason: 'encrypted' });

    const garbage = compound('Workbook', Buffer.from('this is not a workbook at all'));
    expect(readXls(garbage)).toEqual({ ok: false, reason: 'broken' });
  });

  it('a shared string cut by a record boundary switches width where the CONTINUE says so', () => {
    // LibreOffice's file splits its table without a width change, so this is
    // built by hand: «abc» in one byte per character ends the SST record, and
    // the CONTINUE opens with the flag byte 1 — «где» in two bytes each.
    const sst = Buffer.concat([
      Buffer.from([1, 0, 0, 0, 1, 0, 0, 0]),
      Buffer.from([6, 0, 0]),
      Buffer.from('abc', 'latin1'),
    ]);
    const cont = Buffer.concat([Buffer.from([1]), Buffer.from('где', 'utf16le')]);
    const sheetName = Buffer.concat([Buffer.from([1, 0]), Buffer.from('S', 'latin1')]);
    const boundsheet = (at: number) => {
      const head = Buffer.alloc(6);
      head.writeUInt32LE(at, 0);
      return record(0x0085, Buffer.concat([head, sheetName]));
    };
    const globalsLength = [bof(0x0600), boundsheet(0), record(0x00fc, sst), record(0x003c, cont), record(0x000a, Buffer.alloc(0))]
      .reduce((n, b) => n + b.length, 0);
    const labelSst = Buffer.alloc(10);
    labelSst.writeUInt32LE(0, 6);
    const stream = Buffer.concat([
      bof(0x0600),
      boundsheet(globalsLength),
      record(0x00fc, sst),
      record(0x003c, cont),
      record(0x000a, Buffer.alloc(0)),
      bof(0x0600),
      record(0x00fd, labelSst),
      record(0x000a, Buffer.alloc(0)),
    ]);
    const read = readXls(compound('Workbook', stream));
    expect(read.ok && read.sheets[0]!.rows[0]).toEqual(['abcгде']);
  });

  it('an RK number is a 30-bit integer or the top half of a double, maybe ×100', () => {
    expect(rkValue((150 << 2) | 2)).toBe(150);
    expect(rkValue(((-7 << 2) | 2) >>> 0)).toBe(-7);
    expect(rkValue((1234 << 2) | 3)).toBe(12.34);
    // 12.5 as a double: 0x4029000000000000 — the top 32 bits are the RK.
    expect(rkValue(0x40290000)).toBe(12.5);
  });
});

describe('the other two shapes a «.xls» arrives in', () => {
  it('an HTML table saved as .xls (a web system’s export)', async () => {
    const html = `<html><body><table border="1">
      <tr><th>Наименование</th><th>Кол-во</th><th>Вес, кг</th></tr>
      <tr><td>Носки&nbsp;мужские</td><td>100</td><td>25,5</td></tr>
      <tr><td>Футболки &amp; майки</td><td>50</td><td>30</td></tr>
    </table></body></html>`;
    expect(htmlTableSheets(html)![0]!.rows[1]).toEqual(['Носки мужские', '100', '25,5']);
    const read = await readGoodsFile(Buffer.from(html, 'utf8'), 'application/vnd.ms-excel');
    expect(read?.kind === 'goods' && read.goods.map((g) => [g.description, g.quantity, g.weightKg])).toEqual([
      ['Носки мужские', 100, 25.5],
      ['Футболки & майки', 50, 30],
    ]);
  });

  it('an Excel 2003 XML spreadsheet, a skipped cell included', async () => {
    const xml = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="Лист1"><Table>
  <Row><Cell><Data ss:Type="String">Товар</Data></Cell><Cell><Data ss:Type="String">Кол-во</Data></Cell><Cell><Data ss:Type="String">Вес, кг</Data></Cell></Row>
  <Row><Cell><Data ss:Type="String">Кафель</Data></Cell><Cell ss:Index="3"><Data ss:Type="Number">500</Data></Cell></Row>
 </Table></Worksheet>
</Workbook>`;
    expect(spreadsheetMlSheets(xml)![0]).toEqual({
      name: 'Лист1',
      rows: [
        ['Товар', 'Кол-во', 'Вес, кг'],
        ['Кафель', null, '500'],
      ],
    });
    const read = await readGoodsFile(Buffer.from(xml, 'utf8'), null);
    expect(read?.kind === 'goods' && read.goods[0]).toMatchObject({ description: 'Кафель', quantity: null, weightKg: 500 });
  });
});

describe('a CSV in the encoding the sender’s machine wrote', () => {
  it('cp1251 from a Russian Windows and GBK from a Chinese office both read', async () => {
    const ru = Buffer.from(new Uint8Array([
      // «Наименование;Кол-во\nНоски;100» in cp1251
      0xcd, 0xe0, 0xe8, 0xec, 0xe5, 0xed, 0xee, 0xe2, 0xe0, 0xed, 0xe8, 0xe5, 0x3b, 0xca, 0xee, 0xeb, 0x2d, 0xe2, 0xee,
      0x0a, 0xcd, 0xee, 0xf1, 0xea, 0xe8, 0x3b, 0x31, 0x30, 0x30,
    ]));
    expect(decodeText(ru)).toBe('Наименование;Кол-во\nНоски;100');
    const read = await readGoodsFile(ru, 'text/csv');
    expect(read?.kind === 'goods' && read.goods[0]).toMatchObject({ description: 'Носки', quantity: 100 });

    // «品名,数量\n袜子,500» in GBK
    const zh = Buffer.from(new Uint8Array([
      0xc6, 0xb7, 0xc3, 0xfb, 0x2c, 0xca, 0xfd, 0xc1, 0xbf, 0x0a, 0xcd, 0xe0, 0xd7, 0xd3, 0x2c, 0x35, 0x30, 0x30,
    ]));
    expect(decodeText(zh)).toBe('品名,数量\n袜子,500');
  });

  it('UTF-16 with its mark (Excel’s «Unicode text») is text, not binary', async () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Товар\tКол-во\nСумка\t7', 'utf16le')]);
    const read = await readGoodsFile(body, null);
    expect(read?.kind === 'goods' && read.goods[0]).toMatchObject({ description: 'Сумка', quantity: 7 });
  });
});

describe('a sheet the reader cannot map goes to the model, never becomes goods', () => {
  it('no header: the seller’s name and address are NOT products (the diagnosis’ cause 1)', async () => {
    const csv = 'Yiwu Trading Co.\nAddress: Futian market\nInvoice No 1234\nкуртки 300 шт\n';
    const read = await readGoodsFile(Buffer.from(csv, 'utf8'), 'text/csv');
    expect(read?.kind).toBe('text');
    expect(read?.kind === 'text' && read.text).toContain('куртки 300 шт');
  });

  it('a title row of one merged cell is not the header, even when it says «товар»', () => {
    const rows = [
      ['Товарная накладная № 15'],
      ['№', 'Наименование', 'Кол-во'],
      [1, 'Носки', 100],
    ];
    expect(detectColumns(rows)!.headerRow).toBe(1);
  });

  it('«Item No.» left of «Description»: the description is the name', () => {
    const rows = [
      ['Item No.', 'Description', 'Qty'],
      ['YW-2301', 'Women jacket', 300],
      ['YW-2302', 'Men shoes', 40],
    ];
    expect(detectColumns(rows)!.columns.name).toBe(1);
  });
});

describe('a figure with its unit glued on (Chinese packing lists)', () => {
  it('«120KGS», «12.5 CBM», «300PCS» read in their own columns; «5 CTNS» is never pieces; NET over gross', () => {
    const rows = [
      ['Description', 'Qty', 'G.W.(KGS)', 'N.W.(KGS)', 'CBM'],
      ['Women jacket', '300PCS', '130KGS', '120KGS', '12.5 CBM'],
      ['Men shoes', '5 CTNS', '1 300 kg', '1 200 kg', '0,8m3'],
    ];
    const goods = parseGoods(rows).goods;
    expect(goods.map((g) => [g.quantity, g.weightKg, g.volumeM3])).toEqual([
      [300, 120, 12.5],
      [null, 1200, 0.8],
    ]);
  });
});
