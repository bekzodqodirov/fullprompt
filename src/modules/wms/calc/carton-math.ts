/**
 * Carton arithmetic — the ONE place a figure stated PER PACKAGE becomes a
 * line's (docs/AI-SORAYDI.md §2.3).
 *
 * Until 2026-11 every reader stopped at two refusals: a carton count is not
 * pieces (units.ts), and one carton's cube is not the line's (SAKKIZ-R2
 * §8.2 rule 1). Both are right, and both left the seller typing a cube the
 * page already stated twice over — «20 karobka, 60×40×50 sm» — or, worse,
 * the model multiplying by itself with nothing to check it. So the readers
 * (the model's answer, a sheet's columns, the seller's own words) now fill a
 * `Packing` with what they READ, and this file multiplies. Nothing here
 * guesses a count, and every product says how it was made (`Derived.how`),
 * so the table, the row's note and the VED all read the same arithmetic.
 *
 * Pure. Its one import is the kernel's decimal rounding, itself a leaf —
 * units.ts and the sheet reader both call this file, so it must import
 * neither.
 */
import { roundM3 } from './line-totals';

export type SizeUnit = 'cm' | 'mm' | 'm';

/** ONE package's outer size, as written. `unit: null` — none was written. */
export interface CartonSize {
  l: number;
  w: number;
  h: number;
  unit: SizeUnit | null;
}

/** Who stated the packing — worded on the row's note («AI o‘qidi», «fayldan», «sotuvchi»). */
export type PackingSource = 'ai' | 'file' | 'typed';

export interface Packing {
  /** Packages of THIS line — a whole number, 1…`CARTONS_MAX`. */
  cartons: number | null;
  pcsPerCarton: number | null;
  kgPerCarton: number | null;
  /** Which weight `kgPerCarton` is; null — the source did not say. */
  kgPerCartonKind: 'gross' | 'net' | null;
  m3PerCarton: number | null;
  size: CartonSize | null;
  from: PackingSource;
}

/** A figure this file computed, and the arithmetic a person can check. */
export interface Derived {
  value: number;
  how: string;
}

export const CARTONS_MAX = 100_000;

/** A carton written «60×40×50» with no unit is centimetres — inside this band only. */
export const ASSUMED_CM_SIDE = { min: 5, max: 300 } as const;

/** Two figures within this share of each other are one figure written twice. */
export const SAME_FIGURE_TOLERANCE = 0.02;

/** A stated per-carton cube against the size's own: past this, the note says both. */
export const SIZE_CUBE_TOLERANCE = 0.05;

export const emptyPacking = (from: PackingSource): Packing => ({
  cartons: null,
  pcsPerCarton: null,
  kgPerCarton: null,
  kgPerCartonKind: null,
  m3PerCarton: null,
  size: null,
  from,
});

/** Does the packing state anything at all? */
export function packingStated(p: Packing | null | undefined): p is Packing {
  if (!p) return false;
  return (
    p.cartons !== null || p.pcsPerCarton !== null || p.kgPerCarton !== null || p.m3PerCarton !== null || p.size !== null
  );
}

const positive = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** A carton count the arithmetic may use: whole, 1…`CARTONS_MAX`. */
export function wholeCartons(n: number | null | undefined): number | null {
  return positive(n) && Number.isInteger(n) && n <= CARTONS_MAX ? n : null;
}

/**
 * Half-up to three places, on the DECIMAL the product means — the columns'
 * own scale, and the kernel's one rounding (`roundM3`): 7 × 1.2345 is
 * 8.641499999999999 in binary and 8.642 on paper.
 */
export const round3 = roundM3;

/** A figure as a person writes it: at most four decimals, no trailing zeros. */
export const fmtFigure = (n: number): string => String(Number(n.toFixed(4)));

// ── reading a size ──────────────────────────────────────────────────────────

