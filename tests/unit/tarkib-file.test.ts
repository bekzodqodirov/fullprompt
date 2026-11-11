import { readFileSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { SheetRows } from '@/modules/wms/deals/xls';
import {
  kindOfAttachment,
  MERGED_MARK,
  prepareFile,
  READ_CAPS,
  SHEET_TEXT_BUDGET,
  SHEET_TEXT_ROWS,
  sheetsToText,
  XLSX_CELL_XML_MAX,
  xlsxCellBytes,
} from '@/modules/wms/receipts/tarkib-file';

/**
 * «🤖 Fayldan to'ldirish» — the client's document as the model is given it
 * (docs/TARKIB-TAKLIFLAR.md §3): what kind of file it is (from the row alone,
 * before a byte is read), and a spreadsheet written out as text.
 *
 * The workbooks are REAL ones — built with exceljs and read back through the
 * readers the adapter imports — because the text's rules are about what
 * those readers hand over: a formula's float, a hidden sheet, a merged cell.
 * `invoice-97.xls` is the Excel 97 file LibreOffice wrote for the bot's
 * reader; it is only read here.
 */

const MB = 1024 * 1024;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function workbook(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const sheet = (rows: SheetRows['rows'], over: Partial<SheetRows> = {}): SheetRows => ({ name: 'Packing', rows, ...over });

describe('the kind of file, from the attachment’s row alone', () => {
  const row = (contentType: string, fileName: string, sizeBytes = 1000) => ({ contentType, fileName, sizeBytes });

  it('a video, an archive, a Word file and a recording are refused BEFORE a byte is read', () => {
    for (const [type, name] of [
      ['video/mp4', 'pogruzka.mp4'],
      ['video/quicktime', 'IMG_0001.MOV'],
      ['application/zip', 'docs.zip'],
      ['application/vnd.rar', 'docs.rar'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'packing.docx'],
      ['application/msword', 'packing.doc'],
      ['audio/mpeg', 'call.mp3'],
    ] as const) {
      // Sixty megabytes of video: the size is never even looked at.
      expect(kindOfAttachment(row(type, name, 60 * MB)), name).toEqual({ ok: false, error: 'read_unsupported' });
    }
  });

  it('a PDF, a picture and a spreadsheet are the three kinds the model reads', () => {
    expect(kindOfAttachment(row('application/pdf', 'packing.pdf'))).toEqual({ ok: true, kind: 'pdf' });
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif']) {
      expect(kindOfAttachment(row(type, 'photo')), type).toEqual({ ok: true, kind: 'image' });
    }
    for (const [type, name] of [
      [XLSX, 'packing.xlsx'],
      ['application/vnd.ms-excel', 'packing.xls'],
      ['text/csv', 'packing.csv'],
      ['text/plain', 'packing.txt'],
      ['text/csv; charset=windows-1251', 'packing.csv'],
    ] as const) {
      expect(kindOfAttachment(row(type, name)), name).toEqual({ ok: true, kind: 'sheet' });
    }
  });

  it('a type that says nothing is answered by the extension — and by nothing else', () => {
    expect(kindOfAttachment(row('application/octet-stream', 'Packing List.XLSX'))).toEqual({ ok: true, kind: 'sheet' });
    expect(kindOfAttachment(row('', 'scan.PDF'))).toEqual({ ok: true, kind: 'pdf' });
    expect(kindOfAttachment(row('application/octet-stream', 'photo.heic'))).toEqual({ ok: true, kind: 'image' });
    expect(kindOfAttachment(row('application/octet-stream', 'archive.bin'))).toEqual({ ok: false, error: 'read_unsupported' });
    // A known type wins over a misleading name.
    expect(kindOfAttachment(row('video/mp4', 'packing.xlsx'))).toEqual({ ok: false, error: 'read_unsupported' });
  });

  it('each kind has its own ceiling, judged from the row’s size', () => {
    expect(kindOfAttachment(row('application/pdf', 'a.pdf', READ_CAPS.pdf))).toEqual({ ok: true, kind: 'pdf' });
    expect(kindOfAttachment(row('application/pdf', 'a.pdf', READ_CAPS.pdf + 1))).toEqual({ ok: false, error: 'read_too_large' });
    expect(kindOfAttachment(row('image/jpeg', 'a.jpg', READ_CAPS.image + 1))).toEqual({ ok: false, error: 'read_too_large' });
    expect(kindOfAttachment(row(XLSX, 'a.xlsx', READ_CAPS.sheet + 1))).toEqual({ ok: false, error: 'read_too_large' });
    expect(READ_CAPS).toEqual({ sheet: 15 * MB, pdf: 10 * MB, image: 15 * MB });
  });
});

describe('a spreadsheet as the text the model reads', () => {
  it('[sheet name], one line per row, cells joined by « | » — and every cell stays in its COLUMN', () => {
    const out = sheetsToText([
      sheet([
        ['Name', 'Qty', 'CTNS', 'N.W.', 'G.W.', null],
        ['Клавиатура', 500, 50, null, 600, null],
        [null, null, null, null, null, null],
        ['Мышь', 1000, 50, 380, 400, null],
      ]),
    ]);
    expect(out.text).toBe(
      ['[Packing]', 'Name | Qty | CTNS | N.W. | G.W.', 'Клавиатура | 500 | 50 |  | 600', 'Мышь | 1000 | 50 | 380 | 400'].join('\n'),
    );
    expect(out).toMatchObject({ rows: 3, rowsCut: false, cellsCut: false });
  });

  it('a column that holds nothing is dropped from every line; a row’s trailing empties are dropped', () => {
    const out = sheetsToText([sheet([[null, 'Name', null, 'Qty', null], [null, 'Мышь', null, null, null], [null, 'Коврик', null, 3, null]])]);
    expect(out.text).toBe('[Packing]\nName | Qty\nМышь\nКоврик | 3');
  });

  it('a formula’s float is printed at twelve significant digits; a whole number keeps every digit', () => {
    const out = sheetsToText([sheet([['Вес', 37.800000000000004, 0.1 + 0.2, 6901234567893, 2.5]])]);
    expect(out.text).toBe('[Packing]\nВес | 37.8 | 0.3 | 6901234567893 | 2.5');
  });

  it('a cell’s own line breaks are « / », and a « | » inside a cell is never a column', () => {
    const out = sheetsToText([sheet([['Стол 5 шт\r\n  Стул 3 шт', 'A|B', '  много   пробелов  ']])]);
    expect(out.text).toBe('[Packing]\nСтол 5 шт / Стул 3 шт | A/B | много пробелов');
  });

  it('a cell is cut at 300 characters and that is SAID as cells cut, not rows', () => {
    const out = sheetsToText([sheet([['я'.repeat(1000), 5]])]);
    const [, line] = out.text.split('\n');
    expect(line).toBe(`${'я'.repeat(300)} | 5`);
    expect(out).toMatchObject({ rows: 1, rowsCut: false, cellsCut: true });
    // Never half a surrogate pair at the cut.
    const emoji = sheetsToText([sheet([[`${'a'.repeat(299)}📦📦`]])]).text.split('\n')[1]!;
    expect(emoji).toBe('a'.repeat(299));
  });

  it('ONE budget for the whole file, cut on WHOLE lines — never a string built and sliced', () => {
    const rows: SheetRows['rows'] = Array.from({ length: 300 }, (_, i) => [`Товар ${i} ${'x'.repeat(80)}`, i + 1, 'END']);
    const out = sheetsToText([sheet(rows, { name: 'One' }), sheet(rows, { name: 'Two' })]);
    expect(out.text.length).toBeLessThanOrEqual(SHEET_TEXT_BUDGET);
    expect(out.rowsCut).toBe(true);
    const lines = out.text.split('\n');
    // Every row that made it is whole: its last cell is there.
    for (const line of lines.slice(1)) expect(line.endsWith(' | END'), line).toBe(true);
    expect(out.rows).toBe(lines.length - 1);
    // …and the next row would not have fitted.
    expect(out.text.length + lines[1]!.length + 1).toBeGreaterThan(SHEET_TEXT_BUDGET);
    expect(out.text).not.toContain('[Two]');
  });

  it(`at most ${SHEET_TEXT_ROWS} rows, however short — the rest is said as cut`, () => {
    const rows: SheetRows['rows'] = Array.from({ length: 500 }, (_, i) => [i + 1]);
    const out = sheetsToText([sheet(rows)]);
    expect(out.rows).toBe(SHEET_TEXT_ROWS);
    expect(out.rowsCut).toBe(true);
    expect(out.text.split('\n').at(-1)).toBe(String(SHEET_TEXT_ROWS));
    // Exactly the cap is not a cut.
    expect(sheetsToText([sheet(rows.slice(0, SHEET_TEXT_ROWS))]).rowsCut).toBe(false);
  });

  it('one row of a hundred long cells is cut in whole cells — it does not swallow the budget', () => {
    const wide: SheetRows['rows'] = [Array.from({ length: 100 }, (_, i) => `c${i} ${'y'.repeat(200)}`), ['next', 1]];
    const out = sheetsToText([sheet(wide)]);
    const lines = out.text.split('\n');
    expect(lines[1]!.length).toBeLessThanOrEqual(2000);
    expect(lines[1]!.endsWith('y')).toBe(true);
    expect(lines[2]).toBe('next | 1');
    expect(out).toMatchObject({ rows: 2, cellsCut: true, rowsCut: false });
  });

  it('only VISIBLE sheets — a hidden one is read when no visible sheet holds a cell', () => {
    const order = sheet([['Заказ', 20]], { name: 'Order' });
    const hidden = sheet([['Справочник', 300]], { name: 'Prices', hidden: true });
    const blank = sheet([[null, '  ']], { name: 'Sheet1' });
    expect(sheetsToText([hidden, order]).text).toBe('[Order]\nЗаказ | 20');
    expect(sheetsToText([blank, hidden]).text).toBe('[Prices]\nСправочник | 300');
    expect(sheetsToText([blank])).toEqual({ text: '', rows: 0, rowsCut: false, cellsCut: false });
  });

  it('what a reader’s own bound left out is said too', () => {
    expect(sheetsToText([sheet([['a']], { rowsLeftOut: true })]).rowsCut).toBe(true);
    expect(sheetsToText([sheet([['a']], { colsLeftOut: true })]).cellsCut).toBe(true);
  });
});

describe('real files, through the readers the adapter imports', () => {
  it('an .xlsx: a formula result is its 12-digit figure, a merged cell is marked, a hidden sheet stays out', async () => {
    const body = await workbook((wb) => {
      const ws = wb.addWorksheet('Packing list');
      ws.addRow(['Наименование', 'Кол-во', 'Мест', 'Брутто']);
      ws.addRow(['Клавиатура', 500, 50, { formula: 'B2*0.0756', result: 37.800000000000004 }]);
      ws.addRow(['Мышь', 1000, 50, null]);
      ws.addRow(['Коврик', 200, 10, 12.5]);
      // One gross weight for the keyboard AND the mouse.
      ws.mergeCells('D2:D3');
      const prices = wb.addWorksheet('Справочник');
      prices.state = 'hidden';
      prices.addRow(['Секретная цена', 999]);
    });
    const out = await prepareFile('sheet', body, { contentType: XLSX });
    expect(out.ok).toBe(true);
    if (!out.ok || out.file.kind !== 'sheet') return;
    expect(out.file.text).toBe(
      [
        '[Packing list]',
        'Наименование | Кол-во | Мест | Брутто',
        'Клавиатура | 500 | 50 | 37.8',
        `Мышь | 1000 | 50 | ${MERGED_MARK}`,
        'Коврик | 200 | 10 | 12.5',
      ].join('\n'),
    );
    expect(out.file).toMatchObject({ rows: 4, rowsCut: false, cellsCut: false });
  });

  it('a CSV saved by Excel on a Russian Windows (cp1251) is decoded, not a row of «�»', async () => {
    // «Наименование;Кол-во;Мест» / «Клавиатура;500;50» / «Мышь;1000;50» in windows-1251.
    const cp1251 = (text: string) =>
      Buffer.from(
        [...text].map((ch) => {
          const code = ch.codePointAt(0)!;
          if (code < 0x80) return code;
          if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
          throw new Error(`no cp1251 byte for ${ch}`);
        }),
      );
    const body = cp1251('Наименование;Кол-во;Мест\r\nКлавиатура;500;50\r\nМышь;1000;50\r\n');
    // The premise: read as UTF-8 these bytes are not the words.
    expect(body.toString('utf8')).not.toContain('Клавиатура');
    const out = await prepareFile('sheet', body, { contentType: 'text/csv' });
    expect(out.ok && out.file.kind === 'sheet' && out.file.text).toBe(
      '[CSV]\nНаименование | Кол-во | Мест\nКлавиатура | 500 | 50\nМышь | 1000 | 50',
    );
  });

  it('a real Excel 97 workbook (the OLE signature decides, not the name)', async () => {
    const body = readFileSync(path.join(__dirname, '..', 'fixtures', 'invoice-97.xls'));
    const out = await prepareFile('sheet', body, { contentType: 'application/vnd.ms-excel' });
    expect(out.ok).toBe(true);
    if (!out.ok || out.file.kind !== 'sheet') return;
    expect(out.file.text.startsWith('[Invoice]\nCOMMERCIAL INVOICE / 商业发票\n№ | Item No. | Наименование товара')).toBe(true);
    // A line of the first sheet with its figures in their columns, and one
    // whose last column (the code) is empty.
    expect(out.file.text).toContain('\n1 | YW-2300 | Куртка женская 0 модель-1000 | 10 | 12.5 | 0 | 20 | 6201930000\n');
    expect(out.file.text).toContain('\n3 | YW-2302 | Кроссовки мужские 2 жж中中 модель-1002 | 12 | 13 | 0.25 | 24\n');
    // Both sheets, the second under its own name — 155 rows fit the budget whole.
    expect(out.file.text.endsWith('\n\n[Packing]\nТовар | Мест | Брутто\nМасло | 3 | 240')).toBe(true);
    expect(out.file.text.length).toBeLessThanOrEqual(SHEET_TEXT_BUDGET);
    expect(out.file).toMatchObject({ rows: 155, rowsCut: false });
  });

  it('a workbook with no cell, a zip that is no workbook, a broken old file and a PDF under a sheet’s type each have their word', async () => {
    const empty = await workbook((wb) => void wb.addWorksheet('Sheet1'));
    expect(await prepareFile('sheet', empty, { contentType: XLSX })).toEqual({ ok: false, error: 'read_empty' });
    expect(await prepareFile('sheet', Buffer.from('PK\u0003\u0004 not a workbook at all'), { contentType: XLSX })).toEqual({
      ok: false,
      error: 'read_broken',
    });
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
    expect(await prepareFile('sheet', ole, { contentType: 'application/vnd.ms-excel' })).toEqual({ ok: false, error: 'read_broken' });
    expect(await prepareFile('sheet', Buffer.from('%PDF-1.4\n1 0 obj\n'), { contentType: 'text/csv' })).toEqual({
      ok: false,
      error: 'read_unsupported',
    });
    expect(await prepareFile('sheet', Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]), { contentType: 'text/plain' })).toEqual({
      ok: false,
      error: 'read_unsupported',
    });
  });

  it('a PDF is handed over whole — and bytes that are no PDF are not', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    expect(await prepareFile('pdf', pdf, { contentType: 'application/pdf' })).toEqual({ ok: true, file: { kind: 'pdf', data: pdf } });
    expect(await prepareFile('pdf', Buffer.from('PK\u0003\u0004'), { contentType: 'application/pdf' })).toEqual({
      ok: false,
      error: 'read_unsupported',
    });
    expect(await prepareFile('pdf', Buffer.alloc(READ_CAPS.pdf + 1, 0x20), { contentType: 'application/pdf' })).toEqual({
      ok: false,
      error: 'read_too_large',
    });
  });

  it('a photograph is reduced to fit 2000 × 2000 as a JPEG; one that cannot be opened is broken, or a kind with no codec', async () => {
    const png = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: { r: 250, g: 250, b: 250 } } })
      .png()
      .toBuffer();
    const out = await prepareFile('image', png, { contentType: 'image/png' });
    expect(out.ok).toBe(true);
    if (!out.ok || out.file.kind !== 'image') return;
    const meta = await sharp(out.file.data).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 2000, 1000]);
    // A small picture is not enlarged.
    const small = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const kept = await prepareFile('image', small, { contentType: 'image/jpeg' });
    expect(kept.ok && kept.file.kind === 'image' && (await sharp(kept.file.data).metadata()).width).toBe(300);
    const junk = Buffer.from('this is not a picture');
    expect(await prepareFile('image', junk, { contentType: 'image/jpeg' })).toEqual({ ok: false, error: 'read_broken' });
    expect(await prepareFile('image', junk, { contentType: 'image/heic' })).toEqual({ ok: false, error: 'read_unsupported' });
  });
});

