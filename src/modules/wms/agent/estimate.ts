import { freightFor, type FreightBand } from '../calc/pricing';
import type { StoredEstimate } from './auto-money';
import { AGENT_LIMITS } from './limits';
import { SITE_TARIFF, siteEstimate, type SiteTariff } from './site-estimate';

/**
 * The ONE arithmetic behind the AI's two prices (spec SPEC-P1-v2 §1.3, §1.6) — the truck's yo'lkira and the
 * flight's rate × kilos — called by the tools when the figure is QUOTED and by the re-price when it is SENT
 * (drafts `draftOfferStands`, at every send step, at his ✅ and at the machine's press). Two formulas could not
 * be asked to agree: the website rounds its own way and bills a 0.1 m³ minimum, /admin/tarif rounds another
 * (`freightFor`), so the figure is made here once and the re-price asks this very function again.
 *
 * Pure: the caller reads the tariff (`tariffFor(day)`) and his avia rate; nothing here touches the database.
 *
 * The truck, his ⭐ Q4 a (MAP): the price is the website's while its snapshot is valid — and /admin/tarif's China
 * column must say the same rate and unit, or the figure is refused (money-3: a public price that is no longer
 * the list price is no quote); after the snapshot's `validThrough` the website is skipped, never refused, and
 * the price IS /admin/tarif's (`freightFor(...).listUsd` and its band's rate), the $50 floor on that list price,
 * the days the company's rule (`AGENT_LIMITS.truckDays`, ⭐ Q5 a, asked of him).
 */

/** The column the truck is priced on: Yiwu and Guangzhou share it (calc_freight_tariffs `zone`). */
export const TRUCK_ZONE = 'cn';

/**
 * His Q7 ⭐: above these, or at an impossible density, the figure is not a quote — the job goes to
 * hisoblatish. The small end is the company's own minimum (`AGENT_LIMITS.minShipment`), asked by the tool
 * before anything is priced. `minTotalUsd` floors the TOTAL: the website's figure, or the list price after it.
 */
export const YOLKIRA_GUARDS = { maxM3: 100, maxKg: 20_000, minTotalUsd: 50, minDensity: 1 } as const;

/** Where a truck figure came from — said in the tool's words and the card's ledger label. */
export type TruckSource = 'site' | 'tariff';

export interface TruckFigure {
  total: number;
  rate: number;
  unit: 'm3' | 'kg';
  days: readonly [number, number];
  /** Whole kg/m³ the band was read at; null when it could not be told. */
  densityKgM3: number | null;
  source: TruckSource;
}

export type TruckRefusal =
  /** Too big, too heavy, or denser than nothing real (`YOLKIRA_GUARDS`). */
  | 'size'
  /** Under `YOLKIRA_GUARDS.minTotalUsd`. */
  | 'min_total'
  /** The website's snapshot refused (no volume, not a number) — while it is the price. */
  | 'site_refused'
  /** The website and /admin/tarif disagree — while the website is the price (money-3). */
  | 'tariff_mismatch'
  /** /admin/tarif has no band for the load — after the website's table ran out (`band_missing`, …). */
  | 'tariff_refused';

export type TruckResult = { ok: true; figure: TruckFigure } | { ok: false; reason: TruckRefusal; detail?: string };

/** Is the website's snapshot still the price on this Tashkent day (YYYY-MM-DD)? */
export function siteStillValid(day: string, t: SiteTariff = SITE_TARIFF): boolean {
  return day <= t.validThrough;
}

/**
 * The truck's yo'lkira for this load on this day, against this tariff (the bands in force that day). The tool's
 * refusal words and the re-price's verdict are both read off the reason.
 */
export function truckEstimate(
  input: { kg: number; m3: number; day: string; bands: readonly FreightBand[] },
  t: SiteTariff = SITE_TARIFF,
): TruckResult {
  const { kg, m3, day } = input;
  const g = YOLKIRA_GUARDS;
  if (!(kg > 0) || !(m3 > 0) || m3 > g.maxM3 || kg > g.maxKg || kg / m3 < g.minDensity) return { ok: false, reason: 'size' };
  const list = freightFor([...input.bands], { zone: TRUCK_ZONE, weightKg: kg, volumeM3: m3 });
  if (siteStillValid(day, t)) {
    const site = siteEstimate({ mode: 'truck', kg, m3, day }, t);
    if (!site.ok) return { ok: false, reason: 'site_refused', detail: site.reason };
    const e = site.estimate;
    if (e.total < g.minTotalUsd) return { ok: false, reason: 'min_total' };
    // The website's figure must still be the list price the VED would charge (money-3): his table, China column.
    const same = list.ok && Math.abs(list.band.priceUsd - e.rate) < 0.005 && list.band.perKg === (e.unit === 'kg');
    if (!same) return { ok: false, reason: 'tariff_mismatch' };
    return {
      ok: true,
      figure: {
        total: e.total,
        rate: e.rate,
        unit: e.unit === 'kg' ? 'kg' : 'm3',
        days: [e.days[0], e.days[1]],
        densityKgM3: e.densityKgM3 ?? null,
        source: 'site',
      },
    };
  }
  // Past the snapshot: his table is the price — skipped, never refused (⭐ Q4 a).
  if (!list.ok) return { ok: false, reason: 'tariff_refused', detail: list.reason };
  if (list.listUsd < g.minTotalUsd) return { ok: false, reason: 'min_total' };
  return {
    ok: true,
    figure: {
      total: list.listUsd,
      rate: list.band.priceUsd,
      unit: list.band.perKg ? 'kg' : 'm3',
      days: [AGENT_LIMITS.truckDays[0], AGENT_LIMITS.truckDays[1]],
      densityKgM3: list.bandDensity,
      source: 'tariff',
    },
  };
}

