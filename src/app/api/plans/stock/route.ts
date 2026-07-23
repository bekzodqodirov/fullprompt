import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  receiptLots,
  receipts,
} from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';

const querySchema = z.object({ warehouseId: z.string().uuid() });

/** Plannable stock at a warehouse: lots with un-reserved in-stock boxes. */
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
      and(eq(boxes.status, 'in_stock'), eq(boxes.currentWarehouseId, query.data.warehouseId)),
    )
    .groupBy(receiptLots.id, clients.clientCode, receipts.unclaimedMarking, receipts.receivedAt)
    // FIFO default (spec 6.3): oldest stock first.
    .orderBy(asc(receipts.receivedAt), asc(receiptLots.letter));

  return Response.json({
    lots: rows.map((r) => ({
      ...r,
      available: Number(r.available),
      perBoxKg: Number(r.totalWeightKg) / r.boxCount,
      perBoxM3: Number(r.totalVolumeM3) / r.boxCount,
      daysInStock: Math.floor((Date.now() - new Date(r.receivedAt).getTime()) / 86_400_000),
    })),
  });
}
