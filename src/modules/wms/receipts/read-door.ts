import { eq, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { boxes, receiptLots } from '../../platform/db/schema';
import { inScope, type ScopedActor } from '../../platform/rbac/scope';
import { cargoNearActor, receiptsNearActor } from '../inventory/near';

/**
 * May this person open this prixod?
 *
 * TWO warehouses answer yes, and the second one is the point. `warehouse_id`
 * is where the goods were RECEIVED and it never moves, so on that column alone
 * a Kashgar prixod whose cartons now stand in Andijan belongs to a warehouse
 * the Andijan operator has nothing to do with — while the PHOTOGRAPHS on that
 * same page opened for them, because the attachment gate learned this rule in
 * round 90 and the page it hangs on did not.
 *
 * What made it urgent is the handover list (owner's item 3): «egasi
 * aniqlanmagan yuk» is a row on it precisely so somebody can name the client,
 * and the person who knows is the one standing over the cargo in Uzbekistan.
 * A row that opens on «not found» is worse than no row.
 *
 * A function in a module rather than two conditions in the page, because a
 * rule written inside a server component can only be proven by grepping the
 * file (#531) — and a grep is satisfied by a call that can never run.
 */
export async function mayReadReceipt(
  actor: ScopedActor & { warehouseIds: string[] },
  receipt: { id: string; warehouseId: string },
): Promise<boolean> {
  if (inScope(actor, receipt.warehouseId)) return true;
  return cargoNearActor(
    actor,
    inArray(
      boxes.lotId,
      db.select({ id: receiptLots.id }).from(receiptLots).where(eq(receiptLots.receiptId, receipt.id)),
    ),
  );
}

/**
 * `mayReadReceipt` for a whole list: the ids of the prixods this person may
 * open. The same two answers — the receiving warehouse is theirs, or a carton
 * of it stands near them — with the second asked ONCE for every receipt the
 * first did not settle (the client card's «Yuklar» tab links every prixod it
 * lists; one query per row for a scoped reader is #432's shape, the tab's
 * judge finding 11). An unscoped reader costs no query at all.
 */
export async function receiptsReadableBy(
  actor: ScopedActor & { warehouseIds: string[] },
  list: { id: string; warehouseId: string }[],
): Promise<Set<string>> {
  const open = new Set<string>();
  const rest: string[] = [];
  for (const r of list) {
    if (inScope(actor, r.warehouseId)) open.add(r.id);
    else rest.push(r.id);
  }
  if (rest.length === 0) return open;
  for (const id of await receiptsNearActor(actor, [...new Set(rest)])) open.add(id);
  return open;
}
