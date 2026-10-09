/**
 * The rows a person types or pastes goods into — the seller's «Hisoblatishga
 * yuborish» table and the VED's «Ro'yxatdan qo'shish» paste — as pure
 * functions over the kernel (docs/RASTAMOJKA-TUZATISH.md P1.1, P1.6, §7.1).
 *
 * The owner's first complaint, verbatim: «tnved code va dona m2 juftda
 * otadgan tovarlarni kirgizadgan joyi yoqku». The form had ONE textarea read
 * as «nomi, soni[, birlik]», so «Kafel, 120 m2» lost its 120, «1,5» became a
 * count of 1 with the unit «5», and nothing could carry a code, a net weight
 * or a pair. Every reading here is the kernel's (`parseGoodsLine`,
 * `readNumberCell`, `normalizeRowUnit`, `normalizeTnved` via `doorRow`):
 * this file decides only how a row LOOKS and what blocks a send.
 *
 * Pure and import-light, because the browser runs all of it.
 */
import { doorRow, type DoorItemInput, type DoorRow } from './door-row';
import { detectColumns, parseGoods, type Cell } from '../deals/goods-import';
import { readNumberCell, type NumberCell } from './number-cell';
import type { MeasureUnit } from './pricing';
import {
  normalizeRowUnit,
  normalizeTnved,
  parseGoodsLine,
  unitOf,
  type GoodsLine,
  type GoodsLineProblem,
} from './units';

/** The one «amount + unit» cell of a row: a pair unit, or m³ (`volume_m3`). */
export type AmountUnit = 'm2' | 'juft' | 'litr' | 'm3';
export const AMOUNT_UNITS: readonly AmountUnit[] = ['m2', 'juft', 'litr', 'm3'];

/**
 * One product, two lines in the card's 358 px rail (judge UX1): name · dona
 * · ✕ over netto kg · amount + unit · TNVED. Every cell is TEXT, read only on
 * send, so a refused send keeps every keystroke (#377, #463).
 */
export interface SendRow {
  key: number;
  name: string;
  qty: string;
  kg: string;
  amount: string;
  unit: AmountUnit;
  code: string;
  /** Words the row carries to the VED that no cell holds — a carton count,
   * a unit nobody prices. They become the row's note, never a number. */
  notes: string[];
  /** The seller's own count word («шт») — kept for display (his 20a). */
  countWord: string | null;
  /** A volume read beside a pair, which the one amount cell cannot hold. */
  extraVolume: number | null;
  /** The text this row was read from, while a problem on it is unanswered. */
  raw: string | null;
  problems: GoodsLineProblem[];
  /** A person typed in it — a blank, touched row stays on screen. */
  touched: boolean;
}

export function blankRow(key: number): SendRow {
  return {
    key,
    name: '',
    qty: '',
    kg: '',
    amount: '',
    unit: 'm2',
    code: '',
    notes: [],
    countWord: null,
    extraVolume: null,
    raw: null,
    problems: [],
    touched: false,
  };
}

const num = (n: number | null) => (n === null ? '' : String(n));

/** The carton / unknown-unit words a line states, as the door's own note. */
function lineNotes(line: GoodsLine): string[] {
  const notes: string[] = [];
  if (line.cartons !== null) {
    const word = line.unitWords.find((w) => unitOf(w) === 'karobka') ?? 'karobka';
    const moved = normalizeRowUnit({
      quantity: line.cartons,
      unit: word,
      weightKg: null,
      volumeM3: null,
      measureUnit: null,
      measureQty: null,
    });
    if (moved.moved) notes.push(moved.note);
  }
  for (const p of line.problems) {
    if (p.kind !== 'unknown_unit') continue;
    const moved = normalizeRowUnit({
      quantity: p.value,
      unit: p.word,
      weightKg: null,
      volumeM3: null,
      measureUnit: null,
      measureQty: null,
    });
    if (moved.moved) notes.push(moved.note);
  }
  return notes;
}

