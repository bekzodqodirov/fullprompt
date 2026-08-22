import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxMovements,
  boxes,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { inTransitBatches } from '@/modules/wms/reports/queries';

/**
 * The «in transit» report answers about what DEPARTED, never about the live
 * pointer.
 *
 * Landing NULLs `boxes.current_batch_id` box by box, so the old count
 * drained 180 → 0 while the truck stood half-unloaded at the gate — the
 * report titled «what is on the road» answered zero about the truck that
 * most needed an answer. #440's trap, on its last consumer.
 */

const SUFFIX = randomUUID().slice(0, 8);
let whA: string;
let whB: string;
let batchId: string;
let actorId: string;
const boxIds: string[] = [];
let receiptId: string;
let lotId: string;

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const mk = async (code: string) => {
    const [w] = await db
      .insert(warehouses)
      .values({ code, name: code, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: code })
      .returning({ id: warehouses.id });
    return w!.id;
  };
  whA = await mk(`ZT${SUFFIX.slice(0, 3).toUpperCase()}`);
  whB = await mk(`ZU${SUFFIX.slice(3, 6).toUpperCase()}`);

  const [batch] = await db
    .insert(batches)
    .values({
      code: `ZTB-${SUFFIX}`,
      originWarehouseId: whA,
      destWarehouseId: whB,
      status: 'arrived',
      departedAt: new Date(),
      createdBy: actorId,
    })
    .returning({ id: batches.id });
  batchId = batch!.id;

  receiptId = randomUUID();
  await db.insert(receipts).values({
    id: receiptId,
    number: `ZT-${SUFFIX}`,
    warehouseId: whA,
    status: 'confirmed',
    createdBy: actorId,
  });
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId,
      seq: 1,
      letter: 'A',
      cycleNo: 1,
      productNameZh: '测试',
      boxCount: 2,
      dimsMode: 'uniform',
      totalWeightKg: '10',
      totalVolumeM3: '0.1',
    })
    .returning({ id: receiptLots.id });
  lotId = lot!.id;
  for (let i = 0; i < 2; i += 1) {
    const [box] = await db
      .insert(boxes)
      .values({
        lotId,
        seqInLot: i + 1,
        shortCode: `ZT${SUFFIX}${i}`,
        status: i === 0 ? 'in_stock' : 'in_transit',
        // The first box has LANDED: its live pointer is gone — that is what
        // landing does, and what the old count could not survive.
        currentWarehouseId: i === 0 ? whB : null,
        currentBatchId: i === 0 ? null : batchId,
      })
      .returning({ id: boxes.id });
    boxIds.push(box!.id);
    await db.insert(boxMovements).values({
      boxId: box!.id,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: batchId,
      actorId,
    });
  }
});

afterAll(async () => {
  await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
  await db.delete(boxes).where(inArray(boxes.id, boxIds));
  await db.delete(receiptLots).where(eq(receiptLots.id, lotId));
  await db.delete(receipts).where(eq(receipts.id, receiptId));
  await db.delete(batches).where(eq(batches.id, batchId));
  await db.delete(warehouses).where(inArray(warehouses.id, [whA, whB]));
  await pgClient.end();
});

describe('the in-transit report', () => {
  it('a half-unloaded truck still reports everything it carried', async () => {
    const rows = await inTransitBatches([whA]);
    const row = rows.find((r) => r.id === batchId);
    expect(row, 'the arrived-but-open batch is on the report').toBeTruthy();
    // One box landed (pointer gone), one still on board — the truck carried 2.
    expect(row!.boxCount).toBe(2);
  });
});
