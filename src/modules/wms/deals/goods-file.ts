import ExcelJS from 'exceljs';
import { CoverMask, parseGoods, readsAsFigure, type Cell, type Covered, type GoodsRow } from './goods-import';
import {
  MAX_COLS,
  MAX_MARKUP_CHARS,
  MAX_ROWS,
  htmlTableSheets,
  isCompoundFile,
  markupOf,
  readXls,
  spreadsheetMlSheets,
  withCovered,
  withLeftOut,
  type SheetRows,
} from './xls';

/**
 * The most text a spreadsheet hands the model — per file, every sheet's text
 * together. The model reads the first 15,000 characters of the sheets'
 * text and no more, so a longer string was memory and nothing else: 41 KB
 * of XLSX whose cells all point at one 30,000-character shared string became
 * a 510-million-character text held for the intake's 30 minutes (the review;
 * three such forwards ended the process).
 */
export const SHEET_TEXT_BUDGET = 15_000;

/** A cell in that text is cut where `parseGoods` cuts a description. */
const CELL_TEXT_CHARS = 300;

/**
 * The longest one row's line may be in that text, in whole cells (S4, the
 * second review): the text is cut on whole LINES now, so one row of a hundred
 * long cells would otherwise not fit at all and leave the text empty.
 */
const LINE_TEXT_CHARS = 2_000;

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

/**
 * One worksheet read into rows, a merged region's covered cells included,
 * bounded like every other shape (`MAX_ROWS` × `MAX_COLS`).
 *
 * exceljs answers a covered cell with its master's value; one rule for every
 * format now (R3-S3, the third review): DOWN the master's own column the value
 * repeats and the position is `covered`, so `parseGoods` counts a merged
 * carton weight or line total once and reads a merged name, code or unit
 * price as every covered line's own; to the RIGHT of the master a covered
 * cell is null, so a title merged across the sheet is never a header of four
 * «Товарная накладная» cells (S11). The second round decided by what the TEXT
 * looked like and lost a merged HS code, a merged price and names such as
 * «LED 50W» — and ran a pattern over the master's text per covered cell
 * (R3-S7: 18.7 s measured for one 370 KB file). A master is read once
 * (`masters`): a rich-text master merged down five thousand rows is joined
 * once, not five thousand times — measured, four such columns held +603 MB of
 * copies of one string.
 */
function worksheetRows(sheet: ExcelJS.Worksheet): SheetRows {
  const rows: Cell[][] = [];
  const covered = new CoverMask();
  const masters = new WeakMap<ExcelJS.Cell, Cell>();
  const masterValue = (master: ExcelJS.Cell): Cell => {
    if (!masters.has(master)) masters.set(master, cellValue(master.value));
    return masters.get(master) ?? null;
  };
  let rowsLeftOut = false;
  let colsLeftOut = false;
  sheet.eachRow({ includeEmpty: true }, (row) => {
    if (rows.length >= MAX_ROWS) {
      if (!rowsLeftOut && row.hasValues) rowsLeftOut = true;
      return;
    }
    // A value past the column bound: exceljs holds the row's cells already,
    // so asking costs one walk of them, and only on a row that wide.
    if (!colsLeftOut && row.cellCount > MAX_COLS) {
      row.eachCell((cell, col) => {
        if (col > MAX_COLS && cell.type !== ExcelJS.ValueType.Merge) colsLeftOut = true;
      });
    }
    const r = rows.length;
    const values: Cell[] = [];
    // row.values is 1-based with a hole at 0.
    for (let c = 1; c <= Math.min(row.cellCount, MAX_COLS); c += 1) {
      const cell = row.getCell(c);
      if (cell.type !== ExcelJS.ValueType.Merge) {
        values.push(cellValue(cell.value));
        continue;
      }
      const master = cell.master;
      if (master === cell || master.fullAddress.col !== cell.fullAddress.col) {
        values.push(null);
        continue;
      }
      const value = masterValue(master);
      if (value !== null) covered.add(r, c - 1);
      values.push(value);
    }
    rows.push(values);
  });
  // exceljs hands back every sheet whatever its `state`.
  const hidden = sheet.state === 'hidden' || sheet.state === 'veryHidden';
  const read = withCovered(hidden ? { name: sheet.name, rows, hidden } : { name: sheet.name, rows }, covered);
  return withLeftOut(read, rowsLeftOut, colsLeftOut);
}

/**
 * The deal import's reader: the FIRST worksheet, with its covered positions —
 * `parseGoods(sheet.rows, sheet.covered)`, or a merged amount is counted
 * twice (R3-S3).
 */
