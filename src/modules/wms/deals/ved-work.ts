import { sql, type SQL } from 'drizzle-orm';

/**
 * The VED's work set on the deal board — the owner's G3 a (2026-10-07): the
 * «Bitimlar» board shows the VED only the deals that are his to work,
 * read-only: deals that carry a calc request, and OPEN deals with a position
 * that has no TNVED code.
 *
 * ONE sentence, five consumers (#513) — so the board, the number on his home
 * screen and his ⌘K can never disagree about which deals those are:
 *   1. the board's rows AND its true column totals (`dealBoardWhere`'s
 *      `vedWork` → `listDeals` / `openDealCounts` / `closedDealCounts`);
 *   2. the `deal-tnved-missing` chip on those cards (`DealRow.tnvedMissing`);
 *   3. the home row «TNVED kodsiz bitimlar» (`vedFlowCounts`), which counts
 *      DEALS by the missing arm and links the board that draws the chip;
 *   4. ⌘K and every `/api/search` picker (`searchDeals`);
 *   5. the calc card door (`calcCardExists`'s deal arm).
 *
 * Every fragment takes the deal as a ROW reference — `sql\`${deals}\`` (which
 * renders `"deals"`) or an alias like `sql\`d\`` — and writes `${deal}.id`,
 * never `${deals.id}`: Drizzle renders a column unqualified in a single-table
 * select, and an unqualified `id` inside these subqueries would bind to the
 * SUBQUERY's own table (#128) and make the slice everything or nothing with
 * no error. The subqueries use their own aliases (`vr`, `vs`, `vl`) and never
 * the outer table's name. Pure: imports only drizzle's `sql`.
 */

/** A calc request stands on this deal (any status — 15a's «which cards»). */
export function dealCarriesCalcSql(deal: SQL): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM calc_requests vr
    WHERE vr.entity_type = 'deal' AND vr.entity_id = ${deal}.id
  )`;
}

/**
 * An OPEN deal with at least one position that has no TNVED code (NULL or
 * blank). Open by the stage's kind — the same test `listDeals` and the home
 * count have always used; `deal_lines_deal_idx (deal_id, seq)` serves the
 * line probe.
 */
export function dealMissingTnvedSql(deal: SQL): SQL<boolean> {
  return sql<boolean>`(EXISTS (
    SELECT 1 FROM deal_stages vs WHERE vs.id = ${deal}.stage_id AND vs.kind = 'open'
  ) AND EXISTS (
    SELECT 1 FROM deal_lines vl
    WHERE vl.deal_id = ${deal}.id AND (vl.tnved_code IS NULL OR btrim(vl.tnved_code) = '')
  ))`;
}

/**
 * G3 a — what the VED's board holds. Wears its own parentheses: drizzle's
 * `and()` embeds its members verbatim, and a bare `a OR b` inside it reads
 * `(filter AND a) OR b` (round 99's lesson).
 */
export function vedWorkSql(deal: SQL): SQL<boolean> {
  return sql<boolean>`((${dealCarriesCalcSql(deal)}) OR (${dealMissingTnvedSql(deal)}))`;
}
