import * as CFB from 'cfb';
import { CoverMask, SHEET_MAX_COLS, type Cell, type Covered } from './goods-import';

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
export const MAX_COLS = SHEET_MAX_COLS;
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
  /**
   * The positions a merge DOWN covers, which hold their master's value
   * repeated (R3-S3): `parseGoods` counts a covered figure once and reads a
   * covered name or code as the line's own, and the model's text leaves a
   * covered figure empty. Present only when a merge covers something.
   */
  covered?: Covered;
  /**
   * The reader left out a row past `MAX_ROWS` (`rowsLeftOut`) or a cell past
   * `MAX_COLS` (`colsLeftOut`) that HELD something — an empty tail is no
   * loss. The bound protects the process; it must not hide a line (the
   * fourth review: «LAST» at line 5,500 of a CSV and two figured lines at
   * A5200 were dropped and `readGoodsFile` said nothing), so the cut is said:
   * a row left out as `textCut`, a cell as `cellsCut` (R3-S6).
   */
  rowsLeftOut?: true;
  colsLeftOut?: true;
}

/** A sheet's two left-out words, set only when true — every reader's one shape. */
export function withLeftOut(sheet: SheetRows, rows: boolean, cols: boolean): SheetRows {
  if (rows) sheet.rowsLeftOut = true;
  if (cols) sheet.colsLeftOut = true;
  return sheet;
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
  MERGEDCELLS: 0x00e5,
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
  rowsLeftOut = false;
  colsLeftOut = false;

  set(row: number, col: number, value: Cell): void {
    if (value === null || (typeof value === 'string' && value.trim() === '')) return;
    if (row >= MAX_ROWS || col >= MAX_COLS) {
      if (row >= MAX_ROWS) this.rowsLeftOut = true;
      else this.colsLeftOut = true;
      return;
    }
    let r = this.rows.get(row);
    if (!r) this.rows.set(row, (r = new Map()));
    r.set(col, value);
    if (row > this.maxRow) this.maxRow = row;
  }

  get(row: number, col: number): Cell {
    return this.rows.get(row)?.get(col) ?? null;
  }

  /** A position's value gone: the cells a merge covers to the RIGHT of its master read as nothing. */
  clear(row: number, col: number): void {
    this.rows.get(row)?.delete(col);
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

/** One merged range, inclusive, as BIFF8's Ref8 states it. */
interface Merge {
  r1: number;
  r2: number;
  c1: number;
  c2: number;
}

/**
 * Excel 97's merged cells, read the way the other three readers read theirs
 * (R3-S3; the fourth review: an .xls ignored them, so a name merged over two
 * lines named only the first and the second line, its own figures and all,
 * was dropped as no product): DOWN the master's own column its value repeats
 * and the position is covered; to its RIGHT a covered position reads as
 * nothing. LibreOffice and Excel write a BLANK record in a covered cell, so
 * the grid holds nothing there to keep.
 *
 * Bounded like the rest of the reader: a stranger's file can state a merge
 * of the whole sheet a thousand times, so the positions all its merges touch
 * together stop at one sheet's worth (`MAX_ROWS` × `MAX_COLS`).
 */
function applyMerges(grid: Grid, merges: readonly Merge[]): CoverMask {
  const covered = new CoverMask();
  let budget = MAX_ROWS * MAX_COLS;
  for (const m of merges) {
    const lastRow = Math.min(m.r2, MAX_ROWS - 1);
    const lastCol = Math.min(m.c2, MAX_COLS - 1);
    if (m.r1 > lastRow || m.c1 > lastCol) continue;
    const area = (lastRow - m.r1 + 1) * (lastCol - m.c1 + 1);
    if (area > budget) break;
    budget -= area;
    const master = grid.get(m.r1, m.c1);
    for (let r = m.r1; r <= lastRow; r += 1) {
      for (let c = m.c1; c <= lastCol; c += 1) {
        if (r === m.r1 && c === m.c1) continue;
        if (c === m.c1 && master !== null) {
          grid.set(r, c, master);
          covered.add(r, c);
        } else {
          grid.clear(r, c);
        }
      }
    }
  }
  return covered;
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
      const merges: Merge[] = [];
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
        if (rec.type === R.MERGEDCELLS) {
          // cmcs, then cmcs × Ref8 (first row, last row, first col, last
          // col); a sheet may carry several such records.
          const count = d.length >= 2 ? Math.min(d.readUInt16LE(0), Math.floor((d.length - 2) / 8)) : 0;
          for (let i = 0; i < count; i += 1) {
            const at = 2 + i * 8;
            merges.push({ r1: d.readUInt16LE(at), r2: d.readUInt16LE(at + 2), c1: d.readUInt16LE(at + 4), c2: d.readUInt16LE(at + 6) });
          }
          continue;
        }
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
      const covered = applyMerges(grid, merges);
      const sheet = withCovered(hidden ? { name, rows: grid.toRows(), hidden } : { name, rows: grid.toRows() }, covered);
      sheets.push(withLeftOut(sheet, grid.rowsLeftOut, grid.colsLeftOut));
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
 * money, and the sub-header became a product). A rowspan repeats its value
 * DOWN its own column and says which positions it covers (`DownSpans`,
 * R3-S3): a merged name or code names every row it covers, a merged carton
 * weight or amount is counted once, and the sub-header row under a two-row
 * header, which repeats the header's own name, is no product (`parseGoods`
 * skips a row that names the header).
 */
export function htmlTableSheets(text: string): SheetRows[] | null {
  if (markupOf(text) !== 'html') return null;
  const sheets: SheetRows[] = [];
  const tables = text.split(/<table\b[^<>]*>/i).slice(1);
  for (const [n, piece] of tables.entries()) {
    if (sheets.length >= MAX_SHEETS) break;
    const rows: Cell[][] = [];
    const spans = new DownSpans();
    let rowsLeftOut = false;
    let colsLeftOut = false;
    for (const tr of upTo(piece, /<\/table\s*>/i).split(/<tr\b[^<>]*>/i).slice(1)) {
      const parts = upTo(tr, /<\/tr\s*>/i).split(/(<t[dh]\b[^<>]*>)/i);
      if (rows.length >= MAX_ROWS) {
        // Past the bound only to learn whether anything was left out — and
        // stopped at the first row that holds something.
        if (cellsHoldText(parts, 1)) {
          rowsLeftOut = true;
          break;
        }
        continue;
      }
      spans.row = rows.length;
      const cells: Cell[] = [];
      for (let i = 1; i + 1 < parts.length; i += 2) {
        // A browser places a cell past the positions a rowspan above covers.
        while (cells.length < MAX_COLS && spans.covers(cells.length)) cells.push(spans.take(cells.length));
        if (cells.length >= MAX_COLS) {
          if (cellsHoldText(parts, i)) colsLeftOut = true;
          break;
        }
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
    if (rows.length > 0) {
      sheets.push(withLeftOut(withCovered({ name: `Jadval ${n + 1}`, rows }, spans.covered), rowsLeftOut, colsLeftOut));
    }
  }
  return sheets.length > 0 ? sheets : null;
}

/** Does any cell from `parts[from]` on (a row split on its cell tags) hold text? */
function cellsHoldText(parts: readonly string[], from: number): boolean {
  for (let i = from; i + 1 < parts.length; i += 2) {
    if (cellOf(upTo(parts[i + 1]!, /<\/t[dh]\s*>/i)) !== null) return true;
  }
  return false;
}

/** A sheet, carrying its covered positions only when a merge covers any — every reader's one shape. */
export function withCovered(sheet: SheetRows, covered: CoverMask): SheetRows {
  return covered.size > 0 ? { ...sheet, covered } : sheet;
}

/**
 * The merges DOWN still open over the next rows, per column — one home for
 * the HTML rowspan and SpreadsheetML's `MergeDown`, so the two read a merged
 * cell the same way, and the way exceljs reads an .xlsx (R3-S3): DOWN the
 * master's own column the value repeats and the position is `covered`; to
 * the RIGHT of the master a covered position is null whatever it holds, so a
 * title merged across the sheet stays ONE cell and is never mistaken for a
 * header (S11).
 *
 * The decision is by POSITION, never by what the text looks like: the second
 * round's content rule nulled anything shaped like a figure, and a TNVED code
 * merged over the lines sharing it, a merged unit price and the names «LED
 * 50W», «USB 3.0», «12V», «42 размер» were lost with the cartons' weights —
 * the covered line dropped as no product, in silence. It also ran a pattern
 * over the master's whole text for every covered cell (R3-S7: 18.7 s measured
 * for one 370 KB .xlsx); a repeat is a reference.
 */
class DownSpans {
  /** Per column: how many more rows a merge above still covers… */
  private readonly left: number[] = [];
  /** …what the covered position reads as… */
  private readonly value: Cell[] = [];
  /** …and whether it is DOWN its master's own column. */
  private readonly repeats: boolean[] = [];
  /** The positions that repeat a master, for `SheetRows.covered`. */
  readonly covered = new CoverMask();
  /** The row the covered positions taken next stand in. */
  row = 0;

  /** A cell at `col`, `across` wide, covering `down` more rows. */
  open(col: number, across: number, down: number, value: Cell): void {
    for (let k = 0; k < across && col + k < MAX_COLS; k += 1) {
      this.left[col + k] = down;
      this.value[col + k] = k === 0 ? value : null;
      this.repeats[col + k] = k === 0 && value !== null;
    }
  }

  covers(col: number): boolean {
    return (this.left[col] ?? 0) > 0;
  }

  /** The covered position's value, the merge one row nearer its end. */
  take(col: number): Cell {
    this.left[col]! -= 1;
    if (this.repeats[col]) this.covered.add(this.row, col);
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
 * S11, R3-S3): the value repeated down its column, the position covered.
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
    let rowsLeftOut = false;
    let colsLeftOut = false;
    const rowParts = body.split(/<(?:ss:)?Row\b([^<>]*)>/);
    for (let r = 1; r + 1 < rowParts.length; r += 2) {
      // `<Row/>` is an empty row; what follows it belongs to no row.
      const cellParts = rowParts[r]!.endsWith('/')
        ? []
        : upTo(rowParts[r + 1]!, /<\/(?:ss:)?Row\s*>/).split(/<(?:ss:)?Cell\b([^<>]*)>/);
      if (rows.length >= MAX_ROWS) {
        // Past the bound only to learn whether anything was left out, as the HTML reader.
        if (xmlCellsHoldText(cellParts, 1)) {
          rowsLeftOut = true;
          break;
        }
        continue;
      }
      spans.row = rows.length;
      const cells: Cell[] = [];
      for (let c = 1; c + 1 < cellParts.length; c += 2) {
        const attrs = cellParts[c]!;
        const index = /(?:ss:)?Index\s*=\s*"(\d+)"/.exec(attrs);
        if (index) {
          const at = Number(index[1]) - 1;
          while (cells.length < at && cells.length < MAX_COLS) {
            cells.push(spans.covers(cells.length) ? spans.take(cells.length) : null);
          }
        }
        if (cells.length >= MAX_COLS) {
          if (xmlCellsHoldText(cellParts, c)) colsLeftOut = true;
          break;
        }
        const value = xmlCellValue(attrs, cellParts[c + 1]!);
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
      rows.push(spans.finish(cells));
    }
    const sheet: SheetRows = withLeftOut(withCovered({ name: decodeEntities(name), rows }, spans.covered), rowsLeftOut, colsLeftOut);
    // WorksheetOptions' <Visible>SheetHidden</Visible> (or …VeryHidden).
    if (/<(?:x:)?Visible>\s*Sheet(?:Very)?Hidden\b/.test(body)) sheet.hidden = true;
    sheets.push(sheet);
  }
  return sheets.length > 0 ? sheets : null;
}

/** A SpreadsheetML cell's text: its <Data>, or nothing for a self-closed cell. */
function xmlCellValue(attrs: string, after: string): Cell {
  if (attrs.endsWith('/')) return null;
  const content = upTo(after, /<\/(?:ss:)?Cell\s*>/);
  const open = /<(?:ss:)?Data\b[^<>]*>/.exec(content);
  return open ? cellOf(upTo(content.slice(open.index + open[0].length), /<\/(?:ss:)?Data\s*>/)) : null;
}

/** Does any cell from `cellParts[from]` on (a row split on its cell tags) hold text? */
function xmlCellsHoldText(cellParts: readonly string[], from: number): boolean {
  for (let c = from; c + 1 < cellParts.length; c += 2) {
    if (xmlCellValue(cellParts[c]!, cellParts[c + 1]!) !== null) return true;
  }
  return false;
}
