import { inScope, type ScopedActor } from '../../platform/rbac/scope';

/**
 * Who may open a handover's act — the PDF carrying the customer's name, the
 * receiver's name and PHONE and the signed box list (round 101, #705).
 *
 * The handover's warehouse, not merely a login: the issuing roles
 * (`scan.issue`) and the unclaimed-cargo resolvers, within their warehouses.
 * Exported (0114) so a screen that LINKS to an act asks the route's own
 * question before drawing the link — the debt register's reader is the
 * accountant, who holds neither grant, and a door that bounces is worse than
 * no door (the judge's #7).
 */
export function mayReadHandoverAct(
  actor: ScopedActor & { permissions: Set<string> },
  warehouseId: string | null,
): boolean {
  return (
    (actor.permissions.has('scan.issue') || actor.permissions.has('receipts.unclaimed.resolve')) &&
    inScope(actor, warehouseId)
  );
}
