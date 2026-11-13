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
 * The rules that keep a wrong number from landing under «✅» are the review's
 * (docs/AI-SORAYDI-REVIEW.md, its ids beside each):
 *  - a size's unit is never guessed past what is plausible, and a unit this
 *    file cannot convert is asked, never read as centimetres (JN-1, JN-25);
 *  - only a PACKAGE's size is multiplied by the packages (PR-12, JN-11);
 *  - the MODEL's figure is never corrected against the model's own packing:
 *    a row total equal to one carton's is a QUESTION there, a replacement
 *    only where two independent statements say so (JN-2, JR-5);
 *  - a figure a PERSON stated is never filled over, replaced or doubted, and
 *    no writer has to remember to say so — a computed figure is recognised by
 *    its value (JN-15, JB-1).
 *
 * Pure. Its one import is the kernel's decimal rounding, itself a leaf —
 * units.ts and the sheet reader both call this file, so it must import
 * neither.
 */
import { roundM3 } from './line-totals';

export type SizeUnit = 'cm' | 'mm' | 'm';

/**
 * Three sides as written. `unit: null` — none was written; `'other'` — one
 * was written that this file does not convert (inches, feet, decimetres):
 * such a size is never assumed to be centimetres, it is asked.
 */
export interface BareSize {
  l: number;
  w: number;
  h: number;
  unit: SizeUnit | 'other' | null;
}

/**
 * WHOSE size it is. A carton count multiplies a PACKAGE's size and nothing
 * else: «Стол 120×80×75, 10 коробок» is a table's own size beside ten flat
 * packs, and 10 × 0.72 m³ would be a cube nobody shipped. `null` — the source
 * did not say; then nothing is multiplied and the owner is asked.
 */
export type SizeOwner = 'package' | 'product';

/**
 * A size on a row's packing. `of` is REQUIRED so that every reader says how
 * it knows: a carton word or a «CTN SIZE» header, the model's `size_of`, the
 * bot's own cube question being answered.
 */
export interface CartonSize extends BareSize {
  of: SizeOwner | null;
}

/** Who stated the packing — worded on the row's note («AI o‘qidi», «fayldan», «sotuvchi»). */
export type PackingSource = 'ai' | 'file' | 'typed';

/**
 * What ONE package holds a count of: pieces, or the row's second measure —
 * «12 пар/кор», «1.44 м²/кор» (JR-1). A count with no unit of its own lands
 * as PIECES, which is the root defect of the 2026-10 calculator round: a
 * number in the column nobody's unit named.
 */
export type PerCartonUnit = 'dona' | 'juft' | 'm2' | 'litr';

/** The factors of a packing — each may have its own source after a merge. */
export type PackingFactor = 'cartons' | 'pcsPerCarton' | 'kgPerCarton' | 'm3PerCarton' | 'size' | 'kgPerPiece';
const FACTORS: readonly PackingFactor[] = ['cartons', 'pcsPerCarton', 'kgPerCarton', 'm3PerCarton', 'size', 'kgPerPiece'];

export interface Packing {
  /** Packages of THIS line — a whole number, 1…`CARTONS_MAX`. */
  cartons: number | null;
  pcsPerCarton: number | null;
  /** What `pcsPerCarton` counts; absent = pieces. */
  perCartonUnit?: PerCartonUnit;
  kgPerCarton: number | null;
  /** Which weight `kgPerCarton` is; null — the source did not say. */
  kgPerCartonKind: 'gross' | 'net' | null;
  m3PerCarton: number | null;
  size: CartonSize | null;
  /**
   * ONE PIECE's weight (a marketplace card's «4.5 kg/шт», MP-11) — times the
   * line's pieces it fills an empty row weight.
   */
  kgPerPiece?: number | null;
  /** Who stated it — the whole packing, or every factor `fromOf` does not name. */
  from: PackingSource;
  /** Per factor, after two sources were merged (`mergePacking`). */
  fromOf?: Partial<Record<PackingFactor, PackingSource>>;
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

/** A stated per-carton cube against the size's own: past this they disagree. */
export const SIZE_CUBE_TOLERANCE = 0.05;

/**
 * Cargo is between these, kg per m³. The lower bound is the tariff's own
 * «impossibly light» line (`FREIGHT_LIGHT_BELOW`, his rule 6 of the yo‘lkira
 * round) — restated here because this file imports nothing, and pinned to it
 * by carton-math.test.ts. Used to refuse an ASSUMED unit: a carton typed
 * «250x180x120» that weighs half a kilo is millimetres, not 5.4 m³ (JN-25).
 */
export const PLAUSIBLE_DENSITY = { min: 10, max: 3000 } as const;

/** One package past this, m³, from a unit nobody wrote: asked, not assumed. */
export const ASSUMED_PACKAGE_MAX_M3 = 3;

/** One package past this, m³ — a 40-foot container — is no package: the unit is wrong (JN-26). */
export const PACKAGE_MAX_M3 = 70;

/** A product below this is not a figure to write: its factors are shown and it is asked. */
export const PRODUCT_MIN = 0.001;

/** A netto under its packages' brutto passes silently only from this share of it up (JN-4). */
export const NET_UNDER_GROSS_MIN = 0.5;

/** A GROSS row weight may stand this far above a NET product without a question (JN-4). */
export const GROSS_OVER_NET_MAX = 0.25;

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
    p.cartons !== null ||
    p.pcsPerCarton !== null ||
    p.kgPerCarton !== null ||
    p.m3PerCarton !== null ||
    p.size !== null ||
    (p.kgPerPiece ?? null) !== null
  );
}

/** Who stated one factor of a packing. */
export const sourceOf = (p: Packing, factor: PackingFactor): PackingSource => p.fromOf?.[factor] ?? p.from;

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

/**
 * A bare «A x B unit» the seller wrote — «Stul 20 x 15 kg», «Kurtka 20*24
 * dona» — is the PRODUCT for that unit (review JN-8 (c), binding: «gives the
 * product and sets no carton count without a carton word»): 300 kg, 480
 * pieces, whichever A counts. The kernel's multiplication and rounding, here
 * and nowhere else; nothing else is multiplied by A — it is no carton count.
 * Null when either side is no positive figure.
 */