describe('a workbook is weighed before it is opened', () => {
  /** A zip that is only its directory: the entries’ names and the sizes the directory states. */
  function directory(entries: { name: string; size: number }[]): Buffer {
    const parts = entries.map(({ name, size }) => {
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt32LE(size >>> 0, 24);
      head.writeUInt16LE(Buffer.byteLength(name), 28);
      return Buffer.concat([head, Buffer.from(name)]);
    });
    const dir = Buffer.concat(parts);
    const local = Buffer.from('PK\u0003\u0004');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(local.length, 16);
    return Buffer.concat([local, dir, end]);
  }

  it('the directory’s own sizes of the cell XML are summed — the pictures are not counted', async () => {
    const body = directory([
      { name: 'xl/worksheets/sheet1.xml', size: 1000 },
      { name: 'xl/worksheets/sheet2.xml', size: 2000 },
      { name: 'xl/sharedStrings.xml', size: 300 },
      { name: 'xl/media/image1.png', size: 9 * MB },
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', size: 77 },
    ]);
    expect(xlsxCellBytes(body)).toBe(3300);
    // …and a real workbook's directory is read the same way.
    const real = await workbook((wb) => wb.addWorksheet('S').addRow(['a', 1]));
    expect(xlsxCellBytes(real)).toBeGreaterThan(100);
    expect(xlsxCellBytes(real)).toBeLessThan(real.length * 20);
    expect(xlsxCellBytes(Buffer.from('not a zip'))).toBeNull();
  });

  it('cell XML past the ceiling is refused «too large» from the directory alone — the workbook is never built', async () => {
    const heavy = directory([{ name: 'xl/worksheets/sheet1.xml', size: XLSX_CELL_XML_MAX + 1 }]);
    expect(await prepareFile('sheet', heavy, { contentType: XLSX })).toEqual({ ok: false, error: 'read_too_large' });
    // The same directory under the ceiling is merely not a workbook.
    const light = directory([{ name: 'xl/worksheets/sheet1.xml', size: XLSX_CELL_XML_MAX }]);
    expect(await prepareFile('sheet', light, { contentType: XLSX })).toEqual({ ok: false, error: 'read_broken' });
    // A zip64 directory states no size this code can trust.
    expect(xlsxCellBytes(directory([{ name: 'xl/worksheets/sheet1.xml', size: 0xffffffff }]))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('what the T1 review found at the file’s door', () => {
  const row = (contentType: string, fileName: string, sizeBytes = 1000) => ({ contentType, fileName, sizeBytes });

  it('a macro-enabled workbook (.xlsm) is an Excel file — never «upload an Excel instead» (A4)', async () => {
    const XLSM = 'application/vnd.ms-excel.sheet.macroEnabled.12';
    expect(kindOfAttachment(row(XLSM, 'packing.xlsm'))).toEqual({ ok: true, kind: 'sheet' });
    expect(kindOfAttachment(row('application/octet-stream', 'PACKING.XLSM'))).toEqual({ ok: true, kind: 'sheet' });
    // …and it is read: the container is the same zip of the same sheets.
    const body = await workbook((wb) => {
      wb.addWorksheet('Packing').addRows([
        ['Name', 'Qty'],
        ['Мышь', 500],
      ]);
    });
    const out = await prepareFile('sheet', body, { contentType: XLSM });
    expect(out.ok && out.file.kind === 'sheet' && out.file.text).toContain('Мышь | 500');
  });

  it('a transparent PNG is flattened onto WHITE — dark text on a black page is a paid reading of nothing (A5)', async () => {
    // What `convert file.pdf file.png` and «save as picture» write: an alpha channel, the page see-through.
    const png = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    const out = await prepareFile('image', png, { contentType: 'image/png' });
    expect(out.ok).toBe(true);
    if (!out.ok || out.file.kind !== 'image') throw new Error('not an image');
    const { data } = await sharp(out.file.data).raw().toBuffer({ resolveWithObject: true });
    // Every pixel of the see-through page is white (JPEG noise aside), not black.
    expect(Math.min(...data)).toBeGreaterThan(240);
  });

  it('a text packing list that BEGINS with «PK» — «PKG NO.», «PKGS» — is a table, not a broken workbook (A6)', async () => {
    const csv = Buffer.from('PKG NO.,Description,Qty\n1-50,Keyboard,500\n', 'utf8');
    const out = await prepareFile('sheet', csv, { contentType: 'text/csv' });
    expect(out.ok && out.file.kind === 'sheet' && out.file.text).toContain('PKG NO. | Description | Qty');
    // A real workbook still opens as one, and a zip that is no workbook is still «broken».
    const zipOfNothing = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);
    expect(await prepareFile('sheet', zipOfNothing, { contentType: XLSX })).toEqual({ ok: false, error: 'read_broken' });
  });

  it('a text file is weighed before it is split into a million lines (A9)', async () => {
    const huge = Buffer.from('a,b\n'.repeat(600_000), 'utf8'); // 2.4 MB of two-cell rows
    expect(huge.length).toBeGreaterThan(2 * MB);
    expect(await prepareFile('sheet', huge, { contentType: 'text/csv' })).toEqual({ ok: false, error: 'read_too_large' });
    // An ordinary CSV of a few thousand rows is far under it.
    const usual = Buffer.from(`name,qty\n${'Клавиатура проводная,500\n'.repeat(5_000)}`, 'utf8');
    expect((await prepareFile('sheet', usual, { contentType: 'text/csv' })).ok).toBe(true);
  });

  it('a cell the workbook reader THROWS on is a code, never an unanswerable «try again» (A10)', async () => {
    // A number under a date format that is no date — a 13-digit barcode in a date column, «#####» in
    // Excel: exceljs hands back an Invalid Date and the shared reader's `toISOString()` throws.
    const body = await workbook((wb) => {
      const ws = wb.addWorksheet('Packing');
      ws.addRows([
        ['Name', 'Barcode'],
        ['Мышь', 4_607_004_891_694],
      ]);
      ws.getCell('B2').numFmt = 'dd.mm.yyyy';
    });
    const out = await prepareFile('sheet', body, { contentType: XLSX });
    // Either it is read (the reader learned the cell) or it is «broken» in words — never a throw.
    if (!out.ok) expect(out.error).toBe('read_broken');
  });
});
