import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { db, pgClient } from '@/modules/platform/db/client';
import { batches, boxes, receiptLots, receipts, users, warehouses } from '@/modules/platform/db/schema';
import { transitTrucks } from '@/modules/wms/inventory/service';

/**
 * Round 100 (5A): the «Yo'lda» strip on /stock.
 *
 * The strip's scope is the batch's TWO ends — a truck belongs to its origin
 * until it arrives, and both warehouses have a reason to see it — and its
 * numbers are the SHARE of each lot riding on it. The fixture is raw rows on
 * purpose: the strip reads tables, and the services that write them are
 * proven elsewhere.
 */

const SUFFIX = String(Date.now()).slice(-6);
let originId = '';
let destId = '';
let thirdId = '';
let batchId = '';
let emptyBatchId = '';
const madeReceipts: string[] = [];

async function ensureWarehouse(code: string): Promise<string> {
  const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
  if (existing) return existing.id;
  const [row] = await db
    .insert(warehouses)
    .values({ code, name: `5A ${code}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: code })
    .returning();
  return row!.id;
}

beforeAll(async () => {
  originId = await ensureWarehouse('R5AO');
  destId = await ensureWarehouse('R5AD');
  thirdId = await ensureWarehouse('R5AX');
  const actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;

  const receiptId = uuidv4();
  await db.insert(receipts).values({
    id: receiptId,
    warehouseId: originId,
    status: 'confirmed',
    confirmedAt: new Date(),
    createdBy: actorId,
  });
  madeReceipts.push(receiptId);
  const lotId = uuidv4();
  // 10 boxes, 100 kg, 2 m³ — the SHARE of 4 riding boxes is 40 kg / 0.8 m³.
  await db.insert(receiptLots).values({
    id: lotId,
    receiptId,
    seq: 1,
    letter: 'A',
    productNameZh: '在途货',
    boxCount: 10,
    dimsMode: 'mixed',
    totalWeightKg: '100',
    totalVolumeM3: '2',
  });

  const [batch] = await db
    .insert(batches)
    .values({
      code: `R5A-${SUFFIX}`,
      originWarehouseId: originId,
      destWarehouseId: destId,
      status: 'in_transit',
      departedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  batchId = batch!.id;
  // A truck whose boxes have ALL been unloaded already: it must not render
  // as an empty card.
  const [empty] = await db
    .insert(batches)
    .values({
      code: `R5AE-${SUFFIX}`,
      originWarehouseId: originId,
      destWarehouseId: destId,
      status: 'in_transit',
      departedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  emptyBatchId = empty!.id;

  await db.insert(boxes).values(
    Array.from({ length: 4 }, (_, i) => ({
      lotId,
      shortCode: `R5A${SUFFIX}-${i}`,
      seqInLot: i + 1,
      status: 'in_transit',
      currentBatchId: batchId,
    })),
  );
});

afterAll(async () => {
  await db.delete(boxes).where(inArray(boxes.currentBatchId, [batchId, emptyBatchId]));
  await db.delete(batches).where(inArray(batches.id, [batchId, emptyBatchId]));
  await db.delete(receiptLots).where(inArray(receiptLots.receiptId, madeReceipts));
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  await pgClient.end();
});

const unscoped = { warehouseScoped: false, warehouseIds: [] as string[] };

describe('the Yo‘lda strip', () => {
  it('names the truck with its share of kilos and cubes, and drops the empty one', async () => {
    const rows = await transitTrucks(unscoped);
    const truck = rows.find((r) => r.id === batchId);
    expect(truck).toBeTruthy();
    expect(truck!.boxCount).toBe(4);
    expect(truck!.kg).toBe(40);
    expect(truck!.m3).toBeCloseTo(0.8, 2);
    // A truck with nothing left on it is nothing to announce.
    expect(rows.find((r) => r.id === emptyBatchId)).toBeUndefined();
  });

  it('both ends see it; a third warehouse does not', async () => {
    const fromOrigin = await transitTrucks({ warehouseScoped: true, warehouseIds: [originId] });
    const fromDest = await transitTrucks({ warehouseScoped: true, warehouseIds: [destId] });
    const fromThird = await transitTrucks({ warehouseScoped: true, warehouseIds: [thirdId] });
    expect(fromOrigin.map((r) => r.id)).toContain(batchId);
    expect(fromDest.map((r) => r.id)).toContain(batchId);
    expect(fromThird.map((r) => r.id)).not.toContain(batchId);
  });

  it('the wh filter matches EITHER end — origin screen and destination screen agree', async () => {
    const byOrigin = await transitTrucks(unscoped, originId);
    const byDest = await transitTrucks(unscoped, destId);
    const byThird = await transitTrucks(unscoped, thirdId);
    expect(byOrigin.map((r) => r.id)).toContain(batchId);
    expect(byDest.map((r) => r.id)).toContain(batchId);
    expect(byThird.map((r) => r.id)).not.toContain(batchId);
  });
});
