import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { batches, users, warehouses } from '@/modules/platform/db/schema';
import { actorGrants } from '@/modules/platform/rbac/authorize';
import { CheckpointError, setTrackingCheckpoint } from '@/modules/wms/tracking/checkpoint';

/**
 * The «where is the truck» pin, pressed through the SERVICE (the Horgos
 * round). The action is a thin door over it (batch-door.integration presses
 * that); what is proven here is the rule the screen alone cannot hold: a pin
 * this truck's road does not carry is refused, a pin already on the truck can
 * always be pressed off, and the card's door is asked inside the service.
 *
 * The actors are the seeded demo people with their real grants
 * (`actorGrants`, the same join `getActor` makes). The trucks are rows this
 * file makes and deletes; the audit rows its presses wrote stay.
 */

const SUFFIX = String(Date.now()).slice(-6);
const META = { ip: null, userAgent: 'checkpoint.integration' };
const PHONES = { logist: '+998900000003', yw: '+998900000006', ka: '+998900000008' } as const;

type Pinner = Parameters<typeof setTrackingCheckpoint>[0];
const actors = {} as Record<keyof typeof PHONES, Pinner>;
let kaTas = '';
let loadingTruck = '';

const pinOf = async (id: string) =>
  ((await db.query.batches.findFirst({ where: eq(batches.id, id) }))!.trackingCheckpoint as { key?: string } | null)
    ?.key ?? null;
const codeOf = async (press: Promise<unknown>) => {
  try {
    await press;
    return null;
  } catch (err) {
    if (err instanceof CheckpointError) return err.code;
    throw err;
  }
};

beforeAll(async () => {
  for (const [who, phone] of Object.entries(PHONES) as [keyof typeof PHONES, string][]) {
    const user = await db.query.users.findFirst({ where: eq(users.phone, phone) });
    expect(user, `demo person ${who}`).toBeDefined();
    actors[who] = { id: user!.id, ...(await actorGrants(user!.id)) };
  }
  const wh = async (code: string) => (await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) }))!.id;
  const [ka, tas] = [await wh('KA'), await wh('TAS1')];
  [kaTas, loadingTruck] = (
    await db
      .insert(batches)
      .values([
        {
          code: `PIN${SUFFIX}-1`,
          originWarehouseId: ka,
          destWarehouseId: tas,
          status: 'in_transit',
          departedAt: new Date(),
          createdBy: actors.logist.id,
        },
        { code: `PIN${SUFFIX}-2`, originWarehouseId: ka, destWarehouseId: tas, status: 'loading', createdBy: actors.logist.id },
      ])
      .returning({ id: batches.id })
  ).map((r) => r.id) as [string, string];
});

afterAll(async () => {
  const made = [kaTas, loadingTruck].filter(Boolean);
  if (made.length) await db.delete(batches).where(inArray(batches.id, made));
  await pgClient.end();
});

describe('setTrackingCheckpoint — the truck’s own road decides', () => {
  it('a Kashgar → Tashkent truck takes «in Kyrgyzstan»', async () => {
    const written = await setTrackingCheckpoint(actors.logist, kaTas, 'in_kg', META);
    expect(written?.key).toBe('in_kg');
    expect(await pinOf(kaTas)).toBe('in_kg');
  });

  it('…and refuses «in Kazakhstan», a leg it never drives — in words, writing nothing', async () => {
    expect(await codeOf(setTrackingCheckpoint(actors.logist, kaTas, 'in_kz', META))).toBe('not_on_route');
    expect(await pinOf(kaTas)).toBe('in_kg');
  });

  it('a pin written before the rule, off its road, can still be pressed off', async () => {
    await db
      .update(batches)
      .set({ trackingCheckpoint: { key: 'in_kz', at: new Date().toISOString() } })
      .where(eq(batches.id, kaTas));
    expect(await setTrackingCheckpoint(actors.logist, kaTas, 'in_kz', META)).toBeNull();
    expect(await pinOf(kaTas)).toBeNull();
  });

  it('asks the card’s door INSIDE the service: a Yiwu operator cannot move a Kashgar truck', async () => {
    expect(actors.yw.permissions.has('batches.vehicle_info')).toBe(true);
    expect(await codeOf(setTrackingCheckpoint(actors.yw, kaTas, 'at_border', META))).toBe('forbidden');
    expect(await pinOf(kaTas)).toBeNull();
    // The operator at the truck's own end may.
    expect((await setTrackingCheckpoint(actors.ka, kaTas, 'at_border', META))?.key).toBe('at_border');
  });

  it('a truck still loading has no position to pin', async () => {
    expect(await codeOf(setTrackingCheckpoint(actors.logist, loadingTruck, 'at_border', META))).toBe('not_in_transit');
    expect(await pinOf(loadingTruck)).toBeNull();
  });

  it('refuses a key nobody writes, and a person without the permission', async () => {
    expect(await codeOf(setTrackingCheckpoint(actors.logist, kaTas, 'somewhere', META))).toBe('unknown_key');
    const bare = { ...actors.logist, permissions: new Set<string>() };
    expect(await codeOf(setTrackingCheckpoint(bare, kaTas, 'in_uz', META))).toBe('forbidden');
  });
});
