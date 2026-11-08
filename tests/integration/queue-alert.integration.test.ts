import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  driverPositions,
  notifications,
  truckQueueAlerts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { usersWithPermission } from '@/modules/platform/notifications/service';
import { latestPositions, queueSinceFor } from '@/modules/wms/tracking/devices';
import { routeFor } from '@/modules/wms/tracking/map-data';
import { alertLateQueues } from '@/modules/wms/tracking/queue-alert';
import { roadRowsNow } from '@/modules/wms/tracking/on-road';

/**
 * The held-queue warning against a real database (docs/XORGOS-NAVBAT.md §3,
 * the owner's 3a «har bir navbat uchun bir marta»).
 *
 * What only a database can say: that a late truck is told to the logists
 * once and a second sweep says nothing again (the 0140 claim, in the same
 * transaction as the rows); that Yallama is its own once; that a truck still
 * inside its wait is told nothing; and that the phone's history at a post
 * (`queueSinceFor`) is read the way `gateSince` is.
 *
 * The Horgos road is keyed by the warehouse CODE (`routeFor('HOR', …)`), and
 * no seed carries one, so the file mints `HOR` when the database has none and
 * deletes it afterwards. Every truck is deleted in the final hook — an
 * in-transit leftover is the next spec's map (#154) — and so is every
 * message row it caused, found by the trucks' own codes.
 */

const SFX = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const HOUR = 3_600_000;
const NOW = new Date();
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR);

let actorId = '';
let horId = '';
let tasId = '';
let mintedHor = false;
const ids: Record<'late' | 'fresh' | 'yallama' | 'phone', string> = {
  late: '',
  fresh: '',
  yallama: '',
  phone: '',
};
const codeOf = (key: keyof typeof ids) => `XN${key.slice(0, 2).toUpperCase()}-${SFX}`;

async function mintTruck(key: keyof typeof ids, values: Partial<typeof batches.$inferInsert>) {
  const [b] = await db
    .insert(batches)
    .values({
      code: codeOf(key),
      originWarehouseId: horId,
      destWarehouseId: tasId,
      status: 'in_transit',
      createdBy: actorId,
      ...values,
    })
    .returning({ id: batches.id });
  ids[key] = b!.id;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  tasId = (await db.query.warehouses.findFirst({ where: eq(warehouses.code, 'TAS1') }))!.id;
  const hor = await db.query.warehouses.findFirst({ where: eq(warehouses.code, 'HOR') });
  if (hor) horId = hor.id;
  else {
    const [w] = await db
      .insert(warehouses)
      .values({
        code: 'HOR',
        name: 'Horgos (test)',
        country: 'CN',
        type: 'hub',
        timezone: 'Asia/Shanghai',
        batchPrefix: 'HR',
      })
      .returning({ id: warehouses.id });
    horId = w!.id;
    mintedHor = true;
  }
  // Departed 200 h ago, nothing since: 198 h at Horgos against 84 — late.
  await mintTruck('late', { departedAt: ago(200) });
  // Departed 10 h ago: 8 h into the wait — told nothing.
  await mintTruck('fresh', { departedAt: ago(10) });
  // «Qozog'istonda» 300 h ago: through Kazakhstan, then 276 h at Yallama — late there.
  await mintTruck('yallama', {
    departedAt: ago(400),
    trackingCheckpoint: { key: 'in_kz', at: ago(300).toISOString() },
  });
  await mintTruck('phone', { departedAt: ago(30) });
});

afterAll(async () => {
  const all = Object.values(ids).filter(Boolean);
  try {
    await db.delete(notifications).where(like(sql`${notifications.payload}->>'text'`, `%-${SFX}%`));
    await db.delete(driverPositions).where(inArray(driverPositions.batchId, all));
    await db.delete(batches).where(inArray(batches.id, all));
    if (mintedHor) await db.delete(warehouses).where(eq(warehouses.id, horId));
  } finally {
    await pgClient.end();
  }
});

const claims = async () =>
  db
    .select({ batchId: truckQueueAlerts.batchId, post: truckQueueAlerts.post })
    .from(truckQueueAlerts)
    .where(inArray(truckQueueAlerts.batchId, Object.values(ids)));
