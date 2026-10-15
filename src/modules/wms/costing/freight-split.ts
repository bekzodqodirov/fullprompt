import { bandFor, type FreightBand } from '../calc/pricing';
import { ALLOCATION_BASES, type AllocationBasis } from './engine';
import type {
  BoxMeasure,
  ClientRollup,
  ColumnProblem,
  BandView,
  FreightBandCopy,
  FreightCopy,
  FreightCopyDraft,
  FreightHeld,
  FreightOffer,
  HeldLot,
  LotIdentity,
  LotView,
  PricedLot,
  SplitView,
  TypeFlags,
} from './freight-types';

/**
 * Yo'lkira tarifi bo'yicha taqsimlash — the arithmetic, PURE (docs/
 * YOLKIRA-TAQSIMOT.md §1). Imports only the pure engine and the pure calc
 * engine, so the recompute, the void guard, the preview in the browser and
 * every explanation read the same lines and cannot disagree about a share.
 *
 * A truck's bill is split over the LOTS aboard in proportion to each lot's
 * yo'lkira VALUE on his own tariff (his 2b, 2026-10-15 — «aynan shu tovar
 * qancha foizdaligi hisoblanib»): every lot is priced by its OWN density on
 * its own tariff row, its value is that rate × its m³ on this truck, and
 * inside a lot the share goes by m³ (equally per carton — every carton of a
 * lot has the same measure). His rule 6, per lot: a lot lighter than
 * `lightBelow` kg per m³ is a typing error to be fixed, not a price to be
 * read, so the bill is HELD (written, not split); a lot heavier than that but
 * under the column's lowest floor takes the lowest row («1 kub uchun 100
 * kgdan kam tarifda ketaversin»).
 *
 * The density is computed EXACTLY, in integer grams and cm³: a float sum of
 * 63.968 kg cartons flips 999↔1000 kg/m³ with the carton count, which is the
 * $320/m³ → $0.55/kg step of his table. The calc's own `bandDensityOf` is not
 * touched — the calc and the seals do not move.
 */

/** His rule 6: «1 kub 10 kg dan kam to‘g‘ri keladigan bo‘lsa ogohlantirsin». */
export const FREIGHT_LIGHT_BELOW = 10;

/** An exact non-negative rational: n / d, d > 0. */
export interface Frac {
  n: bigint;
  d: bigint;
}

const ZERO: Frac = { n: 0n, d: 1n };

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

/**
 * Exact, and REDUCED (fix review): unreduced, a totals-measured lot of N
 * cartons — each carton totals ÷ N — summed to a denominator of N^N, so a
 * 500-carton lot carried a 1,350-digit BigInt through every split, and its
 * float twin read Infinity / Infinity = NaN. The cartons of one lot share a
 * denominator, which is the fast path.
 */
const add = (a: Frac, b: Frac): Frac => {
  if (a.n === 0n) return b;
  if (b.n === 0n) return a;
  const n = a.d === b.d ? a.n + b.n : a.n * b.d + b.n * a.d;
  const d = a.d === b.d ? a.d : a.d * b.d;
  const g = gcd(n, d);
  return g > 1n ? { n: n / g, d: d / g } : { n, d };
};

/** A fixed-scale decimal as the database prints it, × 10^scale, as a BigInt. Null on anything else. */
function decimal(raw: string | null, scale: number): bigint | null {
  if (raw === null) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(scale, '0');
  if (frac.length > scale) return null;
  const v = BigInt(m[2]! + frac);
  return m[1] === '-' ? -v : v;
}

/**
 * One carton's measure in grams and cm³, exactly (§1.3).
 *
 * A UNIFORM lot with all four box dims states the carton itself: its box
 * weight (numeric(12,3) — whole grams) and L·W·H (whole cm³). Neither moves
 * when the lot grows or is edited, which the stored totals do (they are
 * re-rounded per count). Any other lot — mixed, or a legacy uniform lot with
 * NULL dims — is its totals ÷ box_count, still exact as a fraction. Null when
 * the lot cannot be measured at all.
 */
