import ExcelJS from 'exceljs';
import { parseGoods, type Cell, type GoodsRow } from './goods-import';
import {
  MAX_COLS,
  MAX_ROWS,
  htmlTableSheets,
  isCompoundFile,
  readXls,
  spreadsheetMlSheets,
  type SheetRows,
} from './xls';

/**
 * A spreadsheet the customer sent, read into rows.
 *
 * Extracted so the deal's «Позиции» import route and the staff bot's invoice
 * reader share one reader as well as one parser (#513). What differs between
 * the two callers is what they do with the rows; how an XLSX becomes rows is
 * not a decision either of them should be making for itself.
 *
 * Content decides, never the file name (#284's rule): a `.xlsx` that is not a
 * workbook and a workbook called `list.txt` both reach this, and only the
 * load says which is which.
 */
function cellValue(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('result' in value) return cellValue(value.result as ExcelJS.CellValue);
    if ('text' in value) return String(value.text);
  }
  return String(value);
}

export async function workbookRows(body: ArrayBuffer | Buffer): Promise<Cell[][] | null> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(body as ArrayBuffer);
  } catch {
    return null;
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return null;
  const rows: Cell[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values: Cell[] = [];
    // row.values is 1-based with a hole at 0.
    for (let c = 1; c <= row.cellCount; c += 1) values.push(cellValue(row.getCell(c).value));
    rows.push(values);
  });
  return rows;
}

/**
 * A comma- or semicolon-separated list, read into the same rows.
 *
 * Deliberately small: the delimiter is whichever of `;` `,` or a tab the
 * FIRST line carries most of, quotes are honoured, and nothing else is
 * attempted. A CSV that needs more than this is a file the seller should send
 * as a workbook — and `parseGoods` still refuses a sheet it cannot find goods
 * in, so a mis-split file is a refusal, not a wrong invoice.
 */
export function csvRows(text: string): Cell[][] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const first = lines[0]!;
  const delim = [';', '\t', ','].reduce((best, d) =>
    first.split(d).length > first.split(best).length ? d : best,
  );
  return lines.map((line) => splitCsvLine(line, delim));
}

function splitCsvLine(line: string, delim: string): Cell[] {
  const out: Cell[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delim) {
      out.push(cell.trim() || null);
      cell = '';
    } else cell += ch;
  }
  out.push(cell.trim() || null);
  return out;
}

/**
 * Every worksheet of an XLSX, read into rows (his 1.2: the goods were on the
 * SECOND sheet as often as the first, and only `worksheets[0]` was opened).
 */
export async function workbookSheets(body: ArrayBuffer | Buffer): Promise<SheetRows[] | null> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(body as ArrayBuffer);
  } catch {
    return null;
  }
  const sheets: SheetRows[] = [];
  for (const sheet of workbook.worksheets) {
    const rows: Cell[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row) => {
      if (rows.length >= MAX_ROWS) return;
      const values: Cell[] = [];
      for (let c = 1; c <= Math.min(row.cellCount, MAX_COLS); c += 1) values.push(cellValue(row.getCell(c).value));
      rows.push(values);
    });
    sheets.push({ name: sheet.name, rows });
  }
  return sheets;
}

/**
 * Bytes of a text file, decoded the way the sender's machine wrote them.
 *
 * A CSV from Excel on a Russian Windows is cp1251 and one from a Chinese
 * office is GBK; read as UTF-8 both are a row of «�» that `parseGoods` then
 * calls «no goods». A byte-order mark decides first; then strict UTF-8; then
 * strict GBK (Russian cp1251 text almost never survives a strict GBK decode —
 * a letter before a space is an invalid pair); cp1251 last, which decodes
 * anything.
 */
export function decodeText(body: Buffer): string {
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    return body.subarray(3).toString('utf8');
  }
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return new TextDecoder('utf-16le').decode(body.subarray(2));
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return new TextDecoder('utf-16be').decode(body.subarray(2));
  for (const encoding of ['utf-8', 'gbk']) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(body);
    } catch {
      // next
    }
  }
  return new TextDecoder('windows-1251').decode(body);
}

