import { asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  clients,
  crates,
  receiptLots,
  receipts,
} from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';

/**
 * Loading-mode snapshot: planned/loaded boxes of the batch + active crate
 * codes at the origin WH. The phone caches this for offline local validation
 * (<300 ms feedback without a round-trip).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, id) });
  if (!batch) return Response.json({ error: 'not_found' }, { status: 404 });
  try {
    await authorize('scan.load', { warehouseId: batch.originWarehouseId });
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  const memberBoxes = await db
    .select({
      shortCode: boxes.shortCode,
      status: boxes.status,
      letter: receiptLots.letter,
      lotId: receiptLots.id,
      productNameZh: receiptLots.productNameZh,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(eq(boxes.currentBatchId, id))
    .orderBy(asc(receiptLots.letter), asc(boxes.seqInLot));

  // Active crates at the origin WH → local crate-scan expansion offline.
  const originCrates = await db
    .select({ id: crates.id, code: crates.code })
    .from(crates)
    .where(eq(crates.warehouseId, batch.originWarehouseId));
  const crateBoxes = originCrates.length
    ? await db
        .select({ crateId: boxes.crateId, shortCode: boxes.shortCode })
        .from(boxes)
        .where(inArray(boxes.crateId, originCrates.map((c) => c.id)))
    : [];
  const byCrate = new Map<string, string[]>();
  for (const row of crateBoxes) {
    if (!row.crateId) continue;
    byCrate.set(row.crateId, [...(byCrate.get(row.crateId) ?? []), row.shortCode]);
  }

  return Response.json({
    batch: { id: batch.id, code: batch.code, status: batch.status },
    boxes: memberBoxes,
    crates: originCrates.map((c) => ({ code: c.code, boxShortCodes: byCrate.get(c.id) ?? [] })),
  });
}
