import ExcelJS from 'exceljs';
import { clipUnits } from '../../platform/text/clip';
import { CoverMask, parseGoods, readsAsFigure, type Cell, type ColumnAsk, type Covered, type DroppedRow, type GoodsRow, type SheetNote, type SheetShape } from './goods-import';
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
  // A line of nothing but separators is the blank row Excel's «Save as CSV»
  // writes for every empty row of a template's used range (the fifth review):
  // an empty tail past the bound is no row left out.
  const rowsLeftOut = filled.slice(MAX_ROWS).some((line) => /[^\s;,\t"]/.test(line));
  // The delimiter is the file's word on its comma (§5.9): «;» is a decimal
  // comma's, «,» a quoted thousands comma's; a tab says nothing.
  const comma = delim === ';' ? 'decimal' : delim === ',' ? 'thousands' : null;
  return withLeftOut({ name: 'CSV', rows, ...(comma ? { comma } : {}) }, rowsLeftOut, colsLeftOut);
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
  return (await loadWorkbook(body))?.sheets ?? null;
}

/**
 * The sheets, and how many pictures the workbook carries (docs/FAYL-OQISH.md
 * §4.4): nothing here reads a picture, so a workbook whose goods exist only
 * as a pasted screenshot read as «jadval bo‘sh» or «AI o‘qiydi», and the
 * seller was never told to send the picture itself. Counted from what the
 * load already holds — every `xl/media/*` entry, which is where floating,
 * WPS and in-cell pictures all keep their bytes — never `getImages()`, which
 * sees the drawing-anchored ones alone.
 */
async function loadWorkbook(body: ArrayBuffer | Buffer): Promise<{ sheets: SheetRows[]; pictures: number } | null> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(body as ArrayBuffer);
  } catch {
    return null;
  }
  // `media` is the loaded workbook's own list; the typings put it on the model only.
  const media = (workbook as unknown as { media?: { type?: string }[] }).media ?? [];
  return { sheets: workbook.worksheets.map(worksheetRows), pictures: media.filter((m) => m.type === 'image').length };
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

/**
 * A further sheet of a workbook whose header the reader MAPPED
 * (docs/FAYL-OQISH.md §4.1): its own rows, its shape, and its rows as text
 * with the reader's two cuts — what the bot needs to judge it against the
 * goods list (`receiveGoodsSheet`): the same goods' packing list gives the
 * totals, another factory's own goods are folded in, and anything it cannot
 * prove either way keeps today's reading, its text read for the totals.
 */
export interface MappedSheet extends SheetShape {
  sheet: string;
  goods: GoodsRow[];
  ownText: { text: string; cut: boolean; cellsCut: boolean };
  /**
   * What the reader did not take as goods on THIS sheet (§5.5, as-built review
   * SHEETS-1): a further sheet's figure-less last lines were trimmed and
   * reached no reader on any surface — «Zavod B»'s «Шарф», said nowhere.
   */
  dropped: DroppedRow[];
  /** The reader stopped at its ceiling with rows left unread (`ParsedGoods.stoppedShort`). */
  stoppedShort: boolean;
  /** What the reader says of THIS sheet's columns (`ParsedGoods.notes`, docs/AI-SORAYDI.md §3.2 X5). */
  notes: SheetNote[];
  /** THIS sheet's line columns nothing settled (`ParsedGoods.asks`, review JN-12, seams-4). Absent = none. */
  asks?: ColumnAsk[];
}

