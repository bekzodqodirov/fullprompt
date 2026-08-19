import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxMovements,
  boxes,
  clients,
  crates,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { batchCrates } from '@/modules/wms/inventory/service';

/**
 * The crates riding a truck (round 109, the owner's item 2: «mashina
 * spiskasida ham tahta yashikni mestasi kubi kg si korinsin»).
 *
 * The fixture is deliberately the ARRIVED truck — its boxes no longer point
 * at the batch, which is the exact state in which the live pointer answers
 * «no crates» about the document somebody is reading (#440) — and it holds
 * round 31's short-loaded member, a carton that kept its crate but never
 * left the origin.
 */

const SUFFIX = String(Date.now()).slice(-6);
let actorId: string;
let whA: string;
let whB: string;
let clientId: string;
let batchId: string;
/** Stated 1 m³, three cartons aboard → over. Its code sorts LAST. */
let crateOver: string;
/** Stated 100 m³, two cartons aboard → within. Its code sorts FIRST. */
let crateFits: string;
const madeBoxes: string[] = [];

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  const wh = (over: { code: string; batchPrefix: string; country: string }) => ({
    name: `Yashik fura ${over.code}`,
    type: 'origin',
    timezone: 'Asia/Shanghai',
    ...over,
  });
  whA = (
    await db
      .insert(warehouses)
      .values(wh({ code: `YA${SUFFIX}`, batchPrefix: `YA${SUFFIX}`, country: 'CN' }))
      .returning({ id: warehouses.id })
  )[0]!.id;
  whB = (
    await db
      .insert(warehouses)
      .values(wh({ code: `YB${SUFFIX}`, batchPrefix: `YB${SUFFIX}`, country: 'UZ' }))
      .returning({ id: warehouses.id })
  )[0]!.id;
  clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `YC${SUFFIX}`, name: `Fura mijoz ${SUFFIX}` })
      .returning({ id: clients.id })
  )[0]!.id;
  batchId = (
    await db
      .insert(batches)
      .values({
        code: `YA${SUFFIX}-001`,
        originWarehouseId: whA,
        destWarehouseId: whB,
        status: 'arrived',
        departedAt: new Date(),
        createdBy: actorId,
      })
      .returning({ id: batches.id })
  )[0]!.id;

  const receiptId = (
    await db
      .insert(receipts)
      .values({ warehouseId: whA, clientId, status: 'confirmed', createdBy: actorId })
      .returning({ id: receipts.id })
  )[0]!.id;
  // 10 boxes, 1 m³ and 10 kg each — the share arithmetic stays legible.
  const lotId = (
    await db
      .insert(receiptLots)
      .values({
        receiptId,
        seq: 1,
        productNameZh: `箱${SUFFIX}`,
        boxCount: 10,
        dimsMode: 'mixed',
        totalWeightKg: '100',
        totalVolumeM3: '10',
      })
      .returning({ id: receiptLots.id })
  )[0]!.id;

  const mintCrate = async (over: Record<string, unknown>) =>
    (
      await db
        .insert(crates)
        .values({
          warehouseId: whB,
          clientId,
          createdBy: actorId,
          status: 'active',
          ...over,
        } as typeof crates.$inferInsert)
        .returning({ id: crates.id })
    )[0]!.id;

  crateOver = await mintCrate({
    code: `CR-YY${SUFFIX}-9`,
    lengthCm: 100,
    widthCm: 100,
    heightCm: 100,
    weightKg: '500',
  });
  crateFits = await mintCrate({
    code: `CR-YY${SUFFIX}-1`,
    lengthCm: 500,
    widthCm: 500,
    heightCm: 400,
    weightKg: '500',
  });

  const box = (seq: number, over: Record<string, unknown>) => ({
    lotId,
    shortCode: `YYC${SUFFIX}${seq}`,
    seqInLot: seq,
    // Landed: the unload nulls current_batch_id, so nothing here points at
    // the truck any more. Membership can only come off the movements.
    currentWarehouseId: whB,
    status: 'ready_for_pickup',
    currentBatchId: null,
    ...over,
  });
  const rows = await db
    .insert(boxes)
    .values([
      box(1, { crateId: crateOver }),
      box(2, { crateId: crateOver }),
      box(3, { crateId: crateOver }),
      box(4, { crateId: crateFits }),
      box(5, { crateId: crateFits }),
      // Round 31's short load: kept its crate, never left the origin, and so
      // rides no manifest — it must not be credited to this truck.
      box(6, {
        crateId: crateOver,
        currentWarehouseId: whA,
        status: 'in_stock',
      }),
    ] as (typeof boxes.$inferInsert)[])
    .returning({ id: boxes.id });
  madeBoxes.push(...rows.map((row) => row.id));

  // The manifest itself: five cartons departed on this batch, the sixth did
  // not. This is the only record the arrived truck still has.
  await db.insert(boxMovements).values(
    madeBoxes.slice(0, 5).map((boxId) => ({
      boxId,
      fromWarehouseId: whA,
      toWarehouseId: whB,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: batchId,
      actorId,
    })),
  );
});

