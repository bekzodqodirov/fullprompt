import { asc, eq, inArray, sql } from 'drizzle-orm';
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
    // Loader at the origin OR unloader at the destination.
    await authorize('scan.load', { warehouseId: batch.originWarehouseId }).catch(() =>
      authorize('scan.unload', { warehouseId: batch.destWarehouseId }),
    );
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
      // The loading list groups crated boxes under their crate so the
      // operator scans the crate instead of hunting loose boxes (owner).
      crateCode: crates.code,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .leftJoin(crates, eq(boxes.crateId, crates.id))
    .where(eq(boxes.currentBatchId, id))
    .orderBy(asc(receiptLots.letter), asc(boxes.seqInLot));

  // Crate codes for local crate-scan expansion offline: crates at the origin
  // WH (load mode) plus crates any member box belongs to (unload mode).
  const memberCrateIds = [
    ...new Set(
      (
        await db
          .select({ crateId: boxes.crateId })
          .from(boxes)
          .where(eq(boxes.currentBatchId, id))
      )
        .map((r) => r.crateId)
        .filter(Boolean) as string[],
    ),
  ];
  const originCrates = await db
    .select({ id: crates.id, code: crates.code })
    .from(crates)
    .where(
      memberCrateIds.length
        ? sql`${crates.warehouseId} = ${batch.originWarehouseId} OR ${crates.id} IN ${memberCrateIds}`
        : eq(crates.warehouseId, batch.originWarehouseId),
    );
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
