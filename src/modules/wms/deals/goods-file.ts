import ExcelJS from 'exceljs';
import { parseGoods, type Cell, type GoodsRow } from './goods-import';

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
 * The one door the bot uses: bytes in, goods out, `null` when the file is not
 * a goods list at all.
 *
 * The FIRST two bytes decide the shape — `PK` is a zip and therefore an
 * xlsx — and everything else is tried as text. A file that parses to no goods
 * answers null, so a random spreadsheet the seller forwarded does not become
 * an invoice.
 */
export async function goodsFromFile(
  body: Buffer,
  contentType: string | null,
): Promise<GoodsRow[] | null> {
  const isZip = body.length > 1 && body[0] === 0x50 && body[1] === 0x4b;
  const rows = isZip
    ? await workbookRows(body)
    : looksTextual(body, contentType)
      ? csvRows(body.toString('utf8'))
      : null;
  if (!rows || rows.length === 0) return null;
  const { goods } = parseGoods(rows);
  return goods.length > 0 ? goods : null;
}

function looksTextual(body: Buffer, contentType: string | null): boolean {
  if (contentType && /^(text\/|application\/csv)/i.test(contentType)) return true;
  // A short sniff: a NUL byte in the first kilobyte means binary, and a
  // binary file read as text is a row of mojibake, not a refusal.
  const head = body.subarray(0, 1024);
  return !head.includes(0);
}
