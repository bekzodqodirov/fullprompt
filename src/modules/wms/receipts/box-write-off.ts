import type { Actor } from '../../platform/rbac/authorize';

/**
 * Who may declare a box gone — said once (#513).
 *
 * Three doors reach `lost` today and all three say the same thing in their
 * own words: the stocktake's tick-list (`reconcileInventory`'s
 * `forbidden_lost`), the receipt card's write-off fold, and the box card's
 * manual status change. The corrections round adds a fourth — the bin scan on
 * `/inventory` — and a fourth restatement is how the four start to disagree.
 *
 * `receipts.void` is the manager-level proxy the other three already use
 * (DECISIONS #43): every seeded role carries it except `warehouse_operator`,
 * deliberately. The owner asked for the bin mode in the words of the person
 * holding the carton («scan qilib musorga tashlaydi») — if he wants the
 * operator to press it, this function is where that decision is made, and
 * widening it here widens the stocktake's tick-list in the same breath rather
 * than leaving two doors on ONE screen answering differently.
 */
export function mayWriteOffBox(actor: Actor): boolean {
  return actor.permissions.has('receipts.void');
}
