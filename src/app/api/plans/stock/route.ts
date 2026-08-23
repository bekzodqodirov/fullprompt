import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  crates,
  receiptLots,
  receipts,
} from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { json } from '@/modules/platform/http/json';

const querySchema = z.object({ warehouseId: z.string().uuid() });

/**
 * Plannable stock at a warehouse: LOOSE lots (un-crated in-stock boxes) plus
 * active crates as single units — a crate is planned whole and counts as one
 * place (owner's request).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = querySchema.safeParse({ warehouseId: url.searchParams.get('warehouseId') });
  if (!query.success) return Response.json({ error: 'validation' }, { status: 400 });
  try {
    await authorize('plans.manage', { warehouseId: query.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

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
        eq(boxes.status, 'in_stock'),
        eq(boxes.currentWarehouseId, query.data.warehouseId),
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
    })
    .from(boxes)
    .innerJoin(crates, eq(boxes.crateId, crates.id))
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(crates.clientId, clients.id))
    .where(
      and(
        eq(boxes.status, 'in_stock'),
        eq(boxes.currentWarehouseId, query.data.warehouseId),
        isNotNull(boxes.crateId),
        eq(crates.status, 'active'),
      ),
    )
    .groupBy(crates.id, clients.clientCode)
    .orderBy(asc(crates.code));

  // Compressed + tagged (round 110): the plan editor re-reads a whole
  // warehouse's loadable stock every time it opens or the origin changes,
  // and it is the screen the owner named — «planlarni yuklayotgan paytda».
  return json(request, {
    lots: rows.map((r) => ({
      ...r,
      available: Number(r.available),
      perBoxKg: Number(r.totalWeightKg) / r.boxCount,
      perBoxM3: Number(r.totalVolumeM3) / r.boxCount,
      daysInStock: Math.floor((Date.now() - new Date(r.receivedAt).getTime()) / 86_400_000),
    })),
    crates: crateRows.map((c) => ({
      crateId: c.crateId,
      code: c.code,
      kind: c.kind,
      clientCode: c.clientCode,
      boxCount: Number(c.boxCount),
      kg: Math.round(Number(c.kg) * 10) / 10,
      m3: Math.round(Number(c.m3) * 1000) / 1000,
      daysInStock: Math.floor(
        (Date.now() - new Date(c.oldestReceivedAt).getTime()) / 86_400_000,
      ),
    })),
  });
}