export type AviaResult = { ok: true; total: number; rate: number } | { ok: false; reason: 'rate_unset' | 'below_minimum' | 'not_a_number' };

/**
 * The flight (his 2026-10-24 «Avia hozir kg uchun 17$ dan», third set «1b»): the ACTUAL kilos × his rate, rounded
 * to cents — no volume, no upper bound. No rate set is no quote.
 */
export function aviaEstimate(input: { kg: number; rate: number | null }): AviaResult {
  const { kg, rate } = input;
  if (rate === null || !(rate > 0) || !Number.isFinite(rate)) return { ok: false, reason: 'rate_unset' };
  if (!Number.isFinite(kg)) return { ok: false, reason: 'not_a_number' };
  if (!(kg >= AGENT_LIMITS.avia.minKg)) return { ok: false, reason: 'below_minimum' };
  return { ok: true, total: Math.round(kg * rate * 100) / 100, rate };
}

/** Two figures are one when they differ by less than half a cent (spec §1.3). */
const same = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** What a stored estimate answers when it is priced again today. */
export type Reprice = 'stands' | 'estimate_moved';

/**
 * A figure the draft quoted, priced again with the same function on the day it goes — today's tariff, today's
 * avia rate (spec §1.3). It stands only when the same total AND the same rate come out (and the same unit for
 * the truck); a refusal — a hole cut in /admin/tarif, his avia rate taken away, the website and his table that
 * stopped agreeing — is a figure that moved. Pure: the caller reads `bands` and `aviaRate` for `day`.
 */
export function reprice(
  stored: StoredEstimate,
  now: { day: string; bands: readonly FreightBand[]; aviaRate: number | null },
  t: SiteTariff = SITE_TARIFF,
): Reprice {
  if (stored.tool === 'avia_estimate') {
    const again = aviaEstimate({ kg: stored.kg, rate: now.aviaRate });
    return again.ok && same(again.total, stored.total) && same(again.rate, stored.rate) ? 'stands' : 'estimate_moved';
  }
  if (stored.m3 === null) return 'estimate_moved';
  const again = truckEstimate({ kg: stored.kg, m3: stored.m3, day: now.day, bands: now.bands }, t);
  if (!again.ok) return 'estimate_moved';
  const f = again.figure;
  return same(f.total, stored.total) && same(f.rate, stored.rate) && f.unit === stored.unit ? 'stands' : 'estimate_moved';
}

/** Every stored figure priced again — one that moved is the draft's answer. */
export function repriceAll(
  stored: readonly StoredEstimate[],
  now: { day: string; bands: readonly FreightBand[]; aviaRate: number | null },
  t: SiteTariff = SITE_TARIFF,
): Reprice {
  return stored.every((e) => reprice(e, now, t) === 'stands') ? 'stands' : 'estimate_moved';
}

/**
 * The memory's copy of one priced call — validated as it is READ, because it comes back out of a jsonb column:
 * a row a reader cannot make sense of is no estimate that stands (the caller answers `estimate_moved`).
 */
export function storedEstimatesOf(raw: unknown): StoredEstimate[] | null {
  if (!Array.isArray(raw)) return null;
  const out: StoredEstimate[] = [];
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) return null;
    const r = e as Record<string, unknown>;
    if (r.tool !== 'yolkira_estimate' && r.tool !== 'avia_estimate') return null;
    if (!num(r.kg) || !num(r.total) || !num(r.rate) || typeof r.day !== 'string') return null;
    if (r.unit !== 'kg' && r.unit !== 'm3') return null;
    if (r.tool === 'yolkira_estimate' && !num(r.m3)) return null;
    out.push({
      tool: r.tool,
      kg: r.kg,
      m3: num(r.m3) ? r.m3 : null,
      zone: typeof r.zone === 'string' ? r.zone : null,
      day: r.day,
      total: r.total,
      rate: r.rate,
      unit: r.unit,
    });
  }
  return out;
}