const NUM = String.raw`\d+(?:[.,]\d+)?`;
/** Latin and Cyrillic length units; «m» only as a whole word. */
const LEN = String.raw`(?:sm|cm|см|mm|мм|metr|метр|m|м)`;
const NOT_LETTER_AFTER = String.raw`(?![\p{L}\d])`;
/** x / X, the Cyrillic х / Х, the multiplication sign and the asterisk. `/` is never one. */
const JOIN = String.raw`\s*[xX×хХ*]\s*`;
const SIDE = String.raw`(${NUM})(?:\s*(${LEN})${NOT_LETTER_AFTER})?`;

/** «60x40x50 sm», «60 * 40 * 50», «60cm×40cm×50cm», «0.6 x 0.4 x 0.5 m». */
const TRIPLE = new RegExp(String.raw`(?<![\d.,\p{L}])${SIDE}${JOIN}${SIDE}${JOIN}${SIDE}`, 'u');
/** «600x600 mm», «600*600» — two sides: a tile, a sheet. Never a cube. */
const PAIR = new RegExp(String.raw`(?<![\d.,\p{L}])${SIDE}${JOIN}${SIDE}`, 'u');
/** «L60 W40 H50 cm», «Д60 Ш40 В50», «L:60 W:40 H:50cm». */
const LABELLED = new RegExp(
  String.raw`(?<![\p{L}\d])[LlДд]\s*[:=]?\s*(${NUM})[\s,;x×хХ*]*[WwШш]\s*[:=]?\s*(${NUM})[\s,;x×хХ*]*[HhВв]\s*[:=]?\s*(${NUM})(?:\s*(${LEN})${NOT_LETTER_AFTER})?`,
  'u',
);

const num = (raw: string): number => Number(raw.replace(',', '.'));

function lenUnit(word: string | undefined): SizeUnit | null {
  if (!word) return null;
  const w = word.toLowerCase();
  if (w === 'sm' || w === 'cm' || w === 'см') return 'cm';
  if (w === 'mm' || w === 'мм') return 'mm';
  return 'm';
}

export interface SizeToken {
  /** The sides as written — three for a box, two for a sheet. */
  sides: number[];
  unit: SizeUnit | null;
  /** The three-sided size, when the token is one. */
  size: CartonSize | null;
  /** Where the token stands in the text: `[start, end)`. */
  start: number;
  end: number;
}

/**
 * The FIRST size token of a text, or null.
 *
 * Read before any amount reader runs (docs/AI-SORAYDI.md §3.1 T6): the kernel
 * read «1: 60*40*50 15 kg» as three bare amounts and wrote the LAST one into
 * the piece column — 50 dona. A size is three numbers under a joiner; two are
 * a sheet («Kafel 600x600») and are returned so the caller can take them out
 * of the amounts too, never for a cube.
 *
 * Two numbers are a size only when a LENGTH unit follows or nothing word-like
 * does: «20 x 15 kg» and «20x24 dona» are a carton count times a per-carton
 * figure (§3.1 T7), and that reader takes them.
 */
export function parseSize(text: string): SizeToken | null {
  const labelled = LABELLED.exec(text);
  const triple = TRIPLE.exec(text);
  const hit = pickEarlier(labelled, triple);
  if (hit === labelled && labelled) {
    const [whole, l, w, h, unit] = labelled;
    return tokenOf([num(l!), num(w!), num(h!)], lenUnit(unit), labelled.index, whole.length);
  }
  if (triple) {
    const [whole, l, lu, w, wu, h, hu] = triple;
    return tokenOf([num(l!), num(w!), num(h!)], lenUnit(hu ?? wu ?? lu), triple.index, whole.length);
  }
  const pair = PAIR.exec(text);
  if (pair) {
    const [whole, a, au, b, bu] = pair;
    const unit = lenUnit(bu ?? au);
    const after = text.slice(pair.index + whole.length);
    // A word right after two joined numbers that is no length unit: a count
    // times a per-package figure, not a size.
    if (unit === null && /^\s*[\p{L}]/u.test(after)) return null;
    return tokenOf([num(a!), num(b!)], unit, pair.index, whole.length);
  }
  return null;
}

