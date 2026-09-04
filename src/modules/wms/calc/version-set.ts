/**
 * «Which calculation stands» — the two clauses phase D wrote and phase E
 * needed verbatim (#513).
 *
 * Extracted from `payableOffersSql()` unchanged. Phase D's eighteen
 * integration tests staying green IS the proof of the refactor: they measure
 * commissions through this fragment and a single altered character moves
 * money.
 */
import { sql, type SQL } from 'drizzle-orm';

/**
 * The request's newest sealed price, as a predicate over aliases `v`
 * (calc_versions). A corrected job must not be measured on the figure it was
 * corrected away from.
 */
export function currentVersionSql(): SQL {
  return sql`v.version_no = (
    SELECT max(v2.version_no) FROM calc_versions v2
     WHERE v2.request_id = v.request_id
  )`;
}

/** Nobody has superseded this request — a correction is a NEW request. */
export function notSupersededSql(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM calc_requests r2 WHERE r2.supersedes_request_id = r.id
  )`;
}

/**
 * The Готово ANSWER still stands as a floor, as a predicate over alias `r`
 * (calc_requests) — phase 4's second offer anchor.
 *
 * Five clauses, each a judge-confirmed money hole without it:
 * - a completed request with a POSITIVE USD answer (a NULL floor reads as $0
 *   and every price clears it; a non-USD floor is not comparable to a USD
 *   client price);
 * - nobody superseded the request (the version anchor's own rule);
 * - no NEWER completed USD answer exists on the same card — a card carrying
 *   two answered jobs must measure money against its newest word on price,
 *   or a hand-posted requestId picks the cheaper floor;
 * - no version was SEALED on the same card after this answer — a Готово
 *   price and a later proper seal are two requests but one sale, and paying
 *   a commission on each is the double-pay the one-per-job rule exists for.
 *
 * Deliberately NO expiry clause: like the version anchor, the clock gates the
 * DOOR (recordOffer refuses `answer_expired`), never a promise already made.
 */
export function answerFloorStandsSql(): SQL {
  return sql`r.completed_at IS NOT NULL
    AND r.answer_amount IS NOT NULL
    AND r.answer_amount > 0
    AND r.answer_currency = 'USD'
    AND ${notSupersededSql()}
    AND NOT EXISTS (
      SELECT 1 FROM calc_requests rn
       WHERE rn.entity_type = r.entity_type
         AND rn.entity_id = r.entity_id
         AND rn.answer_amount IS NOT NULL
         AND rn.answer_currency = 'USD'
         AND rn.completed_at > r.completed_at
    )
    AND NOT EXISTS (
      SELECT 1 FROM calc_versions vn
        JOIN calc_requests rv ON rv.id = vn.request_id
       WHERE rv.entity_type = r.entity_type
         AND rv.entity_id = r.entity_id
         AND vn.sealed_at > r.completed_at
    )`;
}

/**
 * The MEASUREMENT's version of «not superseded», and deliberately NOT the
 * same clause.
 *
 * A commission and a measurement disagree about an abandoned correction, on
 * purpose. If a VED presses «Qayta hisoblash» and then hands the job back
 * without sealing, the money side must stop paying on the old promise at
 * once — a superseding request exists, so the promise no longer stands. The
 * measurement side must NOT drop the shipment: the cargo was priced, it
 * arrived, and the only figure that ever existed for it is the old one.
 * Dropping it would make an abandoned correction a way to disappear from the
 * accuracy table.
 */
export function measurableRequestSql(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM calc_requests r2
      JOIN calc_versions cv2 ON cv2.request_id = r2.id
     WHERE r2.supersedes_request_id = r.id
  )`;
}