export function stableMeasure(m: BoxMeasure): { grams: Frac; cm3: Frac } | null {
  const uniform =
    m.dimsMode === 'uniform' &&
    m.boxLengthCm !== null &&
    m.boxWidthCm !== null &&
    m.boxHeightCm !== null &&
    m.boxWeightKg !== null;
  if (uniform) {
    const grams = decimal(m.boxWeightKg, 3);
    if (grams === null) return null;
    const cm3 = BigInt(m.boxLengthCm!) * BigInt(m.boxWidthCm!) * BigInt(m.boxHeightCm!);
    return { grams: { n: grams, d: 1n }, cm3: { n: cm3, d: 1n } };
  }
  if (!(m.boxCount > 0)) return null;
  const grams = decimal(m.totalWeightKg, 3);
  const cm3x100 = decimal(m.totalVolumeM3, 4); // m³ × 1e4 → cm³ is × 100 more
  if (grams === null || cm3x100 === null) return null;
  const count = BigInt(m.boxCount);
  return { grams: { n: grams, d: count }, cm3: { n: cm3x100 * 100n, d: count } };
}

/**
 * The whole kg/m³ of Σgrams over Σcm³, rounded half-up EXACTLY — the number
 * every screen prints. Null when there is no volume. 999.5 is 1000 at every
 * carton count, because no float ever sees it.
 */
export function wholeDensity(grams: Frac, cm3: Frac): number | null {
  // kg/m³ = (g / 1000) / (cm³ / 1e6) = 1000 · g / cm³
  const num = 1000n * grams.n * cm3.d;
  const den = grams.d * cm3.n;
  if (den <= 0n || num < 0n) return null;
  return Number((2n * num + den) / (2n * den));
}

const toNumber = (f: Frac, scale: number) => Number(f.n) / Number(f.d) / scale;

export interface FreightLotIn extends LotIdentity {
  /** `l:<lotId>`. */
  key: string;
  /** The lot's cartons in this base, in base order. */
  boxIds: string[];
  /** Exact Σ over the cartons aboard (each carton is the lot's `stableMeasure`). */
  grams: Frac;
  cm3: Frac;
  /** The lot cannot be measured at all (no dims, no totals, no volume). */
  missing: boolean;
}

const lotLabel = (m: BoxMeasure) =>
  `${m.unclaimedMarking ?? m.clientCode ?? m.receiptNumber ?? '❓'}-${m.lotLetter ?? m.lotSeq}`;

/** The identity a lot is drawn with — ONE rule for the split, the held lines and the pool's fallback. */
export function lotIdentityOf(m: BoxMeasure): LotIdentity {
  return {
    lotId: m.lotId,
    receiptId: m.receiptId,
    receiptNumber: m.receiptNumber,
    clientKey: m.clientId ? `c:${m.clientId}` : `r:${m.receiptId}`,
    clientLabel: m.clientId ? (m.clientCode ?? '❓') : (m.unclaimedMarking ?? m.receiptNumber ?? '❓'),
    label: lotLabel(m),
    goods: m.productNameRu?.trim() || m.productNameZh,
  };
}

/**
 * The base grouped the way his 2b reads it: one entry per LOT (a
 * `receipt_lots` row). A lot's density is a property of the lot, not of the
 * truck: `stableMeasure` gives every carton of a lot the same exact measure,
 * so k cartons aboard read the density of one — the count aboard enters only
 * the lot's m³ here, i.e. its value. A claim (a prixod getting its client)
 * moves no freight share at all: it changes only `clientKey`, the label a
 * lot is drawn under.
 */