/** A read line as a row — its raw text kept while a problem stands on it. */
export function rowOfLine(line: GoodsLine, key: number, raw: string): SendRow {
  const pair = line.measureUnit !== null && line.measureUnit !== 'sm3' ? line.measureUnit : null;
  const amountUnit: AmountUnit = pair ?? 'm3';
  const amount = pair ? line.measureQty : line.volumeM3;
  const blocking = line.problems.filter(isBlockingProblem);
  return {
    key,
    name: line.name,
    qty: num(line.quantity),
    kg: num(line.weightKg),
    amount: num(amount),
    unit: amount === null ? 'm2' : amountUnit,
    // A sm³ pair is a vehicle's engine — no amount cell holds it, so it rides
    // in the note rather than vanishing.
    code: line.tnvedCode ?? codeShortText(line) ?? '',
    notes: [
      ...lineNotes(line),
      ...(line.measureUnit === 'sm3' && line.measureQty !== null ? [`sotuvchi: ${line.measureQty} sm³`] : []),
    ],
    countWord: line.unitWords.find((w) => unitOf(w) === 'dona') ?? null,
    extraVolume: pair && line.volumeM3 !== null ? line.volumeM3 : null,
    raw: blocking.length > 0 ? raw : null,
    problems: line.problems,
    touched: true,
  };
}

function codeShortText(line: GoodsLine): string | null {
  const p = line.problems.find((x) => x.kind === 'code_short');
  return p && p.kind === 'code_short' ? p.text : null;
}

/**
 * Only these stop a send (judge UX3): a number that reads two ways, two
 * pairs on one line, or two bare numbers whose order is a guess — each a
 * question with one-tap answers. A carton count or an unknown unit is a fact
 * the seller often cannot resolve on the spot; it is sent, with a chip, and
 * the door writes the note.
 */
export function isBlockingProblem(p: GoodsLineProblem): boolean {
  return p.kind === 'ambiguous' || p.kind === 'two_pairs' || p.kind === 'unlabelled';
}

/** The quick textarea's lines, read LIVE into rows (judge UX2). */
export function textRows(text: string, firstKey: number): SendRow[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim())
    .map((l, i) => rowOfLine(parseGoodsLine(l), firstKey + i, l));
}

/** A deal's own goods line as a row — `routeAmount` through the door's rule. */
export function rowFromDealLine(
  dl: {
    name: string;
    tnvedCode: string | null;
    quantity: number | null;
    unit: string | null;
    weightKg: number | null;
    volumeM3: number | null;
  },
  key: number,
): SendRow {
  const moved = normalizeRowUnit({
    quantity: dl.quantity,
    unit: dl.unit,
    weightKg: dl.weightKg,
    volumeM3: dl.volumeM3,
    measureUnit: null,
    measureQty: null,
  });
  const r = moved.moved
    ? moved.patch
    : { quantity: dl.quantity, weightKg: dl.weightKg, volumeM3: dl.volumeM3, measureUnit: null, measureQty: null };
  const pair = r.measureUnit !== null && r.measureUnit !== 'sm3' ? r.measureUnit : null;
  return {
    ...blankRow(key),
    name: dl.name,
    qty: num(r.quantity),
    kg: num(r.weightKg),
    amount: num(pair ? r.measureQty : r.volumeM3),
    unit: pair ?? (r.volumeM3 !== null ? 'm3' : 'm2'),
    code: dl.tnvedCode ?? '',
    extraVolume: pair ? r.volumeM3 : null,
    notes: moved.moved && (moved.to === 'cartons' || moved.to === 'unknown' || moved.conflict) ? [moved.note] : [],
    countWord: !moved.moved && dl.unit && unitOf(dl.unit) === 'dona' ? dl.unit : null,
    touched: true,
  };
}

/** Nothing typed and nothing carried — the row is not a product. */
export function isBlankRow(row: SendRow): boolean {
  return (
    !row.name.trim() &&
    !row.qty.trim() &&
    !row.kg.trim() &&
    !row.amount.trim() &&
    !row.code.trim() &&
    row.notes.length === 0 &&
    row.extraVolume === null &&
    row.problems.length === 0
  );
}

export type CellField = 'qty' | 'kg' | 'amount';
export const CELL_FIELDS: readonly CellField[] = ['qty', 'kg', 'amount'];

