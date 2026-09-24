import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxMovements,
  boxes,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  events,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recomputeAll } from '@/modules/wms/costing/service';

/**
 * The receive wizard's «extra cost» (the audit's G10, 2026-09-24): it was
 * inserted inside the receipt's transaction with no dollar figure and no
 * allocation, and nothing afterwards ever converted it — a USD rate is never
 * saved, so the FX trigger never fired for USD. The receipt card said «kurs
 * yo'q» and every tannarx read $0 of it, for ever.
 */

const S = String(Date.now()).slice(-7);
let actorId: string;
let warehouseId: string;
let clientId: string;
let costTypeId: string;
const madeReceipts: string[] = [];
const ctx = () => ({ actorId });

async function receive(extraUsd: number) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `g10/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: `货${S}`,
          boxCount: 2,
          dimsMode: 'mixed',
          totalWeightKg: 20,
          totalVolumeM3: 0.2,
        },
      ],
      extraCosts: [{ costTypeId, amount: extraUsd, currency: 'USD', note: '' }],
    } as Parameters<typeof confirmReceipt>[0],
    ctx(),
  );
  madeReceipts.push(receiptId);
  return receiptId;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  warehouseId = (await db.select({ id: warehouses.id }).from(warehouses).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `XC${S}`, name: `Extra cost ${S}` })
      .returning({ id: clients.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(costEntries).where(inArray(costEntries.receiptId, madeReceipts));
  const lots = await db
    .select({ id: receiptLots.id })
    .from(receiptLots)
    .where(inArray(receiptLots.receiptId, madeReceipts));
  const lotIds = lots.map((lot) => lot.id);
  if (lotIds.length) {
    const made = await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds));
    if (made.length) {
      await db.delete(boxMovements).where(inArray(boxMovements.boxId, made.map((box) => box.id)));
    }
    await db.delete(boxes).where(inArray(boxes.lotId, lotIds));
    await db.delete(attachments).where(inArray(attachments.entityId, lotIds));
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  }
  await db.delete(events).where(inArray(events.entityId, madeReceipts));
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

describe("the receive wizard's extra cost", () => {
  it('is converted and allocated the moment the receipt commits', async () => {
    const receiptId = await receive(12);
    const [entry] = await db.select().from(costEntries).where(eq(costEntries.receiptId, receiptId));
    expect(entry!.amountUsd).toBe('12.00');
    const shares = await db
      .select()
      .from(costAllocations)
      .where(eq(costAllocations.costEntryId, entry!.id));
    expect(shares.reduce((sum, row) => sum + Number(row.amountUsd), 0)).toBeCloseTo(12, 2);
  });

  it('an old unconverted one is repaired by the nightly sweep', async () => {
    const receiptId = await receive(7);
    // The state production holds for every wizard cost before this round.
    const [entry] = await db.select().from(costEntries).where(eq(costEntries.receiptId, receiptId));
    await db.update(costEntries).set({ amountUsd: null, fxRateUsed: null }).where(eq(costEntries.id, entry!.id));
    await db.delete(costAllocations).where(eq(costAllocations.costEntryId, entry!.id));

    await recomputeAll({ unconverted: true });

    const [after] = await db.select().from(costEntries).where(eq(costEntries.id, entry!.id));
    expect(after!.amountUsd).toBe('7.00');
  });
});