export function freightLots(measures: BoxMeasure[]): FreightLotIn[] {
  const lots = new Map<string, FreightLotIn>();
  for (const m of measures) {
    let lot = lots.get(m.lotId);
    if (!lot) {
      lot = { ...lotIdentityOf(m), key: `l:${m.lotId}`, boxIds: [], grams: ZERO, cm3: ZERO, missing: false };
      lots.set(m.lotId, lot);
    }
    const sm = stableMeasure(m);
    const missing = sm === null || sm.cm3.n <= 0n || sm.grams.n < 0n;
    lot.boxIds.push(m.boxId);
    lot.missing ||= missing;
    if (!missing) {
      lot.grams = add(lot.grams, sm!.grams);
      lot.cm3 = add(lot.cm3, sm!.cm3);
    }
  }
  return [...lots.values()];
}

const heldLot = (l: FreightLotIn): HeldLot => ({
  lotId: l.lotId,
  receiptId: l.receiptId,
  receiptNumber: l.receiptNumber,
  clientKey: l.clientKey,
  clientLabel: l.clientLabel,
  label: l.label,
  goods: l.goods,
  m3: toNumber(l.cm3, 1e6),
  kg: toNumber(l.grams, 1000),
  density: l.missing ? null : wholeDensity(l.grams, l.cm3),
});

const byDensity = (a: { density: number | null }, b: { density: number | null }) =>
  (a.density ?? -1) - (b.density ?? -1);

export type FreightSplit =
  | { ok: true; lots: PricedLot[]; weights: Map<string, number> }
  | { ok: false; held: FreightHeld };

/**
 * His rule 6 and the tariff, over every LOT (§1.4, §15.2). EVERY lot is
 * judged and both lists are collected over the whole truck — a bill with one
 * unmeasured lot and one light lot names both, measure first, so fixing one
 * does not uncover the other a day later. The order inside a lot is the
 * rule: the light check runs BEFORE any band lookup, or a 5 kg/m³ lot would
 * land in «1–100». ONE light lot holds the whole bill (his rule read per
 * lot): no lot is priced on a number that is a typing error.
 */
export function splitFreight(lots: FreightLotIn[], copy: FreightCopy): FreightSplit {
  const bands: FreightBand[] = copy.bands.map((b) => ({
    zone: copy.zone,
    minDensity: b.min,
    maxDensity: b.max,
    priceUsd: b.price,
    perKg: b.perKg,
  }));
  const lowest = [...copy.bands].sort((a, b) => a.min - b.min)[0];
  const measureMissing: HeldLot[] = [];
  const tooLight: HeldLot[] = [];
  let bandFailed = false;
  const priced: Omit<PricedLot, 'share'>[] = [];

  for (const l of lots) {
    const density = l.missing ? null : wholeDensity(l.grams, l.cm3);
    if (density === null) {
      measureMissing.push(heldLot(l));
      continue;
    }
    if (density < copy.lightBelow) {
      tooLight.push(heldLot(l));
      continue;
    }
    let band: FreightBandCopy | null = null;
    let clamped = false;
    if (lowest && density < lowest.min) {
      band = lowest; // «1 kub uchun 100 kgdan kam tarifda ketaversin»
      clamped = true;
    } else {
      const found = bandFor(bands, copy.zone, density);
      if (found.ok) {
        band = { min: found.band.minDensity, max: found.band.maxDensity, price: found.band.priceUsd, perKg: found.band.perKg };
      }
    }
    if (!band) {
      bandFailed = true;
      continue;
    }
    // Float twins of the EXACT sums — the per-kg multiplier and the screen.
    const kg = toNumber(l.grams, 1000);
    const m3 = toNumber(l.cm3, 1e6);
    const ratePerM3 = band.perKg ? band.price * (kg / m3) : band.price;
    priced.push({
      key: l.key,
      lotId: l.lotId,
      receiptId: l.receiptId,
      receiptNumber: l.receiptNumber,
      clientKey: l.clientKey,
      clientLabel: l.clientLabel,
      label: l.label,
      goods: l.goods,
      m3,
      kg,
      density,
      band,
      clamped,
      ratePerM3,
      value: ratePerM3 * m3,
    });
  }

  if (measureMissing.length > 0 || tooLight.length > 0) {
    return {
      ok: false,
      held: { reason: 'cargo', measureMissing: measureMissing.sort(byDensity), tooLight: tooLight.sort(byDensity) },
    };
  }
  if (bandFailed) return { ok: false, held: { reason: 'copy_invalid' } };

  const total = priced.reduce((a, l) => a + l.value, 0);
  const weights = new Map<string, number>();
  const rate = new Map(priced.map((p) => [p.key, p.ratePerM3]));
  for (const l of lots) {
    // Every carton of a lot is the same measure: the lot's m³ ÷ its count here.
    const perBox = toNumber(l.cm3, 1e6) / l.boxIds.length;
    for (const boxId of l.boxIds) weights.set(boxId, rate.get(l.key)! * perBox);
  }
  return {
    ok: true,
    lots: priced.map((l) => ({ ...l, share: total > 0 ? l.value / total : 0 })),
    weights,
  };
}

