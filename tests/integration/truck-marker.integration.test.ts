import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { batches, users, warehouses } from '@/modules/platform/db/schema';
import { truckFor } from '@/modules/wms/tracking/truck';

/**
 * The map's one promise: a truck the driver's phone is REPORTING is drawn.
 *
 * The estimate needs a route table; the phone's own position needs nothing.
 * `truckFor` used to return null whenever `routeFor` did, so a batch between
 * warehouses the map does not know — a code invented after the route table
 * was written — vanished entirely: phone paired, positions arriving, and no
 * truck anywhere on /map.
 */

const STAMP = String(Date.now()).slice(-7);
let actorId = '';
let batchRow: typeof batches.$inferSelect;
const madeWh: string[] = [];

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  // Codes the map's WAREHOUSE_POINTS has never heard of.
  const [o] = await db
    .insert(warehouses)
    .values({ code: `QO${STAMP.slice(-4)}`, name: 'Yangi sklad A', country: 'CN', type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: `Q${STAMP.slice(-3)}` })
    .returning();
  const [d] = await db
    .insert(warehouses)
    .values({ code: `QD${STAMP.slice(-4)}`, name: 'Yangi sklad B', country: 'UZ', type: 'distribution', timezone: 'Asia/Tashkent', batchPrefix: `R${STAMP.slice(-3)}` })
    .returning();
  madeWh.push(o!.id, d!.id);
  const [batch] = await db
    .insert(batches)
    .values({
      code: `TRKM-${STAMP}`,
      originWarehouseId: o!.id,
      destWarehouseId: d!.id,
      status: 'in_transit',
      departedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  batchRow = batch!;
});

afterAll(async () => {
  await db.delete(batches).where(eq(batches.id, batchRow.id));
  await db.delete(warehouses).where(inArray(warehouses.id, madeWh));
  await pgClient.end();
});

describe('a truck between unmapped warehouses', () => {
  it('is drawn at its phone fix — live GPS needs no route table', async () => {
    const truck = await truckFor(batchRow, `QO${STAMP.slice(-4)}`, `QD${STAMP.slice(-4)}`, {
      batchId: batchRow.id,
      lat: 40.1,
      lon: 72.5,
      recordedAt: new Date(),
      source: 'device',
      ageMinutes: 3,
      fresh: true,
    });
    expect(truck).not.toBeNull();
    expect(truck!.x).toBe(72.5);
    expect(truck!.y).toBe(40.1);
    expect(truck!.live).toBe(true);
    // No schedule — so no invented corridor and no invented ETA.
    expect(truck!.routePoints).toEqual([]);
  });

  it('stays off the map only when there is NOTHING to draw', async () => {
    expect(
      await truckFor(batchRow, `QO${STAMP.slice(-4)}`, `QD${STAMP.slice(-4)}`, undefined),
    ).toBeNull();
  });

  it('a mapped pair still rides the estimate when the fix is stale', async () => {
    const truck = await truckFor(batchRow, 'YW', 'AND', {
      batchId: batchRow.id,
      lat: 40.1,
      lon: 72.5,
      recordedAt: new Date(Date.now() - 20 * 60 * 60_000),
      source: 'device',
      ageMinutes: 20 * 60,
      fresh: false,
    });
    expect(truck).not.toBeNull();
    // The schedule drives the dot; the stale fix survives as information.
    expect(truck!.live).toBe(false);
    expect(truck!.fixAgeMinutes).toBe(20 * 60);
    expect(truck!.routePoints.length).toBeGreaterThan(0);
  });
});
