import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { boxes, receiptLots, receipts } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';

const querySchema = z.object({
  warehouseId: z.string().uuid(),
  clientId: z.string().uuid(),
});

/** Issue mode (W7): the client's issuable boxes at this warehouse. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = querySchema.safeParse({
    warehouseId: url.searchParams.get('warehouseId'),
    clientId: url.searchParams.get('clientId'),
  });
  if (!query.success) return Response.json({ error: 'validation' }, { status: 400 });
  try {
    await authorize('scan.issue', { warehouseId: query.data.warehouseId });
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  const rows = await db
    .select({
      boxId: boxes.id,
      shortCode: boxes.shortCode,
      seqInLot: boxes.seqInLot,
      status: boxes.status,
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(
      and(
        eq(receipts.clientId, query.data.clientId),
        eq(boxes.currentWarehouseId, query.data.warehouseId),
        inArray(boxes.status, ['ready_for_pickup', 'in_stock']),
      ),
    )
    .orderBy(asc(receiptLots.letter), asc(boxes.seqInLot));

  return Response.json({ boxes: rows });
}
