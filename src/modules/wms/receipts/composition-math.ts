/**
 * Lot tarkibi — the pure arithmetic (docs/LOT-TARKIBI.md §2). The owner's
 * case: a lot of 100 cartons received as «klaviatura» turns out, on the
 * client's papers, to be 50 keyboards + 50 mice. The lot, its cartons and its
 * stickers never change (nobody knows which carton is which — his 2c); the
 * VED states a COMPOSITION, and every money-free number the customs papers
 * print about it comes from here.
 *
 * Zero imports from `db`, `next` or `react`: the receipt card's editor runs
 * the same parse and the same live remainder in the browser, and the server
 * re-runs both on save.
 *
 * Integers everywhere a figure is summed: a measure is held as integer UNITS
 * at its column's scale (kg ×1000, m³ ×10000), and every split is a largest
 * remainder over BigInt weights — `0.1 + 0.2` is not `0.3` in floating point,
 * and at the columns' limits a product of two figures passes 2^53.
 */

export const KG_SCALE = 3;
export const M3_SCALE = 4;

/** int4's ceiling — pieces and cartons are `integer` columns. */
const INT4_MAX = 2_147_483_647;

/** Digit grouping a person types: spaces, NBSP, the narrow NBSP, apostrophes. */
const GROUPING = /[\s  '’ʼ]/g;

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/**
 * A typed MEASURE → integer units at `scale`, by string arithmetic (never
 * `x * 1000` in floating point). Spaces, NBSP and apostrophes group digits;
 * a single «,» or «.» is the DECIMAL mark — «2,125» m³ is 2.1250, «450,500»
 * kg is 450.500 (ru is the default locale and m³ is written to three or four
 * decimals; `parseTypedMoney`'s «,ddd = thousands» rule turned «2,125» into
 * 2125 m³). Both marks present → the LAST is the decimal and the other must
 * group threes («1,200.5», «1.200,5»). null for anything else, for more
 * decimals than the column holds, for ≤ 0. Deliberately NOT
 * `crm/field-map.ts parseMeasure` (lenient: «5-10» → 5 is right for a form
 * answer and wrong for a declared figure) nor `parseTypedMoney` (money).
 */
export function toUnits(raw: string, scale: number): number | null {
  const units = unitsOf(raw, scale);
  return units !== null && units > 0 ? units : null;
}

/** `toUnits` without the «> 0» — for a STORED total, which may be zero. */
function unitsOf(raw: string, scale: number): number | null {
  const s = String(raw ?? '').replace(GROUPING, '');
  if (s === '') return null;
  const commas = (s.match(/,/g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  let normal: string;
  if (commas > 0 && dots > 0) {
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const group = decimal === ',' ? '.' : ',';
    if ((decimal === ',' ? commas : dots) !== 1) return null;
    const at = s.lastIndexOf(decimal);
    const whole = s.slice(0, at);
    const frac = s.slice(at + 1);
    const groups = whole.split(group);
    if (!/^\d{1,3}$/.test(groups[0] ?? '')) return null;
    if (groups.slice(1).some((g) => !/^\d{3}$/.test(g))) return null;
    normal = `${groups.join('')}.${frac}`;
  } else if (commas + dots > 1) {
    return null;
  } else {
    normal = s.replace(',', '.');
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(normal);
  if (!m) return null;
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > scale) return null;
  const units = BigInt(whole) * pow10(scale) + BigInt(frac.padEnd(scale, '0') || '0');
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(units);
}

/** A stored numeric string («1000.000») → units; a missing value reads 0. */
export function storedUnits(raw: string | number | null | undefined, scale: number): number {
  if (raw === null || raw === undefined) return 0;
  return unitsOf(String(raw), scale) ?? 0;
}

/** Units → the column's own spelling: 600000 at scale 3 → '600.000'. */
export function fromUnits(units: number, scale: number): string {
  const neg = units < 0;
  const abs = BigInt(Math.abs(Math.trunc(units)));
  const p = pow10(scale);
  const whole = abs / p;
  const frac = (abs % p).toString().padStart(scale, '0');
  return `${neg ? '-' : ''}${whole}${scale > 0 ? `.${frac}` : ''}`;
}

/** A positive whole number («1 000» → 1000), else null — pieces and cartons. */
export function toCount(raw: string): number | null {
  const s = String(raw ?? '').replace(GROUPING, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= INT4_MAX ? n : null;
}

/**
 * Hamilton / largest remainder in INTEGERS over BigInt weights:
 * floor(total·wᵢ/W), the rest one unit at a time to the largest fractional
 * parts, a tie to the LOWER index. BigInt because at the columns' limits
 * total·w passes 2^53 and because the «alohida» kg weights are rationals
 * brought to a common denominator. Σ out = total exactly.
 */
export function largestRemainder(total: number, weights: readonly bigint[]): number[] {
  const k = weights.length;
  if (k === 0) return [];
  let W = 0n;
  for (const w of weights) W += w;
  const T = BigInt(Math.trunc(total));
  if (W <= 0n) {
    // No weight anywhere (never reached by the papers: a printed line always
    // weighs something) — an even split rather than a division by zero.
    return largestRemainder(total, weights.map(() => 1n));
  }
  const floors: bigint[] = [];
  const rems: bigint[] = [];
  let given = 0n;
  for (const w of weights) {
    const q = (T * w) / W;
    floors.push(q);
    rems.push(T * w - q * W);
    given += q;
  }
  const order = weights
    .map((_, i) => i)
    .sort((a, b) => (rems[b]! > rems[a]! ? 1 : rems[b]! < rems[a]! ? -1 : a - b));
  let left = T - given;
  for (let j = 0; left > 0n; j = (j + 1) % k) {
    floors[order[j]!]! += 1n;
    left -= 1n;
  }
  return floors.map((f) => Number(f));
}

/**
 * The first `x` seats of the Sainte-Laguë (Webster) sequence over the
 * integer weights `w`: one seat at a time to the largest wᵢ/(2sᵢ+1), compared
 * by cross-multiplication in BigInt, a tie to the lower index. HOUSE-MONOTONE
 * (every sᵢ is non-decreasing in x — largest remainder is not: the Alabama
 * paradox), and at x = Σw it returns w exactly (an under-seated line always
 * outranks an over-seated one: wᵢ/(2wᵢ−1) > ½ > wⱼ/(2wⱼ+1)).
 */
export function seatsPrefix(x: number, w: readonly number[]): number[] {
  const seats = w.map(() => 0);
  if (w.length === 0) return seats;
  const weights = w.map((v) => BigInt(Math.max(0, Math.trunc(v))));
  for (let k = 0; k < x; k += 1) {
    let best = 0;
    for (let i = 1; i < weights.length; i += 1) {
      // weights[i]/(2s_i+1) > weights[best]/(2s_best+1) ?
      const lhs = weights[i]! * BigInt(2 * seats[best]! + 1);
      const rhs = weights[best]! * BigInt(2 * seats[i]! + 1);
      if (lhs > rhs) best = i;
    }
    seats[best]! += 1;
  }
  return seats;
}

/** round-half-up of num/den in BigInt (num ≥ 0, den > 0). */
export function roundHalfUp(num: bigint, den: bigint): number {
  if (den <= 0n) return 0;
  return Number((2n * num + den) / (2n * den));
}

export type CompositionMode = 'separate' | 'mixed' | 'invalid';

/**
 * The mode is DERIVED from the lines — one fact, one home, no column:
 * every line carries cartons → «alohida karobkalar», none does → «aralash».
 * A half state cannot be saved (the service refuses `cartons_partial`); a
 * reader meeting it prints it as mixed, flagged estimate, and never crashes a
 * customs paper.
 */
export function compositionMode(lines: readonly { cartons: number | null }[]): CompositionMode {
  const withCartons = lines.filter((l) => l.cartons !== null).length;
  if (withCartons === 0) return 'mixed';
  return withCartons === lines.length ? 'separate' : 'invalid';
}

export interface DraftLine {
  name: string;
  pieces: string;
  cartons: string;
  kg: string;
  m3: string;
  tnved: string;
}
export interface ParsedLine {
  seq: number;
  name: string;
  pieces: number | null;
  cartons: number | null;
  kgUnits: number;
  m3Units: number;
  tnvedCode: string | null;
}
/** The lot's own figures, as stored. */
export interface LotTotals {
  boxCount: number;
  kg: string;
  m3: string;
}
/** A saved line as the readers get it — also the frozen copy's element. */
export interface StoredLine {
  seq: number;
  name: string;
  pieces: number | null;
  cartons: number | null;
  kg: string;
  m3: string;
  tnvedCode: string | null;
}
export type FrozenLine = StoredLine;

export type MeasureField = 'pieces' | 'cartons' | 'kg' | 'm3';
export type DraftRefusal =
  | { code: 'lines_count' }
  | { code: 'bad_line' | 'bad_tnved' | 'duplicate_name'; seq: number }
  | { code: 'bad_number'; seq: number; field: MeasureField }
  | { code: 'cartons_partial' }
  | { code: 'cartons_sum'; sum: number; lot: number }
  | { code: 'kg_sum'; sum: string; lot: string }
  | { code: 'm3_sum'; sum: string; lot: string };

export const MIN_LINES = 2;
export const MAX_LINES = 20;

/**
 * The duplicate key of a line name: `tnved/service.ts productKey`, restated
 * (that module reaches the database and this one runs in the browser) — a
 * unit test holds the two equal.
 */
export function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A TNVED code as typed («8471 60 7000») → its digits, or the refusal. */
function tnvedOf(raw: string): { ok: true; code: string | null } | { ok: false } {
  const s = String(raw ?? '').replace(/[\s  .-]/g, '');
  if (s === '') return { ok: true, code: null };
  return /^\d{4,10}$/.test(s) ? { ok: true, code: s } : { ok: false };
}

const isBlank = (l: DraftLine): boolean =>
  [l.name, l.pieces, l.cartons, l.kg, l.m3, l.tnved].every((v) => String(v ?? '').trim() === '');

/**
 * Shape + numbers, in the order the person reads the lines: the first bad
 * row is named by its seq (its place on the screen) and, for a number, its
 * FIELD. Names trimmed and measured in CODE POINTS (`[...name].length`, what
 * the CHECK's char_length counts — «📦» is 2 UTF-16 units and 1 character);
 * a row with every field empty is a blank row the UI left and is dropped.
 */
export function parseDraft(
  lines: readonly DraftLine[],
): { ok: true; lines: ParsedLine[] } | { ok: false; refusal: DraftRefusal } {
  const kept = lines.map((l, i) => ({ l, screen: i + 1 })).filter(({ l }) => !isBlank(l));
  if (kept.length < MIN_LINES || kept.length > MAX_LINES) {
    return { ok: false, refusal: { code: 'lines_count' } };
  }
  const seen = new Set<string>();
  const out: ParsedLine[] = [];
  for (const [i, { l, screen }] of kept.entries()) {
    const name = String(l.name ?? '').trim();
    const len = [...name].length;
    if (len < 2 || len > 200) return { ok: false, refusal: { code: 'bad_line', seq: screen } };
    let pieces: number | null = null;
    if (String(l.pieces ?? '').trim() !== '') {
      pieces = toCount(l.pieces);
      if (pieces === null) return { ok: false, refusal: { code: 'bad_number', seq: screen, field: 'pieces' } };
    }
    let cartons: number | null = null;
    if (String(l.cartons ?? '').trim() !== '') {
      cartons = toCount(l.cartons);
      if (cartons === null) {
        return { ok: false, refusal: { code: 'bad_number', seq: screen, field: 'cartons' } };
      }
    }
    const kgUnits = toUnits(l.kg, KG_SCALE);
    if (kgUnits === null) return { ok: false, refusal: { code: 'bad_number', seq: screen, field: 'kg' } };
    const m3Units = toUnits(l.m3, M3_SCALE);
    if (m3Units === null) return { ok: false, refusal: { code: 'bad_number', seq: screen, field: 'm3' } };
    const tnved = tnvedOf(l.tnved);
    if (!tnved.ok) return { ok: false, refusal: { code: 'bad_tnved', seq: screen } };
    const key = nameKey(name);
    if (seen.has(key)) return { ok: false, refusal: { code: 'duplicate_name', seq: screen } };
    seen.add(key);
    out.push({ seq: i + 1, name, pieces, cartons, kgUnits, m3Units, tnvedCode: tnved.code });
  }
  return { ok: true, lines: out };
}

/** The sums against the lot (cartons only when mode = separate). */
export function checkSums(lines: readonly ParsedLine[], lot: LotTotals): DraftRefusal | null {
  const mode = compositionMode(lines);
  if (mode === 'invalid') return { code: 'cartons_partial' };
  if (mode === 'separate') {
    const sum = lines.reduce((s, l) => s + (l.cartons ?? 0), 0);
    if (sum !== lot.boxCount) return { code: 'cartons_sum', sum, lot: lot.boxCount };
  }
  const kg = lines.reduce((s, l) => s + l.kgUnits, 0);
  const lotKg = storedUnits(lot.kg, KG_SCALE);
  if (kg !== lotKg) return { code: 'kg_sum', sum: fromUnits(kg, KG_SCALE), lot: fromUnits(lotKg, KG_SCALE) };
  const m3 = lines.reduce((s, l) => s + l.m3Units, 0);
  const lotM3 = storedUnits(lot.m3, M3_SCALE);
  if (m3 !== lotM3) return { code: 'm3_sum', sum: fromUnits(m3, M3_SCALE), lot: fromUnits(lotM3, M3_SCALE) };
  return null;
}

/**
 * The live counter, PER MEASURE: what is left (positive) or over (negative)
 * for kg, m³ and cartons separately — `cartons` null while no row states any
 * (aralash). An unreadable cell counts as 0 and sets `incomplete`.
 */
export function remainderOf(
  lines: readonly DraftLine[],
  lot: LotTotals,
): { kgUnits: number; m3Units: number; cartons: number | null; incomplete: boolean } {
  let kg = 0;
  let m3 = 0;
  let cartons = 0;
  let anyCartons = false;
  let incomplete = false;
  for (const l of lines) {
    if (isBlank(l)) continue;
    const k = toUnits(l.kg, KG_SCALE);
    const v = toUnits(l.m3, M3_SCALE);
    if (k === null) incomplete = true;
    else kg += k;
    if (v === null) incomplete = true;
    else m3 += v;
    if (String(l.cartons ?? '').trim() !== '') {
      anyCartons = true;
      const c = toCount(l.cartons);
      if (c === null) incomplete = true;
      else cartons += c;
    }
    if (String(l.pieces ?? '').trim() !== '' && toCount(l.pieces) === null) incomplete = true;
  }
  return {
    kgUnits: storedUnits(lot.kg, KG_SCALE) - kg,
    m3Units: storedUnits(lot.m3, M3_SCALE) - m3,
    cartons: anyCartons ? lot.boxCount - cartons : null,
    incomplete,
  };
}

/**
 * «Karobka soniga qarab taqsimlash»: kg and m³ by largest remainder over the
 * typed cartons — only when every row has cartons and Σ = box_count. A
 * PERSON presses it; nothing divides on save (#768).
 */
export function prefillByCartons(lines: readonly DraftLine[], lot: LotTotals): { kg: string; m3: string }[] | null {
  if (lines.length === 0) return null;
  const cartons = lines.map((l) => toCount(l.cartons));
  if (cartons.some((c) => c === null)) return null;
  const sum = cartons.reduce<number>((s, c) => s + (c ?? 0), 0);
  if (sum !== lot.boxCount) return null;
  const w = cartons.map((c) => BigInt(c ?? 0));
  const kg = largestRemainder(storedUnits(lot.kg, KG_SCALE), w);
  const m3 = largestRemainder(storedUnits(lot.m3, M3_SCALE), w);
  return lines.map((_, i) => ({ kg: fromUnits(kg[i]!, KG_SCALE), m3: fromUnits(m3[i]!, M3_SCALE) }));
}

/**
 * «Sklad o'lchoviga moslashtirish»: the typed kg (or, separately, m³) scaled
 * onto the lot's stored totals by largest remainder over the typed values —
 * the client's paper says 450 + 450 kg, the warehouse scale said 1000.000.
 * Null when a row is unreadable or the sum already matches. A PERSON presses
 * it; save re-checks.
 */
export function scaleToLot(lines: readonly DraftLine[], lot: LotTotals, field: 'kg' | 'm3'): string[] | null {
  if (lines.length === 0) return null;
  const scale = field === 'kg' ? KG_SCALE : M3_SCALE;
  const values = lines.map((l) => toUnits(l[field], scale));
  if (values.some((v) => v === null)) return null;
  const sum = values.reduce<number>((s, v) => s + (v ?? 0), 0);
  const target = storedUnits(field === 'kg' ? lot.kg : lot.m3, scale);
  if (sum === target || target <= 0) return null;
  const out = largestRemainder(
    target,
    values.map((v) => BigInt(v ?? 0)),
  );
  // A line scaled to nothing could not be saved (> 0 CHECK) — no offer then.
  if (out.some((u) => u <= 0)) return null;
  return out.map((u) => fromUnits(u, scale));
}

/**
 * «=» beside ONE field of one row: the lot total minus the OTHER rows of that
 * field, when positive. Per field, so balancing kg never overwrites an m³
 * copied from the document.
 */
export function fillRest(
  lines: readonly DraftLine[],
  index: number,
  field: 'kg' | 'm3',
  lot: LotTotals,
): string | null {
  const scale = field === 'kg' ? KG_SCALE : M3_SCALE;
  let others = 0;
  for (const [i, l] of lines.entries()) {
    if (i === index || isBlank(l)) continue;
    const v = toUnits(l[field], scale);
    if (v === null) return null;
    others += v;
  }
  const rest = storedUnits(field === 'kg' ? lot.kg : lot.m3, scale) - others;
  return rest > 0 ? fromUnits(rest, scale) : null;
}

/**
 * The lot moved after the save: box_count ≠ seen, or Σ lines ≠ the lot's
 * current kg or m³ (compared in units). The one stale test — nothing hooks
 * into editLot or the count doors; every reader compares.
 */
export function isStale(
  comp: { seenBoxCount: number; lines: readonly { kg: string; m3: string }[] },
  lot: LotTotals,
): boolean {
  if (comp.seenBoxCount !== lot.boxCount) return true;
  const kg = comp.lines.reduce((s, l) => s + storedUnits(l.kg, KG_SCALE), 0);
  if (kg !== storedUnits(lot.kg, KG_SCALE)) return true;
  const m3 = comp.lines.reduce((s, l) => s + storedUnits(l.m3, M3_SCALE), 0);
  return m3 !== storedUnits(lot.m3, M3_SCALE);
}

export interface LotTruck {
  batchId: string;
  departedAt: string | null;
  createdAt: string;
  crosses: boolean;
  n: number;
}

const instant = (s: string | null): number => (s === null ? Number.NaN : Date.parse(s));

/** Departed first by departure, then not departed by creation, then id. */
function truckOrder(a: LotTruck, b: LotTruck): number {
  const ad = a.departedAt !== null;
  const bd = b.departedAt !== null;
  if (ad !== bd) return ad ? -1 : 1;
  const ta = ad ? instant(a.departedAt) : instant(a.createdAt);
  const tb = bd ? instant(b.departedAt) : instant(b.createdAt);
  if (ta !== tb && !Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
  return a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0;
}

/**
 * The lot's cartons on its cross-border trucks ordered BEFORE this one — the
 * cumulative offset of §2's rule. `trucks` = `lotTrucksFor` rows of ONE lot.
 * A truck that does not cross the border → 0 (its papers do not go to
 * customs), and so does a truck the list does not name.
 */
export function cartonsBefore(trucks: readonly LotTruck[], batchId: string): number {
  const self = trucks.find((t) => t.batchId === batchId);
  if (!self || !self.crosses) return 0;
  const crossing = trucks.filter((t) => t.crosses).slice().sort(truckOrder);
  let before = 0;
  for (const t of crossing) {
    if (t.batchId === batchId) break;
    before += t.n;
  }
  return before;
}

/** What ONE document prints for a composed lot. */
export interface PaperPortion {
  /** `cartonsBefore` for this lot and this document's truck. */
  before: number;
  /** The lot's cartons in THIS document's population (n). */
  cartons: number;
  /**
   * The single figure today's builder prints for this lot — the builder's
   * OWN rounded value (invoice `Math.round(x·10)/10`, packing-photos
   * `Number(x.toFixed(1))`), passed on, never recomputed here.
   */
  kg: number;
  m3?: number;
  /** Invoice only: `invoicePlaceParts` for this lot. */
  places?: { loose: number; pallets: number };
}
export interface PaperLine {
  seq: number;
  name: string;
  tnvedCode: string | null;
  /** null when the line states none; 0 when it does and none fall on this truck. */
  pieces: number | null;
  /** null in aralash. */
  cartons: number | null;
  kg: number;
  /** null when the portion has no m3. */
  m3: number | null;
  /** null when the portion has no places. */
  places: number | 'part' | null;
}
export type PaperReason = 'share' | 'stale' | 'invalid' | 'pallet' | 'clamped';
export interface PaperView {
  lines: PaperLine[];
  estimate: boolean;
  reasons: PaperReason[];
}

/**
 * The one rule (§2): what a document prints for a composed lot.
 *
 * Cartons and pieces are allocated CUMULATIVELY over the lot's crossing
 * trucks (a Sainte-Laguë prefix for cartons), so they sum to the typed
 * composition however the lot was split; kg and m³ split THIS document's
 * single figure by largest remainder, so the paper's column sums never move.
 */
export function paperLines(
  comp: { seenBoxCount: number; lines: readonly StoredLine[] },
  lot: LotTotals,
  portion: PaperPortion,
  opts: { kgDecimals?: number; m3Decimals?: number } = {},
): PaperView {
  const kgD = opts.kgDecimals ?? 1;
  const m3D = opts.m3Decimals ?? 3;
  const reasons = new Set<PaperReason>();
  const B = lot.boxCount;
  const S = comp.seenBoxCount;
  const n = Math.max(0, Math.trunc(portion.cartons));
  let b = Math.max(0, Math.trunc(portion.before));
  if (b + n > B) {
    b = Math.max(0, B - n);
    reasons.add('clamped');
  }
  const lines = comp.lines;
  let mode = compositionMode(lines);
  if (mode === 'invalid') {
    reasons.add('invalid');
    mode = 'mixed';
  }
  if (n !== B) reasons.add('share');
  if (isStale(comp, lot)) reasons.add('stale');

  const kgUnits = lines.map((l) => BigInt(storedUnits(l.kg, KG_SCALE)));
  const m3Units = lines.map((l) => BigInt(storedUnits(l.m3, M3_SCALE)));
  const T = Math.round(portion.kg * 10 ** kgD);
  const M = portion.m3 !== undefined ? Math.round(portion.m3 * 10 ** m3D) : null;

  let printed: number[];
  let cOn: number[] = lines.map(() => 0);
  let kgW: bigint[];
  let m3W: bigint[];
  let piecesOn: (number | null)[];

  if (mode === 'separate') {
    const typed = lines.map((l) => l.cartons ?? 0);
    const before = seatsPrefix(b, typed);
    const upto = seatsPrefix(b + n, typed);
    cOn = upto.map((s, i) => s - before[i]!);
    printed = cOn.map((c, i) => (c >= 1 ? i : -1)).filter((i) => i >= 0);
    // wᵢ = cᵢ·unitsᵢ/cartonsᵢ, exact over the common denominator Π cartonsⱼ.
    const denom = printed.reduce((d, i) => d * BigInt(typed[i]!), 1n);
    const weight = (units: bigint[], i: number): bigint =>
      BigInt(cOn[i]!) * units[i]! * (denom / BigInt(typed[i]!));
    kgW = printed.map((i) => weight(kgUnits, i));
    m3W = printed.map((i) => weight(m3Units, i));
    piecesOn = lines.map((l, i) => {
      if (l.pieces === null) return null;
      const P = (x: number) => roundHalfUp(BigInt(l.pieces!) * BigInt(x), BigInt(typed[i]!));
      return P(upto[i]!) - P(before[i]!);
    });
  } else {
    printed = lines.map((_, i) => i);
    kgW = printed.map((i) => kgUnits[i]!);
    m3W = printed.map((i) => m3Units[i]!);
    piecesOn = lines.map((l) => {
      if (l.pieces === null) return null;
      const P = (x: number) => roundHalfUp(BigInt(l.pieces!) * BigInt(x), BigInt(Math.max(1, S)));
      return P(b + n) - P(b);
    });
  }

  const kgOut = largestRemainder(T, kgW);
  const m3Out = M !== null ? largestRemainder(M, m3W) : null;

  let places: (number | 'part' | null)[] = printed.map(() => null);
  if (portion.places) {
    const P = portion.places.loose + portion.places.pallets;
    if (mode === 'separate') {
      const split = largestRemainder(
        P,
        printed.map((i) => BigInt(cOn[i]!)),
      );
      places = split.map((p) => (p === 0 ? 'part' : p));
      if (portion.places.pallets > 0 && printed.length > 1) reasons.add('pallet');
    } else {
      places = printed.map((_, j) => (j === 0 ? P : 'part'));
    }
  }

  const out: PaperLine[] = printed.map((i, j) => {
    const l = lines[i]!;
    return {
      seq: l.seq,
      name: l.name,
      tnvedCode: l.tnvedCode,
      pieces: piecesOn[i] ?? null,
      cartons: mode === 'separate' ? cOn[i]! : null,
      kg: kgOut[j]! / 10 ** kgD,
      m3: m3Out ? m3Out[j]! / 10 ** m3D : null,
      places: places[j] ?? null,
    };
  });
  const order: PaperReason[] = ['share', 'stale', 'invalid', 'pallet', 'clamped'];
  const list = order.filter((r) => reasons.has(r));
  return { lines: out, estimate: list.length > 0, reasons: list };
}