export type RowIssue =
  | { kind: 'no_name' }
  | { kind: 'cell'; field: CellField; cell: Extract<NumberCell, { state: 'ambiguous' | 'bad' }>; text: string }
  | { kind: 'line'; problem: GoodsLineProblem };

/** What stops this row being sent, and what is only said beside it. */
export function rowIssues(row: SendRow): { blocking: RowIssue[]; said: RowIssue[] } {
  const blocking: RowIssue[] = [];
  const said: RowIssue[] = [];
  if (isBlankRow(row)) return { blocking, said };
  if (!row.name.trim()) blocking.push({ kind: 'no_name' });
  for (const field of CELL_FIELDS) {
    const cell = readNumberCell(row[field]);
    if (cell.state === 'ambiguous' || cell.state === 'bad') blocking.push({ kind: 'cell', field, cell, text: row[field] });
  }
  for (const problem of row.problems) {
    if (isBlockingProblem(problem)) {
      if (row.raw !== null) blocking.push({ kind: 'line', problem });
    } else if (problem.kind !== 'unknown_unit' && problem.kind !== 'cartons_only') {
      // A carton count and an unknown unit are said by the row's notes.
      said.push({ kind: 'line', problem });
    }
  }
  return { blocking, said };
}

const cellValue = (text: string): number | null => {
  const cell = readNumberCell(text);
  return cell.state === 'ok' && cell.value > 0 ? cell.value : null;
};

/**
 * The row as the door takes it — STRUCTURED: the count in pieces, the net
 * weight, the pair or the volume, the code as typed (the door shape-checks
 * it and notes a bad one). Null for a blank row. Never derives a weight from
 * the shipment total: the row has its own netto cell (judge MR-7).
 */
export function itemOfRow(row: SendRow): DoorItemInput | null {
  if (isBlankRow(row)) return null;
  const amount = cellValue(row.amount);
  const isVolume = row.unit === 'm3';
  return {
    name: row.name.trim(),
    quantity: cellValue(row.qty),
    unit: row.countWord,
    weightKg: cellValue(row.kg),
    volumeM3: isVolume ? amount : row.extraVolume,
    measureUnit: !isVolume && amount !== null ? (row.unit as MeasureUnit) : null,
    measureQty: !isVolume ? amount : null,
    tnvedCode: row.code.trim() || null,
    note: row.notes.join(' · ') || null,
  };
}

// ---------------------------------------------------------------------------
// One-tap answers — each rewrites the row's TEXT and the kernel reads it
// again, so an answer is never a second reading rule.
// ---------------------------------------------------------------------------

/** «1,200» → the chosen reading, in the text it was written in. */
export function answerAmbiguous(raw: string, problemText: string, value: number): string {
  return raw.replace(problemText, String(value));
}

/** Two pairs on a line: keep one, take the other's figure out of the text. */
export function keepPair(raw: string, line: GoodsLine, keep: MeasureUnit): string {
  let out = raw;
  for (const word of line.unitWords) {
    const unit = unitOf(word);
    if (unit === null || unit === keep || !['m2', 'juft', 'litr', 'sm3'].includes(unit)) continue;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // The figure starts where a NUMBER starts: without the look-behind the
    // «2» of the kept «m2» was taken as the start of «2 40 juft», and the
    // line re-read as «120 m» — a unit nobody prices.
    out = out.replace(new RegExp(`(?<![\\p{L}\\d.,])\\d[\\d  .,]*\\s*${escaped}(?![\\p{L}\\d])`, 'u'), ' ');
  }
  return out;
}

/** The row's text written back with every figure labelled. */
function labelledText(line: GoodsLine, extra: { quantity?: number; weightKg?: number }): string {
  const parts = [
    line.name,
    line.tnvedCode,
    extra.quantity !== undefined ? `${extra.quantity} dona` : line.quantity !== null ? `${line.quantity} dona` : null,
    extra.weightKg !== undefined ? `${extra.weightKg} kg` : line.weightKg !== null ? `${line.weightKg} kg` : null,
    line.volumeM3 !== null ? `${line.volumeM3} m3` : null,
    line.measureUnit !== null && line.measureQty !== null ? `${line.measureQty} ${line.measureUnit}` : null,
    line.cartons !== null ? `${line.cartons} karobka` : null,
  ];
  return parts.filter(Boolean).join('; ');
}

