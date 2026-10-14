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
 * The receive wizard's «extra cost». The audit's G10 (2026-09-24) found it
 * inserted with no dollar figure and never converted; #1045 took the money
 * input off the wizard; and SARFLAR §8.2 CLOSED the door, because a
 * hand-built post was the last way to write a cargo cost past the cost door
 * (its grant, its payer rules, the truck lock and the twin warning). What
 * stays is the nightly sweep that repairs the old rows production still holds.
 */

const S = String(Date.now()).slice(-7);
let actorId: string;
let warehouseId: string;
let clientId: string;
let costTypeId: string;
const madeReceipts: string[] = [];
const ctx = () => ({ actorId });

/** A receipt; `extraUsd > 0` posts the retired extra cost with it. */
async function receive(extraUsd: number, receiptId = uuidv4()) {
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
      extraCosts: extraUsd > 0 ? [{ costTypeId, amount: extraUsd, currency: 'USD', note: '' }] : [],
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
  it('is REFUSED, and nothing — not the receipt, not a cost — is written', async () => {
    const receiptId = uuidv4();
    await expect(receive(12, receiptId)).rejects.toMatchObject({ code: 'extra_costs_retired' });
    expect(await db.select().from(receipts).where(eq(receipts.id, receiptId))).toEqual([]);
    expect(await db.select().from(costEntries).where(eq(costEntries.receiptId, receiptId))).toEqual([]);
  });

  it('an old unconverted one is repaired by the nightly sweep', async () => {
    const receiptId = await receive(0);
    // The row production holds from before #1045: written inside the receipt,
    // no dollars, no shares.
    const [entry] = await db
      .insert(costEntries)
      .values({
        scope: 'receipt',
        receiptId,
        costTypeId,
        amount: '7',
        currency: 'USD',
        costDate: '2026-09-20',
        enteredBy: actorId,
      })
      .returning();

    await recomputeAll({ unconverted: true });

    const [after] = await db.select().from(costEntries).where(eq(costEntries.id, entry!.id));
    expect(after!.amountUsd).toBe('7.00');
    const shares = await db.select().from(costAllocations).where(eq(costAllocations.costEntryId, entry!.id));
    expect(shares.reduce((sum, row) => sum + Number(row.amountUsd), 0)).toBeCloseTo(7, 2);
  });
});