const toldAbout = async (key: keyof typeof ids) =>
  db
    .select({ userId: notifications.userId, text: sql<string>`${notifications.payload}->>'text'` })
    .from(notifications)
    .where(
      and(
        eq(notifications.type, 'TruckQueueLate'),
        like(sql`${notifications.payload}->>'text'`, `%${codeOf(key)}%`),
      ),
    );

describe('the late-queue warning (3a)', () => {
  it('the rows the sweep reads are the dashboard’s own: Horgos late, Yallama late, the fresh one inside its wait', async () => {
    const rows = new Map((await roadRowsNow(NOW)).map((r) => [r.id, r]));
    expect(rows.get(ids.late)?.queue).toMatchObject({ post: 'khorgos', late: true });
    expect(rows.get(ids.late)?.kind).toBe('overdue');
    expect(rows.get(ids.yallama)?.queue).toMatchObject({ post: 'yallama', late: true });
    expect(rows.get(ids.fresh)?.queue).toMatchObject({ post: 'khorgos', late: false, over: false });
    expect(rows.get(ids.fresh)?.kind).toBe('on_road');
  });

  it('tells the logists once per (truck, post), and nothing about a truck inside its wait', async () => {
    await alertLateQueues(NOW);
    const claimed = await claims();
    expect(claimed).toEqual(
      expect.arrayContaining([
        { batchId: ids.late, post: 'khorgos' },
        { batchId: ids.yallama, post: 'yallama' },
      ]),
    );
    expect(claimed.some((c) => c.batchId === ids.fresh)).toBe(false);

    const logists = await usersWithPermission('plans.manage');
    expect(logists.length).toBeGreaterThan(0);
    const late = await toldAbout('late');
    // One row per colleague who plans trips — the claim never doubles it.
    expect(new Set(late.map((r) => r.userId)).size).toBe(late.length);
    expect(late.length).toBeGreaterThan(0);
    expect(late[0]!.text).toContain('Horgos navbatida');
    expect(late[0]!.text).toContain('«Qozog‘istonda» tugmasini bosing');
    expect((await toldAbout('yallama'))[0]!.text).toContain('«O‘zbekistonda» tugmasini bosing');
    expect(await toldAbout('fresh')).toHaveLength(0);
  });

  it('a second sweep says nothing again — the claim is the once', async () => {
    const before = (await toldAbout('late')).length;
    await alertLateQueues(new Date(NOW.getTime() + HOUR));
    expect((await toldAbout('late')).length).toBe(before);
    expect((await claims()).filter((c) => c.batchId === ids.late)).toHaveLength(1);
  });
});

describe('the phone’s history at a held post (queueSinceFor)', () => {
  it('since its first fix at the post after its last one elsewhere, read as gateSince is', async () => {
    const hor = routeFor('HOR', 'TAS1')!;
    const post = hor.points[hor.segments.find((s) => s.key === 'border_wait')!.span[0]]!;
    const at = (lat: number, lon: number, hoursAgo: number) => ({
      batchId: ids.phone,
      lat: lat.toFixed(6),
      lon: lon.toFixed(6),
      recordedAt: ago(hoursAgo),
      receivedAt: ago(hoursAgo),
      source: 'device',
    });
    await db.insert(driverPositions).values([
      // Far out (Urumqi side), then in the queue from 20 h ago, still there 1 h ago.
      at(post.y, post.x + 1, 26),
      at(post.y, post.x + 0.01, 20),
      at(post.y, post.x + 0.005, 1),
    ]);
    const trip = {
      id: ids.phone,
      originCode: 'HOR',
      destCode: 'TAS1',
      departedAt: ago(30),
      until: null,
    };
    const since = await queueSinceFor([trip]);
    expect(since.get(ids.phone)?.khorgos?.toISOString()).toBe(ago(20).toISOString());
    const latest = await latestPositions([trip]);
    expect(latest.get(ids.phone)?.queueSince.khorgos?.toISOString()).toBe(ago(20).toISOString());
    // And the place counts the queue from it, not from the newest fix.
    const row = (await roadRowsNow(NOW)).find((r) => r.id === ids.phone)!;
    expect(row.queue!.stoodHours).toBeCloseTo(20, 1);
  });
});
