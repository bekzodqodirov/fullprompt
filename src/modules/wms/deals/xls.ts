import * as CFB from 'cfb';
import type { Cell } from './goods-import';

/**
 * The three shapes a file called «.xls» arrives in, read into rows (his 1.3 b,
 * 2026-10-21: «.xls ham o'qilsin»).
 *
 *  1. A real Excel 97-2003 workbook (BIFF8 inside an OLE compound file) — what
 *     WPS and old Excel save. `cfb` (SheetJS's own container reader) opens the
 *     compound file; the cell records are read HERE, and only the ones that
 *     carry a value: shared strings, inline strings, numbers, RK numbers,
 *     formula results. No formatting, no formulas evaluated, nothing written.
 *  2. An HTML table saved with an «.xls» name — what most web systems in China
 *     export.
 *  3. Excel 2003 «XML Spreadsheet» (SpreadsheetML) — the same, from older
 *     office tools.
 *
 * Why not a full spreadsheet library: the one that reads all three (SheetJS)
 * is published to npm only in a version with known parsing CVEs, the fixed one
 * lives on a host this build cannot reach, and a third-party republish could
 * not be verified against the original. Reading cell VALUES of a BIFF8 stream
 * is a few record types; the parser below refuses anything else in words.
 *
 * Every answer is bounded — a stranger's file is read, so its size is never
 * trusted: `MAX_ROWS` × `MAX_COLS` per sheet, `MAX_SHEETS` per workbook, a
 * markup text no longer than `MAX_MARKUP_CHARS`, and every reader LINEAR in
 * its input (the review's 300 sheet entries pointing at one sheet, and an
 * HTML file with no `</tr>`, each froze the one Node process for seconds to
 * hours — the bot polls inside the app).
 */

export const MAX_ROWS = 5_000;
export const MAX_COLS = 100;
/** More sheets than any invoice or packing list carries; each costs a grid. */
export const MAX_SHEETS = 32;
/**
 * The longest HTML / SpreadsheetML text read at all. Measured: 5,000 rows of
 * a web export with its styles on every cell are ~1.1 MB, so this holds more
 * than `MAX_ROWS` of any real export; above it the honest answer is «save it
 * as .xlsx», which is what the refusal says.
 */
export const MAX_MARKUP_CHARS = 4_000_000;

export interface SheetRows {
  name: string;
  rows: Cell[][];
  /**
   * The sheet is hidden in its workbook (a price list behind a drop-down, an
   * old proforma left in a factory template). Read, so a workbook of nothing
   * BUT hidden sheets still answers, and never chosen while a visible one
   * exists — the review's hidden 300-line «Справочник» replaced the 20-line
   * order.
   */
  hidden?: boolean;
}

export type XlsRead =
  | { ok: true; sheets: SheetRows[] }
  | {
      ok: false;
      /** `old_format` = Excel 95 or older (BIFF5/7); `encrypted` = a password. */
      reason: 'old_format' | 'encrypted' | 'broken';
    };

/** The first eight bytes of every OLE compound file. */
export function isCompoundFile(body: Buffer): boolean {
  return (
    body.length >= 8 &&
    body.readUInt32LE(0) === 0xe011cfd0 &&
    body.readUInt32LE(4) === 0xe11ab1a1
  );
}

const R = {
  BOF: 0x0809,
  EOF: 0x000a,
  FILEPASS: 0x002f,
  BOUNDSHEET: 0x0085,
  SST: 0x00fc,
  CONTINUE: 0x003c,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  FORMULA: 0x0006,
  STRING: 0x0207,
  BOOLERR: 0x0205,
  SHRFMLA: 0x04bc,
  ARRAY: 0x0221,
  TABLE: 0x0236,
} as const;

/**
 * BIFF8's cell grammar is `FORMULA [ShrFmla / Array / Table] [String]`: the
 * cached string of a formula arrives AFTER these. A filled-down column of
 * `=VLOOKUP(…)` or `=A2&B2` names carries a ShrFmla after its first cell, and
 * clearing the pending cell there lost the first product of every block.
 */
const BETWEEN_FORMULA_AND_STRING: ReadonlySet<number> = new Set([R.SHRFMLA, R.ARRAY, R.TABLE]);

interface RecordAt {
  type: number;
  data: Buffer;
  next: number;
}

