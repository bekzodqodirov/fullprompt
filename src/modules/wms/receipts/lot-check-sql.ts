import { sql, type SQL } from 'drizzle-orm';
import type { CheckFilter } from './lot-check-face';

export {
  LOT_CHECK_STATES,
  chipFace,
  inCheckFilter,
  readCheckFilter,
  type CheckFilter,
  type LotCheckState,
} from './lot-check-face';

/**
 * «Yuk ma'lumoti tekshirildi» (0123, docs/YUK-TEKSHIRUV.md) — the ONE sentence
 * for whether a lot's information is confirmed, read by the stock table, its
 * Σ and its chip counts, the Ostatka XLSX, the plan editor, the prixod card,
 * the client card's «Yuklar» and the homes' counts (#513). Nothing else may
 * restate it; `tests/unit/lot-check-wire.test.ts` says so.
 *
 * Two bases, and neither is a flag somebody has to remember to clear:
 *
 *  · the PERSON's (the owner's 2b) — a `lot_checks` row whose snapshot still
 *    equals the lot: the goods name (both spellings), the carton count and
 *    the client. A rename, a count correction, the QR-siz count growth or a
 *    new client make it read «stale» by COMPARISON — and a take-back to the
 *    vouched count reads checked again by itself, which a clear-on-write
 *    could never do. kg/m³ are deliberately not compared: a re-weigh is the
 *    warehouse's correction, not «what is it»;
 *  · the DOCUMENT's (his 3a) — a lot tarkibi that still stands: the same
 *    three terms `isStale` (composition-math.ts) compares, restated here in
 *    SQL and pinned against it by `lot-check.integration.test.ts`. Only
 *    whether a composition STANDS is read — never its lines — so the stock
 *    and plan screens still learn nothing about the contents (LOT-TARKIBI §9).
 *
 * Every reader LEFT JOINs `lot_checks` and `lotTarkibJoinSql()` on the lot
 * and asks `lotCheckStateSql`. A JOIN and never a correlated subquery in a
 * WHERE: the design review measured that shape at 3.3 s on an 18k-carton
 * copy against 41 ms for the join. Both joins are at most one row per lot,
 * so neither can fan a count out.
 *
 * `lot`, `receipt`, `check` are table REFERENCES, never columns (#128): pass
 * `sql\`${receiptLots}\`` for a joined table or `sql\`l\`` for an alias
 * (`qrlessRowSql`'s shape).
 */

/** The derived per-lot composition totals' alias. */
export const LOT_TARKIB = sql.raw('lot_tarkib');

/**
 * The lot tarkibi's totals, one row per composed lot, as a join source:
 * `.leftJoin(lotTarkibJoinSql(), lotTarkibOnSql(sql\`${receiptLots}\`))`. The table is
 * small (compositions are rare) and grouped once per statement.
 */
export function lotTarkibJoinSql(): SQL {
  return sql`(
    SELECT c.lot_id, c.seen_box_count, sum(l.weight_kg) AS kg, sum(l.volume_m3) AS m3
      FROM lot_compositions c
      JOIN lot_composition_lines l ON l.lot_id = c.lot_id
     GROUP BY c.lot_id, c.seen_box_count
  ) AS ${LOT_TARKIB}`;
}

export function lotTarkibOnSql(lot: SQL): SQL {
  return sql`${LOT_TARKIB}.lot_id = ${lot}.id`;
}

export interface LotCheckRefs {
  lot: SQL;
  receipt: SQL;
  check: SQL;
}

/** The composition stands: the SQL twin of `!isStale(...)`. */
export function tarkibStandsSql(lot: SQL): SQL {
  return sql`(${LOT_TARKIB}.lot_id IS NOT NULL
    AND ${LOT_TARKIB}.seen_box_count = ${lot}.box_count
    AND ${LOT_TARKIB}.kg = ${lot}.total_weight_kg
    AND ${LOT_TARKIB}.m3 = ${lot}.total_volume_m3)`;
}

/**
 * The person's snapshot, term by term — the card names WHICH one moved, and
 * the state below is their conjunction, so the two cannot disagree.
 * `NULLIF(…, '')` on the lot's Russian name: the column stores an absent name
 * as NULL, and a row written before that rule must not read «renamed».
 */
export function checkTermsSql(refs: LotCheckRefs): { name: SQL; count: SQL; client: SQL } {
  const { lot, receipt, check } = refs;
  return {
    name: sql`(${check}.seen_name_zh = ${lot}.product_name_zh
      AND ${check}.seen_name_ru IS NOT DISTINCT FROM NULLIF(${lot}.product_name_ru, ''))`,
    count: sql`(${check}.seen_box_count = ${lot}.box_count)`,
    client: sql`(${check}.seen_client_id IS NOT DISTINCT FROM ${receipt}.client_id)`,
  };
}

/**
 * The state, in this order: a standing composition answers first (the
 * client's own document, his 3a — it holds on unclaimed cargo too); cargo
 * with no client has nobody to ask and its own list (/unclaimed); then the
 * person's snapshot; anything that WAS confirmed and no longer matches is
 * «stale» («o'zgardi — qayta so'rang»).
 */
export function lotCheckStateSql(refs: LotCheckRefs): SQL {
  const terms = checkTermsSql(refs);
  return sql`(CASE
    WHEN ${tarkibStandsSql(refs.lot)} THEN 'checked'
    WHEN ${refs.receipt}.client_id IS NULL THEN 'unclaimed'
    WHEN ${refs.check}.lot_id IS NOT NULL AND ${terms.name} AND ${terms.count} AND ${terms.client} THEN 'checked'
    WHEN ${refs.check}.lot_id IS NOT NULL OR ${LOT_TARKIB}.lot_id IS NOT NULL THEN 'stale'
    ELSE 'none'
  END)`;
}

/**
 * «Askable» (his 4a): the ❓ list is cargo standing in a CHINESE warehouse —
 * the information is needed for the invoice, and the invoice is made before
 * the truck leaves China. Cargo already in Uzbekistan shows ✅ when it was
 * checked and nothing otherwise.
 */
export function askableSql(warehouse: SQL): SQL {
  return sql`(${warehouse}.country = 'CN')`;
}

/**
 * The filter over a state and an «askable» — ONE function for the row level
 * (`lotCheckStateSql`, `askableSql`) and the grouped level (`g.state`,
 * `g.askable`), so the table and its Σ cannot answer two different questions.
 */
export function checkFilterSql(tek: CheckFilter, state: SQL, askable: SQL): SQL {
  return tek === 'ha'
    ? sql`(${state} = 'checked')`
    : sql`(${state} IN ('none', 'stale') AND ${askable})`;
}