/** What the bot learns from a spreadsheet the seller forwarded. */
export type GoodsFileRead =
  /**
   * The reader found a header and read the goods exactly. The goods sheet is
   * the one with the most lines (the first on a tie); an «Invoice» sheet and a
   * «Packing list» sheet in one workbook usually list the SAME goods, and
   * adding them would double the order. Every OTHER sheet whose header the
   * reader maps is handed over beside it (`moreSheets`) for the bot to judge
   * by its shape (docs/FAYL-OQISH.md §4.2) — before, it became text the model
   * was told not to list, and another factory's goods on «Sheet2» were lost
   * with no word. Only the sheets with no header the reader knows are `text`
   * (their gross weights and volumes are the shipment's totals), under their
   * own `textCut` / `cellsCut`.
   */
  | ({
      kind: 'goods';
      goods: GoodsRow[];
      sheet: string;
      sheets: number;
      text: string;
      textCut: boolean;
      cellsCut: boolean;
      /** The other visible sheets the reader mapped, in workbook order. */
      moreSheets: MappedSheet[];
      /**
       * The goods sheet's rows the reader did NOT take as goods, and why
       * (FAYL-OQISH §5.4, §5.5): its total rows, a figure-less «SAY TOTAL»
       * line, a subtotal the arithmetic shows, and the footer under the last
       * line that states anything («Made in China», «Remarks:», a stamp).
       * The collector shows their text to the model as context — a real
       * good typed there without figures is still read — and names them on
       * receipt (`droppedRowsLine`).
       */
      dropped: DroppedRow[];
      /** The goods sheet was cut at the reader's ceiling with rows left unread (`ParsedGoods.stoppedShort`). */
      stoppedShort: boolean;
      /**
       * The goods sheet's OWN rows as text, the way `text` writes the others
       * — only for a packing-shaped sheet (docs/IKKI-ESHIK.md §1.2.2): when it
       * gives the shipment's totals beside an invoice, its whole text goes to
       * the model under the totals-only heading («TOTAL G.W.» is a row of it).
       * With the reader's own two words (review PF-ADV-14): `cut` = rows are
       * missing — a «TOTAL G.W.» row at the bottom may be among them — and
       * `cellsCut` = some cells shortened; the model is told either. An
       * invoice-shaped sheet carries it only when its own TOTAL rows give the
       * shipment's brutto or cube (X8); null for any other invoice.
       */
      ownText: { text: string; cut: boolean; cellsCut: boolean } | null;
      /**
       * What the reader says of the goods sheet's COLUMNS (docs/AI-SORAYDI.md
       * §3.2 X5): a column it read as ONE carton's, and one the sheet's own
       * TOTAL row disowns — said on the file's receipt (`receiveGoodsSheet`).
       */
      notes: SheetNote[];
      /** The goods sheet's line columns nothing settled — asked once (`ParsedGoods.asks`, review JN-12). Absent = none. */
      asks?: ColumnAsk[];
      /**
       * How many pictures the WORKBOOK carries (`loadWorkbook` — every
       * `xl/media` image, floating, WPS and in-cell alike; 0 for a CSV, an
       * HTML table or an Excel 97 file). A mapped sheet keeps the count as a
       * text sheet always did (docs/AI-SORAYDI.md §3.2 X10, review CR-3): a
       * quotation whose goods are pictures beside an article number reads
       * its rows here, and the pictures are where the goods are named. A
       * count only — nothing here reads a picture (release 1b's).
       */
      pictures: number;
    } & SheetShape)
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
  | {
      kind: 'text';
      text: string;
      sheets: number;
      textCut: boolean;
      cellsCut: boolean;
      /**
       * What the reader saw, for the seller's words (docs/FAYL-OQISH.md §4.4):
       * `header` — a sheet's header WAS found and no goods row came out under
       * it (a lone «TOTAL cordless drill» row, xlsx1-04), so «sarlavhasini
       * topa olmadim» is false of it; `no_rows` — no row of the text holds a
       * name beside a figure (a cover, a letterhead, a picture's caption), so
       * «AI o‘qiydi» promised goods the model cannot find there. Absent =
       * today's header-less table.
       */
      why?: 'header' | 'no_rows';
      /** The workbook carries pictures the reader does not read (`loadWorkbook`). */
      pictures: number;
    }
  /**
   * A workbook whose cells are empty and which carries pictures: the goods
   * are in a picture this reader does not read (docs/FAYL-OQISH.md §4.4), and
   * «jadval bo‘sh» alone sent nobody to the cure.
   */
  | { kind: 'refused'; reason: 'pictures' }
  /**
   * A spreadsheet that cannot be read, and why — said to the seller. A markup
   * text past `MAX_MARKUP_CHARS` is `broken`: «save it again» (as .xlsx) is
   * the honest cure.
   */
  | { kind: 'refused'; reason: 'old_format' | 'encrypted' | 'broken' | 'empty' };

