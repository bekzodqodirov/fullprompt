/**
 * The arithmetic behind «Narxlar statistikasi» — his C1-C6 of 2026-10-07 —
 * shared by the server that measures and the browser that draws.
 *
 * ZERO imports, on purpose (the import-parse.ts / pricing.ts shape): the
 * dialog bundles this file, and a stray `db` import here would drag the
 * server into a phone's download.
 *
 * Every figure the screen prints is a price some declaration actually
 * carries (`percentile_disc`, never `_cont`, and never a mean — #TBD-a): a
 * single 20-tonne typo moves an average, and an interpolated quartile is a
 * price nobody declared, which «Tanlash» could then not name.
 */

/** The 99-step ladder 0.01…0.99 — 0.25/0.50/0.75 are members, at 24/49/74. */
export const LADDER_STEPS: readonly number[] = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);
/**
 * The same ladder as a postgres array literal. Bound as TEXT and cast
 * `::float8[]` in SQL: a JS array bound into a raw fragment is not a
 * postgres array (CLAUDE.md footgun).
 */
export const LADDER_LITERAL = `{${LADDER_STEPS.join(',')}}`;
/** At or under this many declarations the server sends every price. */
export const RAW_MAX = 60;
/** Under this many, no box and no quartile chips: three quartiles of three
 * rows look authoritative and are not (D9). */
export const FEW = 5;
/** His ±25 % weight-per-piece rule for dona goods — ONE constant (D5). */
export const WEIGHT_BAND = 0.25;

/** One real declaration standing at a quartile — what a chip names (C3). */
export interface PriceExemplar {
  id: string;
  name: string;
  declaredAt: string | null;
  sender: string | null;
  originCountry: string | null;
  weightPerUnitKg: number | null;
  pricePerUnitUsd: number;
}

/** One series of one unit: the counts, the disc quartiles, the shape. */
export interface SeriesStats {
  n: number;
  min: number | null;
  max: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  /** 99 disc steps, only when n > RAW_MAX. */
  ladder: number[] | null;
  /** Every price ascending, only when n <= RAW_MAX. */
  prices: number[] | null;
  exemplars: { p25: PriceExemplar | null; p50: PriceExemplar | null; p75: PriceExemplar | null };
}

/** What one series looks like as the SQL hands it back — prices as TEXT,
 * the numeric's own digits, so a quartile can be matched back to its row. */
export interface RawSeries {
  n: number;
  min: string | null;
  max: string | null;
  ladder: string[] | null;
  prices: string[] | null;
}

export type ExemplarKey = 'p25' | 'p50' | 'p75';
/** Where each quartile sits on the 0-based ladder. */
export const QUARTILE_INDEX: Record<ExemplarKey, number> = { p25: 24, p50: 49, p75: 74 };

/**
 * A `json_agg` column as rows. postgres.js parses json by default, but a
 * driver or a cast that hands back the text must not break the dialog —
 * the defensive read the finance readers already use (off-truck.ts).
 */