/**
 * The ONE order a split is drawn in — share descending, then label by code
 * unit (never `localeCompare`, which differs between the server and a
 * browser). The fold, the preview and the re-basis rows all read it, so the
 * same clients never appear in two orders one above the other (judge J17).
 */
export const byShareThenLabel = (a: { share: number; label: string }, b: { share: number; label: string }) =>
  b.share - a.share || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

/**
 * The lots ordered for drawing, and each client's sum — ONE place (#513):
 * clients by share descending, then by label; a client's lots the same way.
 * The cents column (`splitCents`) breaks ties by row order, so the order is
 * part of the money a preview prints and must not differ between readers.
 */
export function rollupClients<T extends { key: string; clientKey: string; clientLabel: string; label: string; m3: number; share: number }>(
  lots: T[],
): { lots: T[]; clients: ClientRollup[] } {
  const byClient = new Map<string, { label: string; m3: number; share: number; lots: T[] }>();
  for (const l of lots) {
    let c = byClient.get(l.clientKey);
    if (!c) {
      c = { label: l.clientLabel, m3: 0, share: 0, lots: [] };
      byClient.set(l.clientKey, c);
    }
    c.m3 += l.m3;
    c.share += l.share;
    c.lots.push(l);
  }
  const clients = [...byClient.entries()]
    .map(([key, c]) => ({ key, ...c, lots: [...c.lots].sort(byShareThenLabel) }))
    .sort(byShareThenLabel);
  return {
    lots: clients.flatMap((c) => c.lots),
    clients: clients.map((c) => ({ key: c.key, label: c.label, m3: c.m3, share: c.share, lotKeys: c.lots.map((l) => l.key) })),
  };
}

/**
 * What a column lacks (§5), on the whole-number densities each band covers:
 * [ceil(min), floor(max)] or [ceil(min), ∞). Nothing below the lowest floor
 * is a hole — his rule 6 clamps [lightBelow, floor) and holds what is lighter
 * — but every whole density from the lowest floor up must be covered exactly
 * once, and the top must be open (a steel lot is not refused next month).
 * Interval arithmetic, no scan: a typed floor of 99,999,999 costs nothing.
 */
export function columnProblem(bands: FreightBandCopy[]): ColumnProblem | null {
  const sets = bands
    .map((b) => ({ from: Math.ceil(b.min), to: b.max === null ? null : Math.floor(b.max) }))
    .filter((s) => s.to === null || s.to >= s.from)
    .sort((a, b) => a.from - b.from || (a.to === null ? 1 : b.to === null ? -1 : a.to - b.to));
  if (sets.length === 0) return { kind: 'unpriced' };
  let reach = sets[0]!.to; // the last whole density covered so far (null = all)
  for (let i = 1; i < sets.length; i += 1) {
    const s = sets[i]!;
    if (reach === null || s.from <= reach) return { kind: 'overlap', at: s.from };
    if (s.from > reach + 1) return { kind: 'gap', from: reach + 1, to: s.from - 1 };
    reach = s.to;
  }
  if (reach !== null) return { kind: 'gap', from: reach + 1, to: null };
  return null;
}

