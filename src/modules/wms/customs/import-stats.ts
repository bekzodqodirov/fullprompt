import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';
import { basisConflicts } from '../calc/basis';
import type { BazaBasis } from '../calc/pricing';
import { BASIS_FOR_UNIT } from './import-baza';
import type { ImportUnit } from './import-parse';
import {
  LADDER_LITERAL,
  RAW_MAX,
  bandBounds,
  jsonRows,
  quartileTexts,
  seriesFromRaw,
  type ExemplarKey,
  type PriceExemplar,
  type RawSeries,
  type SeriesStats,
} from './import-stats-math';
import { chinaOriginSql, exemplarOrderSql, seriesAggSql, weightBandSql } from './import-stats-sql';

export type { PriceExemplar, SeriesStats } from './import-stats-math';

/**
 * «Narxlar statistikasi» — his C1-C6 of 2026-10-07, read for one row's code
 * in the quarter that answers now.
 *
 * What it says and what it refuses to say, each a decision:
 * - the 25/50/75 % of the declarations are `percentile_disc` — a price some
 *   declaration carries — and there is NO mean anywhere (#1297). C4: one
 *   vote per declaration; a 1 kg sample and a 20 t line count the same.
 * - units are never pooled: one distribution per file unit, and every count
 *   on screen is the active unit's (D2).
 * - China only (C2), by ONE predicate (`chinaOriginSql`), and only when the
 *   file names countries at all — a filter that zeroes every series of a
 *   file without the column would read as «no declarations» (D3).
 * - dona goods get his ±25 % weight-per-piece line (D5).
 * - «oldingi chorak» is the previous quarter's median, like for like (D7).
 *
 * Every statement runs on the `tx` it is handed — the caller's ceiling
 * transaction (`underCeiling`, each statement ≤ 1500 ms) — and NOTHING here
 * touches `db` or `getSetting`: a pool read inside that transaction is #714's
 * freeze. tx-pool.test.ts does not scan `underCeiling` callbacks, so
 * `import-stats-wire.test.ts` pins this body instead.
 */

export interface UnitStats {
  unit: ImportUnit;
  basis: BazaBasis;
  /** Is this unit one the row itself accepts (`unitsForRow`)? */
  matches: boolean;
  /** False when the code's law cannot hold this unit (0125's conflict). */
  pickable: boolean;
  /** THIS unit's counts (D2): China (or every row when not filtered), other
   * countries, no country. */
  origin: { china: number; other: number; unknown: number };
  all: SeriesStats;
  /** The dona tab's ±25 % series; 'no_row_weight' when the row states no
   * count or weight; null on every other tab. */
  weight: SeriesStats | 'no_row_weight' | null;
  /** null = no previous batch at all. `filtered` is the previous batch's
   * own `named_any` for this code — null when that file holds no declaration
   * of the code at all, so it has no country split to compare (`prevLine`). */
  prev: { n: number; p50: number | null; filtered: boolean | null } | null;
}

export interface ImportStatsAnswer {
  state: 'ok' | 'no_code' | 'no_batch' | 'behind' | 'timeout';
  batchId: string | null;
  /** «2026-04-01 … 2026-06-29», or the file name when the file had no dates. */
  period: string | null;
  prevPeriod: string | null;
  /** D3: the current batch names countries, so the series are China only. */
  filtered: boolean;
  /** The default tab first (D2). */
  units: UnitStats[];
  wants: BazaBasis[];
  perPieceKg: number | null;
  /** The code's law unit — for the «why not» sentence on a refused tab
   * (the list's own `lawUnit`, beside it). */
  lawUnit: string | null;
}

export interface StatsInput {
  batchId: string;
  prevBatchId: string | null;
  tnvedCode: string;
  /** The row's accepted units, best first (`unitsForRow`). */
  units: ImportUnit[];
  dutyUnit: string | null;
  perPieceKg: number | null;
}

type UnitAgg = RawSeries & {
  unit: ImportUnit;
  band_n: number;
  band_min: string | null;
  band_max: string | null;
  band_ladder: string[] | null;
  band_prices: string[] | null;
};

type OriginAgg = { unit: ImportUnit; china: number; other: number; unknown: number; total: number };

type ExemplarRow = {
  series: 'all' | 'weight';
  unit: ImportUnit;
  price: string;
  id: string;
  name: string;
  declared_at: string | null;
  sender: string | null;
  origin_country: string | null;
  w: string | null;
};

/**
 * The code's rows in ONE batch, scoped to China by D3 — the three CTEs
 * statement 1 and statement 3 both stand on, so the previous quarter is
 * measured by exactly the rule the current one is.
 *
 * `named_any` is NULL — not false — when the batch holds no row of the code:
 * «this file names no country» and «this file has nothing of this code» are
 * different facts, and only the first is a reason to say the previous
 * quarter's split differs.
 */