/** What the bot learns from a spreadsheet the seller forwarded. */
export type GoodsFileRead =
  /**
   * The reader found a header and read the goods exactly — from ONE sheet,
   * the one with the most lines. An «Invoice» sheet and a «Packing list»
   * sheet in one workbook usually list the SAME goods, and adding them would
   * double the order. The other sheets go to the model as `text` (their
   * gross weights and volumes are the shipment's totals).
   */
  | { kind: 'goods'; goods: GoodsRow[]; sheet: string; sheets: number; text: string }
  /** A table with no header the reader knows — handed to the model as text. */
  | { kind: 'text'; text: string; sheets: number }
  /** A spreadsheet that cannot be read, and why — said to the seller. */
  | { kind: 'refused'; reason: 'old_format' | 'encrypted' | 'broken' | 'empty' };

/** A table as text for the model: one line per row, cells joined by « | ». */
function sheetAsText(sheet: SheetRows): string {
  const lines = sheet.rows
    .map((row) => row.map((cell) => (cell === null ? '' : String(cell).trim())).filter(Boolean).join(' | '))
    .filter(Boolean);
  return lines.length ? `[${sheet.name}]\n${lines.join('\n')}` : '';
}

/**
 * The one door the bot uses: bytes in, what it found out (his 1.2 b, 1.3 b).
 *
 * The shape is decided by CONTENT, never the file name (#284's rule): `PK` is
 * an XLSX, the OLE signature an Excel 97 workbook, and text is an HTML table,
 * an Excel 2003 XML sheet or a CSV, in that order. Null = not a spreadsheet at
 * all (a PDF, a picture) — the caller has other doors for those.
 *
 * Every sheet is read. The sheet whose header the reader FINDS answers with
 * its rows, exactly — no model, no tokens. A sheet with no recognisable header no
 * longer becomes «every row's first text cell is a product» (the seller's
 * company name, the address and «Invoice No» became goods and overruled the
 * model's reading); it goes to the model as text, which can read a table it
 * has never seen.
 */
export async function readGoodsFile(body: Buffer, contentType: string | null): Promise<GoodsFileRead | null> {
  let sheets: SheetRows[] | null = null;
  if (body.length > 1 && body[0] === 0x50 && body[1] === 0x4b) {
    sheets = await workbookSheets(body);
    if (!sheets) return { kind: 'refused', reason: 'broken' };
  } else if (isCompoundFile(body)) {
    const xls = readXls(body);
    if (!xls.ok) return { kind: 'refused', reason: xls.reason };
    sheets = xls.sheets;
  } else if (looksTextual(body, contentType)) {
    const text = decodeText(body);
    sheets = spreadsheetMlSheets(text) ?? htmlTableSheets(text) ?? [{ name: 'CSV', rows: csvRows(text) }];
  } else {
    return null;
  }

  let best: { sheet: SheetRows; goods: GoodsRow[] } | null = null;
  const filled = sheets.filter((sheet) =>
    sheet.rows.some((row) => row.some((cell) => cell !== null && String(cell).trim() !== '')),
  );
  for (const sheet of filled) {
    const parsed = parseGoods(sheet.rows);
    if (parsed.headerRow !== null && parsed.goods.length > (best?.goods.length ?? 0)) {
      best = { sheet, goods: parsed.goods };
    }
  }
  const others = filled
    .filter((sheet) => sheet !== best?.sheet)
    .map(sheetAsText)
    .filter(Boolean)
    .join('\n\n');
  if (best) {
    return { kind: 'goods', goods: best.goods, sheet: best.sheet.name, sheets: filled.length, text: others };
  }
  if (others) return { kind: 'text', text: others, sheets: filled.length };
  return { kind: 'refused', reason: 'empty' };
}

function looksTextual(body: Buffer, contentType: string | null): boolean {
  if (contentType && /^(text\/|application\/csv)/i.test(contentType)) return true;
  // A UTF-16 file carries NUL bytes by construction; its mark says so.
  if (body.length >= 2 && ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff))) return true;
  // A short sniff: a NUL byte in the first kilobyte means binary, and a
  // binary file read as text is a row of mojibake, not a refusal.
  const head = body.subarray(0, 1024);
  return !head.includes(0);
}
