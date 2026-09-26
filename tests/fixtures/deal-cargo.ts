import { inArray } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { receiptLots, receipts, warehouses } from '@/modules/platform/db/schema';

/**
 * A confirmed prixod on a deal, with one lot of the given measure — the
 * least a test needs for a seller's share to be a FACT (the owner's 4b,
 * 2026-09-26: the share follows the cargo that ARRIVED on the deal). Written
 * straight to the tables: the receive wizard's own path is proven elsewhere,
 * and a share test must not depend on photographs and label letters.
 */
export async function arriveOnDeal(input: {
  dealId: string;
  clientId: string;
  actorId: string;
  m3: number;
  kg: number;
}): Promise<string> {
  const [wh] = await db.select({ id: warehouses.id }).from(warehouses).limit(1);
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
  await db.insert(receiptLots).values({
    receiptId: receipt!.id,
    seq: 1,
    productNameZh: '测试',
    boxCount: 1,
    totalWeightKg: input.kg.toFixed(3),
    totalVolumeM3: input.m3.toFixed(4),
  });
  return receipt!.id;
}

/** Takes the prixods `arriveOnDeal` made back out, lots first. */
export async function removeArrived(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.delete(receiptLots).where(inArray(receiptLots.receiptId, ids));
  await db.delete(receipts).where(inArray(receipts.id, ids));
}