function pickEarlier(a: RegExpExecArray | null, b: RegExpExecArray | null): RegExpExecArray | null {
  if (!a) return b;
  if (!b) return a;
  return a.index <= b.index ? a : b;
}

function tokenOf(sides: number[], unit: SizeUnit | null, start: number, length: number): SizeToken | null {
  if (!sides.every(positive)) return null;
  const size = sides.length === 3 ? { l: sides[0]!, w: sides[1]!, h: sides[2]!, unit } : null;
  return { sides, unit, size, start, end: start + length };
}

// ── the cube of one package ─────────────────────────────────────────────────

const TO_M3: Record<SizeUnit, number> = { cm: 1e-6, mm: 1e-9, m: 1 };
const UNIT_UZ: Record<SizeUnit, string> = { cm: 'sm', mm: 'mm', m: 'm' };

export interface SizeCube {
  m3: number;
  unit: SizeUnit;
  /** No unit was written and centimetres were taken — every surface says «sm deb olindi». */
  assumed: boolean;
}

/**
 * One package's cube from its size. A unit that was written is used as it
 * is; with none, centimetres are assumed only while every side is inside
 * `ASSUMED_CM_SIDE` — a carton «60×40×50» is centimetres in this trade, and
 * «1200×800×1000» or «0.6×0.4×0.5» is not something to guess at: null, and
 * the unit is asked.
 */
export function sizeCube(size: CartonSize | null | undefined): SizeCube | null {
  if (!size) return null;
  const sides = [size.l, size.w, size.h];
  if (!sides.every(positive)) return null;
  if (size.unit) return { m3: size.l * size.w * size.h * TO_M3[size.unit], unit: size.unit, assumed: false };
  if (sides.every((s) => s >= ASSUMED_CM_SIDE.min && s <= ASSUMED_CM_SIDE.max)) {
    return { m3: size.l * size.w * size.h * TO_M3.cm, unit: 'cm', assumed: true };
  }
  return null;
}

/** «60×40×50 sm» — the size as the table and the note print it. */
export function sizeText(size: CartonSize): string {
  const cube = sizeCube(size);
  const unit = size.unit ?? cube?.unit ?? null;
  const sides = `${fmtFigure(size.l)}×${fmtFigure(size.w)}×${fmtFigure(size.h)}`;
  return unit ? `${sides} ${UNIT_UZ[unit]}` : sides;
}

// ── the products ────────────────────────────────────────────────────────────

export interface CartonFigures {
  /** cartons × one package's cube (stated, else the size's). */
  volumeM3: Derived | null;
  /** cartons × one package's weight, and which weight it is. */
  weightKg: (Derived & { kind: 'gross' | 'net' | null }) | null;
  /** cartons × pieces in one package. */
  quantity: Derived | null;
  /** The size's unit was assumed (centimetres) — said beside the cube. */
  assumedCm: boolean;
  /** A stated per-carton cube and the size disagree past `SIZE_CUBE_TOLERANCE` — both, for the note. */
  cubeClash: { stated: number; fromSize: number } | null;
}