export function timesProduct(times: number, per: number): number | null {
  return positive(times) && positive(per) ? round3(times * per) : null;
}

/** A figure as a person writes it: at most four decimals, no trailing zeros. */
export const fmtFigure = (n: number): string => String(Number(n.toFixed(4)));

// ── reading a size ──────────────────────────────────────────────────────────

const NUM = String.raw`\d+(?:[.,]\d+)?`;
/** x / X, the Cyrillic х / Х, the multiplication sign and the asterisk. `/` is never one. */
const JOIN = String.raw`\s*[xX×хХ*]\s*`;
/**
 * A unit glued to ONE side («60cm×40cm×50cm») — Latin and Cyrillic, any case
 * («60CM», «60 СМ»: a Chinese carton prints its units in capitals, JN-1).
 */
const SIDE_UNIT = String.raw`(?:sm|cm|см|mm|мм|m|м)`;
const SIDE = String.raw`(${NUM})(?:\s*(${SIDE_UNIT})(?![\p{L}\d]))?`;

/** «60x40x50 sm», «60 * 40 * 50», «60cm×40cm×50cm», «0.6 x 0.4 x 0.5 m». */
const TRIPLE = new RegExp(String.raw`(?<![\d.,\p{L}])${SIDE}${JOIN}${SIDE}${JOIN}${SIDE}`, 'iu');
/** «600x600 mm», «600*600» — two sides: a tile, a sheet. Never a cube. */
const PAIR = new RegExp(String.raw`(?<![\d.,\p{L}])${SIDE}${JOIN}${SIDE}`, 'iu');
/** «L60 W40 H50 cm», «Д60 Ш40 В50», «L:60 W:40 H:50cm». */
const LABELLED = new RegExp(
  String.raw`(?<![\p{L}\d])[LДД]\s*[:=]?\s*(${NUM})[\s,;x×х*]*[WШ]\s*[:=]?\s*(${NUM})[\s,;x×х*]*[HВ]\s*[:=]?\s*(${NUM})`,
  'iu',
);
/** One more joined number right after a size: «20x60x40x50» is no size at all. */
const FOURTH = new RegExp(String.raw`^${JOIN}${NUM}`, 'u');

/**
 * The unit written AFTER the whole size — bare or bracketed, any case, and
 * the Chinese forms («60*40*50(CM)», «60*40*50厘米», «60х40х50 СМ»). A Han
 * unit needs no boundary after it; a Latin or Cyrillic one must end there.
 *
 * The bracket and the spaces after it are ONE optional group: written as
 * `\s*[(]?\s*` the two runs could split one stretch of spaces n ways when no
 * bracket stood there, and a size cell padded with spaces cost seconds a row
 * on the one app process (review load-2 — 12 s for 500 such Excel rows).
 */
const UNIT_AFTER = new RegExp(
  String.raw`^\s*(?:[(（\[]\s*)?(?:(厘米|公分|毫米|米)|(sm|cm|см|сантиметр\p{L}*|santimetr\p{L}*|mm|мм|миллиметр\p{L}*|millimetr\p{L}*|metr\p{L}*|метр\p{L}*|m|м)(?![\p{L}\d]))\s*[)）\]]?`,
  'iu',
);
/** A length unit this file does not convert — the size is real, its cube is asked. */
const FOREIGN_UNIT_AFTER = new RegExp(
  String.raw`^\s*(?:[(（\[]\s*)?(?:inch(?:es)?|in|дюйм\p{L}*|dyuym\p{L}*|ft|feet|foot|фут\p{L}*|dm|дм|英寸|寸|英尺)(?![\p{L}\d])\s*[)）\]]?|^\s*[″"]`,
  'iu',
);

const num = (raw: string): number => Number(raw.replace(',', '.'));

function lenUnit(word: string | undefined): SizeUnit | null {
  if (!word) return null;
  const w = word.toLowerCase();
  if (w === '厘米' || w === '公分' || w === 'sm' || w === 'cm' || w === 'см' || w.startsWith('сантиметр') || w.startsWith('santimetr')) return 'cm';
  if (w === '毫米' || w === 'mm' || w === 'мм' || w.startsWith('миллиметр') || w.startsWith('millimetr')) return 'mm';
  return 'm';
}

