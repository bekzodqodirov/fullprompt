import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { boxes, clients, crates, receiptLots, receipts } from '../../platform/db/schema';
import { PLANNABLE_STATUSES } from '../boxes/shelf';
import { arrivalsForLots } from '../documents/arrivals';
import { qrlessJoinedSql } from '../labels/qrless-sql';

/**
 * Plannable stock at a warehouse — what the plan editor offers: LOOSE lots
 * (un-crated boxes free on the shelf) plus active crates as single units — a
 * crate is planned whole and counts as one place (owner's request).
 *
 * «Free on the shelf» is `PLANNABLE_STATUSES`, the list `availableByLot` and
 * the approval's reservation read too — so what the editor offers, what the
 * submit accepts and what the approval takes are one set. It was `in_stock`
 * here, and a truck unloaded at Andijan leaves its cargo `ready_for_pickup`:
 * the editor showed nothing to plan onto the internal trip to Tashkent.
 *
 * Out of its route handler so a test can ask the question the editor asks
 * (#166); the route keeps the door.
 */
export async function plannableStock(warehouseId: string) {
  const rows = await db
    .select({
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      boxCount: receiptLots.boxCount,
      totalWeightKg: receiptLots.totalWeightKg,
      totalVolumeM3: receiptLots.totalVolumeM3,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      receivedAt: receipts.receivedAt,
      available: sql<number>`count(*)`,
      // Of those, the cartons no phone will scan (0112): the planner sees it
      // before the truck, not the loader after.
      qrless: sql<number>`count(*) FILTER (WHERE ${qrlessJoinedSql()})`,
      photoId: sql<string | null>`(
        SELECT a.id FROM attachments a
        WHERE a.entity_type = 'receipt_lot' AND a.entity_id = ${receiptLots.id} AND a.kind = 'photo'
        ORDER BY a.created_at LIMIT 1
      )`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(
      and(
        inArray(boxes.status, [...PLANNABLE_STATUSES]),
        eq(boxes.currentWarehouseId, warehouseId),
        isNull(boxes.crateId),
      ),
    )
    .groupBy(receiptLots.id, clients.clientCode, receipts.unclaimedMarking, receipts.receivedAt)
    // FIFO default (spec 6.3): oldest stock first.
    .orderBy(asc(receipts.receivedAt), asc(receiptLots.letter));

  const crateRows = await db
    .select({
      crateId: crates.id,
      code: crates.code,
      kind: crates.kind,
      clientCode: clients.clientCode,
      boxCount: sql<number>`count(*)`,
      kg: sql<string>`sum(${receiptLots.totalWeightKg} / ${receiptLots.boxCount})`,
      m3: sql<string>`sum(${receiptLots.totalVolumeM3} / ${receiptLots.boxCount})`,
      oldestReceivedAt: sql<string>`min(${receipts.receivedAt})`,
      lotIds: sql<string[]>`array_agg(distinct ${receiptLots.id})`,
    })
    .from(boxes)
    .innerJoin(crates, eq(boxes.crateId, crates.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(crates.clientId, clients.id))
    .where(
      and(
        inArray(boxes.status, [...PLANNABLE_STATUSES]),
        eq(boxes.currentWarehouseId, warehouseId),
        isNotNull(boxes.crateId),
        eq(crates.status, 'active'),
      ),
    )
    .groupBy(crates.id, clients.clientCode)
    .orderBy(asc(crates.code));

  // «Qaysi partiyada kelgan» (owner, 2026-08-29) — the agent sheet's rule
  // from its one home, computed once for the loose lots AND the crates'
  // member lots together; the planner keeping one arrival's cargo together
  // is exactly what the sheet groups by.
  const arrivals = await arrivalsForLots(
    [...new Set([...rows.map((r) => r.lotId), ...crateRows.flatMap((c) => c.lotIds)])],
    warehouseId,
  );
  const crateArrival = (lotIds: string[]) =>
    [...new Set(lotIds.flatMap((lotId) => arrivals.get(lotId)?.codes ?? []))].join(', ');

  return {
    lots: rows.map((r) => ({
      ...r,
      available: Number(r.available),
      qrless: Number(r.qrless),
      perBoxKg: Number(r.totalWeightKg) / r.boxCount,
      perBoxM3: Number(r.totalVolumeM3) / r.boxCount,
      daysInStock: Math.floor((Date.now() - new Date(r.receivedAt).getTime()) / 86_400_000),
      arrival: (arrivals.get(r.lotId)?.codes ?? []).join(', '),
    })),
    crates: crateRows.map((c) => ({
      crateId: c.crateId,
      code: c.code,
      kind: c.kind,
      clientCode: c.clientCode,
      boxCount: Number(c.boxCount),
      kg: Math.round(Number(c.kg) * 10) / 10,
      m3: Math.round(Number(c.m3) * 1000) / 1000,
      daysInStock: Math.floor((Date.now() - new Date(c.oldestReceivedAt).getTime()) / 86_400_000),
      arrival: crateArrival(c.lotIds),
    })),
  };
}
