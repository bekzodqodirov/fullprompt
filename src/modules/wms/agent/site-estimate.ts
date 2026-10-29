/**
 * The website's own calculator, so the AI says what the website says.
 *
 * The owner, 2026-10-24 (his 9): «Saytlarga tegma agar klient yolkira
 * logistikani ozini sorasa saytdagi kalkulyatorni ozi boyicha». A customer who
 * asks for the road alone is answered with the figure gsrlogistics.uz would
 * have shown him; podklyuch and rastamojka go to the VED queue instead (his 8),
 * because only a person may price customs.
 *
 * A PORT, not an import. The site is another repository (Astro, its own
 * deploy), this system cannot read it at runtime, and «tegma» means it is
 * read and never written. So the arithmetic below is gsrlogistics.uz
 * `src/lib/pricing.ts` (`estimateTruck`, `estimateAir`, `estimateRail`)
 * restated — with one deliberate difference: an air question with neither a
 * weight nor a volume is refused here, where the site's form bills its 0.5 kg
 * minimum; a quote made of nothing is not one the AI should repeat — and the
 * numbers are a VENDORED snapshot of its
 * `src/data/tariffs.json` (commit ccefe05, «updated» 2026-09-08). The site's
 * own worked examples are this file's tests (`agent-site-estimate.test.ts`),
 * so a port that drifts from the original goes red on the site's sentences.
 *
 * Two things the port does NOT do, on purpose:
 *  - it never reads `/admin/tarif`. That table is the VED's list price and a
 *    component of the sealed floor; the website's sheet is what the customer
 *    has already seen. Today they agree on the China column (a fence pins it,
 *    so the day one moves without the other is named, not discovered).
 *  - it never answers past the snapshot's own `validThrough`. A stale public
 *    price quoted with confidence is worse than «hisoblab beramiz»: the caller
 *    gets `stale` and sends the job to the VED.
 *
 * Every answer is TAXMINIY — the site prints «taxminiy narx» on the same
 * figures — and carries the rule it applied, so the reply can say how the
 * number was made.
 */

export interface DensityBand {
  maxKgM3: number | null;
  rate: number;
}

/** gsrlogistics.uz `src/data/tariffs.json` as of commit ccefe05 (2026-09-11). */
export const SITE_TARIFF = {
  source: 'gsrlogistics.uz src/data/tariffs.json @ ccefe05',
  updated: '2026-09-08',
  validThrough: '2026-12-31',
  currency: 'USD',
  air: {
    perKg: { standard: 9.0, brand: 12.0, commercial: 11.5 },
    minKg: 0.5,
    days: [5, 10] as [number, number],
    volumetricDivisor: 5000,
  },
  truck: {
    days: [15, 25] as [number, number],
    lclPerM3ByDensity: [
      { maxKgM3: 100, rate: 110 },
      { maxKgM3: 150, rate: 130 },
      { maxKgM3: 200, rate: 160 },
      { maxKgM3: 250, rate: 180 },
      { maxKgM3: 300, rate: 200 },
      { maxKgM3: 350, rate: 230 },
      { maxKgM3: 400, rate: 260 },
      { maxKgM3: 450, rate: 280 },
      { maxKgM3: 500, rate: 290 },
      { maxKgM3: 700, rate: 300 },
      { maxKgM3: null, rate: 320 },
    ] as DensityBand[],
    minM3: 0.1,
    perKgFromDensityKgM3: 1000,
    perKgAboveDensity: 0.55,
  },
  rail: {
    container20ft: [2800, 5500] as [number, number],
    container40ft: [5200, 6800] as [number, number],
    days: [20, 35] as [number, number],
  },
} as const;

export type SiteTariff = typeof SITE_TARIFF;

export type EstimateMode = 'truck' | 'air' | 'rail';
/** The site's goods categories; battery and liquid cannot fly. */
export type EstimateCategory = 'standard' | 'brand' | 'commercial' | 'battery' | 'liquid';
export type EstimateRule = 'truck-lcl' | 'truck-per-kg' | 'air-per-kg' | 'rail-20ft' | 'rail-40ft';
export type EstimateNote = 'min-m3-applied' | 'min-kg-applied' | 'volumetric-applied' | 'switched-to-truck' | 'range';

export interface SiteEstimate {
  mode: EstimateMode;
  rule: EstimateRule;
  /** USD per `unit` (the low end for rail). */
  rate: number;
  unit: 'm3' | 'kg' | 'container';
  /** USD, rounded to cents as the site rounds it. */
  total: number;
  /** The high end of a range — rail only. */
  totalMax?: number;
  days: [number, number];
  notes: EstimateNote[];
  densityKgM3?: number;
  chargeableM3?: number;
  chargeableKg?: number;
}

export type SiteEstimateRefusal =
  /** The road is priced by volume: weight alone picks no band (the site refuses too). */
  | 'volume_required'
  /** Air needs a weight. */
  | 'weight_required'
  | 'air_forbidden'
  | 'not_a_number'
  /** Past the snapshot's validThrough — the AI sends the job to the VED instead. */
  | 'stale';

export type SiteEstimateResult = { ok: true; estimate: SiteEstimate } | { ok: false; reason: SiteEstimateRefusal };