export interface SizeToken {
  /** The sides as written — three for a box, two for a sheet, four or more for «not a size». */
  sides: number[];
  unit: BareSize['unit'];
  /** The three-sided size, when the token is one — bare: the CALLER says whose it is. */
  size: BareSize | null;
  /** Where the token stands in the text: `[start, end)` — its unit included. */
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
 * of the amounts too, never for a cube. FOUR joined numbers are no size
 * («20x60x40x50» is twenty cartons of 60×40×50, or something else again): the
 * token is returned with `size: null`, so the span is still taken out of the
 * amounts and nothing is multiplied.
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
    const [whole, l, w, h] = labelled;
    return tokenOf(text, [num(l!), num(w!), num(h!)], null, labelled.index, whole.length);
  }
  if (triple) {
    const [whole, l, lu, w, wu, h, hu] = triple;
    const end = triple.index + whole.length;
    const more = FOURTH.exec(text.slice(end));
    if (more) {
      // Swallow every further joined number: none of it is an amount.
      let stop = end;
      const sides = [num(l!), num(w!), num(h!)];
      for (let next: RegExpExecArray | null = more; next; next = FOURTH.exec(text.slice(stop))) {
        sides.push(num(next[0].replace(/^[^\d]*/u, '')));
        stop += next[0].length;
      }
      return { sides, unit: null, size: null, start: triple.index, end: stop };
    }
    return tokenOf(text, [num(l!), num(w!), num(h!)], lenUnit(hu ?? wu ?? lu), triple.index, whole.length);
  }
  const pair = PAIR.exec(text);
  if (pair) {
    const [whole, a, au, b, bu] = pair;
    const inline = lenUnit(bu ?? au);
    const token = tokenOf(text, [num(a!), num(b!)], inline, pair.index, whole.length);
    // A word right after two joined numbers that is no length unit: a count
    // times a per-package figure, not a size.
    if (token && token.unit === null && /^\s*[\p{L}]/u.test(text.slice(token.end))) return null;
    // «Stanok 2 x 1 500 kg»: a side no carton has (under 5, no unit) with a
    // three-digit group right after it is the HEAD of a space-grouped number —
    // taken as a sheet «2 x 1», it left «500 kg» to be read plainly, a figure
    // neither reading of the line gives (review figures-pair-steals-thousands).
    // «Kafel 600x600 500 dona» and «Kafel 60x60 1 200 m2» are sheets still.
    // Only a SPACED joiner of whole numbers opens that doubt (review R1): a
    // side glued to its joiner («Gilam 2x3 100 dona», «Ковер 2х3 150 шт»,
    // «Gilam 2*3») is joined to a letter or a sign — no group's head (JN-6's
    // mask) — and a decimal side («Matras 1.6x2 100 dona», «Samorez 4,2x16
    // 100 kg») is a length, never a count to multiply nor a thousands head: a
    // carpet's, a tile's, a mattress's metres beside its count. Taken for a
    // grouped number they cost the line its count and its size — or the whole
    // row. «Gilam 2 x 3 100 dona», spaced, is the doubt still: the same shape
    // as «Stanok 2 x 1 500 kg».
    if (
      token &&
      token.unit === null &&
      /\d\s+[xX×хХ*]|[xX×хХ*]\s+\d/u.test(whole) &&
      token.sides.every((side) => Number.isInteger(side)) &&
      token.sides.some((side) => side < ASSUMED_CM_SIDE.min) &&
      /^\s\d{3}(?!\d)/u.test(text.slice(token.end))
    ) {
      return null;
    }
    return token;
  }
  return null;
}

function pickEarlier(a: RegExpExecArray | null, b: RegExpExecArray | null): RegExpExecArray | null {
  if (!a) return b;
  if (!b) return a;
  return a.index <= b.index ? a : b;
}