const finiteBand = (b: FreightBandCopy) =>
  Number.isFinite(b.min) &&
  b.min >= 0 &&
  Number.isFinite(b.price) &&
  b.price > 0 &&
  (b.max === null || (Number.isFinite(b.max) && b.max >= b.min)) &&
  typeof b.perKg === 'boolean';

export type CopyDraftResult =
  | { ok: true; draft: FreightCopyDraft }
  | { ok: false; problem: ColumnProblem | { kind: 'not_finite' } };

/**
 * The ONE constructor of a frozen copy (§9.5, E9) — the save and the panel's
 * preview both call it, so the dedupe, the finite check and the hole check
 * cannot differ between what was shown and what is frozen (#513). `history`
 * is `tariffHistory()`; the column in force on `date` is the newest row per
 * floor on or before it, with NO earliest-row fallback.
 */
export function copyDraft(
  zone: string,
  history: { zone: string; minDensity: number; maxDensity: number | null; priceUsd: number; perKg: boolean; effectiveDate: string }[],
  date: string,
  lightBelow: number,
  warehouseId: string,
): CopyDraftResult {
  const seen = new Set<string>();
  const bands: FreightBandCopy[] = [];
  let tariffFrom = '';
  const rows = history
    .filter((r) => r.zone === zone && r.effectiveDate <= date)
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : a.effectiveDate > b.effectiveDate ? -1 : 0));
  for (const r of rows) {
    const key = `${r.minDensity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bands.push({ min: r.minDensity, max: r.maxDensity, price: r.priceUsd, perKg: r.perKg });
    if (r.effectiveDate > tariffFrom) tariffFrom = r.effectiveDate;
  }
  bands.sort((a, b) => a.min - b.min);
  if (!bands.every(finiteBand)) return { ok: false, problem: { kind: 'not_finite' } };
  const problem = columnProblem(bands);
  if (problem) return { ok: false, problem };
  return { ok: true, draft: { warehouseId, zone, tariffFrom, lightBelow, bands } };
}

/**
 * Will the one column split a truck bill — today, and on every later date
 * a version is already typed for (judge J31)? /admin/tarif asks it on its own
 * rows, so a mistyped floor — there is no delete, a moved floor stays an
 * overlap for good, and nothing validates on save — is said where it is
 * made, before the first bill of the day is saved by weight with a ⚠. The
 * same constructor as every save (`copyDraft`), so the page cannot pass a
 * column the save refuses. Empty = every such date is whole.
 */
export function columnWatch(
  zone: string,
  history: Parameters<typeof copyDraft>[1],
  today: string,
  lightBelow: number,
): { from: string; problem: ColumnProblem | { kind: 'not_finite' } }[] {
  const dates = [...new Set(history.filter((r) => r.zone === zone).map((r) => r.effectiveDate))].sort();
  const inForce = dates.filter((d) => d <= today).at(-1);
  const check = [inForce ?? today, ...dates.filter((d) => d > today)];
  return check.flatMap((from) => {
    const made = copyDraft(zone, history, from, lightBelow, '');
    return made.ok ? [] : [{ from, problem: made.problem }];
  });
}

/** A copy read back from jsonb is checked again — the table's CHECK admits NaN. */
export function validCopyBands(raw: unknown): FreightBandCopy[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: FreightBandCopy[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) return null;
    const o = r as Record<string, unknown>;
    const band = {
      min: typeof o.min === 'number' ? o.min : Number.NaN,
      max: o.max === null ? null : typeof o.max === 'number' ? o.max : Number.NaN,
      price: typeof o.price === 'number' ? o.price : Number.NaN,
      perKg: o.perKg as boolean,
    };
    if (!finiteBand(band)) return null;
    out.push(band);
  }
  return out;
}

/**
 * The typed amount split over the shares in CENTS, by the largest remainder,
 * so the preview's column adds up to the bill to the cent (350 → 350.00, not
 * 350.01). Ties go to the earlier row, like the engine.
 */
export function splitCents(amount: number, shares: number[]): number[] {
  if (!Number.isFinite(amount) || shares.length === 0) return shares.map(() => 0);
  const units = Math.round(amount * 100);
  const total = shares.reduce((a, s) => a + s, 0);
  if (!(total > 0)) return shares.map(() => 0);
  const exact = shares.map((s) => (units * s) / total);
  const whole = exact.map((x) => Math.floor(x + 1e-9));
  let rest = units - whole.reduce((a, n) => a + n, 0);
  const order = exact.map((x, i) => ({ i, f: x - whole[i]! })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; rest > 0 && order.length > 0; k = (k + 1) % order.length, rest -= 1) whole[order[k]!.i]! += 1;
  return whole.map((n) => n / 100);
}

/**
 * A bill's dollars to the cent per LOT — ONE rule for the preview, the saved
 * fold and the re-basis rows (judge J2/J14/J22). The cents are split over the
 * LOTS by the largest remainder, in KEY order: a tie must not trade a cent
 * between two renders of the same bill, and a SQL `GROUP BY` hands rows back
 * in no order at all. `weight` is a lot's share (a typed preview) or what its
 * allocations hold (a saved bill). A client's dollars are `clientCentsOf`.
 */
export function lotCents(amount: number, lots: readonly { key: string; weight: number }[]): Record<string, number> {
  const sorted = [...lots].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const cents = splitCents(amount, sorted.map((l) => l.weight));
  return Object.fromEntries(sorted.map((l, i) => [l.key, cents[i]!]));
}

/**
 * A client's dollars = the SUM of its lots' cents — never a second split over
 * the clients, which rounds the spare cents differently: a client header read
 * $0.01 off the lots under it, and the preview $0.01 off the fold after
 * Saqlash. A client with any lot the cents do not name has no figure (a lot
 * that boarded after the split has no allocation yet). Summed in whole cents.
 */
export function clientCentsOf(
  lots: readonly { key: string; clientKey: string }[],
  byLot: Readonly<Record<string, number>>,
): Record<string, number> {
  const units = new Map<string, number | null>();
  for (const l of lots) {
    const was = units.has(l.clientKey) ? units.get(l.clientKey)! : 0;
    const c = byLot[l.key];
    units.set(l.clientKey, was === null || c === undefined ? null : was + Math.round(c * 100));
  }
  const out: Record<string, number> = {};
  for (const [k, u] of units) if (u !== null) out[k] = u / 100;
  return out;
}

const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

export interface BandText {
  key: 'freightBand' | 'freightBandPerKg' | 'freightBandMoney' | 'freightBandMoneyPerKg';
  range: string;
  price: string;
}

/**
 * ONE way to word a band (SP-8), for the preview, the fold, the Narx line and
 * the re-basis preview. A per-kg band says «kg bo‘yicha» and its price per kg —
 * never a «$605/kub» that /admin/tarif nowhere prints.
 */
export function bandText(band: BandView, opts: { money: boolean }): BandText {
  const range = band.max === null ? `${num(band.min)}+` : `${num(band.min)}–${num(band.max)}`;
  // A band sent without its price (no money sight) can only be worded without one.
  const money = opts.money && band.price !== undefined;
  const price = money ? `$${num(band.price!)}` : '';
  const key = money
    ? band.perKg
      ? 'freightBandMoneyPerKg'
      : 'freightBandMoney'
    : band.perKg
      ? 'freightBandPerKg'
      : 'freightBand';
  return { key, range, price };
}

/**
 * A band as a page may send it — the price only to a money reader. ONE rule
 * for the panel's preview, the saved fold and the re-basis preview (the fix
 * review found the preview restating it).
 */
export function bandForSight(band: FreightBandCopy, money: boolean): BandView {
  return money ? band : { min: band.min, max: band.max, perKg: band.perKg };
}

/**
 * A frozen column as ONE line for the history (the audit's `tariffBands`):
 * every band, lowest first, as /admin/tarif prints it. Pure, so the create
 * and the re-basis write the same words.
 */
export function bandsSummary(bands: readonly FreightBandCopy[]): string {
  return [...bands]
    .sort((a, b) => a.min - b.min)
    .map((b) => `${num(b.min)}${b.max === null ? '+' : `–${num(b.max)}`} $${num(b.price)}${b.perKg ? '/kg' : ''}`)
    .join('; ');
}

/** One lot of a split view; none when held or absent. */
export function splitLot(view: SplitView | null | undefined, lotId: string): LotView | undefined {
  return view?.kind === 'split' ? view.lots.find((l) => l.lotId === lotId) : undefined;
}

/** A client's lots of a split view (`c:<client>` / `r:<receipt>`), in display order; [] when held or absent. */
export function lotsOfClient(view: SplitView | null | undefined, clientKey: string): LotView[] {
  return view?.kind === 'split' ? view.lots.filter((l) => l.clientKey === clientKey) : [];
}

/**
 * The Narx tab's band line for ONE client part of ONE bill (judge J1/J15/J21/
 * J36) — pure, so the rule is pinned by literals and not by a server page.
 * Only the lots whose money IS in that part (`lotIds`, the breakdown's own
 * rows): a «shu reysgacha» part that carries only the kafel cartons must not
 * print the yostiq's band beside the kafel's dollars. Distinct by VALUE (a
 * band for a non-money reader is a fresh object, so identity would keep
 * repeats for one sight and not the other), in the lots' display order
 * (share descending), two at most and «+N» for the rest. `null` = nothing to
 * name: no split, or none of the part's lots on it.
 */
export function clientBandLine(
  view: SplitView | null | undefined,
  clientKey: string,
  lotIds: readonly string[] | null,
  opts: { money: boolean },
): { bands: BandText[]; more: number } | null {
  const here = lotIds ? new Set(lotIds) : null;
  const lots = lotsOfClient(view, clientKey).filter((l) => !here || here.has(l.lotId));
  const seen = new Map<string, BandText>();
  for (const lot of lots) {
    const text = bandText(lot.band, opts);
    const key = `${text.key}|${text.range}|${text.price}`;
    if (!seen.has(key)) seen.set(key, text);
  }
  const all = [...seen.values()];
  if (all.length === 0) return null;
  return { bands: all.slice(0, 2), more: Math.max(0, all.length - 2) };
}

export type CostScope = 'receipt' | 'batch' | 'crate' | 'pickup';

/**
 * Which bases a cost panel LISTS (§4). 'freight' only on a truck's own bill
 * (his 4a) and never on a customs type (customs is declared per prixod). Its
 * enabled state is `freightUsable`'s, a separate question.
 */
export function offeredBases(scope: CostScope, flags: TypeFlags, typeId: string | null): AllocationBasis[] {
  const old = ALLOCATION_BASES.filter((b) => b !== 'freight');
  if (scope !== 'batch') return old;
  if (typeId && flags.customsTypeIds.includes(typeId)) return old;
  return [...old, 'freight'];
}

export type FreightUsable =
  | { ok: true; version: Extract<FreightOffer, { status: 'ready' }>['versions'][number] | null }
  | { ok: false; why: 'server_behind' | 'unpriced' | 'problem' };

/**
 * May the freight option be chosen for this typed date? `version` null means
 * «older than the versions the page holds — the server decides at save»
 * (E9): only a date before the column's FIRST price is unpriced here.
 */
export function freightUsable(offer: FreightOffer | null, costDate: string): FreightUsable {
  if (!offer || offer.status === 'server_behind') return { ok: false, why: 'server_behind' };
  if (!offer.firstFrom || costDate < offer.firstFrom) return { ok: false, why: 'unpriced' };
  const version = offer.versions.find((v) => v.from <= costDate) ?? null;
  if (version?.problem) return { ok: false, why: 'problem' };
  return { ok: true, version };
}