/** What the packing multiplies out to. Null where a factor is missing. */
export function cartonFigures(p: Packing | null | undefined): CartonFigures {
  const none: CartonFigures = { volumeM3: null, weightKg: null, quantity: null, assumedCm: false, cubeClash: null };
  if (!p) return none;
  const cartons = wholeCartons(p.cartons);
  if (cartons === null) return none;

  const fromSize = sizeCube(p.size);
  const stated = positive(p.m3PerCarton) ? p.m3PerCarton : null;
  let volumeM3: Derived | null = null;
  let assumedCm = false;
  let cubeClash: CartonFigures['cubeClash'] = null;
  if (stated !== null) {
    volumeM3 = { value: round3(cartons * stated), how: `${cartons} × ${fmtFigure(stated)} m³` };
    if (fromSize && !sameFigure(stated, fromSize.m3, SIZE_CUBE_TOLERANCE)) {
      cubeClash = { stated, fromSize: round3(fromSize.m3) };
    }
  } else if (fromSize && p.size) {
    volumeM3 = { value: round3(cartons * fromSize.m3), how: `${cartons} × ${sizeText(p.size)}` };
    assumedCm = fromSize.assumed;
  }

  const weightKg = positive(p.kgPerCarton)
    ? {
        value: round3(cartons * p.kgPerCarton),
        how: `${cartons} × ${fmtFigure(p.kgPerCarton)} kg`,
        kind: p.kgPerCartonKind,
      }
    : null;
  const quantity = positive(p.pcsPerCarton)
    ? { value: round3(cartons * p.pcsPerCarton), how: `${cartons} × ${fmtFigure(p.pcsPerCarton)}` }
    : null;
  return { volumeM3, weightKg, quantity, assumedCm, cubeClash };
}

/** Are two figures one figure, within `tolerance` of the larger? */
export function sameFigure(a: number, b: number, tolerance = SAME_FIGURE_TOLERANCE): boolean {
  if (a === b) return true;
  const top = Math.max(Math.abs(a), Math.abs(b));
  return top > 0 && Math.abs(a - b) / top <= tolerance;
}

export type CartonVerdict = 'fill' | 'agrees' | 'one_carton' | 'differs';

/**
 * A figure the source STATED for the line, against what its packing
 * multiplies out to:
 *  - `fill` — nothing was stated: the product is the figure;
 *  - `agrees` — the same figure, written twice;
 *  - `one_carton` — the stated figure is ONE package's (several packages, and
 *    it equals the per-package value): a per-carton column read as the line's,
 *    or a model that copied the carton's cube into the row (dg2-5, DIM-8);
 *  - `differs` — neither: nobody guesses, the table asks.
 */
export function judgeStated(
  stated: number | null | undefined,
  derived: Derived | null,
  perCarton: number | null,
  cartons: number | null,
): CartonVerdict | null {
  if (!derived) return null;
  if (!positive(stated)) return 'fill';
  if (sameFigure(stated, derived.value)) return 'agrees';
  if (cartons !== null && cartons > 1 && positive(perCarton) && sameFigure(stated, perCarton)) return 'one_carton';
  return 'differs';
}

// ── the one door ────────────────────────────────────────────────────────────

export type PackedField = 'volumeM3' | 'weightKg' | 'quantity';

/** The figures of a line the packing may fill — every reader's row has these. */
export interface PackedLine {
  quantity?: number | null;
  weightKg?: number | null;
  volumeM3?: number | null;
  packing?: Packing | null;
  derived?: LineDerived | null;
}

/**
 * What this file did to a line — everything a surface needs to word it, kept
 * as DATA so the note is rendered from the row and never appended to it
 * (`derivedNotes`): a row passes through here again each time the seller
 * adds a factor, and a sentence baked into `note` would be said twice.
 */
export interface LineDerived {
  /** The arithmetic of a COMPUTED figure, per field — its presence is «this figure is derived». */
  volumeM3?: string;
  weightKg?: string;
  quantity?: string;
  /** A stated figure that was ONE carton's, replaced by the product — the original, per field. */
  replaced?: Partial<Record<PackedField, number>>;
  /** The row's computed weight is the packages' GROSS (the source gave no netto). */
  weightIsGross?: boolean;
  /** The line's GROSS weight from its packages, for the shipment's brutto. */
  grossKg?: Derived;
  /** The size carried no unit and centimetres were taken. */
  assumedCm?: boolean;
  /** A stated per-carton cube the size does not agree with — both, for the note. */
  cubeClash?: { stated: number; fromSize: number };
}

export interface CartonDoubt {
  field: PackedField;
  stated: number;
  derived: Derived;
}