function recordAt(stream: Buffer, at: number): RecordAt | null {
  if (at + 4 > stream.length) return null;
  const type = stream.readUInt16LE(at);
  const size = stream.readUInt16LE(at + 2);
  const end = at + 4 + size;
  if (end > stream.length) return null;
  return { type, data: stream.subarray(at + 4, end), next: end };
}

/**
 * A cursor over a record and the CONTINUE records after it.
 *
 * A shared string may be cut by a record boundary anywhere in its characters;
 * the continuation then starts with ONE flag byte saying whether the rest is
 * one or two bytes per character. Everything else (lengths, formatting runs,
 * phonetic data) simply carries on into the next record.
 */
class Segments {
  private seg = 0;
  private off = 0;
  constructor(private readonly segs: Buffer[]) {}

  private ensure(): boolean {
    while (this.seg < this.segs.length && this.off >= this.segs[this.seg]!.length) {
      this.seg += 1;
      this.off = 0;
    }
    return this.seg < this.segs.length;
  }

  u8(): number {
    if (!this.ensure()) throw new Error('sst: past the end');
    const v = this.segs[this.seg]![this.off]!;
    this.off += 1;
    return v;
  }

  u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  i32(): number {
    return (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) | 0;
  }

  skip(n: number): void {
    let left = n;
    while (left > 0) {
      if (!this.ensure()) throw new Error('sst: past the end');
      const avail = this.segs[this.seg]!.length - this.off;
      const step = Math.min(avail, left);
      this.off += step;
      left -= step;
    }
  }

  /** `cch` characters, honouring the flag byte at every continuation. */
  chars(cch: number, highByte: boolean): string {
    let high = highByte;
    let left = cch;
    let out = '';
    while (left > 0) {
      const atEnd = this.seg >= this.segs.length || this.off >= this.segs[this.seg]!.length;
      if (atEnd) {
        this.seg += 1;
        this.off = 0;
        if (this.seg >= this.segs.length) throw new Error('sst: string past the end');
        // A continuation of CHARACTERS restates their width — even when the
        // boundary falls right before the first one (LibreOffice reads it so).
        high = (this.u8() & 1) === 1;
      }
      const seg = this.segs[this.seg]!;
      const avail = seg.length - this.off;
      const n = high ? Math.min(left, Math.floor(avail / 2)) : Math.min(left, avail);
      if (n === 0) {
        // One stray byte before a boundary in a two-byte run: the file is cut.
        throw new Error('sst: misaligned string');
      }
      out += high
        ? seg.toString('utf16le', this.off, this.off + n * 2)
        : seg.toString('latin1', this.off, this.off + n);
      this.off += high ? n * 2 : n;
      left -= n;
    }
    return out;
  }
}

/** XLUnicodeRichExtendedString — one entry of the shared-string table. */
function richString(cur: Segments): string {
  const cch = cur.u16();
  const flags = cur.u8();
  const runs = flags & 0x08 ? cur.u16() : 0;
  const ext = flags & 0x04 ? cur.i32() : 0;
  const text = cur.chars(cch, (flags & 0x01) === 1);
  cur.skip(runs * 4);
  if (ext > 0) cur.skip(ext);
  return text;
}

/** XLUnicodeString inside one record (LABEL, STRING): cch u16, flags u8, chars. */
function plainString(data: Buffer, at: number): string {
  if (at + 3 > data.length) return '';
  const cch = data.readUInt16LE(at);
  const high = (data[at + 2]! & 1) === 1;
  const start = at + 3;
  const end = Math.min(data.length, start + (high ? cch * 2 : cch));
  return high ? data.toString('utf16le', start, end - ((end - start) % 2)) : data.toString('latin1', start, end);
}

/** ShortXLUnicodeString (a sheet name): cch u8, flags u8, chars. */
function shortString(data: Buffer, at: number): string {
  if (at + 2 > data.length) return '';
  const cch = data[at]!;
  const high = (data[at + 1]! & 1) === 1;
  const start = at + 2;
  const end = Math.min(data.length, start + (high ? cch * 2 : cch));
  return high ? data.toString('utf16le', start, end - ((end - start) % 2)) : data.toString('latin1', start, end);
}

/** An RK number: 30 bits of an integer or the top of a double, maybe ×100. */
export function rkValue(rk: number): number {
  const x100 = (rk & 1) === 1;
  let n: number;
  if (rk & 2) {
    n = (rk | 0) >> 2;
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    n = b.readDoubleLE(0);
  }
  return x100 ? n / 100 : n;
}

