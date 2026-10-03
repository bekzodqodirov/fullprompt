import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { boxes, lotChecks, receiptLots, receipts, warehouses } from '../../platform/db/schema';
import { warehouseScope, type ScopedActor } from '../../platform/rbac/scope';
import {
  askableSql,
  checkFilterSql,
  lotCheckStateSql,
  withLotCheckJoins,
} from '../receipts/lot-check-sql';
import { lotChecksReady } from '../receipts/lot-check-ready';
import { SHELF_STATUSES } from './service';

/**
 * «❓ Tekshirilmagan yuk: N prixod» on the logist's and the VED's home
 * (docs/YUK-TEKSHIRUV.md §6) — the SAME number `/stock?tek=yoq`'s chip
 * prints for this person with no other filter: the shelf statuses, their
 * warehouse scope, the check's one sentence and the `yoq` filter over it,
 * counted in prixods (#513). The row links to that screen, so the two must
 * agree to the digit.
 */
export async function uncheckedPrixodCount(actor: ScopedActor): Promise<number | null> {
  // A server whose migration has not landed (#472) has no list to count.
  if (!(await lotChecksReady())) return null;
  const checkState = lotCheckStateSql({
    lot: sql`${receiptLots}`,
    receipt: sql`${receipts}`,
    check: sql`${lotChecks}`,
  });
  const scope = warehouseScope(actor, boxes.currentWarehouseId);
  const askable = askableSql(sql`${warehouses}`);
  // Grouped per lot FIRST and filtered after (HAVING): the review measured
  // the state as a WHERE misjudged by the planner (≈1 % for a third of the
  // rows), which then walked every lot ever received to answer a shelf of a
  // hundred cartons. The Chinese warehouses are a plain WHERE so the scan
  // starts from their shelf.
  const groups = withLotCheckJoins(
    db
      .select({ receiptId: sql<string>`${receipts.id}`.as('receipt_id') })
      .from(boxes)
      .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
      .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
      .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
      .$dynamic(),
    true,
  )
    .where(and(inArray(boxes.status, [...SHELF_STATUSES]), ...(scope ? [scope] : []), askable))
    .groupBy(receiptLots.id, receipts.id)
    .having(checkFilterSql('yoq', sql`min(${checkState})`, sql`bool_and(${askable})`))
    .as('g');
  const [row] = await db.select({ n: sql<number>`count(DISTINCT g.receipt_id)` }).from(groups);
  return Number(row?.n ?? 0);
}