function tokenOf(text: string, sides: number[], inline: SizeUnit | null, start: number, length: number): SizeToken | null {
  if (!sides.every(positive)) return null;
  let end = start + length;
  let unit: BareSize['unit'] = inline;
  if (unit === null) {
    const rest = text.slice(end);
    const known = UNIT_AFTER.exec(rest);
    if (known) {
      unit = lenUnit(known[1] ?? known[2]);
      end += known[0].length;
    } else {
      const foreign = FOREIGN_UNIT_AFTER.exec(rest);
      if (foreign) {
        unit = 'other';
        end += foreign[0].length;
      }
    }
  }
  const size = sides.length === 3 ? { l: sides[0]!, w: sides[1]!, h: sides[2]!, unit } : null;
  return { sides, unit, size, start, end };
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
 * the unit is asked. A unit this file cannot convert (`'other'`) is null too.
 *
 * This is the ARITHMETIC; whether an assumed unit is believable for a given
 * package is `cartonFigures`' question (it knows the weight).
 */
export function sizeCube(size: BareSize | null | undefined): SizeCube | null {
  if (!size) return null;
  const sides = [size.l, size.w, size.h];
  if (!sides.every(positive)) return null;
  if (size.unit === 'other') return null;
  if (size.unit) return { m3: size.l * size.w * size.h * TO_M3[size.unit], unit: size.unit, assumed: false };
  if (sides.every((s) => s >= ASSUMED_CM_SIDE.min && s <= ASSUMED_CM_SIDE.max)) {
    return { m3: size.l * size.w * size.h * TO_M3.cm, unit: 'cm', assumed: true };
  }
  return null;
}

/** «60×40×50 sm» — the size as the table and the note print it. */
export function sizeText(size: BareSize): string {
  const cube = sizeCube(size);
  const unit = size.unit === 'other' ? null : (size.unit ?? cube?.unit ?? null);
  const sides = `${fmtFigure(size.l)}×${fmtFigure(size.w)}×${fmtFigure(size.h)}`;
  return unit ? `${sides} ${UNIT_UZ[unit]}` : sides;
}

/**
 * Is a package's cube believable? A unit somebody WROTE is doubted only past
 * a container (`PACKAGE_MAX_M3`: «60x40x50 м» is 120 000 m³). An ASSUMED
 * unit must also stay under `ASSUMED_PACKAGE_MAX_M3` and, when the package's
 * weight is known, give a density cargo can have — a shoebox «250x180x120»
 * at half a kilo is millimetres (JN-25).
 */
function cubeBelievable(cube: SizeCube, kgOne: number | null): boolean {
  if (cube.m3 > PACKAGE_MAX_M3) return false;
  if (!cube.assumed) return true;
  if (cube.m3 > ASSUMED_PACKAGE_MAX_M3) return false;
  if (kgOne !== null && cube.m3 > 0) {
    const density = kgOne / cube.m3;
    if (density < PLAUSIBLE_DENSITY.min || density > PLAUSIBLE_DENSITY.max) return false;
  }
  return true;
}

// ── the products ────────────────────────────────────────────────────────────

export interface CartonFigures {
  /** cartons × one package's cube (stated, else the size's) — or the line's own, see `cubeIsLine`. */
  volumeM3: Derived | null;
  /** ONE package's cube the volume was made from — what a row total is compared with. */
  cubeOne: number | null;
  /** cartons × one package's weight, and which weight it is. */
  weightKg: (Derived & { kind: 'gross' | 'net' | null }) | null;
  /** cartons × what one package holds — pieces, or the row's second measure. */
  count: (Derived & { unit: PerCartonUnit }) | null;
  /** The size's unit was assumed (centimetres) — said beside the cube. */
  assumedCm: boolean;
  /**
   * The figure in the «per-carton cube» key is the LINE's: it equals cartons
   * × the size's cube (JN-2). It is used once and never multiplied.
   */
  cubeIsLine: boolean;
  /** A stated per-carton cube and the size disagree, and neither explains the other: asked. */
  cubeClash: { stated: number; fromSize: number } | null;
  /** A package size is there but gives no cube: no unit that can be trusted. */
  sizeUnitUnsure: boolean;
}

const NO_FIGURES: CartonFigures = {
  volumeM3: null,
  cubeOne: null,
  weightKg: null,
  count: null,
  assumedCm: false,
  cubeIsLine: false,
  cubeClash: null,
  sizeUnitUnsure: false,
};

/**
 * What the packing multiplies out to. Null where a factor is missing.
 * `lineKg` — the row's own stated weight, for the plausibility of an
 * assumed unit when the packing gives no weight per package.
 */
export function cartonFigures(p: Packing | null | undefined, lineKg: number | null = null): CartonFigures {
  if (!p) return NO_FIGURES;
  const cartons = wholeCartons(p.cartons);
  if (cartons === null) return NO_FIGURES;

  const kgOne = positive(p.kgPerCarton) ? p.kgPerCarton : positive(lineKg) ? lineKg / cartons : null;
  // Only a PACKAGE's size is multiplied by the packages (`SizeOwner`).
  const raw = p.size?.of === 'package' ? sizeCube(p.size) : null;
  const fromSize = raw && cubeBelievable(raw, kgOne) ? raw : null;
  const stated = positive(p.m3PerCarton) ? p.m3PerCarton : null;

  let volumeM3: Derived | null = null;
  let cubeOne: number | null = null;
  let assumedCm = false;
  let cubeIsLine = false;
  let cubeClash: CartonFigures['cubeClash'] = null;
  if (stated !== null && fromSize) {
    if (sameFigure(stated, fromSize.m3, SIZE_CUBE_TOLERANCE)) {
      volumeM3 = { value: round3(cartons * stated), how: `${cartons} × ${fmtFigure(stated)} m³` };
      cubeOne = stated;
    } else if (cartons > 1 && sameFigure(stated, cartons * fromSize.m3)) {
      // The «per-carton» figure is the whole line's: the size says so.
      volumeM3 = { value: round3(stated), how: `${cartons} × ${sizeText(p.size!)}` };
      cubeOne = fromSize.m3;
      cubeIsLine = true;
      assumedCm = fromSize.assumed;
    } else {
      // Two statements about one carton, and neither explains the other.
      cubeClash = { stated, fromSize: round3(fromSize.m3) };
    }
  } else if (stated !== null) {
    volumeM3 = { value: round3(cartons * stated), how: `${cartons} × ${fmtFigure(stated)} m³` };
    cubeOne = stated;
  } else if (fromSize && p.size) {
    volumeM3 = { value: round3(cartons * fromSize.m3), how: `${cartons} × ${sizeText(p.size)}` };
    cubeOne = fromSize.m3;
    assumedCm = fromSize.assumed;
  }

  const weightKg = positive(p.kgPerCarton)
    ? {
        value: round3(cartons * p.kgPerCarton),
        how: `${cartons} × ${fmtFigure(p.kgPerCarton)} kg`,
        kind: p.kgPerCartonKind,
      }
    : null;
  const count = positive(p.pcsPerCarton)
    ? {
        value: round3(cartons * p.pcsPerCarton),
        how: `${cartons} × ${fmtFigure(p.pcsPerCarton)}`,
        unit: p.perCartonUnit ?? ('dona' as const),
      }
    : null;
  const sizeUnitUnsure = p.size?.of === 'package' && stated === null && fromSize === null;
  return { volumeM3, cubeOne, weightKg, count, assumedCm, cubeIsLine, cubeClash, sizeUnitUnsure };
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
 *    or a model that copied the carton's cube into the row (dg2-5, DIM-8).
 *    What is DONE about it depends on who stated the packing (`applyPacking`);
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

export type PackedField = 'volumeM3' | 'weightKg' | 'quantity' | 'measureQty';

/** The figures of a line the packing may fill — every reader's row has these. */
export interface PackedLine {
  quantity?: number | null;
  weightKg?: number | null;
  volumeM3?: number | null;
  /** The row's second measure (pairs, m², litres) — where a non-piece per-carton count lands. */
  measureUnit?: string | null;
  measureQty?: number | null;
  /** Which weight the row's own stated weight is, when its source said. */
  weightKind?: 'gross' | 'net';
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
  measureQty?: string;
  /**
   * The VALUE each computed figure was given. A field is «computed earlier»
   * only while it still holds it: a figure a writer changed afterwards is
   * STATED, whoever wrote it and whether or not they knew to say so (JB-1).
   */
  computed?: Partial<Record<PackedField, number>>;
  /**
   * Fields a PERSON stated or chose (`setStated`): never filled over,
   * replaced or doubted — he has just overruled the arithmetic (JN-15).
   */
  person?: PackedField[];
  /** A stated figure that was ONE carton's (or piece's), replaced by the product — the original, per field. */
  replaced?: Partial<Record<PackedField, number>>;
  /** The row's weight is its packages' GROSS: computed from it, or stated equal to it with no kind said. */
  weightIsGross?: boolean;
  /** The row's computed weight is pieces × ONE PIECE's weight, not cartons × a carton's. */
  weightFromPieces?: boolean;
  /** The line's GROSS weight from its packages, for the shipment's brutto — only a weight SAID to be gross. */
  grossKg?: Derived;
  /** The size carried no unit and centimetres were taken. */
  assumedCm?: boolean;
  /** The «per-carton cube» was the line's own (cartons × the size's): used once. */
  cubeIsLine?: boolean;
  /** This call set the row's `measureUnit` with a computed measure — taken back with it. */
  measureUnitSet?: boolean;
}

/**
 * What the arithmetic could not settle and a PERSON must:
 *  - `differs` — a stated figure and the product disagree;
 *  - `one_or_all` — a stated figure equals ONE package's (or one piece's) and
 *    nothing independent says which it is: the model's own packing against
 *    the model's own total (JR-5), or a weight far under its packages';
 *  - `cube_clash` — one carton's cube is stated and its size gives another;
 *  - `not_whole` — cartons × pieces is not a whole number of pieces;
 *  - `size_unit` — a package's size with no unit that can be trusted;
 *  - `size_owner` — a size beside a carton count, and nobody said whose;
 *  - `weight_kind` — a per-package weight, brutto or netto unsaid, on a line
 *    whose brutto would be summed from it;
 *  - `measure_clash` — the per-carton count is in a unit the row already
 *    holds another of.
 */
export type CartonDoubtKind =
  | 'differs'
  | 'one_or_all'
  | 'cube_clash'
  | 'not_whole'
  | 'size_unit'
  | 'size_owner'
  | 'weight_kind'
  | 'measure_clash';

export interface CartonDoubt {
  kind: CartonDoubtKind;
  field: PackedField;
  /** The figure as stated; null where the doubt is about a factor, not a row figure. */
  stated: number | null;
  /** What the arithmetic gives (or would give once answered); null where it gives nothing. */
  derived: Derived | null;
  /** ONE package's (piece's) figure the stated one was compared with, for the question's words. */
  perOne?: number;
  /** `one_or_all` about a PIECE's weight rather than a package's. */
  perPiece?: boolean;
}

export interface PackingOutcome<T extends PackedLine> {
  /**
   * The line as it came, with what the packing computed. Typed as a
   * `PackedLine` over `T`: a caller's literal («{ volumeM3: null, packing }»)
   * has no `derived` key in its own type, and the line that comes back does.
   */
  line: T & Pick<PackedLine, 'derived' | 'measureUnit' | 'measureQty'>;
  /** What a person must settle — the table asks each (`CartonDoubt`). */
  doubts: CartonDoubt[];
}

const MEASURE_UZ: Record<Exclude<PerCartonUnit, 'dona'>, string> = { juft: 'juft', m2: 'm²', litr: 'litr' };
const FIELDS: readonly PackedField[] = ['volumeM3', 'weightKg', 'quantity', 'measureQty'];

/** Units of a count that come only whole. */
const WHOLE_ONLY: ReadonlySet<PerCartonUnit> = new Set(['dona', 'juft']);

/**
 * Fill a line from its packing — the ONE function every reader calls, and
 * safe to call again whenever the packing or a figure changes.
 *
 * Per field: nothing stated → the product is written and `derived` says how;
 * the same figure → untouched; ONE carton's figure standing as the line's →
 * replaced by the product where two independent statements say so (a sheet's
 * columns, a seller's words), ASKED where the packing is the model's own
 * reading of the same page; anything else → the stated figure stays and a
 * doubt is returned for the table to ask.
 *
 * A figure this function computed earlier is not «stated» — it is recomputed
 * from the packing as it stands now (a seller who corrects «20 karobka» to
 * «25» moves the cube with it) and dropped again when the packing no longer
 * multiplies out, the original it replaced coming back. It is recognised BY
 * ITS VALUE (`derived.computed`): any writer that changes the figure makes it
 * stated without having to know this file exists. A figure a PERSON set
 * (`setStated`) is left alone altogether.
 *
 * A line's weight is netto, so a GROSS per-package weight fills an empty row
 * weight (marked `weightIsGross`, the reading's old rule for «only brutto is
 * written») and is also kept apart as `derived.grossKg`, the piece the
 * shipment's brutto may be offered from.
 */
export function applyPacking<T extends PackedLine>(input: T): PackingOutcome<T> {
  const p = input.packing;
  const before = input.derived ?? {};
  const line: PackingOutcome<T>['line'] = { ...input };
  const person = new Set<PackedField>((before.person ?? []).filter((f) => positive(input[f] ?? null)));

  // A figure computed on an earlier pass goes back to what stood before it:
  // the original it replaced, else «not stated». One that no longer holds the
  // computed value was changed by somebody since — it is stated, and stays.
  for (const field of FIELDS) {
    if (before[field] === undefined || person.has(field)) continue;
    if (before.computed?.[field] !== undefined && input[field] !== before.computed[field]) continue;
    line[field] = before.replaced?.[field] ?? null;
    if (field === 'measureQty' && before.measureUnitSet) line.measureUnit = null;
  }

  const derived: LineDerived = {};
  const doubts: CartonDoubt[] = [];
  const write = (field: PackedField, product: Derived) => {
    line[field] = product.value;
    derived[field] = product.how;
    derived.computed = { ...(derived.computed ?? {}), [field]: product.value };
  };
  const replace = (field: PackedField, original: number, product: Derived) => {
    derived.replaced = { ...(derived.replaced ?? {}), [field]: original };
    write(field, product);
  };

  if (packingStated(p)) {
    const figures = cartonFigures(p, person.has('weightKg') || before.weightKg === undefined ? (input.weightKg ?? null) : null);
    const cartons = wholeCartons(p.cartons);

    /**
     * Settle one field against its product. `factor` — the per-package
     * factor behind the product: its SOURCE decides whether one carton's
     * figure standing as the line's may be replaced without a question.
     */
    const settle = (field: PackedField, product: Derived | null, perOne: number | null, factor: PackingFactor): CartonVerdict | null => {
      if (!product || person.has(field)) return null;
      const stated = line[field] ?? null;
      const verdict = judgeStated(stated, product, perOne, cartons);
      if (verdict === 'fill') {
        // Not a figure to write: its factors are shown and the row is asked.
        if (product.value >= PRODUCT_MIN) write(field, product);
      } else if (verdict === 'one_carton') {
        if (sourceOf(p, factor) === 'ai') {
          doubts.push({ kind: 'one_or_all', field, stated: stated as number, derived: product, perOne: perOne as number });
        } else {
          replace(field, stated as number, product);
        }
      }
      return verdict;
    };

    // ── the cube
    if (figures.cubeClash) {
      doubts.push({
        kind: 'cube_clash',
        field: 'volumeM3',
        stated: figures.cubeClash.stated,
        derived: { value: figures.cubeClash.fromSize, how: p.size ? sizeText(p.size) : '' },
      });
    } else if (figures.sizeUnitUnsure && !positive(line.volumeM3 ?? null)) {
      doubts.push({ kind: 'size_unit', field: 'volumeM3', stated: null, derived: null });
    } else {
      const cubeFactor: PackingFactor = positive(p.m3PerCarton) && !figures.cubeIsLine ? 'm3PerCarton' : 'size';
      const verdict = settle('volumeM3', figures.volumeM3, figures.cubeOne, cubeFactor);
      if (verdict === 'differs') {
        doubts.push({ kind: 'differs', field: 'volumeM3', stated: line.volumeM3 as number, derived: figures.volumeM3 });
      }
      if (figures.assumedCm && derived.volumeM3 !== undefined) derived.assumedCm = true;
      if (figures.cubeIsLine && derived.volumeM3 !== undefined) derived.cubeIsLine = true;
    }
    if (sizeOwnerUnknown(p) && !positive(line.volumeM3 ?? null)) {
      doubts.push({ kind: 'size_owner', field: 'volumeM3', stated: null, derived: null });
    }

    // ── what one package holds: pieces, or the row's second measure
    if (figures.count) {
      const { unit, ...product } = figures.count;
      if (WHOLE_ONLY.has(unit) && !Number.isInteger(product.value)) {
        doubts.push({ kind: 'not_whole', field: unit === 'dona' ? 'quantity' : 'measureQty', stated: null, derived: product });
      } else if (unit === 'dona') {
        if (settle('quantity', product, p.pcsPerCarton, 'pcsPerCarton') === 'differs') {
          doubts.push({ kind: 'differs', field: 'quantity', stated: line.quantity as number, derived: product });
        }
      } else {
        const holds = line.measureUnit ?? null;
        if (holds && holds !== unit && positive(line.measureQty ?? null)) {
          doubts.push({ kind: 'measure_clash', field: 'measureQty', stated: line.measureQty as number, derived: product });
        } else {
          const had = positive(line.measureQty ?? null);
          const verdict = settle('measureQty', { ...product, how: `${product.how} ${MEASURE_UZ[unit]}` }, p.pcsPerCarton, 'pcsPerCarton');
          if (verdict === 'differs') {
            doubts.push({ kind: 'differs', field: 'measureQty', stated: line.measureQty as number, derived: product });
          } else if (derived.measureQty !== undefined) {
            if (!had && !holds) derived.measureUnitSet = true;
            line.measureUnit = unit;
          }
        }
      }
    }

    // ── the weight
    if (figures.weightKg) {
      const { kind, ...product } = figures.weightKg;
      const stated = person.has('weightKg') ? null : (line.weightKg ?? null);
      const verdict = person.has('weightKg') ? null : judgeStated(stated, product, p.kgPerCarton, cartons);
      if (verdict === 'fill' || verdict === 'one_carton') {
        settle('weightKg', product, p.kgPerCarton, 'kgPerCarton');
      } else if (verdict === 'differs' && positive(stated)) {
        const rowGross = line.weightKind === 'gross';
        if (kind !== 'net' && !rowGross && stated <= product.value) {
          // A row's netto under its packages' brutto is a row, not a question
          // — while it is a believable share of it. Far below, it is more
          // likely ONE carton's weight standing as the row's (JN-4).
          if (stated < product.value * NET_UNDER_GROSS_MIN) {
            const oneCarton = cartons !== null && cartons > 1 && positive(p.kgPerCarton) && stated <= p.kgPerCarton * (1 + SAME_FIGURE_TOLERANCE);
            doubts.push({
              kind: oneCarton ? 'one_or_all' : 'differs',
              field: 'weightKg',
              stated,
              derived: product,
              ...(oneCarton ? { perOne: p.kgPerCarton as number } : {}),
            });
          }
        } else if (kind === 'net' && rowGross && stated > product.value && stated <= product.value * (1 + GROSS_OVER_NET_MAX)) {
          // A brutto row over its packages' netto: both are right.
        } else {
          doubts.push({ kind: 'differs', field: 'weightKg', stated, derived: product });
        }
      }
      if (kind === 'gross') {
        derived.grossKg = product;
        // Computed from a gross weight, or stated equal to it with no kind said (JS-32).
        if (derived.weightKg !== undefined || (verdict === 'agrees' && line.weightKind === undefined)) derived.weightIsGross = true;
      } else if (kind === null && derived.weightKg !== undefined) {
        // Brutto or netto, nobody said — and the row's weight now rests on it.
        doubts.push({ kind: 'weight_kind', field: 'weightKg', stated: null, derived: product, perOne: p.kgPerCarton as number });
      }
    } else if (positive(p.kgPerPiece) && !person.has('weightKg')) {
      // Pieces × one piece's weight (MP-11) — over the line's pieces as they
      // stand NOW, stated or just computed from the cartons. The piece count
      // is the «how many» here, as the carton count is above.
      const pieces = line.quantity ?? null;
      if (positive(pieces)) {
        const product = { value: round3(pieces * p.kgPerPiece), how: `${fmtFigure(pieces)} × ${fmtFigure(p.kgPerPiece)} kg` };
        const stated = line.weightKg ?? null;
        if (!positive(stated)) {
          if (product.value >= PRODUCT_MIN) {
            write('weightKg', product);
            derived.weightFromPieces = true;
          }
        } else if (pieces > 1 && sameFigure(stated, p.kgPerPiece)) {
          if (sourceOf(p, 'kgPerPiece') === 'ai') {
            doubts.push({ kind: 'one_or_all', field: 'weightKg', stated, derived: product, perOne: p.kgPerPiece, perPiece: true });
          } else {
            replace('weightKg', stated, product);
            derived.weightFromPieces = true;
          }
        } else if (!sameFigure(stated, product.value)) {
          doubts.push({ kind: 'differs', field: 'weightKg', stated, derived: product });
        }
      }
    }
  }

  if (person.size > 0) derived.person = FIELDS.filter((f) => person.has(f));
  if (Object.keys(derived).length > 0) line.derived = derived;
  else delete line.derived;
  return { line, doubts };
}

/**
 * A figure a PERSON states or chooses — the one writer of it. The figure is
 * set, whatever the arithmetic had made of that field is forgotten, and the
 * field is marked so no later pass fills over it, replaces it or asks about
 * it again. `null` takes a person's figure back (the arithmetic may fill the
 * field once more).
 */
export function setStated<T extends PackedLine>(line: T, field: PackedField, value: number | null): T {
  const before = line.derived ?? {};
  const derived: LineDerived = { ...before };
  delete derived[field];
  for (const key of ['computed', 'replaced'] as const) {
    const kept = { ...derived[key] };
    delete kept[field];
    if (Object.keys(kept).length > 0) derived[key] = kept;
    else delete derived[key];
  }
  if (field === 'weightKg') {
    delete derived.weightIsGross;
    delete derived.weightFromPieces;
  }
  if (field === 'volumeM3') {
    delete derived.assumedCm;
    delete derived.cubeIsLine;
  }
  if (field === 'measureQty') delete derived.measureUnitSet;
  const others = (before.person ?? []).filter((f) => f !== field);
  const person = positive(value) ? [...others, field] : others;
  if (person.length > 0) derived.person = FIELDS.filter((f) => person.includes(f));
  else delete derived.person;
  const out: T = { ...line, [field]: value };
  if (Object.keys(derived).length > 0) out.derived = derived;
  else delete out.derived;
  return out;
}

/**
 * A person's figure TAKEN BACK (the table's «↩️»): the field holds `before`
 * again and is no longer his. When `before` is exactly what the packing
 * computes, it is the arithmetic's own again — with its mark, so the row
 * reads «hisoblangan» as it did before he answered; otherwise it stands as
 * the stated figure it was.
 */
export function unsetStated<T extends PackedLine>(line: T, field: PackedField, before: number | null): T & Pick<PackedLine, 'derived' | 'measureUnit' | 'measureQty'> {
  const empty = setStated(line, field, null);
  const computed = applyPacking(empty).line;
  if (!positive(before)) return computed;
  if (computed[field] === before && computed.derived?.[field] !== undefined) return computed;
  return applyPacking({ ...empty, [field]: before }).line;
}

const UNIT_OF = (field: PackedField, line: PackedLine): string =>
  field === 'volumeM3'
    ? 'm³'
    : field === 'weightKg'
      ? 'kg'
      : field === 'quantity'
        ? 'dona'
        : (MEASURE_UZ[line.measureUnit as Exclude<PerCartonUnit, 'dona'>] ?? '');
const WORD_OF: Record<PackedField, string> = { volumeM3: 'hajm', weightKg: 'og‘irlik', quantity: 'soni', measureQty: 'o‘lchov' };

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
    const unit = UNIT_OF(field, line);
    // A measure's arithmetic already ends in its unit («20 × 12 juft»).
    const figure = typeof value === 'number' ? ` = ${fmtFigure(value)}${unit ? ` ${unit}` : ''}` : '';
    const was = d.replaced?.[field];
    if (was !== undefined) {
      const one = field === 'weightKg' && d.weightFromPieces ? 'bitta donaniki' : 'bitta karobkaniki';
      out.push(`${WORD_OF[field]} ${one} edi (${fmtFigure(was)}): ${how}${figure}`);
    } else if (field === 'volumeM3' && d.cubeIsLine) {
      out.push(`hajm ${fmtFigure(value as number)} m³ — butun qatorniki (${how})`);
    } else {
      const cm = field === 'volumeM3' && d.assumedCm ? ', sm deb olindi' : '';
      out.push(`${WORD_OF[field]} hisoblangan: ${how}${figure}${cm}`);
    }
  }
  if (d.weightIsGross) out.push('og‘irlik brutto (karobka og‘irligidan)');
  return out;
}

