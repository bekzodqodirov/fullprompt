import { inArray } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { boxes, receiptLots, receipts, warehouses } from '@/modules/platform/db/schema';

/**
 * A confirmed prixod with CARTONS and a seller stamp (0117) — the least a
 * test of the KPI's one cargo reader (`staff/cargo.ts`) needs: the reader's
 * grain is the carton, so a lot with no boxes is no cargo at all. Written
 * straight to the tables, like `deal-cargo.ts`: the stamp's own writers are
 * proven through `confirmReceipt` / `assignReceiptClient` in
 * staff-pay.integration, and a figure test must not depend on photographs.
 */
const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;

export async function receiveStamped(input: {
  clientId: string;
  actorId: string;
  sellerId: string | null;
  m3: number;
  kg: number;
  boxes?: number;
  receivedAt?: Date;
  dealId?: string | null;
  number?: string;
}): Promise<{ receiptId: string; lotId: string; boxIds: string[] }> {
  const [wh] = await db.select({ id: warehouses.id }).from(warehouses).limit(1);
  const n = input.boxes ?? 1;
  seq += 1;
  const [receipt] = await db
    .insert(receipts)
    .values({
      warehouseId: wh!.id,
      number: input.number ?? `KP-${SUFFIX}-${seq}`,
      clientId: input.clientId,
      salesManagerId: input.sellerId,
      status: 'confirmed',
      createdBy: input.actorId,
      confirmedAt: new Date(),
      confirmedBy: input.actorId,
      dealId: input.dealId ?? null,
      ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
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
  const made = await db
    .insert(boxes)
    .values(
      Array.from({ length: n }, (_, i) => ({
        lotId: lot!.id,
        shortCode: `KP${SUFFIX}-${seq}-${i + 1}`,
        seqInLot: i + 1,
        status: 'in_stock',
        currentWarehouseId: wh!.id,
      })),
    )
    .returning({ id: boxes.id });
  return { receiptId: receipt!.id, lotId: lot!.id, boxIds: made.map((b) => b.id) };
}

/** Takes the prixods `receiveStamped` made back out, cartons and lots first. */
export async function removeStamped(receiptIds: string[]): Promise<void> {
  if (receiptIds.length === 0) return;
  const lots = await db
    .select({ id: receiptLots.id })
    .from(receiptLots)
    .where(inArray(receiptLots.receiptId, receiptIds));
  if (lots.length > 0) {
    await db.delete(boxes).where(
      inArray(
        boxes.lotId,
        lots.map((l) => l.id),
      ),
    );
  }
  await db.delete(receiptLots).where(inArray(receiptLots.receiptId, receiptIds));
  await db.delete(receipts).where(inArray(receipts.id, receiptIds));
}
