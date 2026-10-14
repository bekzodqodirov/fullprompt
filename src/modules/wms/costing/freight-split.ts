import { bandFor, type FreightBand } from '../calc/pricing';
import { ALLOCATION_BASES, type AllocationBasis } from './engine';
import type {
  BoxMeasure,
  ColumnProblem,
  FreightBandCopy,
  FreightCopy,
  FreightCopyDraft,
  FreightHeld,
  FreightOffer,
  GroupView,
  HeldGroup,
  HeldLot,
  PricedGroup,
  SplitView,
  TypeFlags,
} from './freight-types';

/**
 * Yo'lkira tarifi bo'yicha taqsimlash — the arithmetic, PURE (docs/
 * YOLKIRA-TAQSIMOT.md §1). Imports only the pure engine and the pure calc
 * engine, so the recompute, the void guard, the preview in the browser and
 * every explanation read the same lines and cannot disagree about a share.
 *
 * A truck's bill is split over the clients aboard in proportion to each
 * client's yo'lkira VALUE on his own tariff: the client's WHOLE cargo on the
 * truck is one group with one density and one tariff row (his 1a — the VED
 * prices a consignment, never an item), and inside the client the share goes
 * by m³. His rule 6: a group lighter than `lightBelow` kg per m³ is a typing
 * error to be fixed, not a price to be read, so the bill is HELD (written,
 * not split); a group heavier than that but under the column's lowest floor
 * takes the lowest row («1 kub uchun 100 kgdan kam tarifda ketaversin»).
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

const add = (a: Frac, b: Frac): Frac => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });

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

export interface FreightLotIn {
  lotId: string;
  receiptId: string;
  label: string;
  grams: Frac;
  cm3: Frac;
  missing: boolean;
}

export interface FreightGroupIn {
  key: string;
  label: string;
  /** In base order; null measure = the lot could not be measured. */
  boxes: { boxId: string; lotId: string; grams: Frac; cm3: Frac; missing: boolean }[];
  lots: FreightLotIn[];
  grams: Frac;
  cm3: Frac;
  /** Float twins of the exact sums, for the per-kg multiplier and the screen. */
  kgF: number;
  m3F: number;
}

const lotLabel = (m: BoxMeasure) =>
  `${m.unclaimedMarking ?? m.clientCode ?? m.receiptNumber ?? '❓'}-${m.lotLetter ?? m.lotSeq}`;

/**
 * The base grouped the way his 1a reads it: each CLIENT's whole cargo on the
 * truck, and an unclaimed prixod on its own (`r:<receipt>`) — a claim folds it
 * into the client by the ordinary re-split. Phone-sibling codes are separate
 * clients and so separate groups (stated).
 */
