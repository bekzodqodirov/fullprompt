import { inScope, type ScopedActor } from '../../platform/rbac/scope';

/**
 * Who may read a handover's act — the PDF carrying the customer's name, the
 * receiver's name and PHONE and the signed box list (round 101, #705) — and
 * the files hanging off the same handover.
 *
 * The rule is the warehouse's: the people who hand cargo over (`scan.issue`)
 * or resolve the unclaimed, within the handover's warehouse. It lived twice —
 * in the act route and in the attachment gate's `handover` branch, each with
 * a comment saying the two must never disagree — and every screen that LINKS
 * to an act now asks it too before drawing the link, because a link that
 * bounces is worse than no link: the client card's «Yuklar» tab draws «Akt»
 * beside every handover it lists (the tab's judge, finding 5), and the debt
 * register's reader is the accountant, who holds neither grant.
 *
 * ONE home, and `tests/unit/document-route-gates.test.ts` refuses a second
 * definition anywhere under `src/`: two parallel packages minted this door
 * the same week under the same name in two modules, which is #513 arriving
 * by merge. The signature is the widest either asked for — any permission
 * set, and a warehouse that may be missing (`inScope` refuses it for a
 * scoped reader).
 *
 * `handoverActRefusal` keeps the attachment gate's two refusal codes apart;
 * everybody else asks the boolean.
 */
export function handoverActRefusal(
  actor: ScopedActor & { permissions: { has(code: string): boolean } },
  warehouseId: string | null,
): 'no-permission' | 'out-of-scope' | null {
  if (!actor.permissions.has('scan.issue') && !actor.permissions.has('receipts.unclaimed.resolve')) {
    return 'no-permission';
  }
  return inScope(actor, warehouseId) ? null : 'out-of-scope';
}

export function mayReadHandoverAct(
  actor: ScopedActor & { permissions: { has(code: string): boolean } },
  warehouseId: string | null,
): boolean {
  return handoverActRefusal(actor, warehouseId) === null;
}
