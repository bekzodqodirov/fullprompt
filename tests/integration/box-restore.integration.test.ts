import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  events,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { setBoxStatus } from '@/modules/wms/boxes/status';

/**
 * The one way back from `lost` — the undo behind every write-off in the
 * system (the stocktake's tick-list, the receipt card's fold, the bin scan).
 *
 * The corrections round's review found it shipping three ways to lie, and
 * these are the three: it landed a blanket `in_stock` at warehouses that
 * issue to clients, it asked nothing about the receipt, and it left the box
 * pointing at the truck it went missing from.
 */
const STAMP = String(Date.now()).slice(-6);
let actorId = '';
let whCustoms = '';
let whOrigin = '';
let clientId = '';
const madeReceipts: string[] = [];
const madeBatches: string[] = [];

async function mintWarehouse(code: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({
      code,
      name: `BR ${code}`,
      country: type === 'origin' ? 'CN' : 'UZ',
      type,
      timezone: 'Asia/Tashkent',
      batchPrefix: code,
    })
    .returning();
  return row!.id;
}

async function mintBox(warehouseId: string, tag: string) {
  const [receipt] = await db
    .insert(receipts)
    .values({
      warehouseId,
      clientId,
      status: 'confirmed',
      confirmedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  madeReceipts.push(receipt!.id);
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: receipt!.id,
      seq: 1,
      letter: 'A',
      dimsMode: 'mixed',
      productNameZh: '测试',
      boxCount: 1,
      totalWeightKg: '10',
      totalVolumeM3: '0.2',
    })
    .returning();
  const [box] = await db
    .insert(boxes)
    .values({
      lotId: lot!.id,
      shortCode: `BR${STAMP}-${tag}`,
      seqInLot: 1,
      status: 'in_stock',
      currentWarehouseId: warehouseId,
    })
    .returning();
  return { receiptId: receipt!.id, box: box! };
}

const ctx = () => ({ actorId, ip: null, userAgent: null });

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({
      phone: `+99894${STAMP}1`,
      fullName: `BR manager ${STAMP}`,
      passwordHash: 'x',
      active: true,
    })
    .returning();
  actorId = u!.id;
  whCustoms = await mintWarehouse(`BRC${STAMP}`.slice(0, 8), 'customs');
  whOrigin = await mintWarehouse(`BRO${STAMP}`.slice(0, 8), 'origin');
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `BR${STAMP}`.slice(0, 10), name: `BR ${STAMP}` })
    .returning();
  clientId = client!.id;
});

afterAll(async () => {
  const lotIds = (
    await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(inArray(receiptLots.receiptId, madeReceipts))
  ).map((r) => r.id);
  if (lotIds.length) {
    const boxIds = (
      await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds))
    ).map((b) => b.id);
    if (boxIds.length) {
      await db.delete(events).where(inArray(events.entityId, boxIds));
      await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
      await db.delete(boxes).where(inArray(boxes.id, boxIds));
    }
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  }
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  if (madeBatches.length) await db.delete(batches).where(inArray(batches.id, madeBatches));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db
    .update(warehouses)
    .set({ active: false })
    .where(inArray(warehouses.id, [whCustoms, whOrigin]));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('a written-off box comes back', () => {
  it('lands ready_for_pickup at a warehouse the client collects from', async () => {
    // Every Uzbek destination is customs or distribution. Restoring blanket
    // `in_stock` there means the carton never reaches a «tayyor» list and the
    // customer's cabinet says «O'zbekistonda» for ever.
    const { box } = await mintBox(whCustoms, 'a');
    await setBoxStatus({ boxId: box.id, to: 'lost', reason: `sindi ${STAMP}` }, ctx());
    const res = await setBoxStatus({ boxId: box.id, to: 'in_stock', reason: 'topildi' }, ctx());
    expect(res.to).toBe('ready_for_pickup');
    const after = await db.query.boxes.findFirst({ where: eq(boxes.id, box.id) });
    expect(after?.status).toBe('ready_for_pickup');
    expect(after?.statusReason).toBeNull();
    // …and an ORIGIN warehouse still restores to plain stock.
    const other = await mintBox(whOrigin, 'b');
    await setBoxStatus({ boxId: other.box.id, to: 'lost', reason: 'sindi' }, ctx());
    const res2 = await setBoxStatus(
      { boxId: other.box.id, to: 'in_stock', reason: 'topildi' },
      ctx(),
    );
    expect(res2.to).toBe('in_stock');
  });

  it('refuses to mint live stock on a receipt that was voided meanwhile', async () => {
    const { receiptId, box } = await mintBox(whOrigin, 'c');
    await setBoxStatus({ boxId: box.id, to: 'lost', reason: 'yo‘qoldi' }, ctx());
    // The prixod is voided a week later — `splitForCorrection` leaves a lost
    // box alone, so the void succeeds over it.
    await db
      .update(receipts)
      .set({ status: 'voided', voidedAt: new Date(), voidReason: 'test' })
      .where(eq(receipts.id, receiptId));

    await expect(
      setBoxStatus({ boxId: box.id, to: 'in_stock', reason: 'topildi' }, ctx()),
    ).rejects.toMatchObject({ code: 'receipt_voided' });
    expect((await db.query.boxes.findFirst({ where: eq(boxes.id, box.id) }))?.status).toBe('lost');
  });

  it('lets go of the truck it went missing from', async () => {
    const { box } = await mintBox(whOrigin, 'd');
    const [batch] = await db
      .insert(batches)
      .values({
        code: `BRB${STAMP}`,
        originWarehouseId: whOrigin,
        destWarehouseId: whCustoms,
        status: 'unloaded',
        departedAt: new Date(),
        createdBy: actorId,
      })
      .returning();
    madeBatches.push(batch!.id);
    // The stocktake's own write-off does not clear the pointer, so a box lost
    // while it was on a truck comes back still claiming to be on it.
    await db
      .update(boxes)
      .set({ status: 'lost', currentBatchId: batch!.id, flags: ['missing_in_transit'] })
      .where(eq(boxes.id, box.id));

    await setBoxStatus({ boxId: box.id, to: 'in_stock', reason: 'topildi' }, ctx());
    const after = await db.query.boxes.findFirst({ where: eq(boxes.id, box.id) });
    expect(after?.currentBatchId).toBeNull();
    expect(after?.flags).toEqual([]);
  });
});
