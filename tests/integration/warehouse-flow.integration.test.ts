import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  clients,
  expectedArrivals,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { warehouseFlowCounts } from '@/modules/wms/home/flow';

/**
 * The numbers on a skladchi's home screen.
 *
 * What only a real database can prove: that each count reads ITS side of the
 * warehouse — a truck counts at its destination, a forming batch at its
 * origin — and that the three-answer scope rule holds. The dangerous failure
 * is the quiet one: a scoped operator with no warehouse seeing the whole
 * company's numbers, which is exactly the bug `rbac/scope.ts` exists to end.
 */

const STAMP = Date.now();
const TODAY = new Date().toISOString().slice(0, 10);

let cnId: string; // origin side — loads trucks
let uzId: string; // destination side — receives them, issues to clients
let actorId: string;
let clientId: string;
let receiptId: string;
let lotId: string;
const batchIds: string[] = [];
const arrivalIds: string[] = [];

const scopedTo = (ids: string[]) => ({ warehouseScoped: true, warehouseIds: ids });

beforeAll(async () => {
  async function ensureWarehouse(code: string): Promise<string> {
    const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    if (existing) return existing.id;
    const [wh] = await db
      .insert(warehouses)
      .values({ code, name: `Flow ${code}`, country: 'UZ', type: 'origin', timezone: 'Asia/Tashkent', batchPrefix: code })
      .returning();
    return wh!.id;
  }
  cnId = await ensureWarehouse('FLWCN');
  uzId = await ensureWarehouse('FLWUZ');
  actorId = (await db.select().from(users).limit(1))[0]!.id;

  const [c] = await db
    .insert(clients)
    .values({ clientCode: `FL${STAMP}`.slice(0, 12), name: `Flow ${STAMP}`, phones: [] })
    .returning({ id: clients.id });
  clientId = c!.id;

  // Promises to the UZ warehouse: one still ahead, one already late, and one
  // cancelled — which must count as nothing at all.
  const arrivals = await db
    .insert(expectedArrivals)
    .values([
      { warehouseId: uzId, clientId, expectedOn: null, status: 'waiting', createdBy: actorId },
      { warehouseId: uzId, clientId, expectedOn: '2020-01-01', status: 'waiting', createdBy: actorId },
      { warehouseId: uzId, clientId, expectedOn: '2020-01-01', status: 'cancelled', cancelReason: 'x', createdBy: actorId },
    ])
    .returning({ id: expectedArrivals.id });
  arrivalIds.push(...arrivals.map((a) => a.id));

  // A batch being formed at CN, one on the road to UZ, one long finished.
  const rows = await db
    .insert(batches)
    .values([
      { code: `FLW-${STAMP}-F`, originWarehouseId: cnId, destWarehouseId: uzId, status: 'forming', createdBy: actorId },
      { code: `FLW-${STAMP}-T`, originWarehouseId: cnId, destWarehouseId: uzId, status: 'in_transit', createdBy: actorId },
      { code: `FLW-${STAMP}-U`, originWarehouseId: cnId, destWarehouseId: uzId, status: 'unloaded', createdBy: actorId },
    ])
    .returning({ id: batches.id });
  batchIds.push(...rows.map((r) => r.id));

  // Two boxes at UZ: one a client could collect, one still plain stock.
  const [r] = await db
    .insert(receipts)
    .values({ warehouseId: cnId, clientId, status: 'confirmed', createdBy: actorId })
    .returning({ id: receipts.id });
  receiptId = r!.id;
  const [lot] = await db
    .insert(receiptLots)
    .values({ receiptId, seq: 1, productNameZh: '测试', boxCount: 2, totalWeightKg: '10', totalVolumeM3: '0.1' })
    .returning({ id: receiptLots.id });
  lotId = lot!.id;
  await db.insert(boxes).values([
    { lotId, shortCode: `FLW${STAMP}1`, seqInLot: 1, status: 'ready_for_pickup', currentWarehouseId: uzId },
    { lotId, shortCode: `FLW${STAMP}2`, seqInLot: 2, status: 'in_stock', currentWarehouseId: uzId },
  ]);
});

afterAll(async () => {
  await db.delete(boxes).where(eq(boxes.lotId, lotId));
  await db.delete(receiptLots).where(eq(receiptLots.id, lotId));
  await db.delete(receipts).where(eq(receipts.id, receiptId));
  await db.delete(batches).where(inArray(batches.id, batchIds));
  await db.delete(expectedArrivals).where(inArray(expectedArrivals.id, arrivalIds));
  await db.delete(clients).where(eq(clients.id, clientId));
  // The e2e suite runs on this same database (CI seeds once); an extra ACTIVE
  // warehouse would appear in its dropdowns, and configuration left behind is
  // worse than data (#183).
  await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [cnId, uzId]));
  await pgClient.end();
});

describe('each count reads its own side of the road', () => {
  it('the destination sees the truck, the promises, and the ready boxes', async () => {
    const flow = await warehouseFlowCounts(scopedTo([uzId]), TODAY);
    expect(flow).toEqual({
      trucksIncoming: 1,
      expectedWaiting: 2,
      expectedLate: 1,
      loadingBatches: 0,
      readyBoxes: 1,
    });
  });

  it('the origin sees only what it is loading', async () => {
    const flow = await warehouseFlowCounts(scopedTo([cnId]), TODAY);
    expect(flow).toEqual({
      trucksIncoming: 0,
      expectedWaiting: 0,
      expectedLate: 0,
      loadingBatches: 1,
      readyBoxes: 0,
    });
  });
});

describe('the scope rule', () => {
  it('scoped with no warehouse means zeros, never everything', async () => {
    const flow = await warehouseFlowCounts(scopedTo([]), TODAY);
    expect(flow).toEqual({
      trucksIncoming: 0,
      expectedWaiting: 0,
      expectedLate: 0,
      loadingBatches: 0,
      readyBoxes: 0,
    });
  });

  it('an unscoped viewer sees at least both sides together', async () => {
    // The shared database may hold other fixtures, so ≥, not equality.
    const flow = await warehouseFlowCounts({ warehouseScoped: false, warehouseIds: [] }, TODAY);
    expect(flow.trucksIncoming).toBeGreaterThanOrEqual(1);
    expect(flow.expectedWaiting).toBeGreaterThanOrEqual(2);
    expect(flow.loadingBatches).toBeGreaterThanOrEqual(1);
    expect(flow.readyBoxes).toBeGreaterThanOrEqual(1);
  });
});