export function freightGroups(measures: BoxMeasure[]): FreightGroupIn[] {
  const groups = new Map<string, FreightGroupIn>();
  for (const m of measures) {
    const key = m.clientId ? `c:${m.clientId}` : `r:${m.receiptId}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        label: m.clientId ? (m.clientCode ?? '❓') : (m.unclaimedMarking ?? m.receiptNumber ?? '❓'),
        boxes: [],
        lots: [],
        grams: ZERO,
        cm3: ZERO,
        kgF: 0,
        m3F: 0,
      };
      groups.set(key, g);
    }
    const sm = stableMeasure(m);
    const missing = sm === null || sm.cm3.n <= 0n || sm.grams.n < 0n;
    const grams = missing ? ZERO : sm!.grams;
    const cm3 = missing ? ZERO : sm!.cm3;
    g.boxes.push({ boxId: m.boxId, lotId: m.lotId, grams, cm3, missing });
    let lot = g.lots.find((l) => l.lotId === m.lotId);
    if (!lot) {
      lot = { lotId: m.lotId, receiptId: m.receiptId, label: lotLabel(m), grams: ZERO, cm3: ZERO, missing: false };
      g.lots.push(lot);
    }
    lot.missing ||= missing;
    lot.grams = add(lot.grams, grams);
    lot.cm3 = add(lot.cm3, cm3);
    g.grams = add(g.grams, grams);
    g.cm3 = add(g.cm3, cm3);
    g.kgF += toNumber(grams, 1000);
    g.m3F += toNumber(cm3, 1e6);
  }
  return [...groups.values()];
}

const heldLot = (l: FreightLotIn): HeldLot => ({
  lotId: l.lotId,
  receiptId: l.receiptId,
  label: l.label,
  m3: toNumber(l.cm3, 1e6),
  kg: toNumber(l.grams, 1000),
  density: l.missing ? null : wholeDensity(l.grams, l.cm3),
});

const byDensity = (a: { density: number | null }, b: { density: number | null }) =>
  (a.density ?? -1) - (b.density ?? -1);

export type FreightSplit =
  | { ok: true; groups: PricedGroup[]; weights: Map<string, number> }
  | { ok: false; held: FreightHeld };

/**
 * His rule 6 and the tariff, over every group (§1.4). EVERY group is judged
 * and both lists are collected — a bill with one unmeasured lot and one light
 * client names both, measure first, so fixing one does not uncover the other
 * a day later. The order inside a group is the rule: the light check runs
 * BEFORE any band lookup, or a 5 kg/m³ group would land in «1–100».
 */
export function splitFreight(groups: FreightGroupIn[], copy: FreightCopy): FreightSplit {
  const bands: FreightBand[] = copy.bands.map((b) => ({
    zone: copy.zone,
    minDensity: b.min,
    maxDensity: b.max,
    priceUsd: b.price,
    perKg: b.perKg,
  }));
  const lowest = [...copy.bands].sort((a, b) => a.min - b.min)[0];
  const measureMissing: HeldLot[] = [];
  const tooLight: HeldGroup[] = [];
  let bandFailed = false;
  const priced: Omit<PricedGroup, 'share'>[] = [];

  for (const g of groups) {
    const missingLots = g.lots.filter((l) => l.missing);
    if (missingLots.length > 0) {
      measureMissing.push(...missingLots.map(heldLot));
      continue;
    }
    const density = wholeDensity(g.grams, g.cm3);
    if (density === null) {
      measureMissing.push(...g.lots.map(heldLot));
      continue;
    }
    const lots = g.lots.map(heldLot).sort(byDensity);
    if (density < copy.lightBelow) {
      tooLight.push({ key: g.key, label: g.label, m3: g.m3F, kg: g.kgF, density, lots });
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
    const ratePerM3 = band.perKg ? band.price * (g.kgF / g.m3F) : band.price;
    priced.push({
      key: g.key,
      label: g.label,
      m3: g.m3F,
      kg: g.kgF,
      density,
      band,
      clamped,
      ratePerM3,
      value: ratePerM3 * g.m3F,
      lightLots: lots.filter((l) => l.density !== null && l.density < copy.lightBelow),
    });
  }

  if (measureMissing.length > 0 || tooLight.length > 0) {
    return {
      ok: false,
      held: { reason: 'cargo', measureMissing, tooLight: tooLight.sort(byDensity) },
    };
  }
  if (bandFailed) return { ok: false, held: { reason: 'copy_invalid' } };

  const total = priced.reduce((a, g) => a + g.value, 0);
  const weights = new Map<string, number>();
  for (const g of groups) {
    const pg = priced.find((p) => p.key === g.key)!;
    for (const box of g.boxes) weights.set(box.boxId, pg.ratePerM3 * toNumber(box.cm3, 1e6));
  }
  return {
    ok: true,
    groups: priced.map((g) => ({ ...g, share: total > 0 ? g.value / total : 0 })),
    weights,
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
export function bandText(band: FreightBandCopy, opts: { money: boolean }): BandText {
  const range = band.max === null ? `${num(band.min)}+` : `${num(band.min)}–${num(band.max)}`;
  const price = `$${num(band.price)}`;
  const key = opts.money
    ? band.perKg
      ? 'freightBandMoneyPerKg'
      : 'freightBandMoney'
    : band.perKg
      ? 'freightBandPerKg'
      : 'freightBand';
  return { key, range, price };
}

/** One group of a split view by its key (`c:<client>` / `r:<receipt>`); none when held or absent. */
export function splitGroup(view: SplitView | null | undefined, key: string): GroupView | undefined {
  return view?.kind === 'split' ? view.groups.find((g) => g.key === key) : undefined;
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
  | { ok: false; why: 'server_behind' | 'no_column' | 'unpriced' | 'problem' };

/**
 * May the freight option be chosen for this typed date? `version` null means
 * «older than the versions the page holds — the server decides at save»
 * (E9): only a date before the column's FIRST price is unpriced here.
 */
export function freightUsable(offer: FreightOffer | null, costDate: string): FreightUsable {
  if (!offer || offer.status === 'server_behind') return { ok: false, why: 'server_behind' };
  if (offer.status === 'no_column') return { ok: false, why: 'no_column' };
  if (!offer.firstFrom || costDate < offer.firstFrom) return { ok: false, why: 'unpriced' };
  const version = offer.versions.find((v) => v.from <= costDate) ?? null;
  if (version?.problem) return { ok: false, why: 'problem' };
  return { ok: true, version };
}