export interface PackingOutcome<T extends PackedLine> {
  line: T;
  /** A stated figure that neither agrees with the packing nor is one carton's. */
  doubts: CartonDoubt[];
}

const UNIT_OF: Record<PackedField, string> = { volumeM3: 'm³', weightKg: 'kg', quantity: 'dona' };
const WORD_OF: Record<PackedField, string> = { volumeM3: 'hajm', weightKg: 'og‘irlik', quantity: 'soni' };
const FIELDS: readonly PackedField[] = ['volumeM3', 'weightKg', 'quantity'];

/**
 * Fill a line from its packing — the ONE function every reader calls, and
 * safe to call again whenever the packing changes.
 *
 * Per field: nothing stated → the product is written and `derived` says how;
 * the same figure → untouched; ONE carton's figure standing as the line's →
 * replaced by the product, the original kept in `derived.replaced`; anything
 * else → the stated figure stays and a doubt is returned for the table to
 * ask. A figure this function computed earlier is not «stated»: it is
 * recomputed from the packing as it stands now (a seller who corrects «20
 * karobka» to «25» moves the cube with it), and dropped again when the
 * packing no longer multiplies out. A WRITER that takes a figure from a
 * person must clear that field's `derived` mark first — then it is stated.
 *
 * A line's weight is netto, so a GROSS per-package weight fills an empty row
 * weight (marked `weightIsGross`, the reading's old rule for «only brutto is
 * written») and is also kept apart as `derived.grossKg`, the piece the
 * shipment's brutto is summed from.
 */
export function applyPacking<T extends PackedLine>(input: T): PackingOutcome<T> {
  const p = input.packing;
  const before = input.derived ?? {};
  const line: T = { ...input };
  // A figure computed on an earlier pass goes back to «not stated».
  for (const field of FIELDS) if (before[field] !== undefined) line[field] = null;
  const derived: LineDerived = {};
  const doubts: CartonDoubt[] = [];
  if (before.replaced) derived.replaced = { ...before.replaced };

  if (packingStated(p)) {
    const figures = cartonFigures(p);
    const cartons = wholeCartons(p.cartons);
    const settle = (
      field: PackedField,
      product: Derived | null,
      perCarton: number | null,
      /** The product is a CEILING for the stated figure, not its twin (a netto under a brutto). */
      ceiling = false,
    ) => {
      const stated = line[field] ?? null;
      const verdict = judgeStated(stated, product, perCarton, cartons);
      if (!verdict || !product) return;
      // A row's netto under its packages' brutto is a row, not a question.
      if (verdict === 'differs' && ceiling && (stated as number) <= product.value) return;
      if (verdict === 'fill') {
        line[field] = product.value;
        derived[field] = product.how;
      } else if (verdict === 'one_carton') {
        derived.replaced = { ...(derived.replaced ?? {}), [field]: stated as number };
        line[field] = product.value;
        derived[field] = product.how;
      } else if (verdict === 'differs') {
        doubts.push({ field, stated: stated as number, derived: product });
      }
    };

    settle('volumeM3', figures.volumeM3, positive(p.m3PerCarton) ? p.m3PerCarton : (sizeCube(p.size)?.m3 ?? null));
    settle('quantity', figures.quantity, p.pcsPerCarton);
    if (figures.weightKg) {
      const { kind, ...product } = figures.weightKg;
      settle('weightKg', product, p.kgPerCarton, kind !== 'net');
      if (kind !== 'net') {
        derived.grossKg = product;
        if (derived.weightKg !== undefined) derived.weightIsGross = true;
      }
    }
    if (figures.assumedCm && derived.volumeM3 !== undefined) derived.assumedCm = true;
    if (figures.cubeClash) derived.cubeClash = figures.cubeClash;
  }

  // An original kept for a field that is no longer computed says nothing true.
  if (derived.replaced) {
    for (const field of FIELDS) if (derived[field] === undefined) delete derived.replaced[field];
    if (Object.keys(derived.replaced).length === 0) delete derived.replaced;
  }
  if (Object.keys(derived).length > 0) line.derived = derived;
  else delete line.derived;
  return { line, doubts };
}