function scopedCtes(batchId: string, code: string): SQL {
  // `cn` is decided ONCE per row: both the origin counts and the scope ask
  // the same question, and the country patterns are the costly part of the
  // read — measured on a synthetic 130k-row code (jit off, work_mem 16MB),
  // statement 1 took ~450 ms asking it three times per row, ~330 ms once.
  return sql`base AS (
      SELECT r.unit, r.price_per_unit_usd AS p, r.weight_per_unit_kg AS w, r.origin_country AS o,
             (r.origin_country IS NOT NULL AND ${chinaOriginSql(sql`r.origin_country`)}) AS cn
        FROM customs_import_rows r
       WHERE r.batch_id = ${batchId}::uuid AND r.tnved_code = ${code}
    ), na AS (
      SELECT bool_or(o IS NOT NULL) AS named_any FROM base
    ), scoped AS (
      SELECT b.* FROM base b CROSS JOIN na
       WHERE NOT na.named_any OR b.cn
    )`;
}

export async function readImportStats(
  tx: Tx,
  input: StatsInput,
): Promise<Omit<ImportStatsAnswer, 'state' | 'period' | 'prevPeriod'>> {
  const bounds = bandBounds(input.perPieceKg);
  const band = weightBandSql(sql`s.unit`, sql`s.w`, bounds);

  // Statement 1, the aggregate. ONE row always — even for a code where China
  // has nothing — so the other-countries line still exists. Origin counts
  // are PER UNIT (D2); `named_any` is code-wide (D3).
  const [agg] = await tx.execute<{ named_any: boolean | null; origin_by_unit: unknown; units: unknown }>(sql`
    WITH ${scopedCtes(input.batchId, input.tnvedCode)},
    og AS (
      SELECT unit,
             count(*) FILTER (WHERE cn)::int                     AS china,
             count(*) FILTER (WHERE o IS NOT NULL AND NOT cn)::int AS other,
             count(*) FILTER (WHERE o IS NULL)::int               AS unknown,
             count(*)::int AS total
        FROM base
       GROUP BY unit
    ), u AS (
      SELECT s.unit, ${seriesAggSql(sql`s.p`)},
             (count(*) FILTER (WHERE ${band}))::int AS band_n,
             (min(s.p) FILTER (WHERE ${band}))::text AS band_min,
             (max(s.p) FILTER (WHERE ${band}))::text AS band_max,
             (percentile_disc(${LADDER_LITERAL}::float8[]) WITHIN GROUP (ORDER BY s.p) FILTER (WHERE ${band}))::text[] AS band_ladder,
             CASE WHEN count(*) FILTER (WHERE ${band}) <= ${sql.raw(String(RAW_MAX))}
                  THEN array_agg(s.p::text ORDER BY s.p) FILTER (WHERE ${band}) END AS band_prices
        FROM scoped s
       GROUP BY s.unit
    )
    SELECT (SELECT named_any FROM na) AS named_any,
           coalesce((SELECT json_agg(og) FROM og), '[]'::json) AS origin_by_unit,
           coalesce((SELECT json_agg(u) FROM u), '[]'::json) AS units
  `);
  const filtered = agg?.named_any === true;
  const origins = jsonRows<OriginAgg>(agg?.origin_by_unit);
  const aggs = new Map(jsonRows<UnitAgg>(agg?.units).map((u) => [u.unit, u]));

  const allRaw = (u: ImportUnit): RawSeries | null => aggs.get(u) ?? null;
  const weightRaw = (u: ImportUnit): RawSeries | null => {
    const a = aggs.get(u);
    if (!a || u !== 'dona' || !bounds) return null;
    return { n: a.band_n, min: a.band_min, max: a.band_max, ladder: a.band_ladder, prices: a.band_prices };
  };

  // Statement 2, the exemplars: the newest real declaration at exactly each
  // quartile price, within that series' scope — so a tap names one and
  // costs no fetch (C3). Skipped when no series reaches FEW.
  const targets: { series: 'all' | 'weight'; unit: ImportUnit; price: string }[] = [];
  for (const o of origins) {
    for (const [series, raw] of [
      ['all', allRaw(o.unit)],
      ['weight', weightRaw(o.unit)],
    ] as const) {
      const q = raw ? quartileTexts(raw) : null;
      if (!q) continue;
      for (const price of new Set(Object.values(q))) targets.push({ series, unit: o.unit, price });
    }
  }
  const exemplars = new Map<string, PriceExemplar>();
  if (targets.length > 0) {
    const rows = await tx.execute<ExemplarRow>(sql`
      SELECT DISTINCT ON (t.series, r.unit, r.price_per_unit_usd)
             t.series, r.unit, r.price_per_unit_usd::text AS price, r.id::text AS id, r.name,
             r.declared_at::text AS declared_at, r.sender, r.origin_country,
             r.weight_per_unit_kg::text AS w
        FROM (VALUES ${sql.join(
          targets.map((x) => sql`(${x.series}::text, ${x.unit}::text, ${x.price}::numeric)`),
          sql`, `,
        )}) AS t(series, unit, price)
        JOIN customs_import_rows r
          ON r.batch_id = ${input.batchId}::uuid AND r.tnved_code = ${input.tnvedCode}
         AND r.unit = t.unit AND r.price_per_unit_usd = t.price
       WHERE (NOT ${filtered} OR (r.origin_country IS NOT NULL AND ${chinaOriginSql(sql`r.origin_country`)}))
         AND (t.series <> 'weight' OR ${weightBandSql(sql`r.unit`, sql`r.weight_per_unit_kg`, bounds)})
       ORDER BY t.series, r.unit, r.price_per_unit_usd, ${exemplarOrderSql(sql`r`)}
    `);
    for (const r of rows) {
      exemplars.set(`${r.series}|${r.unit}|${Number(r.price)}`, {
        id: r.id,
        name: r.name,
        declaredAt: r.declared_at,
        sender: r.sender,
        originCountry: r.origin_country,
        weightPerUnitKg: r.w === null ? null : Number(r.w),
        pricePerUnitUsd: Number(r.price),
      });
    }
  }
  const exemplarsOf = (series: 'all' | 'weight', unit: ImportUnit, raw: RawSeries | null) => {
    const q = raw ? quartileTexts(raw) : null;
    const out: Partial<Record<ExemplarKey, PriceExemplar | null>> = {};
    if (!q) return out;
    for (const key of ['p25', 'p50', 'p75'] as const) {
      out[key] = exemplars.get(`${series}|${unit}|${Number(q[key])}`) ?? null;
    }
    return out;
  };

  // Statement 3, the previous quarter — the SAME scope over THAT batch's own
  // rows, and its own `named_any`, so a China-only median is never set beside
  // an all-countries one as if they measured one population (D7).
  let prev: { filtered: boolean | null; byUnit: Map<ImportUnit, { n: number; p50: number | null }> } | null = null;
  if (input.prevBatchId) {
    const [p] = await tx.execute<{ named_any: boolean | null; units: unknown }>(sql`
      WITH ${scopedCtes(input.prevBatchId, input.tnvedCode)}
      SELECT (SELECT named_any FROM na) AS named_any,
             coalesce((
               SELECT json_agg(x) FROM (
                 SELECT unit, count(*)::int AS n,
                        (percentile_disc(0.5) WITHIN GROUP (ORDER BY p))::text AS p50
                   FROM scoped
                  GROUP BY unit
               ) x
             ), '[]'::json) AS units
    `);
    prev = {
      filtered: p?.named_any ?? null,
      byUnit: new Map(
        jsonRows<{ unit: ImportUnit; n: number; p50: string | null }>(p?.units).map((x) => [
          x.unit,
          { n: x.n, p50: x.p50 === null ? null : Number(x.p50) },
        ]),
      ),
    };
  }

  const stats: UnitStats[] = origins.map((o) => {
    const all = seriesFromRaw(allRaw(o.unit), exemplarsOf('all', o.unit, allRaw(o.unit)));
    const weight =
      o.unit !== 'dona'
        ? null
        : !bounds
          ? ('no_row_weight' as const)
          : seriesFromRaw(weightRaw(o.unit), exemplarsOf('weight', o.unit, weightRaw(o.unit)));
    return {
      unit: o.unit,
      basis: BASIS_FOR_UNIT[o.unit],
      matches: input.units.includes(o.unit),
      pickable: !basisConflicts(input.dutyUnit, BASIS_FOR_UNIT[o.unit]),
      // Not filtered: the file names no country, every row is in the series
      // and the line says so in words (statsNoOrigin), never «Xitoydan».
      origin: filtered
        ? { china: o.china, other: o.other, unknown: o.unknown }
        : { china: o.total, other: 0, unknown: 0 },
      all,
      weight,
      prev: prev
        ? { ...(prev.byUnit.get(o.unit) ?? { n: 0, p50: null }), filtered: prev.filtered }
        : null,
    };
  });

  return {
    batchId: input.batchId,
    filtered,
    units: orderUnits(stats, input.units),
    wants: input.units.map((u) => BASIS_FOR_UNIT[u]),
    perPieceKg: input.perPieceKg,
    lawUnit: input.dutyUnit,
  };
}

/**
 * The tab order (D2): the row's own units in `unitsForRow`'s order (the
 * auto-fill's preference), then the rest by count. The DEFAULT tab goes
 * first — the first wanted unit that has declarations in scope, else the
 * unit with the most.
 */
export function orderUnits<T extends { unit: ImportUnit; all: { n: number } }>(
  stats: T[],
  wanted: ImportUnit[],
): T[] {
  const rank = (u: ImportUnit) => {
    const i = wanted.indexOf(u);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  const ordered = [...stats].sort((a, b) => rank(a.unit) - rank(b.unit) || b.all.n - a.all.n);
  const first =
    ordered.find((s) => wanted.includes(s.unit) && s.all.n > 0) ??
    [...ordered].sort((a, b) => b.all.n - a.all.n)[0];
  return first ? [first, ...ordered.filter((s) => s !== first)] : ordered;
}

/** «2026-04-01 … 2026-06-29», else the file name (the column is NOT NULL)
 * — one rule for the list's `source` and the statistics' two periods. */
export function periodText(b: { fileName: string; periodFrom: string | null; periodTo: string | null } | undefined): string | null {
  if (!b) return null;
  return b.periodFrom && b.periodTo ? `${b.periodFrom} … ${b.periodTo}` : b.fileName;
}
