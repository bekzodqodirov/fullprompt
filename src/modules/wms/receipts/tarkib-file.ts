import { csvRows, decodeText, workbookSheets } from '../deals/goods-file';
import {
  htmlTableSheets,
  isCompoundFile,
  markupOf,
  MAX_MARKUP_CHARS,
  readXls,
  spreadsheetMlSheets,
  type SheetRows,
} from '../deals/xls';

/**
 * «🤖 Fayldan to'ldirish» — the client's document as the MODEL is given it
 * (docs/TARKIB-TAKLIFLAR.md §3). One reader for every kind of file: a PDF is
 * handed over whole, a photograph reduced, and a spreadsheet is written out
 * as text — the model reads all three, so there is one answer to «does a
 * reading count», one prompt and one failure vocabulary.
 *
 * THE ONE ADAPTER over the spreadsheet readers. Another round is rewriting
 * the goods PARSER (`parseGoods`, `detectColumns`, `readGoodsFile`), so this
 * file imports none of it — only the low-level «bytes → rows» exports
 * (`workbookSheets`, `readXls`, the two markup readers, `csvRows`,
 * `decodeText`) — and it is the only file of this feature that imports them:
 * whoever merges that rewrite has one place to look.
 *
 * Every answer is bounded, as those readers are: the kind and the size are
 * decided from the attachment's ROW before a byte leaves storage (a 60 MB
 * video must never be loaded to learn that it is a video), the text is built
 * under one budget and never sliced afterwards, and a workbook whose cell XML
 * would not fit in memory is refused from the zip's own directory.
 */

export type FileKind = 'sheet' | 'pdf' | 'image';

export type FileRefusal =
  | 'read_unsupported'
  | 'read_too_large'
  | 'read_broken'
  | 'read_old_format'
  | 'read_encrypted'
  | 'read_empty';

const MB = 1024 * 1024;

/**
 * The largest file of each kind that is read at all. A PDF past 10 MB is
 * refused by the provider anyway; a photograph is the upload's own ceiling;
 * a spreadsheet is bounded twice — here, and by `XLSX_CELL_XML_MAX` below.
 */
export const READ_CAPS: Readonly<Record<FileKind, number>> = { sheet: 15 * MB, pdf: 10 * MB, image: 15 * MB };

/** What the reduced photograph may weigh: the provider refuses an image past ~5 MB. */
const IMAGE_OUT_MAX = 4_500_000;
/** The photograph the model looks at: inside 2000 × 2000, so a packing list's small print survives. */
const IMAGE_PX = 2000;