afterAll(async () => {
  await db.delete(boxMovements).where(inArray(boxMovements.boxId, madeBoxes));
  await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  await db.delete(crates).where(inArray(crates.id, [crateOver, crateFits]));
  const lots = await db
    .select({ id: receiptLots.id, receiptId: receiptLots.receiptId })
    .from(receiptLots)
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .where(eq(receipts.clientId, clientId));
  if (lots.length) {
    await db.delete(receiptLots).where(inArray(receiptLots.id, lots.map((l) => l.id)));
    await db.delete(receipts).where(inArray(receipts.id, lots.map((l) => l.receiptId)));
  }
  await db.delete(batches).where(eq(batches.id, batchId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(warehouses).where(inArray(warehouses.id, [whA, whB]));
  await pgClient.end();
});

describe('batchCrates', () => {
  it('still lists the crates after the truck has been unloaded', async () => {
    // The live pointer is null on every box here. Read through
    // box_movements, the document says what rode; read through the pointer,
    // it says the truck was empty (#440).
    const rows = await batchCrates(batchId);
    expect(rows.map((row) => row.id).sort()).toEqual([crateOver, crateFits].sort());
  });

  it('counts only the cartons that RODE, as a share of their lot', async () => {
    const rows = await batchCrates(batchId);
    const over = rows.find((row) => row.id === crateOver)!;
    // Three aboard, not the four its crate_id claims — the short-loaded
    // sixth carton is standing at the origin.
    expect(over.boxCount).toBe(3);
    expect(over.m3).toBe(3);
    expect(over.kg).toBe(30);
    expect(over.clientCode).toBe(`YC${SUFFIX}`);
    const fits = rows.find((row) => row.id === crateFits)!;
    expect(fits.boxCount).toBe(2);
    expect(fits.m3).toBe(2);
    expect(fits.kg).toBe(20);
  });

  it('puts the over-capacity crate at the top, whatever its code', async () => {
    // His answer on item 2: «ogohlantirish … spiskani tepasida tursa boladi,
    // bolmasam shar etmas». The flagged crate's code sorts LAST of the two,
    // so alphabetical order alone cannot produce this.
    const rows = await batchCrates(batchId);
    expect(rows[0]!.id).toBe(crateOver);
    expect(rows[0]!.over).toBe(true);
    expect(rows[0]!.statedM3).toBe(1);
    expect(rows[1]!.id).toBe(crateFits);
    expect(rows[1]!.over).toBe(false);
  });

  it('a truck that carried no crate produces no rows', async () => {
    const bare = (
      await db
        .insert(batches)
        .values({
          code: `YA${SUFFIX}-002`,
          originWarehouseId: whA,
          destWarehouseId: whB,
          status: 'forming',
          createdBy: actorId,
        })
        .returning({ id: batches.id })
    )[0]!.id;
    expect(await batchCrates(bare)).toHaveLength(0);
    await db.delete(batches).where(eq(batches.id, bare));
  });
});