/** «Kurtka; 300; 150» — which is the count: `countFirst` says the first. */
export function labelNumbers(line: GoodsLine, values: [number, number], countFirst: boolean): string {
  const [a, b] = values;
  return labelledText(line, countFirst ? { quantity: a, weightKg: b } : { quantity: b, weightKg: a });
}

/** «Raqamlarni olib tashlash»: the bare numbers go, the rest stays. */
export function dropBareNumbers(line: GoodsLine): string {
  return labelledText(line, {});
}

/**
 * «Samsung TV 55, 10»: the first number is part of the NAME and the second is
 * the count — the commonest «nomi, soni» line there is, and the one the
 * kernel cannot tell from «Kurtka; 300; 150» (a name cell's trailing number
 * is a count candidate like any other). None of the three text answers fits
 * it — both labellings invent a weight, and «drop» takes the count with it —
 * so this one is said by the seller and written as a ROW, not re-read: the
 * name with its number back where it stood, the count in its cell.
 */
export function nameKeepsNumber(row: SendRow, line: GoodsLine, values: [number, number]): SendRow {
  return {
    ...row,
    name: `${line.name} ${values[0]}`.trim(),
    qty: String(values[1]),
    raw: null,
    problems: row.problems.filter((p) => p.kind !== 'unlabelled'),
  };
}

// ---------------------------------------------------------------------------
// The VED's «Ro'yxatdan qo'shish» paste (P1.6, judge TT-16)
// ---------------------------------------------------------------------------

/** A pasted line as the workspace posts it — exactly the door's own row. */
export type PasteItem = DoorRow;

/**
 * The paste NEVER ASKS — his answer for this door (B-round, pinned in
 * calc-phone-safety.test.ts): every line lands. What changed is that it
 * lands in the right columns. A TSV with a header goes through the shared
 * header detector (`parseGoods`, TNVED column included); a headerless TSV row
 * or a free line goes through `parseGoodsLine` (a code cell right after the
 * name IS the code, judge TT-2). Every row is then normalised exactly as the
 * door normalises (`doorRow`), so the paste posts the measure pair, the code
 * and the note as structured fields. A figure that reads two ways, two
 * pairs, or bare numbers in an unknown order land EMPTY — with the line's
 * own text in the note, so the VED sees what was dropped and why.
 */
export function pasteItems(text: string): PasteItem[] {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim());
  if (lines.length === 0) return [];
  if (lines.some((l) => l.includes('\t'))) {
    const cells: Cell[][] = lines.map((l) => l.split('\t').map((c) => c.trim()));
    if (detectColumns(cells)) {
      return parseGoods(cells).goods.map((g) =>
        doorRow({
          name: g.description,
          quantity: g.quantity,
          unit: g.unit,
          weightKg: g.weightKg,
          volumeM3: g.volumeM3,
          tnvedCode: g.tnvedCode,
          note: g.note,
        }),
      );
    }
  }
  return lines
    .map((line) => ({ line, read: parseGoodsLine(line) }))
    .filter(({ read }) => read.name)
    .map(({ line, read }) => {
      const unclear = read.problems.filter(isBlockingProblem);
      return doorRow({
        name: read.name,
        quantity: read.quantity,
        unit: read.unitWords.find((w) => unitOf(w) === 'dona') ?? null,
        weightKg: read.weightKg,
        volumeM3: read.volumeM3,
        measureUnit: read.measureUnit,
        measureQty: read.measureQty,
        // A typed nine-digit code is the door's to note, never to pad.
        tnvedCode: read.tnvedCode ?? codeShortText(read),
        note:
          [...lineNotes(read), unclear.length > 0 ? `qatorda: «${line.trim().slice(0, 200)}» — aniq emas` : null]
            .filter(Boolean)
            .join(' · ') || null,
      });
    });
}

/** Is this text a TNVED code the door will keep? (a hint, never a gate) */
export function codeLooksRight(text: string): boolean {
  const code = normalizeTnved(text);
  return !text.trim() || (code !== null && 'code' in code);
}