/**
 * The same, in ONE short clause — for a note that has no room for the
 * arithmetic (`provenanceNote`'s budget): which figures are computed, and the
 * originals a replacement stood in for, which must never be lost.
 */
export function derivedBrief(line: PackedLine): string | null {
  const d = line.derived;
  if (!d) return null;
  const made = FIELDS.filter((f) => d[f] !== undefined).map((f) => {
    const was = d.replaced?.[f];
    return was !== undefined ? `${WORD_OF[f]} (asli ${fmtFigure(was)})` : WORD_OF[f];
  });
  if (made.length === 0) return d.weightIsGross ? 'og‘irlik brutto' : null;
  const marks = [d.assumedCm ? 'sm deb olindi' : null, d.weightIsGross ? 'og‘irlik brutto' : null].filter(Boolean);
  return `karobkadan hisoblangan: ${made.join(', ')}${marks.length > 0 ? ` — ${marks.join(', ')}` : ''}`;
}

/**
 * The shipment's BRUTTO from the lines' packages: the Σ of every line's gross
 * product — only when EVERY line has one whose weight was SAID to be gross (a
 * sum over some of the lines is one factory's, or half a list's; a weight of
 * an unsaid kind is as often netto, JN-24). An OFFER for the brutto question,
 * never a figure to write without a person's press.
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
 * AI o‘qidi». Null when the packing states nothing. (Named apart from
 * file-goods.ts's `packingNote`, which words a whole packing LIST.)
 */