export async function workbookRows(body: ArrayBuffer | Buffer): Promise<SheetRows | null> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(body as ArrayBuffer);
  } catch {
    return null;
  }
  const sheet = workbook.worksheets[0];
  return sheet ? worksheetRows(sheet) : null;
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
  return csvSheet(text).rows;
}

/** The CSV as a sheet, saying what its bounds left out (`SheetRows.rowsLeftOut`). */
function csvSheet(text: string): SheetRows {
  // Bounded like every other shape (`MAX_ROWS` × `MAX_COLS`): one line of a
  // million commas was a million-column header the detector walked per key.
  const filled = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const lines = filled.slice(0, MAX_ROWS);
  if (lines.length === 0) return { name: 'CSV', rows: [] };
  const first = lines[0]!.slice(0, 64 * 1024);
  const delim = [';', '\t', ','].reduce((best, d) =>
    first.split(d).length > first.split(best).length ? d : best,
  );
  let colsLeftOut = false;
  const rows = lines.map((line) => {
    const read = splitCsvLine(line, delim);
    if (read.leftOut) colsLeftOut = true;
    return read.cells;
  });
  return withLeftOut({ name: 'CSV', rows }, filled.length > lines.length, colsLeftOut);
}

function splitCsvLine(line: string, delim: string): { cells: Cell[]; leftOut: boolean } {
  const out: Cell[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  for (; i < line.length && out.length < MAX_COLS; i += 1) {
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
  if (out.length < MAX_COLS) out.push(cell.trim() || null);
  // The bound stopped the line with something still in it — a cell, not
  // only more delimiters (scanned, never split: the line may be a million
  // commas).
  let leftOut = false;
  for (let k = i; out.length >= MAX_COLS && k < line.length && !leftOut; k += 1) {
    const ch = line[k]!;
    leftOut = ch !== delim && ch !== '"' && ch.trim() !== '';
  }
  return { cells: out, leftOut };
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
  return workbook.worksheets.map(worksheetRows);
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
  | { kind: 'goods'; goods: GoodsRow[]; sheet: string; sheets: number; text: string; textCut: boolean; cellsCut: boolean }
  /**
   * A table with no header the reader knows — handed to the model as text.
   *
   * On both kinds `text` is whole lines, one per row, at most
   * `SHEET_TEXT_BUDGET` characters (`sheetsAsText`), and two different
   * things can be shortened in it (R3-S6, the third review):
   *  - `textCut` — some ROW is missing: the budget ran out before the sheets
   *    did, or a reader's `MAX_ROWS` left one out (`SheetRows.rowsLeftOut`).
   *    A row-wise fitter downstream cannot see rows it was never given,
   *    so this is the only word that they are missing (S4) — «AI reads only
   *    the start» is true, and the totals the model sums are partial;
   *  - `cellsCut` — every row is there, but a cell was cut at its 300
   *    characters, a too-long row lost its last cells, or a reader's
   *    `MAX_COLS` left a cell out (`SheetRows.colsLeftOut`). A customs
   *    description past 300 characters is ordinary, and calling that «rows
   *    left out» told the seller and the model so on almost every invoice.
   */
  | { kind: 'text'; text: string; sheets: number; textCut: boolean; cellsCut: boolean }
  /**
   * A spreadsheet that cannot be read, and why — said to the seller. A markup
   * text past `MAX_MARKUP_CHARS` is `broken`: «save it again» (as .xlsx) is
   * the honest cure.
   */
  | { kind: 'refused'; reason: 'old_format' | 'encrypted' | 'broken' | 'empty' };

/**
 * Sheets as text for the model: `[name]`, then one line per row with its
 * cells joined by « | ». Built under ONE budget for the whole file and
 * stopped where it runs out — never joined first and sliced after (that join
 * WAS the 510-million-character string).
 *
 * Cut on WHOLE lines only (S4, the second review): `slice(0, room)` ended the
 * text in the middle of a row, the half row reached the model as a product,
 * and the row-wise fitter downstream (`fitSheetTexts`) counted the text as
 * fitting whole — so nobody told the seller. A row's own line is capped first
 * (`LINE_TEXT_CHARS`, whole cells), and a cell's own line breaks are « / »
 * (R3-S9: «Стол 5 шт» and «Стул 3 шт» typed one per line in one cell were one
 * run-on line), so a line here is always one row and its items still show.
 *
 * A position a merge DOWN covers is EMPTY here when its master is a FIGURE
 * (R3-S3, `readsAsFigure`): the readers repeat the master's value there, and
 * a carton's weight merged over three lines, written three times or as «〃»
 * («the same again»), is a weight a model sums three times — on the
 * packing-list sheets the model reads the shipment's totals from. An empty
 * cell under a merged figure is also exactly what Excel's own CSV export
 * writes, the shape the model has seen most. A merged TEXT — a name, a spec
 * — is repeated on every line it covers (the fourth review): left empty, the
 * covered line reached the model with no identity and its figures shifted
 * into the name's place («2 | 120 | 60» for «2 | 女士夹克 黑色 | 120 | 60»), and
 * a sheet with no header the reader knows has no other reader of its names.
 *
 * `rowsCut` is a row the budget did not reach, or one the sheet's reader left
 * out past its bound; `cellsCut` a cell or a row's tail shortened while the
 * row itself is there, here or by the reader (R3-S6, `SheetRows.rowsLeftOut`).
 */
function sheetsAsText(sheets: SheetRows[]): { text: string; rowsCut: boolean; cellsCut: boolean } {
  let text = '';
  let rowsCut = sheets.some((sheet) => sheet.rowsLeftOut);
  let cellsCut = sheets.some((sheet) => sheet.colsLeftOut);
  each: for (const sheet of sheets) {
    let opened = false;
    for (const [r, row] of sheet.rows.entries()) {
      const read = rowLine(row, r, sheet.covered ?? null);
      if (!read.line) continue;
      const head = opened ? '\n' : `${text ? '\n\n' : ''}[${sheet.name.slice(0, 100)}]\n`;
      if (text.length + head.length + read.line.length > SHEET_TEXT_BUDGET) {
        rowsCut = true;
        break each;
      }
      text += head + read.line;
      opened = true;
      if (read.cut) cellsCut = true;
    }
  }
  return { text, rowsCut, cellsCut };
}

/** One row as one line: its cells, each cut at `CELL_TEXT_CHARS`, while they fit `LINE_TEXT_CHARS`. */
function rowLine(row: Cell[], r: number, covered: Covered | null): { line: string; cut: boolean } {
  let line = '';
  let cut = false;
  for (const [c, cell] of row.entries()) {
    if (cell === null || (covered?.has(r, c) && readsAsFigure(cell))) continue;
    const raw = String(cell);
    // Only the head of a long cell is read: a cell is never the length of
    // the text it lands in (the 30,000-character shared string, #8).
    const window = raw.slice(0, CELL_TEXT_CHARS * 4);
    const flat = window
      .trim()
      .replace(/\s*[\r\n]+\s*/g, ' / ')
      .replace(/\s+/g, ' ');
    if (!flat) continue;
    const kept = flat.slice(0, CELL_TEXT_CHARS);
    if (kept.length < flat.length || /\S/.test(raw.slice(window.length))) cut = true;
    const piece = line ? ` | ${kept}` : kept;
    if (line.length + piece.length > LINE_TEXT_CHARS) return { line, cut: true };
    line += piece;
  }
  return { line, cut };
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
 *
 * Only VISIBLE sheets are chosen from (the review: a hidden 300-line price
 * list behind the order form's drop-downs out-counted the 20-line order and
 * became the job). A workbook whose visible sheets are all EMPTY — Excel
 * always keeps one visible, so a blank «Sheet1» over a hidden data sheet is
 * the shape a script writes — is read from its hidden sheets rather than
 * called empty: emptiness is judged first, visibility among what has cells
 * (S2, S9, the second review).
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
    if (markupOf(text) !== null && text.length > MAX_MARKUP_CHARS) return { kind: 'refused', reason: 'broken' };
    sheets = spreadsheetMlSheets(text) ?? htmlTableSheets(text) ?? [csvSheet(text)];
  } else {
    return null;
  }

  const nonEmpty = sheets.filter((sheet) => sheet.rows.some((row) => row.some((cell) => cell !== null && String(cell).trim() !== '')));
  const shown = nonEmpty.filter((sheet) => !sheet.hidden);
  const filled = shown.length > 0 ? shown : nonEmpty;
  let best: { sheet: SheetRows; goods: GoodsRow[] } | null = null;
  for (const sheet of filled) {
    const parsed = parseGoods(sheet.rows, sheet.covered ?? null);
    if (parsed.headerRow !== null && parsed.goods.length > (best?.goods.length ?? 0)) {
      best = { sheet, goods: parsed.goods };
    }
  }
  const others = sheetsAsText(filled.filter((sheet) => sheet !== best?.sheet));
  const cut = { textCut: others.rowsCut, cellsCut: others.cellsCut };
  if (best) {
    return { kind: 'goods', goods: best.goods, sheet: best.sheet.name, sheets: filled.length, text: others.text, ...cut };
  }
  if (others.text) return { kind: 'text', text: others.text, sheets: filled.length, ...cut };
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
