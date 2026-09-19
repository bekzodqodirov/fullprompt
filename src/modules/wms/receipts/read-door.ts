import { eq, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { boxes, receiptLots } from '../../platform/db/schema';
import { inScope, type ScopedActor } from '../../platform/rbac/scope';
import { cargoNearActor } from '../inventory/near';

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
