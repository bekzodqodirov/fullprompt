import { pricingSight } from './pricing-view';

/**
 * May this person open the «Partiya moliyasi» of a truck that brought cargo
 * INTO Uzbekistan (`/batches/[id]/pricing`)?
 *
 * ONE predicate for every link the unpriced-cargo ban draws — the unpriced
 * list's truck cells, /approvals' «narx qo'yish →» — because a row whose link
 * bounces is worse than a row with no link (#1023's rule). It is the page's
 * own answer, `pricingSight`, and nothing restated: the VED keeps the
 * price-only view (Q19 — he prices trucks, he only stops seeing the
 * tannarx), everybody without `finance.manage` has no door.
 *
 * `internal` is false by construction, not by assumption: every truck these
 * links name is an ARRIVAL truck, i.e. its movement landed the carton in a UZ
 * warehouse, and a CN → CN leg (the one kind `pricingSight` closes for the
 * VED) never lands anything in Uzbekistan.
 */
export function mayOpenPricing(permissions: ReadonlySet<string>): boolean {
  return pricingSight(permissions, false) !== 'none';
}
