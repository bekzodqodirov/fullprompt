import { sql, type SQL } from 'drizzle-orm';
import { answerFloorStandsSql, currentVersionSql, notSupersededSql } from './version-set';

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
  // Phase 4: the LEFT JOIN carries the second anchor. Every version-only
  // clause is GUARDED by `o.version_id IS NOT NULL` — unguarded, each
  // evaluates NULL on a request-anchored row and silently drops it (the
  // judge's NULL-trap list: currentVersionSql, discount, band override).
  // The floor is COALESCE(v.total_usd, r.answer_amount), emitted under the
  // old name so every consumer reads the right figure unchanged; the
  // partition key COALESCEs the same way, so «one payable per JOB» covers
  // both anchors of one request. `answerFloorStandsSql` (version-set.ts)
  // carries the answer branch's own five clauses, including the cross-request
  // fences (no newer answer, no later seal on the same card).
  //
  // WHAT A JOB HAS ALREADY PAID is asked of the whole SALE, not of one
  // request (audit 2026-09-24, A18). A correction is a NEW request
  // (`recalcFromSealed`) and a Готово answer followed by a proper seal on the
  // same card is two requests but one sale (`answerFloorStandsSql`'s own
  // words) — so a payout counted per request let the seller be paid the
  // whole difference AGAIN the moment the paid job was corrected or sealed.
  // `job` walks `supersedes_request_id` down from each chain's root, the
  // shape `calc/chain.ts` already uses (and caps the same way); `paid` is
  // every payout with the chain it belongs to and, for an answer anchor, the
  // card and the moment the answer was given.
  return sql`
    WITH RECURSIVE job AS (
      SELECT id, id AS root_id, 0 AS depth
        FROM calc_requests
       WHERE supersedes_request_id IS NULL
      UNION ALL
      SELECT cr.id, j.root_id, j.depth + 1
        FROM calc_requests cr
        JOIN job j ON cr.supersedes_request_id = j.id
       WHERE j.depth < 64
    ),
    paid AS (
      SELECT p2.payout_usd,
             COALESCE(pj.root_id, pr.id) AS root_id,
             p2.version_id IS NULL        AS on_answer,
             pr.entity_type,
             pr.entity_id,
             pr.completed_at
        FROM calc_offers p2
        LEFT JOIN calc_versions pv ON pv.id = p2.version_id
        JOIN calc_requests pr ON pr.id = COALESCE(pv.request_id, p2.request_id)
        LEFT JOIN job pj ON pj.id = pr.id
       WHERE p2.payout_expense_id IS NOT NULL
    ),
    base AS (
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
             COALESCE(v.request_id, o.request_id) AS request_id,
             COALESCE(v.total_usd, r.answer_amount) AS total_usd,
             v.discount_usd,
             v.band_override_min,
             v.density,
             -- What the promise was priced ON (the owner, 2026-09-26, his 4b:
             -- the share follows the cargo that ARRIVED): the quote's own
             -- measure, per kg when its freight was priced per kg.
             COALESCE(v.freight_per_kg, false) AS per_kg,
             COALESCE(v.volume_m3, r.volume_m3) AS quoted_m3,
             COALESCE(v.weight_kg, r.weight_kg) AS quoted_kg,
             COALESCE(v.section, r.section) AS section,
             r.entity_type,
             r.entity_id,
             -- Does this offer's promise still stand? Computed rather than
             -- filtered, so a PAID offer whose promise was corrected away
             -- stays on the owner's screen as the record of what was paid.
             COALESCE(
               (o.version_id IS NOT NULL AND ${currentVersionSql()} AND ${notSupersededSql()})
               OR (o.version_id IS NULL AND ${answerFloorStandsSql()}),
               false
             ) AS stands,
             /**
              * WHAT THIS SALE HAS ALREADY PAID (audit A1, widened by A18).
              *
              * «One payable per job» was enforced by the rank alone, which
              * holds until the accountant PAYS: re-offering is the designed
              * workflow (pick a language, press again), so the next offer
              * became rn = 1 with a NULL payout and the whole difference
              * became payable a SECOND time — one sale, two commissions.
              *
              * The remaining amount is the honest figure: what this promise
              * is worth minus what this sale has already paid out — on this
              * request, on every request of its correction chain, and on any
              * Готово answer this card gave before this floor existed. A
              * re-offer at a HIGHER price pays the difference; a re-offer at
              * a lower one pays nothing (and nothing is clawed back — a
              * payment made is a payment made).
              */
             COALESCE((
               SELECT sum(pd.payout_usd)
                 FROM paid pd
                WHERE pd.root_id = COALESCE(j.root_id, r.id)
                   OR (pd.on_answer
                       AND pd.entity_type = r.entity_type
                       AND pd.entity_id = r.entity_id
                       AND pd.completed_at <= COALESCE(v.sealed_at, r.completed_at))
             ), 0) AS paid_on_request
        FROM calc_offers   o
        LEFT JOIN calc_versions v ON v.id = o.version_id
        JOIN calc_requests r ON r.id = COALESCE(v.request_id, o.request_id)
        LEFT JOIN job j ON j.id = r.id
    ),
    ranked AS (
      SELECT base.*,
             row_number() OVER (
               PARTITION BY base.request_id, base.stands
               ORDER BY base.offered_at DESC, base.id DESC
             ) AS rn
        FROM base
    )
    , measured AS (
      SELECT ranked.*,
             cargo.receipts AS cargo_receipts,
             cargo.m3       AS cargo_m3,
             cargo.kg       AS cargo_kg,
             /**
              * «Fakt» (the owner, 2026-09-26, 4b): the share is the promise
              * scaled by the cargo that actually ARRIVED on the deal —
              * confirmed prixods linked to it — over what the quote was
              * priced on: 30 m³ promised, 20 m³ arrived, two thirds of the
              * share. No arrived cargo is 0 (nothing is a fact yet); a quote
              * with no measure at all (a lump rastamojka) keeps its whole
              * promise once anything has arrived. Per kg when the freight
              * was priced per kg, else per m³, else whichever it has.
              */
             CASE
               WHEN cargo.receipts = 0 THEN 0
               WHEN ranked.per_kg AND ranked.quoted_kg > 0 THEN cargo.kg / ranked.quoted_kg
               WHEN ranked.quoted_m3 > 0 THEN cargo.m3 / ranked.quoted_m3
               WHEN ranked.quoted_kg > 0 THEN cargo.kg / ranked.quoted_kg
               ELSE 1
             END AS cargo_factor
        FROM ranked
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT rc.id)                    AS receipts,
                 coalesce(sum(rl.total_volume_m3), 0)      AS m3,
                 coalesce(sum(rl.total_weight_kg), 0)      AS kg
            FROM receipts rc
            JOIN receipt_lots rl ON rl.receipt_id = rc.id
           WHERE ranked.entity_type = 'deal'
             AND rc.deal_id = ranked.entity_id
             AND rc.status = 'confirmed'
        ) cargo ON true
    )
    SELECT ranked.*,
           round(ranked.client_price_usd - ranked.total_usd, 2) AS promised_usd,
           round((ranked.client_price_usd - ranked.total_usd) * ranked.cargo_factor, 2) AS upsale_usd,
           -- The price the client owes for what arrived — what the invoice
           -- check compares the deal's charges with, so a deal priced on the
           -- cargo that came is not «no invoice» for ever.
           round(ranked.client_price_usd * ranked.cargo_factor, 2) AS due_price_usd,
           -- What a payout would actually move: the share for the cargo that
           -- arrived less whatever this sale has already paid (A1, A18),
           -- never below zero. A paid row moves nothing more.
           CASE WHEN ranked.payout_expense_id IS NOT NULL THEN 0
                ELSE GREATEST(0, round(
                  (ranked.client_price_usd - ranked.total_usd) * ranked.cargo_factor
                    - ranked.paid_on_request, 2))
           END AS payable_usd
      FROM measured AS ranked
     -- A row that has been PAID stays listed whatever became of its promise,
     -- because the owner's screen is also the record of what was paid (a
     -- corrected job used to drop its paid row and the «To'langan» total
     -- with it). An unpaid row must be the standing promise of its job and
     -- survive every rule below.
     WHERE ranked.payout_expense_id IS NOT NULL
        OR (
          ranked.stands
          AND ranked.rn = 1
          AND (NOT ranked.below_floor OR ranked.approved_at IS NOT NULL)
          AND (ranked.version_id IS NULL OR ranked.discount_usd <= ${MONEY_EPSILON})
          AND (ranked.version_id IS NULL OR NOT (
                ranked.band_override_min IS NOT NULL
                AND (ranked.density IS NULL OR ranked.band_override_min < ranked.density - 0.0001)
              ))
          AND ranked.client_price_usd - ranked.total_usd > ${MONEY_EPSILON}
          -- Something is still owed on the job.
          AND ranked.client_price_usd - ranked.total_usd - ranked.paid_on_request
              > ${MONEY_EPSILON}
        )
  `;
}
