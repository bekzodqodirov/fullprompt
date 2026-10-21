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
 * Every answer is bounded (`MAX_ROWS` × `MAX_COLS`) — a stranger's file is
 * read, so its size is never trusted.
 */

export const MAX_ROWS = 5_000;
export const MAX_COLS = 100;

export interface SheetRows {
  name: string;
  rows: Cell[][];
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
} as const;

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
    const sheetDir: { at: number; name: string }[] = [];
    let sst: string[] = [];
    let at = first.next;
    for (let rec = recordAt(stream, at); rec; rec = recordAt(stream, at)) {
      at = rec.next;
      if (rec.type === R.EOF) break;
      if (rec.type === R.FILEPASS) return { ok: false, reason: 'encrypted' };
      if (rec.type === R.BOUNDSHEET && rec.data.length >= 8) {
        // dt = 0 is a worksheet; charts and macro sheets carry no cells.
        if (rec.data[5] === 0) sheetDir.push({ at: rec.data.readUInt32LE(0), name: shortString(rec.data, 6) });
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
    for (const { at: sheetAt, name } of sheetDir) {
      const bof = recordAt(stream, sheetAt);
      if (!bof || bof.type !== R.BOF) continue;
      const grid = new Grid();
      let pendingString: { row: number; col: number } | null = null;
      let p = bof.next;
      for (let rec = recordAt(stream, p); rec; rec = recordAt(stream, p)) {
        p = rec.next;
        const d = rec.data;
        if (rec.type === R.EOF) break;
        if (rec.type === R.STRING && pendingString) {
          grid.set(pendingString.row, pendingString.col, plainString(d, 0));
          pendingString = null;
          continue;
        }
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
      sheets.push({ name, rows: grid.toRows() });
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

const cellOf = (html: string): Cell => {
  const text = decodeEntities(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? null : text;
};

/** An HTML page with a table — a web system's «Excel» export. */
export function htmlTableSheets(text: string): SheetRows[] | null {
  if (!/<table[\s>]/i.test(text)) return null;
  const sheets: SheetRows[] = [];
  let n = 0;
  for (const table of text.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    n += 1;
    const rows: Cell[][] = [];
    for (const tr of table[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      if (rows.length >= MAX_ROWS) break;
      rows.push(
        [...tr[1]!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].slice(0, MAX_COLS).map((m) => cellOf(m[1]!)),
      );
    }
    if (rows.length > 0) sheets.push({ name: `Jadval ${n}`, rows });
  }
  return sheets.length > 0 ? sheets : null;
}

/** Excel 2003 «XML Spreadsheet». */
export function spreadsheetMlSheets(text: string): SheetRows[] | null {
  if (!/urn:schemas-microsoft-com:office:spreadsheet/.test(text) || !/<(?:ss:)?Workbook\b/.test(text)) {
    return null;
  }
  const sheets: SheetRows[] = [];
  for (const ws of text.matchAll(/<(?:ss:)?Worksheet\b([^>]*)>([\s\S]*?)<\/(?:ss:)?Worksheet>/g)) {
    const name = /(?:ss:)?Name="([^"]*)"/.exec(ws[1]!)?.[1] ?? `Varaq ${sheets.length + 1}`;
    const rows: Cell[][] = [];
    for (const row of ws[2]!.matchAll(/<(?:ss:)?Row\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:ss:)?Row>)/g)) {
      if (rows.length >= MAX_ROWS) break;
      const cells: Cell[] = [];
      for (const cell of (row[1] ?? '').matchAll(/<(?:ss:)?Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:ss:)?Cell>)/g)) {
        const index = /(?:ss:)?Index="(\d+)"/.exec(cell[1]!);
        if (index) {
          const at = Number(index[1]) - 1;
          while (cells.length < at && cells.length < MAX_COLS) cells.push(null);
        }
        if (cells.length >= MAX_COLS) break;
        const data = /<(?:ss:)?Data\b[^>]*>([\s\S]*?)<\/(?:ss:)?Data>/.exec(cell[2] ?? '');
        cells.push(data ? cellOf(data[1]!) : null);
      }
      rows.push(cells);
    }
    sheets.push({ name: decodeEntities(name), rows });
  }
  return sheets.length > 0 ? sheets : null;
}