export function packingWords(p: Packing | null | undefined): string | null {
  if (!packingStated(p)) return null;
  const parts: string[] = [];
  if (positive(p.cartons)) parts.push(`${fmtFigure(p.cartons)} karobka`);
  if (p.size) {
    const whose = p.size.of === 'product' ? 'tovar o‘lchami ' : p.size.of === null ? 'o‘lcham (kimniki — aniq emas) ' : '';
    parts.push(`${whose}${sizeText(p.size)}`);
  }
  if (positive(p.m3PerCarton)) parts.push(`${fmtFigure(p.m3PerCarton)} m³/karobka`);
  if (positive(p.kgPerCarton)) {
    const kind = p.kgPerCartonKind === 'gross' ? ' (brutto)' : p.kgPerCartonKind === 'net' ? ' (netto)' : '';
    parts.push(`${fmtFigure(p.kgPerCarton)} kg/karobka${kind}`);
  }
  if (positive(p.pcsPerCarton)) {
    const unit = p.perCartonUnit && p.perCartonUnit !== 'dona' ? MEASURE_UZ[p.perCartonUnit] : 'dona';
    parts.push(`${fmtFigure(p.pcsPerCarton)} ${unit}/karobka`);
  }
  if (positive(p.kgPerPiece)) parts.push(`${fmtFigure(p.kgPerPiece)} kg/dona`);
  if (parts.length === 0) return null;
  const sources = new Set<PackingSource>(FACTORS.filter((f) => p[f] != null).map((f) => sourceOf(p, f)));
  const who = (['typed', 'file', 'ai'] as const).filter((s) => sources.has(s)).map((s) => SOURCE_UZ[s]);
  return `📦 ${parts.join(' · ')} — ${who.join(' + ') || SOURCE_UZ[p.from]}`;
}