export interface SiteEstimateInput {
  mode: EstimateMode;
  kg?: number | null;
  m3?: number | null;
  category?: EstimateCategory | null;
  container?: '20ft' | '40ft' | null;
  /** The Tashkent day the estimate is given on (YYYY-MM-DD). */
  day: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const AIR_FORBIDDEN: ReadonlySet<EstimateCategory> = new Set(['battery', 'liquid']);

/** Present, finite and not negative — a NaN answers false to every comparison a guard is made of (#777). */
const sane = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** kg per m³, rounded the site's way; 0 when either side is unknown. */
export function densityKgM3(kg: number, m3: number): number {
  return kg > 0 && m3 > 0 ? Math.round(kg / m3) : 0;
}

/** First band whose ceiling holds the density, inclusive — the site's `densityBandRate`. */
export function densityBandRate(bands: readonly DensityBand[], density: number): number {
  for (const band of bands) if (band.maxKgM3 === null || density <= band.maxKgM3) return band.rate;
  return bands[bands.length - 1]?.rate ?? 0;
}

function truck(kg: number, m3: number, t: SiteTariff): SiteEstimate {
  const density = densityKgM3(kg, m3);
  const days: [number, number] = [t.truck.days[0], t.truck.days[1]];
  // Denser than water: the truck fills by weight, so the sheet bills per kg.
  if (density >= t.truck.perKgFromDensityKgM3) {
    return {
      mode: 'truck',
      rule: 'truck-per-kg',
      rate: t.truck.perKgAboveDensity,
      unit: 'kg',
      total: r2(kg * t.truck.perKgAboveDensity),
      days,
      notes: [],
      densityKgM3: density,
      chargeableKg: kg,
    };
  }
  const notes: EstimateNote[] = [];
  let billable = m3;
  if (billable < t.truck.minM3) {
    billable = t.truck.minM3;
    notes.push('min-m3-applied');
  }
  const rate = densityBandRate(t.truck.lclPerM3ByDensity, density);
  return {
    mode: 'truck',
    rule: 'truck-lcl',
    rate,
    unit: 'm3',
    total: r2(billable * rate),
    days,
    notes,
    densityKgM3: density || undefined,
    chargeableM3: billable,
    chargeableKg: kg,
  };
}

function air(kg: number, m3: number, category: EstimateCategory, t: SiteTariff): SiteEstimate {
  const notes: EstimateNote[] = [];
  const volumetric = m3 > 0 ? r2((m3 * 1_000_000) / t.air.volumetricDivisor) : 0;
  let chargeable = r2(Math.max(kg, volumetric));
  if (volumetric > kg && volumetric > 0) notes.push('volumetric-applied');
  if (chargeable < t.air.minKg) {
    chargeable = t.air.minKg;
    notes.push('min-kg-applied');
  }
  const rate = category === 'brand' ? t.air.perKg.brand : category === 'commercial' ? t.air.perKg.commercial : t.air.perKg.standard;
  return {
    mode: 'air',
    rule: 'air-per-kg',
    rate,
    unit: 'kg',
    total: r2(chargeable * rate),
    days: [t.air.days[0], t.air.days[1]],
    notes,
    densityKgM3: densityKgM3(kg, m3) || undefined,
    chargeableKg: chargeable,
  };
}

/**
 * The website's figure for this cargo, or the reason there is none.
 *
 * `day` is REQUIRED: a public price has a shelf life and the snapshot says
 * which, so the caller cannot forget to ask whether it still applies.
 */
export function siteEstimate(input: SiteEstimateInput, t: SiteTariff = SITE_TARIFF): SiteEstimateResult {
  if (input.day > t.validThrough) return { ok: false, reason: 'stale' };
  if (input.mode === 'rail') {
    const range = input.container === '40ft' ? t.rail.container40ft : t.rail.container20ft;
    return {
      ok: true,
      estimate: {
        mode: 'rail',
        rule: input.container === '40ft' ? 'rail-40ft' : 'rail-20ft',
        rate: range[0],
        unit: 'container',
        total: range[0],
        totalMax: range[1],
        days: [t.rail.days[0], t.rail.days[1]],
        notes: ['range'],
      },
    };
  }
  const kg = input.kg ?? 0;
  const m3 = input.m3 ?? 0;
  if (!sane(kg) || !sane(m3)) return { ok: false, reason: 'not_a_number' };
  const category: EstimateCategory = input.category ?? 'standard';
  if (input.mode === 'air') {
    // The site's dispatcher switches a category that cannot fly to the truck
    // sheet rather than refusing — and the truck sheet needs a volume.
    if (AIR_FORBIDDEN.has(category)) {
      if (!(m3 > 0)) return { ok: false, reason: 'air_forbidden' };
      const e = truck(kg, m3, t);
      return { ok: true, estimate: { ...e, notes: ['switched-to-truck', ...e.notes] } };
    }
    if (!(kg > 0) && !(m3 > 0)) return { ok: false, reason: 'weight_required' };
    return { ok: true, estimate: air(kg, m3, category, t) };
  }
  if (!(m3 > 0)) return { ok: false, reason: 'volume_required' };
  return { ok: true, estimate: truck(kg, m3, t) };
}
