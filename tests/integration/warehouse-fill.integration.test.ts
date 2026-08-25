import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  boxes,
  boxMovements,
  clients,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { warehouseFill } from '@/modules/wms/reports/queries';

/**
 * «Qaysi sklad qanchalik to'lgan va yuk necha kun qolib ketgan» (owner,
 * 2026-08-25).
 *
 * The two rules that are easy to get wrong and expensive when they are: a
 * warehouse with no capacity typed in is a row with NO bar (all nine of his
 * are, today), and the age is measured from the movement that LANDED the box
 * — approving a plan or packing a crate writes the same warehouse on both
 * sides of a movement and must not read as a fresh arrival.
 */
const STAMP = String(Date.now()).slice(-6);
let actorId = '';
let whFull = '';
let whNoCapacity = '';
let whEmpty = '';
let clientId = '';
const madeReceipts: string[] = [];

async function mintWarehouse(code: string, capacity: string | null) {
  const [row] = await db
    .insert(warehouses)
    .values({
      code,
      name: `WF ${code}`,
      country: 'UZ',
      type: 'customs',
      timezone: 'Asia/Tashkent',
      batchPrefix: code,
      capacityM3: capacity,
    })
    .returning();
  return row!.id;
}

/** A box standing at `warehouseId`, landed `daysAgo` days ago. */
async function standingBox(warehouseId: string, tag: string, daysAgo: number, m3: string) {
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
      totalVolumeM3: m3,
    })
    .returning();
  const [box] = await db
    .insert(boxes)
    .values({
      lotId: lot!.id,
      shortCode: `WF${STAMP}-${tag}`,
      seqInLot: 1,
      status: 'ready_for_pickup',
      currentWarehouseId: warehouseId,
    })
    .returning();
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  // The arrival: a receipt writes a movement with a NULL from-warehouse, which
  // is why no `confirmed_at` fallback is needed anywhere.
  await db.insert(boxMovements).values({
    boxId: box!.id,
    fromWarehouseId: null,
    toWarehouseId: warehouseId,
    fromStatus: null,
    toStatus: 'ready_for_pickup',
    cause: 'receipt',
    refType: 'receipt',
    refId: receipt!.id,
    actorId,
    createdAt: at,
  });
  return box!;
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({
      phone: `+99892${STAMP}1`,
      fullName: `WF ${STAMP}`,
      passwordHash: 'x',
      active: true,
    })
    .returning();
  actorId = u!.id;
  whFull = await mintWarehouse(`WFA${STAMP}`.slice(0, 8), '10');
  whNoCapacity = await mintWarehouse(`WFB${STAMP}`.slice(0, 8), null);
  whEmpty = await mintWarehouse(`WFC${STAMP}`.slice(0, 8), '50');
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `WF${STAMP}`.slice(0, 10), name: `WF ${STAMP}` })
    .returning();
  clientId = client!.id;

  await standingBox(whFull, 'a', 40, '3');
  const old = await standingBox(whFull, 'b', 120, '2');
  await standingBox(whNoCapacity, 'c', 5, '1.5');

  // The trap: approving a plan writes the box's OWN warehouse on both sides.
  // A clock that only asks `to_warehouse_id` reads this as an arrival today
  // and the 120-day carton reports «0 kun» — on exactly the cargo somebody is
  // arguing about.
  await db.insert(boxMovements).values({
    boxId: old.id,
    fromWarehouseId: whFull,
    toWarehouseId: whFull,
    fromStatus: 'ready_for_pickup',
    toStatus: 'planned',
    cause: 'plan_approved',
    refType: 'plan',
    actorId,
  });
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
      await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
      await db.delete(boxes).where(inArray(boxes.id, boxIds));
    }
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  }
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db
    .update(warehouses)
    .set({ active: false })
    .where(inArray(warehouses.id, [whFull, whNoCapacity, whEmpty]));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('warehouseFill', () => {
  it('measures the age from the LANDING, not from the newest movement', async () => {
    const rows = await warehouseFill([whFull, whNoCapacity, whEmpty], 30);
    const full = rows.find((r) => r.id === whFull)!;
    // 120 days, not 0 — the plan approval this morning is not an arrival.
    expect(full.oldestDays).toBeGreaterThanOrEqual(119);
    // Both cartons are past the 30-day threshold; one number alone is a dead
    // signal, so the count travels with it.
    expect(full.staleCount).toBe(2);
    expect(full.occupiedM3).toBe(5);
    expect(full.pct).toBe(50);
  });

  it('a warehouse with no capacity is a row with NO bar, never a fake 100%', async () => {
    const rows = await warehouseFill([whFull, whNoCapacity, whEmpty], 30);
    const none = rows.find((r) => r.id === whNoCapacity)!;
    expect(none.capacityM3).toBeNull();
    expect(none.pct).toBeNull();
    // It still reports what is standing there and how long it has been.
    expect(none.occupiedM3).toBe(1.5);
    expect(none.oldestDays).toBeGreaterThanOrEqual(4);
    expect(none.staleCount).toBe(0);
  });

  it('an EMPTY warehouse still appears — «bo‘sh» and «broken» must not look alike', async () => {
    const rows = await warehouseFill([whFull, whNoCapacity, whEmpty], 30);
    const empty = rows.find((r) => r.id === whEmpty)!;
    expect(empty.occupiedM3).toBe(0);
    expect(empty.pct).toBe(0);
    expect(empty.oldestDays).toBeNull();
  });
});