// ── two sources, one row ────────────────────────────────────────────────────

/** A factor two sources state DIFFERENTLY — asked, never silently either (JS-31). */
export interface PackingClash {
  factor: PackingFactor;
  /** As each source wrote it, for the question's words. */
  mine: string;
  theirs: string;
}

const sameSides = (a: BareSize, b: BareSize): boolean =>
  sameFigure(a.l, b.l) && sameFigure(a.w, b.w) && sameFigure(a.h, b.h);

/**
 * One row's packing from TWO sources — the seller's caption beside the
 * packing list's photo. Per factor: only one side states it → that one, with
 * its source; both and equal (2 %) → the first source's, a size taking the
 * other's unit or owner where its own says nothing; both and DIFFERENT → the
 * factor is left out of the result (nothing is multiplied from a figure two
 * sources disagree on) and returned as a clash for the table to ask.
 *
 * `mine` is the source that outranks on a tie — the seller's own words over a
 * reading, a reading over nothing.
 */
export function mergePacking(mine: Packing | null | undefined, theirs: Packing | null | undefined): { packing: Packing | null; clashes: PackingClash[] } {
  if (!packingStated(mine)) return { packing: packingStated(theirs) ? theirs : null, clashes: [] };
  if (!packingStated(theirs)) return { packing: mine, clashes: [] };
  const out: Packing = { ...emptyPacking(mine.from) };
  const fromOf: Partial<Record<PackingFactor, PackingSource>> = {};
  const clashes: PackingClash[] = [];
  const take = <F extends PackingFactor>(factor: F, value: Packing[F], from: Packing) => {
    out[factor] = value;
    fromOf[factor] = sourceOf(from, factor);
  };
  for (const factor of ['cartons', 'pcsPerCarton', 'kgPerCarton', 'm3PerCarton', 'kgPerPiece'] as const) {
    const a = mine[factor] ?? null;
    const b = theirs[factor] ?? null;
    if (a === null && b === null) continue;
    if (b === null) take(factor, a, mine);
    else if (a === null) take(factor, b, theirs);
    else if (sameFigure(a, b)) take(factor, a, mine);
    else clashes.push({ factor, mine: fmtFigure(a), theirs: fmtFigure(b) });
  }
  // The words that travel with a factor follow the source it was taken from.
  if (out.kgPerCarton !== null) {
    const owner = fromOf.kgPerCarton === sourceOf(mine, 'kgPerCarton') && mine.kgPerCarton !== null ? mine : theirs;
    out.kgPerCartonKind = owner.kgPerCartonKind ?? (owner === mine ? theirs.kgPerCartonKind : mine.kgPerCartonKind) ?? null;
  }
  if (out.pcsPerCarton !== null) {
    const unit = (mine.pcsPerCarton !== null ? mine.perCartonUnit : undefined) ?? theirs.perCartonUnit;
    if (unit) out.perCartonUnit = unit;
  }
  if (mine.size && theirs.size) {
    if (sameSides(mine.size, theirs.size) && (mine.size.unit === null || theirs.size.unit === null || mine.size.unit === theirs.size.unit)) {
      out.size = { ...mine.size, unit: mine.size.unit ?? theirs.size.unit, of: mine.size.of ?? theirs.size.of };
      fromOf.size = sourceOf(mine, 'size');
    } else {
      clashes.push({ factor: 'size', mine: sizeText(mine.size), theirs: sizeText(theirs.size) });
    }
  } else if (mine.size) take('size', mine.size, mine);
  else if (theirs.size) take('size', theirs.size, theirs);
  out.fromOf = fromOf;
  return { packing: packingStated(out) ? out : null, clashes };
}

