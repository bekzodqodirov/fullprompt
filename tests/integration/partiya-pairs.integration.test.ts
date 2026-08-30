import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { arrivalCodesForPairs } from '@/modules/wms/documents/arrivals';

/**
 * «Sklad ostatkani ko'rganda … yuk qaysi partiyada kelganini ko'rish» (owner,
 * 2026-08-29). The RULE is round 92's and is proven by the agent-sheet suite;
 * what this file pins is the PAIRS wrapper the stock table needs: a lot
 * standing in two warehouses arrived on two different answers, and the map is
 * keyed on the pair — grouped per warehouse, one arrivals query each, never
 * one per row.
 */
const STAMP = String(Date.now()).slice(-6);
let actorId = '';
let whA = '';
let whB = '';
let clientId = '';
let batchId = '';
let lotId = '';
let walkedLotId = '';
const boxIds: string[] = [];
const madeReceipts: string[] = [];

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99896${STAMP}1`, fullName: `PP ${STAMP}`, passwordHash: 'x', active: true })
    .returning();
  actorId = u!.id;
  const wh = async (code: string, type: string, country: string) => {
    const [row] = await db
      .insert(warehouses)
      .values({ code, name: `PP ${code}`, country, type, timezone: 'Asia/Tashkent', batchPrefix: code })
      .returning();
    return row!.id;
  };
  whA = await wh(`PPA${STAMP}`.slice(0, 8), 'origin', 'CN');
  whB = await wh(`PPB${STAMP}`.slice(0, 8), 'hub', 'CN');
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `PP${STAMP}`.slice(0, 10), name: `PP ${STAMP}` })
    .returning();
  clientId = client!.id;
  const [batch] = await db
    .insert(batches)
    .values({
      code: `PPB${STAMP}`,
      originWarehouseId: whA,
      destWarehouseId: whB,
      status: 'unloaded',
      departedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  batchId = batch!.id;

  const mkLot = async (n: number) => {
    const [receipt] = await db
      .insert(receipts)
      .values({ warehouseId: whA, clientId, status: 'confirmed', confirmedAt: new Date(), createdBy: actorId })
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
        boxCount: n,
        totalWeightKg: String(n * 10),
        totalVolumeM3: String(n * 0.3),
      })
      .returning();
    return lot!.id;
  };
  lotId = await mkLot(2);
  walkedLotId = await mkLot(1);

  // The split lot: one box still standing at A where it was RECEIVED (a
  // receipt movement, no truck), one trucked to B and unloaded there.
  const mkBox = async (lot: string, tag: string, wh: string) => {
    const [b] = await db
      .insert(boxes)
      .values({ lotId: lot, shortCode: `PP${STAMP}-${tag}`, seqInLot: tag.length, status: 'in_stock', currentWarehouseId: wh })
      .returning();
    boxIds.push(b!.id);
    return b!.id;
  };
  const stayed = await mkBox(lotId, 'a', whA);
  const rode = await mkBox(lotId, 'ab', whB);
  const walked = await mkBox(walkedLotId, 'w', whA);
  await db.insert(boxMovements).values([
    // Receipts land with a NULL from-warehouse.
    { boxId: stayed, fromWarehouseId: null, toWarehouseId: whA, fromStatus: null, toStatus: 'in_stock', cause: 'receipt', refType: 'receipt', refId: madeReceipts[0]!, actorId },
    { boxId: rode, fromWarehouseId: null, toWarehouseId: whA, fromStatus: null, toStatus: 'in_stock', cause: 'receipt', refType: 'receipt', refId: madeReceipts[0]!, actorId },
    { boxId: walked, fromWarehouseId: null, toWarehouseId: whA, fromStatus: null, toStatus: 'in_stock', cause: 'receipt', refType: 'receipt', refId: madeReceipts[1]!, actorId },
    { boxId: rode, fromWarehouseId: whA, toWarehouseId: whB, fromStatus: 'loading', toStatus: 'in_transit', cause: 'batch_departed', refType: 'batch', refId: batchId, actorId },
    { boxId: rode, fromWarehouseId: whA, toWarehouseId: whB, fromStatus: 'in_transit', toStatus: 'in_stock', cause: 'unload_scan', refType: 'batch', refId: batchId, actorId },
  ]);
});

afterAll(async () => {
  await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
  await db.delete(boxes).where(inArray(boxes.id, boxIds));
  await db.delete(receiptLots).where(inArray(receiptLots.receiptId, madeReceipts));
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  await db.delete(batches).where(eq(batches.id, batchId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [whA, whB]));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('arrivalCodesForPairs', () => {
  it('one lot, two warehouses, two different answers — keyed on the pair', async () => {
    const map = await arrivalCodesForPairs([
      { lotId, warehouseId: whA },
      { lotId, warehouseId: whB },
      { lotId: walkedLotId, warehouseId: whA },
    ]);
    // At B the lot ARRIVED on the truck; at A it was received on none — the
    // same lot, and a wrapper that mixes the warehouses up prints the truck
    // on the shelf it never left.
    expect(map.get(`${lotId}|${whB}`)).toEqual([`PPB${STAMP}`]);
    expect(map.get(`${lotId}|${whA}`)?.length ?? 0).toBe(0);
    expect(map.get(`${walkedLotId}|${whA}`)?.length ?? 0).toBe(0);
  });
});
