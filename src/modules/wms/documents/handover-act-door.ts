import { inScope, type ScopedActor } from '../../platform/rbac/scope';

/**
 * Who may read a handover's act — the PDF and the files hanging off the same
 * handover.
 *
 * It lived twice: in the act route and in the attachment gate's `handover`
 * branch, each with a comment saying the two must never disagree. The client
 * card's «Yuklar» tab now draws an «Akt» link beside every handover it lists,
 * and a third copy is how the three would come to disagree (the tab's judge,
 * finding 5). The act carries the customer's name, the receiver's name and
 * PHONE and the signed box list, so the rule is the warehouse's: the people
 * who hand cargo over (or resolve the unclaimed), in that warehouse.
 *
 * `handoverActRefusal` keeps the attachment gate's two refusal codes apart;
 * everybody else asks the boolean.
 */
export function handoverActRefusal(
  actor: ScopedActor & { permissions: { has(code: string): boolean } },
  warehouseId: string,
): 'no-permission' | 'out-of-scope' | null {
  if (!actor.permissions.has('scan.issue') && !actor.permissions.has('receipts.unclaimed.resolve')) {
    return 'no-permission';
  }
  return inScope(actor, warehouseId) ? null : 'out-of-scope';
}

export function mayReadHandoverAct(
  actor: ScopedActor & { permissions: { has(code: string): boolean } },
  warehouseId: string,
): boolean {
  return handoverActRefusal(actor, warehouseId) === null;
}