/**
 * A PRODUCT's own size and the row's pieces — a cube the bot may OFFER and
 * never writes by itself (docs/AI-SORAYDI.md §2.3): a lathe «200×150×180 sm ×
 * 1 dona = 5.4 m³» ships in its own size, a flat-packed table does not, and
 * only the seller knows which. Null unless the row has pieces, a product
 * size with a readable unit, and no cube of its own.
 */
export function productCubeOffer(line: PackedLine): Derived | null {
  const size = line.packing?.size;
  if (!size || size.of !== 'product') return null;
  const pieces = line.quantity ?? null;
  if (!positive(pieces) || positive(line.volumeM3 ?? null)) return null;
  const cube = sizeCube(size);
  if (!cube || cube.m3 > PACKAGE_MAX_M3) return null;
  const value = round3(pieces * cube.m3);
  if (value < PRODUCT_MIN) return null;
  return { value, how: `${fmtFigure(pieces)} × ${sizeText(size)}` };
}

/** A size beside a carton count whose owner nobody stated: asked, never multiplied. */
export function sizeOwnerUnknown(p: Packing | null | undefined): boolean {
  return !!p && !!p.size && p.size.of === null && wholeCartons(p.cartons) !== null && !positive(p.m3PerCarton);
}

/** «2.4 m³ (hisoblangan: 20 × 60×40×50 sm)» — a computed figure's own words. */
export function derivedText(how: string, assumedCm = false): string {
  return `hisoblangan: ${how}${assumedCm ? ', sm deb olindi' : ''}`;
}
