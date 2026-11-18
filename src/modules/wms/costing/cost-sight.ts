import { cache } from 'react';
import { moneyHidden } from '../../platform/rbac/money-sight';

/**
 * How a cost row speaks to its reader (owner, 2026-09-25, Q19). No database:
 * the pages compute what they draw with these, the readers filter with
 * `CostSight`, and the unit tests load them without a connection.
 */

/**
 * Whose cost entries a screen lists (Q19 D1, his «19 a»): everybody's, or
 * only the reader's own. REQUIRED on every reader that returns entries — an
 * optional sight fails OPEN (#790).
 */
export interface CostSight {
  ownOnly: string | null;
}

export const ALL_COSTS: CostSight = { ownOnly: null };

export const costSightFor = cache(function costSightFor(actor: { id: string; permissions: ReadonlySet<string> }): CostSight {
  // The whole list next to the truck's kg/m³ IS the tannarx (#791): the VED
  // reads what he typed, and the TYPES of what others typed (no sums) — so
  // he still sees that the customs bill exists and does not enter it twice.
  return { ownOnly: moneyHidden('results', actor.permissions) ? actor.id : null };
});

/**
 * Who reads a prixod's cost AMOUNTS at all (2026-11-18). The people who enter
 * them, and the truck card's «Xarajatlar» audience (`mayOpenBatchCosts`,
 * batches/card-door.ts — restated here as codes because that module imports
 * the pricing door): the warehouse that typed the bill, the logist and the
 * VED, the accountant, a reports reader.
 *
 * Everybody else opening a prixod card used to read its bills too, and since
 * the sellers were given every client's cargo on Ostatka and the board (his
 * «sotuvchilarga … skladdagi yuklarni korishga ruxsat», 4a «yashirilsin») the
 * card is one tap from their menu: a prixod's freight and customs bills beside
 * its kg and m³ are the tannarx (#791). The VED still reads through
 * `costSightFor` — his own amounts, the others' types.
 */
export function mayReadCostAmounts(permissions: { has(code: string): boolean }): boolean {
  return (
    permissions.has('costs.enter_receipt') ||
    permissions.has('costs.enter_batch') ||
    permissions.has('reports.all_warehouses')
  );
}

/**
 * Whether a cost row may print the NAME of the kassa it was paid from: money
 * readers only. A warehouse operator reading a receipt's costs learns that a
 * kassa answered, never which drawer holds the company's cash — and the VED,
 * who holds `finance.manage`, not even that (Q19).
 */
export function maySeeTillNames(permissions: ReadonlySet<string>): boolean {
  return (
    (permissions.has('finance.view') || permissions.has('finance.manage') || permissions.has('finance.expenses')) &&
    !moneyHidden('kassa', permissions)
  );
}

/**
 * How a cost row speaks about its kassa, for this reader. ONE answer for the
 * four cost cards (batch, receipt, crate, pickup) — they used to restate two
 * inline lines each.
 *
 * For a reader the kassa is hidden from: no drawer and no «kassadan» fact,
 * and the 🗑 on a kassa-paid row gives way to «🔒 buxgalter bekor qiladi» —
 * naming the PERSON who may, never the drawer (a silent dead end is #420's
 * shape). Voiding it would put money back into a till, which is the kassa
 * holders' act anyway (`voidCostEntryAction`'s kassa gate).
 */
export function tillView(
  permissions: ReadonlySet<string>,
  /**
   * `mergedExpenseId` REQUIRED (Q8): a merged row carries its «🔗» and the ↩
   * that undoes it on every cost card — optional, one card would forget it.
   */
  row: { accountId: string | null; accountName: string | null; mergedExpenseId: string | null },
): { accountName: string | null; paidFromTill: boolean; voidable: boolean; mergedExpenseId: string | null } {
  if (moneyHidden('kassa', permissions)) {
    return {
      accountName: null,
      paidFromTill: false,
      voidable: row.accountId === null,
      mergedExpenseId: row.mergedExpenseId,
    };
  }
  return {
    accountName: maySeeTillNames(permissions) ? row.accountName : null,
    paidFromTill: row.accountId !== null,
    voidable: true,
    mergedExpenseId: row.mergedExpenseId,
  };
}
