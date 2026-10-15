import { sql, type SQL } from 'drizzle-orm';
import { FEW, LADDER_LITERAL, RAW_MAX } from './import-stats-math';
import type { SuggestInput } from './import-baza';

/**
 * SQL FRAGMENTS of the baza statistics (his C1-C6), and nothing else.
 *
 * No `db` and no service import, deliberately: a unit test renders these
 * with `new PgDialect().sqlToQuery(…)` and reads the statement they make,
 * and both the stats reader (import-stats.ts) and the picker's candidate
 * query (import-baza.ts) build from them without an import cycle (the type
 * import of `SuggestInput` is erased at compile time).
 */

/**
 * «Xitoydan» — the ONE predicate for which declarations are China's (C2,
 * #1298). `col` must be a non-null text column; the caller decides what a
 * NULL origin means.
 *
 * A value that STARTS WITH DIGITS is decided by the numeric customs code
 * alone: «158-ТАЙВАНЬ (КИТАЙ)» and «344-ГОНКОНГ (КИТАЙ)» carry the word КИТАЙ
 * and are separate customs territories with prices of their own, and Taiwan
 * is also written «Китайская Республика». Anything else is a word match,
 * every case spelled out because a C-ctype postgres folds only ASCII (do not
 * trust `~*` or `lower()` with Cyrillic), minus the territories that wear
 * China's name.
 *
 * The patterns are bound as parameters, never spliced into the statement.
 */
const NUMERIC_LEAD = '^\\s*[0-9]';
const CHINA_NUMERIC = '^\\s*156([^0-9]|$)';
const CHINA_ISO = '^\\s*(CN|CHN)\\s*$';
const CHINA_WORDS =
  'китай|КИТАЙ|Китай|кнр|КНР|Кнр|xitoy|Xitoy|XITOY|хитой|ХИТОЙ|Хитой|china|China|CHINA|中国';
const NOT_CHINA =
  'тайван|ТАЙВАН|Тайван|taiwan|Taiwan|TAIWAN|гонконг|ГОНКОНГ|Гонконг|hong kong|Hong Kong|HONG KONG|' +
  'макао|МАКАО|Макао|macao|Macao|MACAO|macau|Macau|MACAU|台湾|香港|澳门';

export function chinaOriginSql(col: SQL): SQL {
  return sql`(CASE WHEN ${col} ~ ${NUMERIC_LEAD} THEN ${col} ~ ${CHINA_NUMERIC}
              ELSE (${col} ~ ${CHINA_ISO} OR (${col} ~ ${CHINA_WORDS} AND ${col} !~ ${NOT_CHINA})) END)`;
}

/**
 * The select-list pieces of ONE series over the price column `price`:
 * the count, the extremes, the 99-step `percentile_disc` ladder (every step
 * a price some declaration carries — D1) and, for a small sample, every
 * price. Prices travel as TEXT, the numeric's own digits, so a quartile can
 * be matched back to the very row that carries it.
 *
 * One vote per declaration (C4): the ladder is over ROWS, never over kilos.
 */
export function seriesAggSql(price: SQL): SQL {
  return sql`count(*)::int AS n,
         min(${price})::text AS min,
         max(${price})::text AS max,
         (percentile_disc(${LADDER_LITERAL}::float8[]) WITHIN GROUP (ORDER BY ${price}))::text[] AS ladder,
         CASE WHEN count(*) <= ${sql.raw(String(RAW_MAX))} THEN array_agg(${price}::text ORDER BY ${price}) END AS prices`;
}

/** Which declaration a quartile chip names when several carry that price:
 * the newest, then the highest id — deterministic, and the most recent. */
export function exemplarOrderSql(r: SQL): SQL {
  return sql`${r}.declared_at DESC NULLS LAST, ${r}.id DESC`;
}

/**
 * His ±25 % per-piece weight band (D5), over the alias `r`'s unit and
 * weight columns, inclusive at both ends. `false` when the row has no
 * weight per piece — the band then simply holds nothing.
 */
export function weightBandSql(
  unit: SQL,
  weight: SQL,
  bounds: { lo: number; hi: number } | null,
): SQL {
  if (!bounds) return sql`false`;
  return sql`(${unit} = 'dona' AND ${weight} IS NOT NULL
              AND ${weight} BETWEEN ${String(bounds.lo)}::numeric AND ${String(bounds.hi)}::numeric)`;
}

/**
 * The picker's candidate query — the ranking that `queryCandidates` used to
 * build inline, moved here so a unit test can READ what each mode pays.
 *
 * Without `named` it is today's statement plus the one display column
 * `origin_country`: the auto-fill and the AI prefill call it per row on
 * every save and must not pay for an aggregate they never read.
 *
 * With `named` (the 📥 dialog only) the per-row `word_similarity` scan —
 * the expensive half, ~7 s on a synthetic 130k-row code — is MATERIALIZED
 * once, and the name-matched series (C1's second series) rides it as two
 * uncorrelated scalar subqueries: the series (`named_q`) and the real
 * declarations at its quartiles (`named_ex`). A separate statement would
 * pay that scan twice (measured: +9 ms riding it, vs the whole scan again).
 */