class Grid {
  private readonly rows = new Map<number, Map<number, Cell>>();
  private maxRow = -1;

  set(row: number, col: number, value: Cell): void {
    if (row >= MAX_ROWS || col >= MAX_COLS || value === null) return;
    if (typeof value === 'string' && value.trim() === '') return;
    let r = this.rows.get(row);
    if (!r) this.rows.set(row, (r = new Map()));
    r.set(col, value);
    if (row > this.maxRow) this.maxRow = row;
  }

  toRows(): Cell[][] {
    const out: Cell[][] = [];
    for (let r = 0; r <= this.maxRow; r += 1) {
      const cells = this.rows.get(r);
      if (!cells) {
        out.push([]);
        continue;
      }
      const width = Math.max(...cells.keys()) + 1;
      const row: Cell[] = new Array(width).fill(null);
      for (const [c, v] of cells) row[c] = v;
      out.push(row);
    }
    return out;
  }
}

/** A real Excel 97-2003 file, read into rows per worksheet. */
export function readXls(body: Buffer): XlsRead {
  let stream: Buffer;
  try {
    const container = CFB.read(body, { type: 'buffer' });
    const book = CFB.find(container, 'Workbook') ?? CFB.find(container, 'Book');
    if (!book) return { ok: false, reason: 'broken' };
    // «Book» is the Excel 5/95 stream name; its strings are in a codepage this
    // reader does not carry. Said, not guessed.
    if (book.name === 'Book') return { ok: false, reason: 'old_format' };
    stream = Buffer.from(book.content as Uint8Array);
  } catch {
    return { ok: false, reason: 'broken' };
  }

  try {
    const first = recordAt(stream, 0);
    if (!first || first.type !== R.BOF) return { ok: false, reason: 'broken' };
    if (first.data.length < 2 || first.data.readUInt16LE(0) !== 0x0600) {
      return { ok: false, reason: 'old_format' };
    }

    // The workbook globals: the sheet directory and the shared strings.
    // A directory entry costs 13 bytes and a whole sheet's parse, so the same
    // offset is read once and the directory stops at `MAX_SHEETS`.
    const sheetDir: { at: number; name: string; hidden: boolean }[] = [];
    const seen = new Set<number>();
    let sst: string[] = [];
    let at = first.next;
    for (let rec = recordAt(stream, at); rec; rec = recordAt(stream, at)) {
      at = rec.next;
      if (rec.type === R.EOF) break;
      if (rec.type === R.FILEPASS) return { ok: false, reason: 'encrypted' };
      if (rec.type === R.BOUNDSHEET && rec.data.length >= 8) {
        const offset = rec.data.readUInt32LE(0);
        // dt = 0 is a worksheet; charts and macro sheets carry no cells. The
        // low two bits of hsState say visible (0), hidden or very hidden.
        if (rec.data[5] === 0 && !seen.has(offset) && sheetDir.length < MAX_SHEETS) {
          seen.add(offset);
          sheetDir.push({ at: offset, name: shortString(rec.data, 6), hidden: (rec.data[4]! & 0x03) !== 0 });
        }
      } else if (rec.type === R.SST && rec.data.length >= 8) {
        const segs = [rec.data.subarray(8)];
        for (let more = recordAt(stream, at); more && more.type === R.CONTINUE; more = recordAt(stream, at)) {
          segs.push(more.data);
          at = more.next;
        }
        const unique = rec.data.readUInt32LE(4);
        const cur = new Segments(segs);
        // Never trust the count beyond what the bytes can hold.
        const cap = Math.min(unique, 1_000_000);
        sst = [];
        for (let i = 0; i < cap; i += 1) {
          try {
            sst.push(richString(cur));
          } catch {
            break;
          }
        }
      }
    }

    const sheets: SheetRows[] = [];
    // Real sheets never overlap, so a real file never walks a byte twice;
    // entries at DISTINCT offsets into one sheet's records (the dedupe's
    // bypass) stop once the whole stream has been walked once, and the sheet
    // the budget ran out in is not answered half-read.
    let walked = 0;
    for (const { at: sheetAt, name, hidden } of sheetDir) {
      const bof = recordAt(stream, sheetAt);
      if (!bof || bof.type !== R.BOF) continue;
      const grid = new Grid();
      let pendingString: { row: number; col: number } | null = null;
      let p = bof.next;
      for (let rec = recordAt(stream, p); rec; rec = recordAt(stream, p)) {
        walked += rec.next - p;
        p = rec.next;
        const d = rec.data;
        if (rec.type === R.EOF || walked > stream.length) break;
        if (rec.type === R.STRING && pendingString) {
          grid.set(pendingString.row, pendingString.col, plainString(d, 0));
          pendingString = null;
          continue;
        }
        if (pendingString && BETWEEN_FORMULA_AND_STRING.has(rec.type)) continue;
        pendingString = null;
        if (d.length < 6) continue;
        const row = d.readUInt16LE(0);
        const col = d.readUInt16LE(2);
        switch (rec.type) {
          case R.LABELSST:
            if (d.length >= 10) grid.set(row, col, sst[d.readUInt32LE(6)] ?? null);
            break;
          case R.LABEL:
            grid.set(row, col, plainString(d, 6));
            break;
          case R.NUMBER:
            if (d.length >= 14) grid.set(row, col, d.readDoubleLE(6));
            break;
          case R.RK:
            if (d.length >= 10) grid.set(row, col, rkValue(d.readUInt32LE(6)));
            break;
          case R.MULRK: {
            const count = Math.floor((d.length - 6) / 6);
            for (let i = 0; i < count; i += 1) {
              grid.set(row, col + i, rkValue(d.readUInt32LE(4 + i * 6 + 2)));
            }
            break;
          }
          case R.FORMULA:
            if (d.length >= 14) {
              if (d.readUInt16LE(12) === 0xffff) {
                // A cached non-number: a string arrives in the next STRING
                // record; a boolean is a word; an error or empty is nothing.
                const kind = d[6];
                if (kind === 0) pendingString = { row, col };
                else if (kind === 1) grid.set(row, col, d[8] ? 'TRUE' : 'FALSE');
              } else {
                grid.set(row, col, d.readDoubleLE(6));
              }
            }
            break;
          case R.BOOLERR:
            if (d.length >= 8 && d[7] === 0) grid.set(row, col, d[6] ? 'TRUE' : 'FALSE');
            break;
          default:
            break;
        }
      }
      if (walked > stream.length) break;
      sheets.push(hidden ? { name, rows: grid.toRows(), hidden } : { name, rows: grid.toRows() });
    }
    return { ok: true, sheets };
  } catch {
    return { ok: false, reason: 'broken' };
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * A cell's markup → its text. `<[^<>]*>`, not `<[^>]*>`: a cell holding many
 * «<» and no «>» made every «<» scan to the end of the cell (quadratic); this
 * one stops at the next «<».
 */
const cellOf = (html: string): Cell => {
  const text = decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^<>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text;
};

/** Which markup a text file is — decided before any reader runs. */
export function markupOf(text: string): 'spreadsheetml' | 'html' | null {
  if (/urn:schemas-microsoft-com:office:spreadsheet/.test(text) && /<(?:ss:)?Workbook\b/.test(text)) {
    return 'spreadsheetml';
  }
  return /<table[\s>]/i.test(text) ? 'html' : null;
}

/** The text up to a closer, or all of it when the closer was left out. */
function upTo(piece: string, closer: RegExp): string {
  const end = piece.search(closer);
  return end < 0 ? piece : piece.slice(0, end);
}

/**
 * A figure as a cell holds it — «900», «1 200,50», «120KGS», «12.5 CBM»,
 * «$500», «USD 500», «15%» — and not a word.
 */
const FIGURE = /^(?:\p{Lu}{3}\s*)?[-+]?[$€¥₽£]?\s*\d[\d\s.,]*(?:\p{L}{1,6}\.?|[%$€¥₽£])?$/u;

/**
 * What a position covered by a merge DOWN its master's column reads as, in
 * every format (S8, S11 — the second review). A TEXT is repeated: a name
 * merged over the two lines packed in one carton names both, where the
 * covered row used to lose its name and be dropped as no product at all. A
 * FIGURE is null: a carton's weight or amount merged over its lines is stated
 * once and counted once. A position covered to the RIGHT of its master is
 * null whatever it holds, so a title merged across the sheet stays ONE cell
 * and is never mistaken for a header.
 */
export function coveredValue(value: Cell): Cell {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' || FIGURE.test(text) ? null : value;
}

/** A span attribute (`colspan="2"`): a whole number from 1 up to `max`. */
function spanOf(attrs: string, name: RegExp, max: number): number {
  const n = Number(name.exec(attrs)?.[1] ?? 1);
  return n >= 1 ? Math.min(Math.floor(n), Math.max(1, max)) : 1;
}

/**
 * An HTML page with a table — a web system's «Excel» export.
 *
 * TOKENISED, never matched lazily to a closer: HTML lets `</tr>` and `</td>`
 * be left out, and `<tr>(.*?)</tr>` then scanned from every row to the end of
 * the file — 930 KB of rows froze the app for 10.8 s and still read nothing
 * (the review). Each piece is cut at its OWN optional closer, so the pass is
 * linear and an omitted closer reads the way a browser reads it.
 *
 * Spans keep every column where the header put it (the review: a two-row
 * header «Вес, кг» over «нетто | брутто» read the gross weight as the line's
 * money, and the sub-header became a product). A covered position reads as
 * `coveredValue` says — a merged amount or carton weight is stated ONCE, so
 * it is counted once; a merged NAME names every row it covers (S8), and the
 * sub-header row under a two-row header, which now repeats the header's own
 * name, is no product (`parseGoods` skips a row that names the header).
 */
export function htmlTableSheets(text: string): SheetRows[] | null {
  if (markupOf(text) !== 'html') return null;
  const sheets: SheetRows[] = [];
  const tables = text.split(/<table\b[^<>]*>/i).slice(1);
  for (const [n, piece] of tables.entries()) {
    if (sheets.length >= MAX_SHEETS) break;
    const rows: Cell[][] = [];
    const spans = new DownSpans();
    for (const tr of upTo(piece, /<\/table\s*>/i).split(/<tr\b[^<>]*>/i).slice(1)) {
      if (rows.length >= MAX_ROWS) break;
      const parts = upTo(tr, /<\/tr\s*>/i).split(/(<t[dh]\b[^<>]*>)/i);
      const cells: Cell[] = [];
      for (let i = 1; i + 1 < parts.length; i += 2) {
        // A browser places a cell past the positions a rowspan above covers.
        while (cells.length < MAX_COLS && spans.covers(cells.length)) cells.push(spans.take(cells.length));
        if (cells.length >= MAX_COLS) break;
        const tag = parts[i]!;
        const col = cells.length;
        const colspan = spanOf(tag, /\bcolspan\s*=\s*["']?\s*(\d+)/i, MAX_COLS - col);
        const rowspan = spanOf(tag, /\browspan\s*=\s*["']?\s*(\d+)/i, MAX_ROWS);
        const value = cellOf(upTo(parts[i + 1]!, /<\/t[dh]\s*>/i));
        cells.push(value);
        for (let k = 1; k < colspan; k += 1) cells.push(null);
        spans.open(col, colspan, rowspan - 1, value);
      }
      rows.push(spans.finish(cells));
    }
    if (rows.length > 0) sheets.push({ name: `Jadval ${n + 1}`, rows });
  }
  return sheets.length > 0 ? sheets : null;
}

/**
 * The merges DOWN still open over the next rows, per column — one home for
 * the HTML rowspan and SpreadsheetML's `MergeDown`, so the two read a merged
 * cell the same way (`coveredValue`, S8/S11).
 */
class DownSpans {
  /** Per column: how many more rows a merge above still covers… */
  private readonly left: number[] = [];
  /** …and what the covered position reads as. */
  private readonly value: Cell[] = [];

  /** A cell at `col`, `across` wide, covering `down` more rows. */
  open(col: number, across: number, down: number, value: Cell): void {
    for (let k = 0; k < across && col + k < MAX_COLS; k += 1) {
      this.left[col + k] = down;
      this.value[col + k] = k === 0 ? coveredValue(value) : null;
    }
  }

  covers(col: number): boolean {
    return (this.left[col] ?? 0) > 0;
  }

  /** The covered position's value, the merge one row nearer its end. */
  take(col: number): Cell {
    this.left[col]! -= 1;
    return this.value[col] ?? null;
  }

  /** A cell the writer put on a covered position wins it; the merge still moves on. */
  claim(col: number): void {
    if (this.covers(col)) this.left[col]! -= 1;
  }

  /**
   * The row with the positions a merge still covers past its last cell —
   * a merged name in the last column, or a row with no cells of its own —
   * and no trailing empties.
   */
  finish(cells: Cell[]): Cell[] {
    const own = cells.length;
    for (let c = own; c < Math.min(this.left.length, MAX_COLS); c += 1) {
      cells.push(this.covers(c) ? this.take(c) : null);
    }
    while (cells.length > own && cells[cells.length - 1] === null) cells.pop();
    return cells;
  }
}

/**
 * Excel 2003 «XML Spreadsheet» — tokenised like the HTML table, for the same
 * reason (an unclosed `<Row>` was the same quadratic scan). `ss:Index` places
 * a cell after skipped ones and `ss:MergeAcross` covers the cells to its
 * right. A merge DOWN (`ss:MergeDown`) leaves the covered positions out of the
 * next rows — the writer gives the cells after them their own `ss:Index` —
 * and those positions read as the HTML reader reads a rowspan (`DownSpans`,
 * S11): a merged name repeated, a merged figure counted once.
 */
export function spreadsheetMlSheets(text: string): SheetRows[] | null {
  if (markupOf(text) !== 'spreadsheetml') return null;
  const sheets: SheetRows[] = [];
  const parts = text.split(/<(?:ss:)?Worksheet\b([^<>]*)>/);
  for (let w = 1; w + 1 < parts.length && sheets.length < MAX_SHEETS; w += 2) {
    const body = upTo(parts[w + 1]!, /<\/(?:ss:)?Worksheet\s*>/);
    const name = /(?:ss:)?Name\s*=\s*"([^"]*)"/.exec(parts[w]!)?.[1] ?? `Varaq ${sheets.length + 1}`;
    const rows: Cell[][] = [];
    const spans = new DownSpans();
    const rowParts = body.split(/<(?:ss:)?Row\b([^<>]*)>/);
    for (let r = 1; r + 1 < rowParts.length; r += 2) {
      if (rows.length >= MAX_ROWS) break;
      const cells: Cell[] = [];
      // `<Row/>` is an empty row; what follows it belongs to no row.
      if (!rowParts[r]!.endsWith('/')) {
        const cellParts = upTo(rowParts[r + 1]!, /<\/(?:ss:)?Row\s*>/).split(/<(?:ss:)?Cell\b([^<>]*)>/);
        for (let c = 1; c + 1 < cellParts.length; c += 2) {
          const attrs = cellParts[c]!;
          const index = /(?:ss:)?Index\s*=\s*"(\d+)"/.exec(attrs);
          if (index) {
            const at = Number(index[1]) - 1;
            while (cells.length < at && cells.length < MAX_COLS) {
              cells.push(spans.covers(cells.length) ? spans.take(cells.length) : null);
            }
          }
          if (cells.length >= MAX_COLS) break;
          let value: Cell = null;
          if (!attrs.endsWith('/')) {
            const content = upTo(cellParts[c + 1]!, /<\/(?:ss:)?Cell\s*>/);
            const open = /<(?:ss:)?Data\b[^<>]*>/.exec(content);
            if (open) value = cellOf(upTo(content.slice(open.index + open[0].length), /<\/(?:ss:)?Data\s*>/));
          }
          const col = cells.length;
          spans.claim(col);
          cells.push(value);
          // MergeAcross="N" covers N cells MORE; MergeDown="N" N rows more.
          const across = Number(/(?:ss:)?MergeAcross\s*=\s*"(\d+)"/.exec(attrs)?.[1] ?? 0);
          for (let k = 0; k < across && cells.length < MAX_COLS; k += 1) {
            spans.claim(cells.length);
            cells.push(null);
          }
          const down = Math.min(Number(/(?:ss:)?MergeDown\s*=\s*"(\d+)"/.exec(attrs)?.[1] ?? 0), MAX_ROWS);
          if (down > 0) spans.open(col, across + 1, down, value);
        }
      }
      rows.push(spans.finish(cells));
    }
    const sheet: SheetRows = { name: decodeEntities(name), rows };
    // WorksheetOptions' <Visible>SheetHidden</Visible> (or …VeryHidden).
    if (/<(?:x:)?Visible>\s*Sheet(?:Very)?Hidden\b/.test(body)) sheet.hidden = true;
    sheets.push(sheet);
  }
  return sheets.length > 0 ? sheets : null;
}