/**
 * What `applyPacking` did, in words, for the row's note — rendered from the
 * row each time, never stored: «hajm bitta karobkaniki edi (0.12): 20 ×
 * 60×40×50 sm = 2.4 m³», «og‘irlik brutto (karobka og‘irligidan)».
 */
export function derivedNotes(line: PackedLine): string[] {
  const d = line.derived;
  if (!d) return [];
  const out: string[] = [];
  for (const field of FIELDS) {
    const how = d[field];
    if (how === undefined) continue;
    const value = line[field];
    const figure = typeof value === 'number' ? ` = ${fmtFigure(value)} ${UNIT_OF[field]}` : '';
    const was = d.replaced?.[field];
    if (was !== undefined) {
      out.push(`${WORD_OF[field]} bitta karobkaniki edi (${fmtFigure(was)}): ${how}${figure}`);
    } else {
      const cm = field === 'volumeM3' && d.assumedCm ? ', sm deb olindi' : '';
      out.push(`${WORD_OF[field]} hisoblangan: ${how}${figure}${cm}`);
    }
  }
  if (d.weightIsGross) out.push('og‘irlik brutto (karobka og‘irligidan)');
  if (d.cubeClash) {
    out.push(
      `karobka hajmi ${fmtFigure(d.cubeClash.stated)} m³ yozilgan, o‘lchamidan ${fmtFigure(d.cubeClash.fromSize)} m³ chiqadi`,
    );
  }
  return out;
}

/**
 * The shipment's BRUTTO from the lines' packages: the Σ of every line's gross
 * product — only when EVERY line has one (a sum over some of the lines is one
 * factory's, or half a list's, and would stand as the whole).
 */
export function grossFromLines(lines: readonly PackedLine[]): Derived | null {
  if (lines.length === 0) return null;
  let sum = 0;
  for (const line of lines) {
    const gross = line.derived?.grossKg;
    if (!gross) return null;
    sum += gross.value;
  }
  return { value: round3(sum), how: 'karobkalardan' };
}

const SOURCE_UZ: Record<PackingSource, string> = { ai: 'AI o‘qidi', file: 'fayldan', typed: 'sotuvchi' };

/**
 * The packing as one line of the row's note — what the VED reads beside a
 * computed figure: «📦 20 karobka · 60×40×50 sm · 15 kg/karobka (brutto) —
 * AI o‘qidi». Null when the packing states nothing.
 */
export function packingNote(p: Packing | null | undefined): string | null {
  if (!packingStated(p)) return null;
  const parts: string[] = [];
  if (positive(p.cartons)) parts.push(`${fmtFigure(p.cartons)} karobka`);
  if (p.size) parts.push(sizeText(p.size));
  if (positive(p.m3PerCarton)) parts.push(`${fmtFigure(p.m3PerCarton)} m³/karobka`);
  if (positive(p.kgPerCarton)) {
    const kind = p.kgPerCartonKind === 'gross' ? ' (brutto)' : p.kgPerCartonKind === 'net' ? ' (netto)' : '';
    parts.push(`${fmtFigure(p.kgPerCarton)} kg/karobka${kind}`);
  }
  if (positive(p.pcsPerCarton)) parts.push(`${fmtFigure(p.pcsPerCarton)} dona/karobka`);
  if (parts.length === 0) return null;
  return `📦 ${parts.join(' · ')} — ${SOURCE_UZ[p.from]}`;
}

/** «2.4 m³ (hisoblangan: 20 × 60×40×50 sm)» — a computed figure's own words. */
export function derivedText(how: string, assumedCm = false): string {
  return `hisoblangan: ${how}${assumedCm ? ', sm deb olindi' : ''}`;
}
