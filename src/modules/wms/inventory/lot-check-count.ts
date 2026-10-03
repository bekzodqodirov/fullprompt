import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { boxes, lotChecks, receiptLots, receipts, warehouses } from '../../platform/db/schema';
import { warehouseScope, type ScopedActor } from '../../platform/rbac/scope';
import {
  askableSql,
  checkFilterSql,
  lotCheckStateSql,
  lotTarkibJoinSql,
  lotTarkibOnSql,
} from '../receipts/lot-check-sql';
import { SHELF_STATUSES } from './service';

/**
 * «❓ Tekshirilmagan yuk: N prixod» on the logist's and the VED's home
 * (docs/YUK-TEKSHIRUV.md §6) — the SAME number `/stock?tek=yoq`'s chip
 * prints for this person with no other filter: the shelf statuses, their
 * warehouse scope, the check's one sentence and the `yoq` filter over it,
 * counted in prixods (#513). The row links to that screen, so the two must
 * agree to the digit.
 */
export async function uncheckedPrixodCount(actor: ScopedActor): Promise<number> {
  const checkState = lotCheckStateSql({
    lot: sql`${receiptLots}`,
    receipt: sql`${receipts}`,
    check: sql`${lotChecks}`,
  });
  const scope = warehouseScope(actor, boxes.currentWarehouseId);
  const [row] = await db
    .select({ n: sql<number>`count(DISTINCT ${receipts.id})` })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .leftJoin(lotChecks, eq(lotChecks.lotId, receiptLots.id))
    .leftJoin(lotTarkibJoinSql(), lotTarkibOnSql(sql`${receiptLots}`))
    .where(
      and(
        inArray(boxes.status, [...SHELF_STATUSES]),
        ...(scope ? [scope] : []),
        checkFilterSql('yoq', checkState, askableSql(sql`${warehouses}`)),
      ),
    );
  return Number(row?.n ?? 0);
}
