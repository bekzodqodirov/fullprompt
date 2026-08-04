import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { boxes, receiptLots, receipts } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';

const querySchema = z.object({
  warehouseId: z.string().uuid(),
  clientId: z.string().uuid(),
});

/** Cratable boxes for the builder: in-stock, un-crated, one client, one WH. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = querySchema.safeParse({
    warehouseId: url.searchParams.get('warehouseId'),
    clientId: url.searchParams.get('clientId'),
  });
  if (!query.success) return Response.json({ error: 'validation' }, { status: 400 });

  try {
    await authorize('crates.manage', { warehouseId: query.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  const rows = await db
    .select({
      boxId: boxes.id,
      shortCode: boxes.shortCode,
      seqInLot: boxes.seqInLot,
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      boxCount: receiptLots.boxCount,
      receiptNumber: receipts.number,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(
      and(
        eq(boxes.status, 'in_stock'),
        isNull(boxes.crateId),
        eq(boxes.currentWarehouseId, query.data.warehouseId),
        eq(receipts.clientId, query.data.clientId),
      ),
    )
    .orderBy(asc(receiptLots.letter), asc(boxes.seqInLot));

  return Response.json({ boxes: rows });
}
