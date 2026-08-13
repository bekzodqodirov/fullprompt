import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, batches, boxes, clients, users, warehouses } from '@/modules/platform/db/schema';
import { confirmReceipt, voidReceipt } from '@/modules/wms/receipts/service';
import { cargoOverview } from '@/modules/wms/client-cabinet/service';
import { nextBatchCode } from '@/modules/wms/codes';

/**
 * Round 98: «yuk qaysi etapdaligini korsin … yolga chiqgandan keyin necha
 * kunda tahminiy yetib kelish bor shunga asoslanib timline yurishi kerak».
 *
 * The rungs themselves are a pure table (`tests/unit/cargo-stages.test.ts`);
 * what this file proves is the wiring — that `cargoOverview` reads the box's
 * PLACE and its TRUCK, and that a date only ever appears when the schedule can
 * support one.
 *
 * It runs on the seeded Kashgar → Andijan pair on purpose: that is a route
 * `map-data.ts` knows, and it is the only way to see a real estimate come out
 * the other end.
 */

let actorId: string;
let clientId: string;
let hubId: string;
let receiptId: string;
let lotId: string;
let batchId: string;

async function stageOf() {
  const lots = await cargoOverview(clientId);
  return lots.find((l) => l.lotId === lotId)!;
}

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const hub = await db.query.warehouses.findFirst({ where: eq(warehouses.code, 'KA') });
  const dest = await db.query.warehouses.findFirst({ where: eq(warehouses.code, 'AND') });
  hubId = hub!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `TL${String(Date.now()).slice(-6)}`, name: 'Timeline client' })
    .returning();
  clientId = c!.id;

  receiptId = uuidv4();
  lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `tltest/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId: hubId,
      clientId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '样品',
          boxCount: 2,
          dimsMode: 'uniform',
          boxLengthCm: 30,
          boxWidthCm: 30,
          boxHeightCm: 30,
          boxWeightKg: 5,
        },
      ],
      extraCosts: [],
    },
    { actorId },
  );

  const [b] = await db
    .insert(batches)
    .values({
      code: await nextBatchCode(db, hub!),
      originWarehouseId: hubId,
      destWarehouseId: dest!.id,
      type: 'export',
      status: 'in_transit',
      departedAt: new Date(Date.now() - 24 * 3_600_000),
      createdBy: actorId,
    })
    .returning();
  batchId = b!.id;
});

afterAll(async () => {
  await pgClient.end();
});

describe('the cabinet timeline', () => {
  it('cargo standing at the border hub is on the hub rung, with no date', async () => {
    const lot = await stageOf();
    expect(lot.groups).toHaveLength(1);
    expect(lot.groups[0]!.stage).toBe('hub');
    // A road bar beside «skladda» would be a promise about a truck that has
    // not left yet.
    expect(lot.groups[0]!.transit).toBeNull();
  });

  it('once it is on the export truck it carries the schedule’s own estimate', async () => {
    await db
      .update(boxes)
      .set({ status: 'in_transit', currentBatchId: batchId, currentWarehouseId: null })
      .where(eq(boxes.lotId, lotId));
    // The departure movement the real `departBatch` writes — this fixture
    // fakes the departure by hand, and the journey reads the LEDGER, not the
    // live pointer.
    const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId));
    const dest = await db.query.warehouses.findFirst({ where: eq(warehouses.code, 'AND') });
    await db.execute(sql`
      INSERT INTO box_movements (box_id, from_warehouse_id, to_warehouse_id, from_status, to_status, cause, ref_type, ref_id, actor_id)
      SELECT b.id, ${hubId}::uuid, ${dest!.id}::uuid, 'in_stock', 'in_transit', 'batch_departed', 'batch', ${batchId}::uuid, ${actorId}::uuid
      FROM boxes b WHERE b.lot_id = ${lotId}
    `);
    expect(rows.length).toBeGreaterThan(0);

    const lot = await stageOf();
    expect(lot.groups[0]!.stage).toBe('export_transit');
    const road = lot.groups[0]!.transit!;
    expect(road).not.toBeNull();
    // The road's two ends by NAME: «Kashgar → Andijan» — a date or a percent
    // with no place cannot be misread, and the truck is never named.
    expect(road.fromPlace).toBe('Kashgar');
    expect(road.toPlace).toBe('Andijan');
    // A day into a 3-6 day road: some of it behind, not all of it.
    expect(road.progress).toBeGreaterThan(0.05);
    expect(road.progress).toBeLessThan(0.95);
    expect(new Date(road.etaFromIso!).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(road.etaToIso!).getTime()).toBeGreaterThanOrEqual(
      new Date(road.etaFromIso!).getTime(),
    );
  });

  it('the operator’s «in Uzbekistan» pin moves the rung and drops the date', async () => {
    await db
      .update(batches)
      .set({ trackingCheckpoint: { key: 'in_uz', at: new Date().toISOString() } })
      .where(eq(batches.id, batchId));

    const lot = await stageOf();
    expect(lot.groups[0]!.stage).toBe('in_uz');
    // Standing still again — the road bar belongs to the road, not to the
    // paperwork, and nothing here can say when a declaration clears.
    expect(lot.groups[0]!.transit).toBeNull();
  });

  it('«rastamojka tugadi» moves the rung, and clearing it takes the rung back', async () => {
    // The button's own action needs a request scope (it calls `authorize`),
    // so the two halves are proven separately: the STAMP's effect here, and
    // that the button really writes this column in
    // `tests/unit/customs-cleared-wire.test.ts` (#531's rule — a
    // service-level test of a form-fed path proves the service, not the
    // system).
    await db
      .update(batches)
      .set({ customsClearedAt: new Date() })
      .where(eq(batches.id, batchId));
    expect((await stageOf()).groups[0]!.stage).toBe('customs_done');

    // A person who marked the wrong truck must be able to say so, and NULL
    // reads as «nobody has said» rather than «not cleared».
    await db.update(batches).set({ customsClearedAt: null }).where(eq(batches.id, batchId));
    expect((await stageOf()).groups[0]!.stage).toBe('in_uz');
  });

  it('the history reads down the road with real dates', async () => {
    // Everything above walked this lot Kashgar → export → in-UZ; the journey
    // must have picked those up from the movements and the truck's own facts.
    const lot = await stageOf();
    const keys = lot.journey.map((s) => s.key);
    // The receipt's movement + the export departure + entering Uzbekistan
    // (the pin) — in ladder order whatever order they were written.
    expect(keys).toEqual(['received', 'export', 'inUz']);
    const dates = lot.journey.map((s) => new Date(s.atIso).getTime());
    expect(dates[0]).toBeLessThanOrEqual(dates[1]!);
  });

  it('a split lot reports both rungs, biggest first', async () => {
    const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId));
    // One box unloaded at Andijan, one still on the truck.
    await db
      .update(boxes)
      .set({ status: 'ready_for_pickup', currentBatchId: null, currentWarehouseId: hubId })
      .where(eq(boxes.id, rows[0]!.id));

    const lot = await stageOf();
    expect(lot.groups.map((g) => g.stage).sort()).toEqual(['in_uz', 'ready']);
    expect(lot.groups.every((g) => g.n === 1)).toBe(true);
  });

  /**
   * Cleanup is a final TEST, not an `afterAll` (round 57's lie): this file
   * puts cargo into the SEEDED Kashgar warehouse, which every browser spec
   * afterwards reads as stock (#154).
   */
  it('leaves nothing of its own behind', async () => {
    await db
      .update(boxes)
      .set({ status: 'in_stock', currentBatchId: null, currentWarehouseId: hubId })
      .where(eq(boxes.lotId, lotId));
    await voidReceipt(receiptId, 'timeline test cleanup', { actorId });
    await db.execute(sql`DELETE FROM box_movements WHERE ref_type = 'batch' AND ref_id = ${batchId}`);
    await db.delete(batches).where(eq(batches.id, batchId));

    expect(await cargoOverview(clientId)).toHaveLength(0);
    expect(await db.select().from(batches).where(eq(batches.id, batchId))).toHaveLength(0);
  });
});
