import { aliasedTable, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  batches,
  costEntries,
  costTypes,
  crates,
  pickups,
  receipts,
  users,
} from '../../platform/db/schema';
import { unplacedCostSince, unplacedCostSql } from '../costing/service';

export const QUEUE_PAGE = 100;

/**
 * The accountant's queue (0101): cargo costs whose kassa nobody has said —
 * typed by the warehouse, the logist, the VED, who hold no kassa grant — and
 * costs whose duplicate expense was merged away naming none (U02). Newest
 * first, a page at a time; the count is the whole queue.
 */
export async function unplacedCostQueue(page = 0) {
  const since = await unplacedCostSince();
  const enteredBy = aliasedTable(users, 'entered_by_user');
  const where = unplacedCostSql(since);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: costEntries.id,
        scope: costEntries.scope,
        amount: costEntries.amount,
        currency: costEntries.currency,
        amountUsd: costEntries.amountUsd,
        costDate: costEntries.costDate,
        note: costEntries.note,
        typeName: costTypes.name,
        batchId: costEntries.batchId,
        batchCode: batches.code,
        receiptId: costEntries.receiptId,
        receiptNumber: receipts.number,
        crateId: costEntries.crateId,
        crateCode: crates.code,
        pickupId: costEntries.pickupId,
        pickupCode: pickups.code,
        enteredByName: enteredBy.fullName,
        createdAt: costEntries.createdAt,
        /** Merged into a kassa-less expense typed since kassas were asked for (U02). */
        mergedExpenseId: costEntries.mergedExpenseId,
      })
      .from(costEntries)
      .innerJoin(costTypes, eq(costEntries.costTypeId, costTypes.id))
      .innerJoin(enteredBy, eq(costEntries.enteredBy, enteredBy.id))
      .leftJoin(batches, eq(costEntries.batchId, batches.id))
      .leftJoin(receipts, eq(costEntries.receiptId, receipts.id))
      .leftJoin(crates, eq(costEntries.crateId, crates.id))
      .leftJoin(pickups, eq(costEntries.pickupId, pickups.id))
      .where(where)
      .orderBy(desc(costEntries.costDate), asc(costEntries.createdAt))
      .limit(QUEUE_PAGE)
      .offset(page * QUEUE_PAGE),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(costEntries)
      .where(where),
  ]);
  return { rows, total: Number(total?.n ?? 0), since };
}
