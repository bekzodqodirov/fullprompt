import 'dotenv/config';
import { eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { batches, driverDevices, users, warehouses } from '@/modules/platform/db/schema';
import {
  addManualPosition,
  createDriverDevice,
  devicesForBatch,
  FRESH_MINUTES,
  ingestPositions,
  latestPositions,
  pairDevice,
  revokeDriverDevice,
} from '@/modules/wms/tracking/devices';
import { silentTrucks, silentTruckText } from '@/modules/wms/tracking/silent';

/**
 * Driver tracking (owner's flow): the warehouse worker pairs the driver's
 * phone with THIS trip during loading; Android then streams fixes, other
 * phones stay manual.
 */

let originId: string;
let destId: string;
let actorId: string;
let batchId: string;
const ctx = () => ({ actorId });

async function ensureWarehouse(code: string) {
  const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
  if (existing) return existing.id;
  const [wh] = await db
    .insert(warehouses)
    .values({ code, name: `Track ${code}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: code })
    .returning();
  return wh!.id;
}

async function newBatch(status = 'in_transit') {
  const [row] = await db
    .insert(batches)
    .values({
      code: `TRK-${String(Date.now()).slice(-6)}-${Math.floor(Math.random() * 1000)}`,
      originWarehouseId: originId,
      destWarehouseId: destId,
      type: 'transfer',
      status,
      driverName: 'Haydovchi Aka',
      createdBy: actorId,
    })
    .returning();
  return row!.id;
}

beforeAll(async () => {
  originId = await ensureWarehouse('TRKO');
  destId = await ensureWarehouse('TRKD');
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  batchId = await newBatch();
});

afterAll(async () => {
  // The quiet paired devices minted above must not feed the silent-truck
  // sweep the e2e server runs on this same database later in CI (#154). A
  // closed trip is nobody the server waits for.
  await db.update(batches).set({ status: 'closed' }).where(like(batches.code, 'TRK-%'));
  await pgClient.end();
});

describe('pairing', () => {
  it('mints a single-use code, exchanges it for a token, and burns the code', async () => {
    const device = await createDriverDevice({ batchId, label: 'Redmi Note 12' }, ctx());
    expect(device.pairCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(device.tokenHash).toBeNull();

    const paired = await pairDevice(device.pairCode!);
    expect(paired.deviceId).toBe(device.id);
    expect(paired.driverName).toBe('Haydovchi Aka');
    expect(paired.token.length).toBeGreaterThan(20);

    // The code cannot be replayed (a screenshot of it is worthless).
    await expect(pairDevice(device.pairCode!)).rejects.toMatchObject({ code: 'bad_code' });
    await expect(pairDevice('ZZZZZZ')).rejects.toMatchObject({ code: 'bad_code' });
    await expect(pairDevice('bad')).rejects.toMatchObject({ code: 'bad_code' });
  });

  it('refuses to pair a finished trip', async () => {
    const closedBatch = await newBatch('closed');
    await expect(createDriverDevice({ batchId: closedBatch }, ctx())).rejects.toMatchObject({
      code: 'batch_closed',
    });
  });

  it('never exposes the token to the batch card', async () => {
    const list = await devicesForBatch(batchId);
    expect(list.length).toBeGreaterThan(0);
    expect(Object.keys(list[0]!)).not.toContain('tokenHash');
  });
});

describe('position ingest', () => {
  it('accepts a queued batch of fixes and ignores a re-flush', async () => {
    const device = await createDriverDevice({ batchId }, ctx());
    const { token } = await pairDevice(device.pairCode!);
    const positions = [
      { lat: 29.31, lon: 120.07, recordedAt: new Date(Date.now() - 60_000).toISOString() },
      { lat: 30.0, lon: 118.5, accuracyM: 12, speedKmh: 78.5, recordedAt: new Date().toISOString() },
    ];

    expect(await ingestPositions(token, { positions })).toEqual({ accepted: 2 });
    // The phone re-sends its queue after a reconnect — no duplicates.
    expect(await ingestPositions(token, { positions })).toEqual({ accepted: 0 });

    const seen = await db.query.driverDevices.findFirst({ where: eq(driverDevices.id, device.id) });
    expect(seen?.lastSeenAt).not.toBeNull();
  });

  it('rejects a token that was never issued', async () => {
    await expect(ingestPositions('nope', { positions: [] as never })).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('tells a REVOKED phone the trip is over, rather than refusing it', async () => {
    /**
     * This test used to assert `unauthorized`, which is what the code did and
     * what the phone could not act on.
     *
     * The two answers mean different things to the handset: `unauthorized`
     * becomes a 401, which the Android client reads as a server hiccup — it
     * keeps its queue and retries every tick, for ever, into a SQLite table
     * with no ceiling. `trip_finished` becomes a 410, the one answer that
     * makes it call `clearTrip()` and stop the service.
     *
     * A revoked device is not an intruder. It is a phone whose trip is over,
     * and that is precisely what revoking is for — so the token hash is now
     * kept on revoke, because a device the ingest cannot find at all is
     * indistinguishable from a bogus token and cannot be told anything.
     */
    const device = await createDriverDevice({ batchId }, ctx());
    const { token } = await pairDevice(device.pairCode!);
    await revokeDriverDevice(device.id, ctx());
    await expect(
      ingestPositions(token, {
        positions: [{ lat: 40, lon: 70, recordedAt: new Date().toISOString() }],
      }),
    ).rejects.toMatchObject({ code: 'trip_finished' });

    // Still refused, of course — the revocation is what counts, not the token.
    const stored = await db.query.driverDevices.findFirst({
      where: eq(driverDevices.id, device.id),
    });
    expect(stored!.revokedAt).not.toBeNull();
    expect(stored!.pairCode).toBeNull();
  });

  it('tells the phone to stop once the trip is finished', async () => {
    const trip = await newBatch();
    const device = await createDriverDevice({ batchId: trip }, ctx());
    const { token } = await pairDevice(device.pairCode!);
    await db.update(batches).set({ status: 'closed' }).where(eq(batches.id, trip));
    await expect(
      ingestPositions(token, {
        positions: [{ lat: 40, lon: 70, recordedAt: new Date().toISOString() }],
      }),
    ).rejects.toMatchObject({ code: 'trip_finished' });
  });
});

describe('latest position', () => {
  it('returns the newest fix per batch with a freshness flag', async () => {
    const trip = await newBatch();
    const device = await createDriverDevice({ batchId: trip }, ctx());
    const { token } = await pairDevice(device.pairCode!);
    await ingestPositions(token, {
      positions: [
        { lat: 39.47, lon: 75.98, recordedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
        { lat: 40.53, lon: 72.8, recordedAt: new Date(Date.now() - 2 * 60_000).toISOString() },
      ],
    });
    const fresh = (await latestPositions([trip])).get(trip)!;
    expect(fresh.lat).toBeCloseTo(40.53, 2);
    expect(fresh.source).toBe('device');
    expect(fresh.fresh).toBe(true);
    expect(fresh.ageMinutes).toBeLessThan(5);
  });

  // The app reports every 2-3 hours to save the driver's battery, so a gap of
  // one skipped cycle must NOT demote the real dot back to the estimate.
  it('still trusts a fix from a few hours ago (normal reporting gap)', async () => {
    const trip = await newBatch();
    const device = await createDriverDevice({ batchId: trip }, ctx());
    const { token } = await pairDevice(device.pairCode!);
    await ingestPositions(token, {
      positions: [{ lat: 39.9, lon: 74.1, recordedAt: new Date(Date.now() - 5 * 3_600_000).toISOString() }],
    });
    const recent = (await latestPositions([trip])).get(trip)!;
    expect(recent.fresh).toBe(true);
    expect(FRESH_MINUTES).toBeGreaterThanOrEqual(3 * 60);
  });

  it('marks an old fix as stale so the estimate takes over', async () => {
    const trip = await newBatch();
    const device = await createDriverDevice({ batchId: trip }, ctx());
    const { token } = await pairDevice(device.pairCode!);
    await ingestPositions(token, {
      positions: [{ lat: 41.3, lon: 69.2, recordedAt: new Date(Date.now() - 12 * 3_600_000).toISOString() }],
    });
    const stale = (await latestPositions([trip])).get(trip)!;
    expect(stale.fresh).toBe(false);
    expect(stale.ageMinutes).toBeGreaterThan(FRESH_MINUTES);
  });

  it("the logist's manual pin counts as a position too (iPhone / HarmonyOS)", async () => {
    const trip = await newBatch();
    await addManualPosition({ batchId: trip, lat: 43.83, lon: 87.62 }, ctx());
    const pinned = (await latestPositions([trip])).get(trip)!;
    expect(pinned.source).toBe('manual');
    expect(pinned.fresh).toBe(true);
  });

  it('returns nothing for a batch without any fix', async () => {
    const trip = await newBatch();
    expect((await latestPositions([trip])).size).toBe(0);
    expect((await latestPositions([])).size).toBe(0);
  });
});

/**
 * The silent-truck alarm (round 55). The driver app can die in ways nothing
 * inside it survives — a vendor battery killer, a force stop — and every
 * alarm the app could raise dies with it. So the server watches for the
 * phone that stopped calling in, judged by the same FRESH_MINUTES that
 * greys the map dot.
 */
describe('silent trucks', () => {
  const quiet = () => new Date(Date.now() - (FRESH_MINUTES + 60) * 60_000);

  async function quietDevice(trip: string) {
    const device = await createDriverDevice({ batchId: trip }, ctx());
    await pairDevice(device.pairCode!);
    await db
      .update(driverDevices)
      .set({ lastSeenAt: quiet(), pairedAt: quiet() })
      .where(eq(driverDevices.id, device.id));
    return device.id;
  }

  it('reports a paired phone on an in-transit trip that went quiet', async () => {
    const trip = await newBatch();
    const deviceId = await quietDevice(trip);
    const due = await silentTrucks();
    const mine = due.find((t) => t.deviceId === deviceId);
    expect(mine).toBeDefined();
    expect(mine!.batchId).toBe(trip);
    expect(mine!.silentSinceMs).toBeGreaterThan(FRESH_MINUTES * 60_000);
  });

  it('one silence is one report: a stamped device is not listed again', async () => {
    const trip = await newBatch();
    const deviceId = await quietDevice(trip);
    await db
      .update(driverDevices)
      .set({ silentNotifiedAt: new Date() })
      .where(eq(driverDevices.id, deviceId));
    const due = await silentTrucks();
    expect(due.find((t) => t.deviceId === deviceId)).toBeUndefined();
  });

  it('the next position ends the silence, so a NEW one can be reported', async () => {
    const trip = await newBatch();
    const device = await createDriverDevice({ batchId: trip }, ctx());
    const { token } = await pairDevice(device.pairCode!);
    await db
      .update(driverDevices)
      .set({ silentNotifiedAt: new Date() })
      .where(eq(driverDevices.id, device.id));

    await ingestPositions(token, {
      positions: [{ lat: 40.1, lon: 72.5, recordedAt: new Date().toISOString() }],
    });
    const stored = await db.query.driverDevices.findFirst({
      where: eq(driverDevices.id, device.id),
    });
    expect(stored!.silentNotifiedAt).toBeNull();
  });

  it('a trip not under way is expected to be quiet', async () => {
    // Paired at loading, truck still at the gate: silence is normal there,
    // and an arrived batch has nothing left to report.
    const loading = await newBatch('loading');
    const deviceId = await quietDevice(loading);
    const due = await silentTrucks();
    expect(due.find((t) => t.deviceId === deviceId)).toBeUndefined();
  });

  it('a revoked phone is nobody we wait for', async () => {
    const trip = await newBatch();
    const deviceId = await quietDevice(trip);
    await revokeDriverDevice(deviceId, ctx());
    const due = await silentTrucks();
    expect(due.find((t) => t.deviceId === deviceId)).toBeUndefined();
  });

  it('a phone that paired and never reported once is judged from the pairing', async () => {
    const trip = await newBatch();
    const device = await createDriverDevice({ batchId: trip }, ctx());
    await pairDevice(device.pairCode!);
    await db
      .update(driverDevices)
      .set({ lastSeenAt: null, pairedAt: quiet() })
      .where(eq(driverDevices.id, device.id));
    const due = await silentTrucks();
    expect(due.find((t) => t.deviceId === device.id)).toBeDefined();
  });

  it('a minted code nobody typed in is not a phone', async () => {
    const trip = await newBatch();
    await createDriverDevice({ batchId: trip }, ctx());
    const due = await silentTrucks();
    expect(due.find((t) => t.batchId === trip)).toBeUndefined();
  });

  it('the message names the trip, the hours, and both causes of silence', () => {
    const text = silentTruckText(
      {
        deviceId: 'd',
        batchId: 'b-1',
        batchCode: 'YW-042',
        driverName: 'Karim aka',
        vehiclePlate: '01A123BC',
        silentSinceMs: 9 * 3_600_000,
      },
      'https://gsrwms.uz',
    );
    expect(text).toContain('YW-042');
    expect(text).toContain('01A123BC');
    expect(text).toContain('9 soatdan beri jim');
    // Silence has two causes; the message must not claim to know which.
    expect(text).toContain("Aloqa yo'q hududda");
    expect(text).toContain('https://gsrwms.uz/batches/b-1');
  });
});
