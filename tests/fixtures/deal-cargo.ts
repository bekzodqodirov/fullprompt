import { inArray } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { boxes, receiptLots, receipts, warehouses } from '@/modules/platform/db/schema';

/**
 * A confirmed prixod on a deal, with one lot of the given measure and its
 * CARTONS — the least a test needs for a seller's share to be a FACT (the
 * owner's 4b, 2026-09-26: the share follows the cargo that ARRIVED on the
 * deal) and PAYABLE (his 3a, 2026-09-29: the share waits on the KPI's
 * paid-cargo rule, whose grain is the carton — a lot with no boxes is no
 * cargo at all). Written straight to the tables: the receive wizard's own
 * path is proven elsewhere, and a share test must not depend on photographs
 * and label letters. The shape is `stamped-cargo.ts`'s.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;

export async function arriveOnDeal(input: {
  dealId: string;
  clientId: string;
  actorId: string;
  m3: number;
  kg: number;
  /** Cartons in the lot; 1 unless a test needs more. */
  boxes?: number;
}): Promise<string> {
  const [wh] = await db.select({ id: warehouses.id }).from(warehouses).limit(1);
  const n = input.boxes ?? 1;
  seq += 1;
  const [receipt] = await db
    .insert(receipts)
    .values({
      warehouseId: wh!.id,
      clientId: input.clientId,
      status: 'confirmed',
      createdBy: input.actorId,
      confirmedAt: new Date(),
      confirmedBy: input.actorId,
      dealId: input.dealId,
    })
    .returning({ id: receipts.id });
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: receipt!.id,
      seq: 1,
      productNameZh: '测试',
      boxCount: n,
      totalWeightKg: input.kg.toFixed(3),
      totalVolumeM3: input.m3.toFixed(4),
    })
    .returning({ id: receiptLots.id });
  if (n > 0) await db.insert(boxes).values(Array.from({ length: n }, (_, i) => ({
    lotId: lot!.id,
    shortCode: `UA${SUFFIX}-${seq}-${i + 1}`,
    seqInLot: i + 1,
    status: 'in_stock',
    currentWarehouseId: wh!.id,
  })));
  return receipt!.id;
}

/** Takes the prixods `arriveOnDeal` made back out: cartons, then lots, then receipts. */
export async function removeArrived(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const lots = await db.select({ id: receiptLots.id }).from(receiptLots).where(inArray(receiptLots.receiptId, ids));
  if (lots.length > 0) {
    await db.delete(boxes).where(
      inArray(
        boxes.lotId,
        lots.map((l) => l.id),
      ),
    );
  }
  await db.delete(receiptLots).where(inArray(receiptLots.receiptId, ids));
  await db.delete(receipts).where(inArray(receipts.id, ids));
}