/** How many dropped rows the receipt names by their text — the rest are counted. */
const DROPPED_NAMED = 3;

/**
 * The receipt's words for the rows a goods sheet held and the reader did not
 * take as goods (FAYL-OQISH §5.5) — «said, never silent»: a footer under the
 * goods («Made in China», «Remarks:») or a subtotal the arithmetic found is a
 * row the seller may know to be a good. A label-only total row («TOTAL»,
 * «Итого», «Umumiy») is no news to anybody and is not said; nothing else to
 * say is null.
 *
 * The phrase opens in lower case so the collector can set it after the
 * file's own line («📄 «pl.xlsx» — …»): all of them footers under the table
 * reads «ostidagi N ta qator tovar deb olinmadi: «…», «…»»; otherwise each
 * says why. Pure, for the collector (calc-files.ts) to print; the collector also
 * hands the rows' text to the model as context.
 */
export function droppedRowsLine(dropped: readonly DroppedRow[]): string | null {
  const said = dropped.filter((row) => row.why !== 'total');
  if (said.length === 0) return null;
  const why: Record<DroppedRow['why'], string> = {
    total: 'jami qatori',
    subtotal: 'jami qatori',
    footer_total: 'izoh qatori',
    footer: 'jadval ostida',
  };
  // «ostidagi» («under it») only when every row said IS under the table: a
  // footer is by construction; a figure-less «Total station Leica» can stand
  // mid-list and says why on its own (review break-ostidagi-midlist).
  const below = said.every((row) => row.why === 'footer');
  const quoted = said.slice(0, DROPPED_NAMED).map((row) => {
    const text = clipUnits(row.text, 40);
    return `«${text}${text.length < row.text.length ? '…' : ''}»${below ? '' : ` (${why[row.why]})`}`;
  });
  const more = said.length > DROPPED_NAMED ? ` va yana ${said.length - DROPPED_NAMED} ta` : '';
  return `${below ? 'ostidagi ' : ''}${said.length} ta qator tovar deb olinmadi: ${quoted.join(', ')}${more}`;
}

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
 * EVERY kept column is written for EVERY row (docs/AI-SORAYDI.md §3.2 X0,
 * review JN-14; the critic's CR-1): leading, interior and trailing empties
 * alike, so a line has as many cells as the header over it. The cells were
 * joined NON-EMPTY ones only, and an empty cell gave up its place — a TOTAL
 * row whose N.W. is blank was sent «TOTAL | 660 | 35 | 530 | 3.6», the cube
 * under «G.W.» and nothing under «CBM»; a quotation with its pictures in
 * column A read one header to the left in every row. Which columns are kept
 * is `keptColumns`' word.
 *
 * A position a merge DOWN covers is an EMPTY slot here when its master is a
 * FIGURE (R3-S3, `readsAsFigure`): the readers repeat the master's value
 * there, and a carton's weight merged over three lines, written three times
 * or as «〃» («the same again»), is a weight a model sums three times — on the
 * packing-list sheets the model reads the shipment's totals from. An empty
 * cell under a merged figure is also exactly what Excel's own CSV export
 * writes («,,»), the shape the model has seen most. A merged TEXT — a name,
 * a spec — is repeated on every line it covers (the fourth review): left
 * empty, the covered line reached the model with no identity, and a sheet
 * with no header the reader knows has no other reader of its names.
 *
 * `rowsCut` is a row the budget did not reach, or one the sheet's reader left
 * out past its bound; `cellsCut` a cell or a row's tail shortened while the
 * row itself is there, here or by the reader (R3-S6, `SheetRows.rowsLeftOut`).
 * Exported for the test; the door is `readGoodsFile`.
 */
export function sheetsAsText(sheets: readonly SheetToText[], budget = SHEET_TEXT_BUDGET): { text: string; rowsCut: boolean; cellsCut: boolean } {
  let text = '';
  let rowsCut = sheets.some(({ sheet }) => sheet.rowsLeftOut);
  let cellsCut = sheets.some(({ sheet }) => sheet.colsLeftOut);
  each: for (const { sheet, headerRow } of sheets) {
    let opened = false;
    const covered = sheet.covered ?? null;
    const columns = keptColumns(sheet.rows, covered, headerRow);
    for (const [r, row] of sheet.rows.entries()) {
      const read = rowLine(row, r, covered, columns);
      if (!read.line) continue;
      const head = opened ? '\n' : `${text ? '\n\n' : ''}[${sheet.name.slice(0, 100)}]\n`;
      if (text.length + head.length + read.line.length > budget) {
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

/** A sheet to write as text, and the header row the column reader found on it (null: none). */
export interface SheetToText {
  sheet: SheetRows;
  headerRow: number | null;
}

/** A cell the text writes nothing for: empty, blank, or a merge's covered FIGURE (`sheetsAsText`). */
const blankInText = (cell: Cell | undefined, r: number, c: number, covered: Covered | null): boolean =>
  cell === null || cell === undefined || (typeof cell === 'string' && !/\S/.test(cell)) || ((covered?.has(r, c) ?? false) && readsAsFigure(cell));

/** A header's own cell is a short label — never a paragraph, never «Buyer:». */
const HEADER_CELL_CHARS = 60;

/**
 * The header of a PICTURE column, whole — «图片», «产品图片», «Picture»,
 * «Photo», «Фото», «Rasm». The one header `keptColumns` takes for a column's
 * heading on a sheet whose header row nobody found: a quotation's pictures
 * are no cell values, so the column under it is empty in every row.
 */
const PICTURE_HEADER =
  /^(?:(?:产品|商品|实物|样品|货物)?(?:图片|圖片|图像|照片|图)|(?:product\s+|item\s+)?(?:pictures?|pics?|photos?|images?|img)\.?|фото\p{L}*(?:\s+товара)?|изображени\p{L}*|картинк\p{L}*|rasm\p{L}*|surat\p{L}*|foto)$/iu;

/**
 * The columns a sheet's text keeps (X0): every column SOME row writes
 * something in — one empty in every row costs each line a separator and says
 * nothing — and never a column only its HEADER names. «Picture», «图片»,
 * «产品图片» head the pictures of a Chinese quotation, which are no cell
 * values: the column is empty in every row, and its header cell goes with it,
 * or the header alone would be one cell longer than every line under it.
 *
 * «Only its header» is one cell of the column's own (a merge's repeats of it
 * are not another) standing in the header row. On a sheet the column reader
 * mapped that row is KNOWN (`headerRow`), and whatever it heads over nothing
 * goes. On a sheet it could not map — every sheet whose goods the model
 * lists — nobody knows the header, and a cell alone in its column is as
 * often content: a remark beside one line's figures, «买方: | GSR LOGISTICS»
 * in a letterhead, the one description of a names-only list. There only a
 * PICTURE header goes, and only from a row that reads as a header
 * (`headsFigures`); any other column keeps its heading and its empty slots,
 * which costs a separator a line and loses nothing.
 */
function keptColumns(rows: readonly Cell[][], covered: Covered | null, headerRow: number | null): number[] {
  const written: boolean[] = [];
  const own: number[] = [];
  const first: number[] = [];
  for (const [r, row] of rows.entries()) {
    for (let c = 0; c < row.length; c += 1) {
      if (blankInText(row[c], r, c, covered)) continue;
      written[c] = true;
      if (covered?.has(r, c)) continue;
      own[c] = (own[c] ?? 0) + 1;
      if (own[c] === 1) first[c] = r;
    }
  }
  const heads = new Map<number, boolean>();
  // A header heads a TABLE: three columns at least. The «header row» of a
  // label|value card is its name line («Tovar nomi: | Kurtka»), whose value
  // may stand alone in its column and is the good itself.
  const tableHeader = (r: number): boolean => (rows[r] ?? []).filter((cell, c) => !blankInText(cell, r, c, covered) && !covered?.has(r, c)).length >= 3;
  const headsOnly = (c: number): boolean => {
    const r = first[c]!;
    if (r === headerRow) return tableHeader(r);
    if (!PICTURE_HEADER.test(String(rows[r]![c]).trim())) return false;
    let known = heads.get(r);
    if (known === undefined) heads.set(r, (known = headsFigures(rows, r, covered)));
    return known;
  };
  const kept: number[] = [];
  for (let c = 0; c < written.length; c += 1) {
    if (written[c] && !(own[c] === 1 && headsOnly(c))) kept.push(c);
  }
  return kept;
}

/** Does row `r` read as a table's header — short words, directly over a row with figures under two of them? */
function headsFigures(rows: readonly Cell[][], r: number, covered: Covered | null): boolean {
  const row = rows[r] ?? [];
  const words: number[] = [];
  for (let c = 0; c < row.length; c += 1) {
    const cell = row[c];
    if (blankInText(cell, r, c, covered) || covered?.has(r, c)) continue;
    if (typeof cell !== 'string' || cell.length > HEADER_CELL_CHARS || readsAsFigure(cell) || /[:：]\s*$/.test(cell)) return false;
    words.push(c);
  }
  if (words.length < 3) return false;
  for (let d = r + 1; d < rows.length; d += 1) {
    const below = rows[d]!;
    if (below.every((cell, c) => blankInText(cell, d, c, covered))) continue;
    return words.filter((c) => !blankInText(below[c], d, c, covered) && readsAsFigure(below[c] ?? null)).length >= 2;
  }
  return false;
}

/**
 * One row as one line: a cell per kept column, each cut at `CELL_TEXT_CHARS`,
 * while they fit `LINE_TEXT_CHARS`; an empty cell is an empty slot between
 * its separators, and a row with nothing in any of them is no line. Neither
 * end carries white space — a slot empty at an edge is its «|» alone — so a
 * caller's `trim()` of the whole text changes no line.
 */
function rowLine(row: Cell[], r: number, covered: Covered | null, columns: readonly number[]): { line: string; cut: boolean } {
  let line = '';
  let cut = false;
  let stated = false;
  for (const [k, c] of columns.entries()) {
    const cell = row[c];
    let kept = '';
    if (!blankInText(cell, r, c, covered)) {
      const raw = String(cell);
      // Only the head of a long cell is read: a cell is never the length of
      // the text it lands in (the 30,000-character shared string, #8). Both
      // cuts keep an emoji whole (`clipUnits`, docs/FAYL-OQISH.md §3.8,
      // apireq-1): a UTF-16 `slice` through one left a lone half in the text,
      // and the Messages API refuses the whole request over it.
      const window = clipUnits(raw, CELL_TEXT_CHARS * 4);
      const flat = window
        .trim()
        .replace(/\s*[\r\n]+\s*/g, ' / ')
        .replace(/\s+/g, ' ');
      kept = clipUnits(flat, CELL_TEXT_CHARS);
      if (kept.length < flat.length || /\S/.test(raw.slice(window.length))) cut = true;
    }
    const piece = k > 0 ? ` | ${kept}` : kept;
    if (line.length + piece.length > LINE_TEXT_CHARS) {
      // The row's tail does not fit: said only when it held something.
      const lost = columns.slice(k).some((rest) => !blankInText(row[rest], r, rest, covered));
      return { line: stated ? line.trim() : '', cut: cut || lost };
    }
    line += piece;
    if (kept) stated = true;
  }
  return { line: stated ? line.trim() : '', cut };
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
 * its rows, exactly — no model, no tokens; so does every other sheet whose
 * header it finds (`moreSheets`), for the bot to judge beside the first. A
 * sheet with no recognisable header no longer becomes «every row's first text
 * cell is a product» (the seller's company name, the address and «Invoice No»
 * became goods and overruled the model's reading); it goes to the model as
 * text, which can read a table it has never seen.
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
  let pictures = 0;
  if (body.length > 1 && body[0] === 0x50 && body[1] === 0x4b) {
    const book = await loadWorkbook(body);
    if (!book) return { kind: 'refused', reason: 'broken' };
    sheets = book.sheets;
    pictures = book.pictures;
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
  const parsed = filled.map((sheet) => ({ sheet, parsed: parseGoods(sheet.rows, sheet.covered ?? null, sheet) }));
  const mapped = parsed.filter((p) => p.parsed.headerRow !== null && p.parsed.goods.length > 0);
  // The goods sheet: the most lines, the first on a tie (strict `>`).
  let best: (typeof parsed)[number] | null = null;
  for (const p of mapped) if (p.parsed.goods.length > (best?.parsed.goods.length ?? 0)) best = p;
  // The text is the sheets no header was mapped on — the mapped ones travel
  // as rows (docs/FAYL-OQISH.md §4.1, sheets-07): a folded «Zavod B» left in
  // the text sat under the model's «for totals only» heading, and its Σ came
  // back as the shipment's.
  const unmapped = parsed.filter((p) => p !== best && !mapped.includes(p));
  // Each sheet is written with the header row the column reader found on it
  // (`keptColumns`): on a mapped sheet, and on one whose header maps over no
  // goods row.
  const toText = (p: (typeof parsed)[number]): SheetToText => ({ sheet: p.sheet, headerRow: p.parsed.headerRow });
  const others = sheetsAsText(unmapped.map(toText));
  const ownSheetText = (p: (typeof parsed)[number], budget = SHEET_TEXT_BUDGET) => {
    const own = sheetsAsText([toText(p)], budget);
    return { text: own.text, cut: own.rowsCut, cellsCut: own.cellsCut };
  };
  const cut = { textCut: others.rowsCut, cellsCut: others.cellsCut };
  if (best) {
    const { goods, dropped, stoppedShort, notes, asks, shape, weightKind, grossKg, grossColumn, volumeM3 } = best.parsed;
    // The further mapped sheets' texts share ONE budget among themselves, in
    // workbook order; a sheet the budget did not reach says so in its own
    // `cut`. The bound is stated, not the old one (review
    // sheets-break-budget-comment): beside the unmapped sheets' own budget
    // and a packing goods sheet's `ownText`, a workbook stores up to three
    // budgets of text in the collection, where every non-goods sheet once
    // shared one. Not the unmapped sheets' budget ON PURPOSE: behind a long
    // cover sheet a further sheet would come with no text at all, and a sheet
    // with no text is held by nothing when the workbook is sent again
    // (`sameWorkbookAgain` cannot tell it from a new «Zavod B»). What reaches
    // the model is bounded apart (`fitSheetRows`).
    let room = SHEET_TEXT_BUDGET;
    const moreSheets: MappedSheet[] = mapped
      .filter((p) => p !== best)
      .map((p) => {
        const ownText = ownSheetText(p, room);
        room = Math.max(0, room - ownText.text.length);
        return {
          sheet: p.sheet.name,
          goods: p.parsed.goods,
          shape: p.parsed.shape,
          weightKind: p.parsed.weightKind,
          grossKg: p.parsed.grossKg,
          grossColumn: p.parsed.grossColumn,
          volumeM3: p.parsed.volumeM3,
          ownText,
          dropped: p.parsed.dropped,
          stoppedShort: p.parsed.stoppedShort,
          notes: p.parsed.notes,
          ...(p.parsed.asks ? { asks: p.parsed.asks } : {}),
        };
      });
    return {
      kind: 'goods',
      goods,
      dropped,
      stoppedShort,
      notes,
      ...(asks ? { asks } : {}),
      sheet: best.sheet.name,
      sheets: filled.length,
      text: others.text,
      ...cut,
      moreSheets,
      shape,
      weightKind,
      grossKg,
      grossColumn,
      volumeM3,
      // …and an invoice-shaped goods sheet whose own TOTAL rows give the
      // shipment's brutto or cube (docs/AI-SORAYDI.md §3.2 X8, third sentence;
      // review excel-spec-3): its text, total rows included, goes to the model
      // under the totals heading as a packing sheet's does — «TOTAL: 60 CTNS /
      // G.W. 710 KGS / 3.8 CBM» under an invoice is the shipment's, and the
      // model read only the rows. A TOTAL of the count and the money alone, or
      // one the belt refused (its figure null here, JR-3), hands nothing.
      ownText:
        shape === 'packing' || (dropped.some((d) => d.why === 'total' || d.why === 'subtotal') && (grossKg !== null || volumeM3 !== null))
          ? ownSheetText(best)
          : null,
      pictures,
    };
  }
  if (others.text) {
    // No goods row came out of a sheet whose header WAS found, or every line
    // of the text is a cover's (docs/FAYL-OQISH.md §4.4).
    const why = parsed.some((p) => p.parsed.headerRow !== null)
      ? ('header' as const)
      : unmapped.every((p) => p.sheet.rows.every(coverRow))
        ? ('no_rows' as const)
        : undefined;
    return { kind: 'text', text: others.text, sheets: filled.length, ...cut, ...(why ? { why } : {}), pictures };
  }
  return { kind: 'refused', reason: pictures > 0 ? 'pictures' : 'empty' };
}

/*
 * What a cover or a letterhead is made of, and nothing a goods line is: a
 * document's title, the sender's company, a contact or document label, a
 * total. Positive and narrow ON PURPOSE (review sheets-spec-no-rows-too-wide):
 * a sheet whose every line is one of these says «jadvalda tovar qatori
 * ko‘rinmadi», and anything it does not know keeps «AI o‘qiydi» — «no row
 * pairs a name with a figure» also took a names-only list, «Kurtka 300 dona»
 * in one cell and «12 рулонов», goods the model then read off that very text.
 * «Tovar:», «Soni:» are a goods card's labels, not a cover's.
 */
const COVER_TITLE =
  /(?<!\p{L})(?:commercial|proforma|invoice|packing\s*list|contract|specification|инвойс|сч[её]т(?:-фактура)?|спецификаци\p{L}*|контракт|упаковочн\p{L}*\s+лист|hisob-faktura|faktura|shartnoma)(?!\p{L})|商业发票|形式发票|发票|装箱单|合同/giu;
/** What a title carries beside its words: its number and its date. */
const TITLE_FILLER = /(?<!\p{L})(?:no|nr|date|от|dated)(?!\p{L})/giu;
const COVER_COMPANY = /(?<!\p{L})(?:co\.?,?\s*(?:ltd|limited)|ltd|llc|ооо|оао|зао|ип|mchj)(?!\p{L})|有限公司|进出口/iu;
const COVER_LABEL =
  /^(?:no|nr|№|to|from|attn|add|address|tel|telephone|phone|mob|fax|e-?mail|date|invoice\s*no|contract\s*no|po\s*no|shipping\s*mark|buyer|seller|shipper|consignee|notify|port|payment|terms|дата|адрес|тел|телефон|кому|от|покупатель|продавец|грузополучатель|отправитель|manzil|sana|oluvchi|jo‘natuvchi|地址|电话|日期|收货人|发货人|买方|卖方|唛头)\.?\s*[:：#№]/iu;
const COVER_TOTAL = /^(?:(?:grand\s+)?total|say|итого|всего|jami|合计|总计|共计)(?!\p{L})/iu;
/** A cell that is a document's title and nothing else but its number or date («PROFORMA INVOICE», «装箱单 PACKING LIST»). */
const coverTitle = (text: string) => {
  const rest = text.replace(COVER_TITLE, ' ');
  return rest !== text && !/\p{L}/u.test(rest.replace(TITLE_FILLER, ' '));
};

/**
 * One line of a cover: led by a contact label or a total (what follows is its
 * value — «Date: | 2026-10-28», «TOTAL G.W. | 1592 KGS»), or every cell of it
 * a title, the company or a label. An empty line is no evidence either way.
 */
function coverRow(row: Cell[]): boolean {
  const cells = row.filter((cell) => cell !== null && String(cell).trim() !== '').map((cell) => String(cell).trim());
  if (cells.length === 0) return true;
  if (COVER_LABEL.test(cells[0]!) || COVER_TOTAL.test(cells[0]!)) return true;
  return cells.every((text) => coverTitle(text) || COVER_COMPANY.test(text) || COVER_LABEL.test(text));
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