const SHEET_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
  'text/plain',
]);
const SHEET_EXTENSIONS = new Set(['xlsx', 'xls', 'csv', 'txt']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
/** A type that says nothing — the extension answers instead (the upload's own fallback). */
const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * What kind of file an attachment is and whether it is small enough —
 * from its ROW alone, before storage is asked for a byte. A video, an
 * archive, a Word file: refused here, unread.
 */
export function kindOfAttachment(row: {
  contentType: string;
  fileName: string;
  sizeBytes: number;
}): { ok: true; kind: FileKind } | { ok: false; error: 'read_unsupported' | 'read_too_large' } {
  const type = (row.contentType.split(';')[0] ?? '').trim().toLowerCase();
  const ext = row.fileName.includes('.') ? (row.fileName.split('.').pop() ?? '').toLowerCase() : '';
  const generic = GENERIC_TYPES.has(type);
  let kind: FileKind | null = null;
  if (type === 'application/pdf' || (generic && ext === 'pdf')) kind = 'pdf';
  else if (type.startsWith('image/') || (generic && IMAGE_EXTENSIONS.has(ext))) kind = 'image';
  else if (SHEET_TYPES.has(type) || (generic && SHEET_EXTENSIONS.has(ext))) kind = 'sheet';
  if (kind === null) return { ok: false, error: 'read_unsupported' };
  if (row.sizeBytes > READ_CAPS[kind]) return { ok: false, error: 'read_too_large' };
  return { ok: true, kind };
}

/** What the model is handed, ready to send. */
export type PreparedFile =
  | { kind: 'sheet'; text: string; rows: number; rowsCut: boolean; cellsCut: boolean }
  | { kind: 'pdf'; data: Buffer }
  | { kind: 'image'; data: Buffer };

type Cell = SheetRows['rows'][number][number];

/** One budget for the whole file — every sheet's text together. */
export const SHEET_TEXT_BUDGET = 15_000;
/** …and no more rows than this, however short they are. */
export const SHEET_TEXT_ROWS = 400;
/** A cell is cut where a description is cut everywhere else here. */
const CELL_CHARS = 300;
/** One row's line, in whole cells — or a row of a hundred long cells would never fit the budget at all. */
const LINE_CHARS = 2_000;
/**
 * A cell merged with the one above it. The readers repeat the master's
 * value into every position a merge DOWN covers and say which positions
 * those are; written out, a carton's weight merged over three goods would be
 * three weights. The mark says what the sheet says — «this cell belongs to
 * the one above» — and the prompt says what to do about it per column: a
 * merged name or code is every line's, a merged figure is the group's.
 */
export const MERGED_MARK = '↑';

function cellText(cell: Cell): { text: string; cut: boolean } {
  if (cell === null || cell === undefined) return { text: '', cut: false };
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) return { text: '', cut: false };
    // A formula's result is a binary float: 0.1 + 0.2 prints 0.30000000000000004.
    // Twelve significant digits is its shortest honest spelling. A whole
    // number is exact already — and a 13-digit barcode must not lose its tail.
    return { text: String(Number.isInteger(cell) ? cell : Number(cell.toPrecision(12))), cut: false };
  }
  const raw = String(cell);
  // Only the head of a long cell is ever looked at: a cell is never the
  // length of the text it lands in (one 30,000-character shared string).
  const head = raw.slice(0, CELL_CHARS * 4);
  const flat = head
    .trim()
    .replace(/\s*[\r\n]+\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    // The column separator belongs to the row, never to a cell.
    .replace(/\|/g, '/');
  let kept = flat.slice(0, CELL_CHARS);
  // Never half a surrogate pair.
  if (kept.length < flat.length && /[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return { text: kept, cut: kept.length < flat.length || /\S/.test(raw.slice(head.length)) };
}

const hasText = (cell: Cell): boolean => cell !== null && cell !== undefined && String(cell).trim() !== '';

/**
 * The columns that hold anything among the rows that can still be written —
 * the rest are dropped from EVERY line of the sheet, so a template's thirty
 * empty columns cost nothing and the columns that stay still line up.
 */
function usedColumns(sheet: SheetRows, limit: number): number[] {
  const used = new Set<number>();
  let seen = 0;
  for (const row of sheet.rows) {
    let any = false;
    row.forEach((cell, c) => {
      if (!hasText(cell)) return;
      used.add(c);
      any = true;
    });
    if (any && (seen += 1) >= limit) break;
  }
  return [...used].sort((a, b) => a - b);
}

/**
 * One row as one line. The cells keep their COLUMNS: an empty cell is an
 * empty place between two separators, never skipped — skipped, a row with no
 * net weight reads «name | 500 | 50 | 600» under a header of five columns and
 * the gross lands in the net's place, which is the one mistake a transcriber
 * of figures must not be handed. Trailing empties are dropped.
 */
function rowLine(row: Cell[], r: number, cols: readonly number[], covered: SheetRows['covered']): { line: string; cut: boolean } {
  const cells: string[] = [];
  let cut = false;
  let last = -1;
  let own = false;
  cols.forEach((c, i) => {
    const value = c < row.length ? row[c] : null;
    let text = '';
    if (hasText(value ?? null) && covered?.has(r, c)) {
      text = MERGED_MARK;
    } else {
      const read = cellText(value ?? null);
      text = read.text;
      if (read.cut) cut = true;
      if (text !== '') own = true;
    }
    cells.push(text);
    if (text !== '') last = i;
  });
  // A row of nothing but merge marks says nothing of its own.
  if (last === -1 || !own) return { line: '', cut: false };
  let line = '';
  for (let i = 0; i <= last; i += 1) {
    const piece = i === 0 ? cells[i]! : ` | ${cells[i]!}`;
    if (line.length + piece.length > LINE_CHARS) {
      cut = true;
      break;
    }
    line += piece;
  }
  return { line, cut };
}

/**
 * Sheets as the text the model reads: `[sheet name]`, then one line per row,
 * cells joined by « | », a cell's own line breaks as « / ».
 *
 * Built under ONE budget for the whole file and stopped where it runs out —
 * never joined first and sliced after (that join was once a 510-million-
 * character string) — and cut on WHOLE lines only: half a row would reach the
 * model as a product. `rowsCut` = a row is missing (the budget, the row
 * count, or the reader's own bound), which the proposal says out loud;
 * `cellsCut` = every row is there but a cell was shortened.
 *
 * Only VISIBLE sheets, unless none of them holds a cell: a hidden price list
 * behind an order form's drop-downs is not the order. Emptiness is judged
 * first, visibility among what has cells.
 */
export function sheetsToText(all: readonly SheetRows[]): { text: string; rows: number; rowsCut: boolean; cellsCut: boolean } {
  const filled = all.filter((sheet) => sheet.rows.some((row) => row.some(hasText)));
  const shown = filled.filter((sheet) => !sheet.hidden);
  const sheets = shown.length > 0 ? shown : filled;
  let text = '';
  let rows = 0;
  let rowsCut = sheets.some((sheet) => sheet.rowsLeftOut === true);
  let cellsCut = sheets.some((sheet) => sheet.colsLeftOut === true);
  each: for (const sheet of sheets) {
    const cols = usedColumns(sheet, SHEET_TEXT_ROWS - rows + 1);
    const name = sheet.name.replace(/[\s[\]]+/g, ' ').trim().slice(0, 100);
    let opened = false;
    for (const [r, row] of sheet.rows.entries()) {
      const read = rowLine(row, r, cols, sheet.covered);
      if (read.line === '') continue;
      if (rows >= SHEET_TEXT_ROWS) {
        rowsCut = true;
        break each;
      }
      const head = opened ? '\n' : `${text ? '\n\n' : ''}[${name}]\n`;
      if (text.length + head.length + read.line.length > SHEET_TEXT_BUDGET) {
        rowsCut = true;
        break each;
      }
      text += head + read.line;
      opened = true;
      rows += 1;
      if (read.cut) cellsCut = true;
    }
  }
  return { text, rows, rowsCut, cellsCut };
}

/**
 * The most cell XML a workbook may hold before it is opened: the worksheets
 * and the shared strings, UNCOMPRESSED. The workbook reader builds every cell
 * in memory before any bound of ours applies, in the one Node process every
 * screen shares — a fifteen-megabyte file of nothing but cells is a gigabyte
 * of them and half a minute during which nobody's page renders. A packing
 * list with photographs is large in its PICTURES, which this does not count.
 */
export const XLSX_CELL_XML_MAX = 40 * MB;

/**
 * Σ uncompressed bytes of an .xlsx's cell XML, read from the zip's central
 * directory — no entry is inflated to learn its size. `null` when the
 * directory cannot be found (not a zip this code understands: the workbook
 * reader decides); `Infinity` for a zip64 archive, which no packing list is.
 */
export function xlsxCellBytes(body: Buffer): number | null {
  const EOCD = 0x06054b50;
  const ENTRY = 0x02014b50;
  // The end record is the last 22 bytes, or sits before a comment of ≤ 65,535.
  let end = -1;
  for (let at = body.length - 22; at >= Math.max(0, body.length - 22 - 0xffff); at -= 1) {
    if (body.readUInt32LE(at) === EOCD) {
      end = at;
      break;
    }
  }
  if (end < 0) return null;
  const entries = body.readUInt16LE(end + 10);
  let at = body.readUInt32LE(end + 16);
  if (entries === 0xffff || at === 0xffffffff) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < entries; i += 1) {
    if (at + 46 > body.length || body.readUInt32LE(at) !== ENTRY) return null;
    const size = body.readUInt32LE(at + 24);
    const nameLength = body.readUInt16LE(at + 28);
    const name = body.toString('utf8', at + 46, Math.min(body.length, at + 46 + nameLength));
    if (/^xl\/(?:worksheets\/[^/]+\.xml|sharedStrings\.xml)$/i.test(name)) {
      if (size === 0xffffffff) return Number.POSITIVE_INFINITY;
      sum += size;
    }
    at += 46 + nameLength + body.readUInt16LE(at + 30) + body.readUInt16LE(at + 32);
  }
  return sum;
}

const isZip = (body: Buffer): boolean => body.length > 3 && body[0] === 0x50 && body[1] === 0x4b;
/** A PDF's signature may follow a little leading junk — the first kilobyte is looked at. */
const isPdf = (body: Buffer): boolean => body.subarray(0, 1024).includes('%PDF-');

/** Text, by content: a byte-order mark says so, and a NUL in the first kilobyte says binary. */
function looksTextual(body: Buffer): boolean {
  if (body.length >= 2 && ((body[0] === 0xff && body[1] === 0xfe) || (body[0] === 0xfe && body[1] === 0xff))) return true;
  return !body.subarray(0, 1024).includes(0);
}

/**
 * A spreadsheet's bytes → its sheets. The shape is decided by CONTENT, never
 * by the name (#284): `PK` is a workbook, the OLE signature an Excel 97 one,
 * and text is an HTML table, an Excel 2003 XML sheet or a CSV, in that order
 * — «.xls» is all three in practice.
 */
async function sheetsOf(body: Buffer): Promise<{ ok: true; sheets: SheetRows[] } | { ok: false; error: FileRefusal }> {
  if (isZip(body)) {
    const cells = xlsxCellBytes(body);
    if (cells !== null && cells > XLSX_CELL_XML_MAX) return { ok: false, error: 'read_too_large' };
    const sheets = await workbookSheets(body);
    return sheets ? { ok: true, sheets } : { ok: false, error: 'read_broken' };
  }
  if (isCompoundFile(body)) {
    const xls = readXls(body);
    if (xls.ok) return { ok: true, sheets: xls.sheets };
    const error = xls.reason === 'old_format' ? 'read_old_format' : xls.reason === 'encrypted' ? 'read_encrypted' : 'read_broken';
    return { ok: false, error };
  }
  // A PDF or a picture stored under a spreadsheet's type is not a table.
  if (isPdf(body) || !looksTextual(body)) return { ok: false, error: 'read_unsupported' };
  const text = decodeText(body);
  if (markupOf(text) !== null && text.length > MAX_MARKUP_CHARS) return { ok: false, error: 'read_broken' };
  return { ok: true, sheets: spreadsheetMlSheets(text) ?? htmlTableSheets(text) ?? [{ name: 'CSV', rows: csvRows(text) }] };
}

/**
 * The photograph the model looks at: turned by its EXIF, inside 2000 × 2000,
 * JPEG. `sharp` decides by content what it can decode — a JPEG, a PNG, a
 * WebP always; an HEIC only where the build carries the codec, which the
 * shipped one does not. Lazily imported, as everywhere here: a native module
 * must never be traced into the standalone bundle.
 */
async function reducePhoto(body: Buffer): Promise<Buffer | null> {
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(body)
      .rotate()
      .resize(IMAGE_PX, IMAGE_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return null;
  }
}

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * The loaded bytes → what the model is handed, or the refusal in a code.
 * The kind came from the row; the CONTENT confirms it here (a PDF's
 * signature, a picture `sharp` can decode, a table that is a table).
 */
export async function prepareFile(
  kind: FileKind,
  body: Buffer,
  row: { contentType: string },
): Promise<{ ok: true; file: PreparedFile } | { ok: false; error: FileRefusal }> {
  if (body.length > READ_CAPS[kind]) return { ok: false, error: 'read_too_large' };
  if (kind === 'pdf') {
    return isPdf(body) ? { ok: true, file: { kind: 'pdf', data: body } } : { ok: false, error: 'read_unsupported' };
  }
  if (kind === 'image') {
    const reduced = await reducePhoto(body);
    if (!reduced) {
      // A photograph of a kind this app stores as one and cannot open is
      // broken; anything else is a format the build has no codec for.
      const type = (row.contentType.split(';')[0] ?? '').trim().toLowerCase();
      return { ok: false, error: PHOTO_TYPES.has(type) ? 'read_broken' : 'read_unsupported' };
    }
    if (reduced.length > IMAGE_OUT_MAX) return { ok: false, error: 'read_too_large' };
    return { ok: true, file: { kind: 'image', data: reduced } };
  }
  const read = await sheetsOf(body);
  if (!read.ok) return read;
  const written = sheetsToText(read.sheets);
  if (written.rows === 0) return { ok: false, error: 'read_empty' };
  return { ok: true, file: { kind: 'sheet', ...written } };
}