export function candidateStatement(
  batchId: string,
  input: SuggestInput,
  needle: string | null,
  limit: number,
  named?: { minSim: number },
): SQL {
  const wantWeight =
    input.units.includes('dona') &&
    input.weightPerUnitKg !== null &&
    input.weightPerUnitKg !== undefined &&
    Number.isFinite(input.weightPerUnitKg) &&
    input.weightPerUnitKg > 0;
  const w = wantWeight ? Number(input.weightPerUnitKg) : 0;

  // A needle of null scores nothing — the ordering falls back to what is
  // knowable without a name, and every row still carries `nameSim` 0 so the
  // AUTO-fill's threshold can never be met by accident.
  const sim = needle === null ? sql`0::real` : sql`word_similarity(${needle}, r.name_norm)`;
  // The row's accepted units, as a postgres list — a JS array bound into a
  // raw fragment is not one. An empty list matches nothing, honestly.
  const accepts =
    input.units.length === 0
      ? sql`false`
      : sql`r.unit IN (${sql.join(
          input.units.map((u) => sql`${u}`),
          sql`, `,
        )})`;
  const score = sql`CASE
             WHEN ${wantWeight} AND r.unit = 'dona' AND r.weight_per_unit_kg IS NOT NULL
               THEN 0.7 * ${sim}
                  + 0.3 * (1 - LEAST(1, abs(${w}::numeric - r.weight_per_unit_kg)
                                        / GREATEST(${w}::numeric, 0.01)))
             ELSE ${sim}
           END`;

  if (!named) {
    return sql`
    SELECT r.id::text AS id,
           r.name,
           r.unit,
           r.price_per_unit_usd,
           r.weight_per_unit_kg,
           r.declared_at::text AS declared_at,
           r.sender,
           r.origin_country,
           ${sim} AS name_sim,
           ${score} AS score,
           -- The count rides the same scan: the screen must be able to say
           -- «200 declarations · the 50 closest» rather than imply that the
           -- page it shows is the whole file.
           count(*) OVER () ::int AS total
      FROM customs_import_rows r
     WHERE r.batch_id = ${batchId}::uuid
       AND r.tnved_code = ${input.tnvedCode}
     ORDER BY (${accepts}) DESC, score DESC, r.declared_at DESC NULLS LAST
     LIMIT ${limit}`;
  }

  return sql`
    WITH scored AS MATERIALIZED (
      SELECT r.id, r.name, r.unit, r.price_per_unit_usd, r.weight_per_unit_kg,
             r.declared_at, r.sender, r.origin_country,
             ${sim} AS name_sim,
             ${score} AS score
        FROM customs_import_rows r
       WHERE r.batch_id = ${batchId}::uuid
         AND r.tnved_code = ${input.tnvedCode}
    ), nna AS (
      -- D3: the country filter applies only when the file names countries at
      -- all — decided over the whole code in this batch, never per unit.
      SELECT coalesce(bool_or(origin_country IS NOT NULL), false) AS named_any FROM scored
    ), nscoped AS (
      SELECT s.* FROM scored s CROSS JOIN nna
       WHERE s.name_sim >= ${named.minSim}
         AND (NOT nna.named_any OR (s.origin_country IS NOT NULL AND ${chinaOriginSql(sql`s.origin_country`)}))
    ), nq AS (
      SELECT s.unit, ${seriesAggSql(sql`s.price_per_unit_usd`)}
        FROM nscoped s
       GROUP BY s.unit
    ), ne AS (
      SELECT DISTINCT ON (q.unit, q.price)
             q.unit, q.price::text AS price, s.id::text AS id, s.name,
             s.declared_at::text AS declared_at, s.sender, s.origin_country,
             s.weight_per_unit_kg::text AS w
        FROM (SELECT nq.unit, unnest(ARRAY[nq.ladder[25], nq.ladder[50], nq.ladder[75]])::numeric AS price
                FROM nq
               WHERE nq.n >= ${sql.raw(String(FEW))}) q
        JOIN nscoped s ON s.unit = q.unit AND s.price_per_unit_usd = q.price
       ORDER BY q.unit, q.price, ${exemplarOrderSql(sql`s`)}
    )
    SELECT r.id::text AS id,
           r.name,
           r.unit,
           r.price_per_unit_usd,
           r.weight_per_unit_kg,
           r.declared_at::text AS declared_at,
           r.sender,
           r.origin_country,
           r.name_sim,
           r.score,
           count(*) OVER () ::int AS total,
           (SELECT coalesce(json_agg(nq), '[]'::json) FROM nq) AS named_q,
           (SELECT coalesce(json_agg(ne), '[]'::json) FROM ne) AS named_ex
      FROM scored r
     ORDER BY (${accepts}) DESC, r.score DESC, r.declared_at DESC NULLS LAST
     LIMIT ${limit}`;
}
