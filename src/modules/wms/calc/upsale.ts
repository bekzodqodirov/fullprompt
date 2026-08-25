import { sql, type SQL } from 'drizzle-orm';
import { currentVersionSql, notSupersededSql } from './version-set';

/**
 * The upsale (docs/VED.md law 4) — what a seller earns on a job.
 *
 * The number itself is NOT stored anywhere, and that is the round's first
 * decision. It is `client_price_usd − calc_versions.total_usd`, and both
 * parents are immutable: a version is never updated after it is written, a
 * correction is a NEW request through `supersedes_request_id`, and an offer
 * names its own `version_id` so the floor it was measured against cannot move
 * under it. Writing the difference down could only ever create a way for it
 * to disagree with itself. What genuinely cannot be derived — whether the
 * promise was ALLOWED and whether the money has been HANDED OVER — is stored,
 * because a derived number can be paid twice.
 */

/** Two decimals, the way money is compared everywhere else in this module. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Money never compares exactly.
 *
 * `total_usd` is numeric(14,2) and the client price is typed to the cent, so
 * a seller quoting exactly the floor produces a difference that is 0 or a
 * float hair either side of it. Below this, there is no upsale and no
 * below-floor either.
 */
export const MONEY_EPSILON = 0.009;

export interface UpsaleFacts {
  /** The concession the VED typed. Any amount at all kills the upsale. */
  discountUsd: number;
  /** The request's own kg/m³ at seal time. NULL means it could not be computed. */
  density: number | null;
  /** The band the VED forced the freight into, if they forced one. */
  bandOverrideMin: number | null;
}

/**
 * Does this job still carry an upsale right? Law 4: **any** concession kills it.
 *
 * Two things can concede, and only two:
 *
 * 1. `discount_usd` — the VED's typed concession, whatever it was called.
 * 2. A band override that LOWERS the freight. `freightFor` takes an override
 *    density and the tariff is monotone in density (a unit test walks every
 *    whole density 1..1500), so an override BELOW the real density buys a
 *    cheaper band and is a concession, while one ABOVE it is the VED
 *    correcting an overstated m³ and charging MORE — which concedes nothing.
 *    A NULL density with an override set is treated as a concession: a money
 *    rule fails closed.
 *
 * **`freight_usd <> freight_list_usd` is NOT one of them, and testing it is a
 * trap in both directions.** Traced end to end: `sealCalc` passes
 * `freight.listUsd` in as `freightUsd` and writes `freight_list_usd` from the
 * same value, so on a yolkira or podklyuch quote the two are one expression
 * and the test finds a freight concession NEVER. And on a **rastamojka**
 * quote `totalsFor` zeroes the freight it does not have while
 * `freight_list_usd` is still written from the resolved band — so the test
 * fires on every customs-only job and would strip the upsale from a whole
 * section. Measured against the code, not assumed.
 */
export function upsaleEligible(facts: UpsaleFacts): boolean {
  if (!Number.isFinite(facts.discountUsd) || facts.discountUsd > MONEY_EPSILON) return false;
  if (facts.bandOverrideMin === null) return true;
  if (facts.density === null || !Number.isFinite(facts.density)) return false;
  // Strictly below the real density is the cheaper band. Equal is a no-op and
  // above is the VED charging more.
  return facts.bandOverrideMin >= facts.density - 0.0001;
}

/** The seller's share. Negative or a hair above zero is not a commission. */
export function upsaleOf(input: { clientPriceUsd: number; totalUsd: number }): number | null {
  const { clientPriceUsd, totalUsd } = input;
  if (!Number.isFinite(clientPriceUsd) || !Number.isFinite(totalUsd)) return null;
  const diff = round2(clientPriceUsd - totalUsd);
  return diff > MONEY_EPSILON ? diff : null;
}

/**
 * THE payable predicate, written once (#513).
 *
 * Every consumer embeds this fragment — the queue, the report rows, the
 * scoreboard's aggregate, the seller table, the liability figure, and
 * `payUpsale`'s own claim as a correlated source. Restating it anywhere is
 * how «the screen said $340 and the till lost $200» happens.
 *
 * Five questions, and each is a rule from somewhere else in the module:
 *
 * - **one payable per JOB.** `calc_offers` has no unique key and re-offering
 *   is the designed workflow (the seller picks a language and presses again),
 *   so without a rank every re-quote is a second commission on one sale. The
 *   rank is per REQUEST and not per card, because 0085 deliberately dropped
 *   «one open request per card» — a client legitimately carries several jobs
 *   and each keeps its own upsale.
 * - **on the request's current version**, or a corrected job pays on the
 *   figure it was corrected away from.
 * - **on a request nobody has superseded** — a correction is a NEW request,
 *   and the old one's promise is not the one that stands.
 * - **released** — a below-floor promise that no admin allowed is not a
 *   promise (law 4).
 * - **eligible and positive** — `upsaleEligible`'s two clauses restated in
 *   SQL, and a loss is not a commission.
 */
export function payableOffersSql(): SQL {
  return sql`
    WITH ranked AS (
      SELECT o.id,
             o.version_id,
             o.offered_by,
             o.offered_at,
             o.client_price_usd,
             o.below_floor,
             o.approved_at,
             o.payout_expense_id,
             o.payout_at,
             o.payout_usd,
             v.request_id,
             v.total_usd,
             v.discount_usd,
             v.band_override_min,
             v.density,
             v.section,
             r.entity_type,
             r.entity_id,
             row_number() OVER (
               PARTITION BY v.request_id
               ORDER BY o.offered_at DESC, o.id DESC
             ) AS rn
        FROM calc_offers   o
        JOIN calc_versions v ON v.id = o.version_id
        JOIN calc_requests r ON r.id = v.request_id
       WHERE ${currentVersionSql()}
         AND ${notSupersededSql()}
    )
    SELECT ranked.*,
           round(ranked.client_price_usd - ranked.total_usd, 2) AS upsale_usd
      FROM ranked
     WHERE ranked.rn = 1
       AND (NOT ranked.below_floor OR ranked.approved_at IS NOT NULL)
       AND ranked.discount_usd <= ${MONEY_EPSILON}
       AND NOT (
             ranked.band_override_min IS NOT NULL
             AND (ranked.density IS NULL OR ranked.band_override_min < ranked.density - 0.0001)
           )
       AND ranked.client_price_usd - ranked.total_usd > ${MONEY_EPSILON}
  `;
}
