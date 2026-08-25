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