export function jsonRows<T>(value: unknown): T[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

const numOrNull = (v: string | number | null | undefined): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The quartile prices of a raw series, as TEXT — what the exemplar lookup
 * matches against `price_per_unit_usd` exactly. Null below FEW: no exemplar
 * is computed where no chip will be drawn.
 */
export function quartileTexts(raw: RawSeries): Record<ExemplarKey, string> | null {
  if (raw.n < FEW || !raw.ladder || raw.ladder.length !== LADDER_STEPS.length) return null;
  return {
    p25: raw.ladder[QUARTILE_INDEX.p25]!,
    p50: raw.ladder[QUARTILE_INDEX.p50]!,
    p75: raw.ladder[QUARTILE_INDEX.p75]!,
  };
}

/**
 * A raw series → the response shape. The ladder rides only above RAW_MAX
 * and the raw prices only at or under it: the browser draws an exact
 * histogram for a small sample and a 99-step one for a big sample.
 */
export function seriesFromRaw(
  raw: RawSeries | null | undefined,
  exemplars: Partial<Record<ExemplarKey, PriceExemplar | null>> = {},
): SeriesStats {
  if (!raw || raw.n <= 0) {
    return {
      n: 0,
      min: null,
      max: null,
      p25: null,
      p50: null,
      p75: null,
      ladder: null,
      prices: null,
      exemplars: { p25: null, p50: null, p75: null },
    };
  }
  const ladder = raw.ladder ? raw.ladder.map((v) => Number(v)) : null;
  const at = (k: ExemplarKey) => (ladder && ladder.length === LADDER_STEPS.length ? ladder[QUARTILE_INDEX[k]]! : null);
  return {
    n: raw.n,
    min: numOrNull(raw.min),
    max: numOrNull(raw.max),
    p25: at('p25'),
    p50: at('p50'),
    p75: at('p75'),
    ladder: raw.n > RAW_MAX ? ladder : null,
    prices: raw.n <= RAW_MAX && raw.prices ? raw.prices.map((v) => Number(v)) : null,
    exemplars: {
      p25: exemplars.p25 ?? null,
      p50: exemplars.p50 ?? null,
      p75: exemplars.p75 ?? null,
    },
  };
}

/** The ±25 % weight band around the row's own kg per piece, or nothing. */
export function bandBounds(perPieceKg: number | null): { lo: number; hi: number } | null {
  if (perPieceKg === null || !Number.isFinite(perPieceKg) || perPieceKg <= 0) return null;
  return { lo: perPieceKg * (1 - WEIGHT_BAND), hi: perPieceKg * (1 + WEIGHT_BAND) };
}

/**
 * The values a histogram is drawn from and what each one weighs. Raw prices
 * weigh 1/n (one vote per declaration — C4: a 1 kg sample and a 20 t line
 * count the same); ladder steps weigh 1/99.
 */
export interface Sample {
  values: number[];
  weight: number;
}

export function sampleOf(series: Pick<SeriesStats, 'n' | 'prices' | 'ladder'>): Sample {
  if (series.prices && series.prices.length > 0) {
    return { values: series.prices, weight: 1 / series.prices.length };
  }
  if (series.ladder && series.ladder.length > 0) {
    return { values: series.ladder, weight: 1 / series.ladder.length };
  }
  return { values: [], weight: 0 };
}

export interface Domain {
  lo: number;
  hi: number;
  log: boolean;
  /** The nominal share of declarations off each end of the chart. */
  clippedLow: number;
  clippedHigh: number;
}

/**
 * The x-axis. A big sample is drawn p5..p95 so one 20-tonne typo cannot
 * squash the whole shape into one bar — the extremes line and the «‹ 5 %»
 * ends say that the tails exist. A small sample is drawn whole.
 * A spread of four times or more is drawn on a log scale.
 */
export function domainOf(all: Pick<SeriesStats, 'n' | 'min' | 'max' | 'ladder' | 'prices'>): Domain | null {
  let lo: number | null;
  let hi: number | null;
  let clippedLow = 0;
  let clippedHigh = 0;
  if (all.n > RAW_MAX && all.ladder && all.ladder.length === LADDER_STEPS.length) {
    lo = all.ladder[4]!;
    hi = all.ladder[94]!;
    // Nominal, and only when something really lies beyond the end: a min
    // equal to p5 has nothing off the chart to announce.
    const min = all.min ?? all.ladder[0]!;
    const max = all.max ?? all.ladder[98]!;
    clippedLow = min < lo ? 0.05 : 0;
    clippedHigh = max > hi ? 0.05 : 0;
  } else {
    const values = all.prices && all.prices.length > 0 ? all.prices : null;
    lo = all.min ?? (values ? Math.min(...values) : null);
    hi = all.max ?? (values ? Math.max(...values) : null);
  }
  if (lo === null || hi === null || !Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
  return { lo, hi, log: lo > 0 && hi / lo >= 4, clippedLow, clippedHigh };
}

/** The scale's own coordinate of a value — ln on a log axis. */
const scaleOf = (value: number, domain: Domain): number =>
  domain.log ? Math.log(Math.max(value, Number.MIN_VALUE)) : value;

export interface Histogram {
  bins: { from: number; to: number; share: number }[];
  /** The sample's own share below lo / above hi — never folded into an end bin. */
  clippedLow: number;
  clippedHigh: number;
}

/**
 * `bins` columns over the domain, log or linear edges. Values outside the
 * domain are counted into clippedLow/High and never into the end bins, so
 * the first bar does not silently carry every typo under p5. Shares of the
 * bins plus both clipped portions sum to 1.
 */
export function histogram(sample: Sample, domain: Domain, bins = 20): Histogram {
  const out: Histogram = { bins: [], clippedLow: 0, clippedHigh: 0 };
  if (sample.values.length === 0) return out;
  if (domain.lo === domain.hi) {
    // One price: one bar, and the renderer says «all at one price».
    let inside = 0;
    for (const v of sample.values) {
      if (v < domain.lo) out.clippedLow += sample.weight;
      else if (v > domain.hi) out.clippedHigh += sample.weight;
      else inside += sample.weight;
    }
    out.bins.push({ from: domain.lo, to: domain.hi, share: inside });
    return out;
  }
  const a = scaleOf(domain.lo, domain);
  const b = scaleOf(domain.hi, domain);
  const edge = (i: number) => {
    const t = a + ((b - a) * i) / bins;
    return domain.log ? Math.exp(t) : t;
  };
  for (let i = 0; i < bins; i++) {
    out.bins.push({ from: i === 0 ? domain.lo : edge(i), to: i === bins - 1 ? domain.hi : edge(i + 1), share: 0 });
  }
  for (const v of sample.values) {
    if (v < domain.lo) {
      out.clippedLow += sample.weight;
      continue;
    }
    if (v > domain.hi) {
      out.clippedHigh += sample.weight;
      continue;
    }
    const at = Math.floor(((scaleOf(v, domain) - a) / (b - a)) * bins);
    out.bins[Math.min(bins - 1, Math.max(0, at))]!.share += sample.weight;
  }
  return out;
}

/**
 * Where a value sits on the axis, 0..100 (%), with a flag when it lies off
 * an end — the renderer draws «‹»/«›» instead of a marker at the edge that
 * would read as «the cheapest». Null for anything not finite, so no marker
 * can ever be placed at `left: NaN%` (a typed «abc» is `Number` → NaN).
 */
export function position(
  value: number,
  domain: Domain,
): { pct: number; clamped: 'low' | 'high' | null } | null {
  if (!Number.isFinite(value)) return null;
  if (value < domain.lo) return { pct: 0, clamped: 'low' };
  if (value > domain.hi) return { pct: 100, clamped: 'high' };
  if (domain.lo === domain.hi) return { pct: 50, clamped: null };
  const a = scaleOf(domain.lo, domain);
  const b = scaleOf(domain.hi, domain);
  const pct = ((scaleOf(value, domain) - a) / (b - a)) * 100;
  return { pct: Math.min(100, Math.max(0, pct)), clamped: null };
}
