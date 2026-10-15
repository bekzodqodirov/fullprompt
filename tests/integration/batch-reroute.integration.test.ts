import 'dotenv/config';
import postgres from 'postgres';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The actions read a session; this file stands in for it (and for Next's
// cache and the job queue) and for nothing else — batch-door.integration's
// shape: a service-level test of a form-fed path proves the service, not the
// system (#531), so section 10 presses the actions the buttons call.
const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  getSessionUser: async () => session.user,
  requestMeta: async () => ({ ip: null, userAgent: 'batch-reroute.integration' }),
}));
vi.mock('next/cache', async (original) => ({
  ...(await original<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: async () => {},
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  batches,
  boxes,
  boxMovements,
  clients,
  events,
  loadPlans,
  notifications,
  roles,
  userRoles,
  userWarehouses,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { actorGrants, AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { mayAt } from '@/modules/platform/rbac/scope';
import {
  countAcceptCrateAction,
  countAcceptLotAction,
  finishUnloadAction,
  rerouteBatchAction,
  unloadRemainingAction,
} from '@/app/(protected)/batches/batch-actions-server';
import { processPendingEvents, renderTelegramText } from '@/modules/platform/notifications/service';
import { roundKg, roundM3, shareOf, sumRounded } from '@/modules/platform/telegram/format';
import { bearsPriceSql, crossesBorderSql, internalLegSql } from '@/modules/wms/batches/internal';
import {
  departureDestination,
  RerouteError,
  rerouteBatch,
  rerouteHistory,
  rerouteTargets,
  type RerouteActor,
} from '@/modules/wms/batches/reroute';
import { clientFeed } from '@/modules/wms/crm/feed';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { CountError, countAcceptCrate, countAcceptLot } from '@/modules/wms/scanning/count-accept';
import { countDoorFor } from '@/modules/wms/scanning/count-door';
import { NO_DOOR } from '@/modules/wms/scanning/count-rules';
import { departBatch, ingestLoadScans, ScanError } from '@/modules/wms/scanning/service';
import { syncScans, type SyncItem } from '@/modules/wms/scanning/sync';
import { finishUnload, ingestUnloadScans, unloadRemaining } from '@/modules/wms/scanning/unload';
import { checkpointsFor, pinOnRoute } from '@/modules/wms/tracking/eta';

/**
 * «Yo'nalishni o'zgartirish» — a truck on the road gets another receiving
 * warehouse (the reroute round). Pressed through the real service and the
 * real unload doors, because the engineering is on the unload side: a door
 * authorized at the OLD warehouse must never land cargo at the new one, and a
 * phone at the old warehouse must never have its whole queue jammed.
 *
 * The cargo trucks run between warehouses this file mints (a real plan, real
 * load scans, a real departure), so nothing lands in a warehouse a later
 * spec reads. The pin test needs the ROAD, which is keyed by the demo codes
 * (KA/TAS1/TAS2): those trucks carry no cargo and are deleted. People are
 * minted per run and DEACTIVATED at the end, warehouses deactivated, never
 * deleted (audit_log FK); the reroutes' audit rows stay (audit_log refuses
 * DELETE); this file's events and their notification rows go.
 */

const S = String(Date.now()).slice(-6);
const META = { ip: null, userAgent: 'batch-reroute.integration' };

const W: Record<'org' | 'a' | 'b' | 'c' | 'cn' | 'off' | 'odd', { id: string; code: string }> = {} as never;
const demo: Record<'KA' | 'TAS1' | 'TAS2', string> = { KA: '', TAS1: '', TAS2: '' };
type Person = RerouteActor;
const P = {} as Record<
  'logistA' | 'logistB' | 'logistFar' | 'plannerAtA' | 'plannerAtB' | 'opA' | 'opB' | 'opC' | 'admin' | 'ved',
  Person
>;
const madeUsers: string[] = [];
const madeTrucks: string[] = [];
const demoTrucks: string[] = [];
let clientId = '';
let seq = 0;

const ctx = () => ({ actorId: P.logistA.id });

async function mintWarehouse(code: string, country: string, type = 'hub', active = true) {
  const [row] = await db
    .insert(warehouses)
    .values({ code, name: `Reroute ${code}`, country, type, timezone: 'Asia/Tashkent', batchPrefix: code, active })
    .returning({ id: warehouses.id, code: warehouses.code });
  return row!;
}

async function mintPerson(label: string, roleCodes: string[], warehouseIds: string[] = []): Promise<Person> {
  seq += 1;
  const fullName = `Yo'nalish ${label} ${S}`;
  const [user] = await db
    .insert(users)
    .values({ phone: `+9989${S}${String(seq).padStart(2, '0')}`, fullName, passwordHash: 'x', locale: 'uz' })
    .returning({ id: users.id });
  madeUsers.push(user!.id);
  for (const code of roleCodes) {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code));
    await db.insert(userRoles).values({ userId: user!.id, roleId: role!.id });
  }
  for (const warehouseId of warehouseIds) await db.insert(userWarehouses).values({ userId: user!.id, warehouseId });
  return { id: user!.id, fullName, ...(await actorGrants(user!.id)) };
}

/** A real lot at the minted origin: a photo, a confirmed receipt, its boxes. */
async function makeLot(boxCount: number) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `reroute-test/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: P.logistA.id,
  });
  await confirmReceipt(
    {
      receiptId,
      warehouseId: W.org.id,
      clientId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '改道货',
          boxCount,
          dimsMode: 'uniform',
          boxLengthCm: 40,
          boxWidthCm: 40,
          boxHeightCm: 40,
          boxWeightKg: 7,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
  const rows = await db.select().from(boxes).where(eq(boxes.lotId, lotId)).orderBy(asc(boxes.seqInLot));
  return { lotId, boxIds: rows.map((b) => b.id), codes: rows.map((b) => b.shortCode) };
}

/** Plan → approve → load every carton → depart, towards `dest`. */
async function truckOnRoad(boxCount: number, dest: { id: string } = W.a) {
  const lot = await makeLot(boxCount);
  const sub = await submitPlan(
    { originWarehouseId: W.org.id, destWarehouseId: dest.id, lines: [{ lotId: lot.lotId, boxCount }] },
    ctx(),
  );
  const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
  for (const code of lot.codes) {
    const [ack] = await ingestLoadScans([{ ...scan(batch!.id, code), addedOnSpot: false }], ctx());
    expect(ack!.result).toBe('ok');
  }
  await departBatch(batch!.id, ctx());
  madeTrucks.push(batch!.id);
  return { id: batch!.id, code: batch!.code, lot };
}

function scan(batchId: string, code: string) {
  return { clientEventUuid: uuidv4(), batchId, code, method: 'qr' as const, scannedAt: new Date().toISOString() };
}

const truckRow = async (id: string) => (await db.query.batches.findFirst({ where: eq(batches.id, id) }))!;
const boxRow = async (id: string) => (await db.select().from(boxes).where(eq(boxes.id, id)))[0]!;

/** What a refused reroute must leave exactly as it was. */
async function footprint(id: string) {
  const truck = await truckRow(id);
  const [audits] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(and(eq(auditLog.entityId, id), sql`${auditLog.after}->>'destWarehouseId' IS NOT NULL`));
  const [evs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.type, 'BatchRerouted'), eq(events.entityId, id)));
  return { dest: truck.destWarehouseId, updatedAt: truck.updatedAt.getTime(), audits: audits!.n, events: evs!.n };
}

async function codeOf(press: Promise<unknown>): Promise<string | null> {
  try {
    await press;
    return null;
  } catch (err) {
    if (err instanceof RerouteError || err instanceof ScanError || err instanceof CountError) return err.code;
    throw err;
  }
}

const reroute = (who: Person, id: string, seen: string, to: string, reason = 'Chegara yopiq') =>
  rerouteBatch(who, id, { destWarehouseId: to, seenDestWarehouseId: seen, reason }, META);

/** Hold the truck row open on a second connection until `whileHeld` has queued up behind it. */
async function withTruckHeld<T>(
  truckId: string,
  start: () => Promise<T>,
  thenHolder: (held: postgres.ReservedSql) => Promise<void>,
): Promise<T> {
  const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
    max: 1,
    onnotice: () => {},
  });
  const held = await helper.reserve();
  try {
    await held`BEGIN`;
    await held`SELECT id FROM batches WHERE id = ${truckId} FOR NO KEY UPDATE`;
    const ours = start();
    let waiting = false;
    for (let i = 0; i < 250 && !waiting; i += 1) {
      const rows = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query ILIKE '%batches%' AND query ILIKE '%for no key update%'
           AND pid <> pg_backend_pid()`);
      waiting = Number(rows[0]?.n ?? 0) > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 20));
    }
    expect(waiting, 'our press never had to wait for the truck row').toBe(true);
    await thenHolder(held);
    await held`COMMIT`;
    return await ours;
  } finally {
    held.release();
    await helper.end();
  }
}

beforeAll(async () => {
  for (const code of ['KA', 'TAS1', 'TAS2'] as const) {
    const row = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
    expect(row, `demo warehouse ${code}`).toBeDefined();
    demo[code] = row!.id;
  }
  W.org = await mintWarehouse(`RRO${S}`, 'CN', 'origin');
  W.a = await mintWarehouse(`RRA${S}`, 'UZ');
  W.b = await mintWarehouse(`RRB${S}`, 'UZ');
  W.c = await mintWarehouse(`RRC${S}`, 'UZ');
  W.cn = await mintWarehouse(`RRK${S}`, 'CN');
  W.off = await mintWarehouse(`RRI${S}`, 'UZ', 'hub', false);
  W.odd = await mintWarehouse(`RRD${S}`, 'UZ');

  P.logistA = await mintPerson('logist A', ['logist']);
  P.logistB = await mintPerson('logist B', ['logist']);
  // A logist SCOPED to a warehouse no reroute here touches: the card would
  // 404 for them, so the Telegram does not reach them.
  P.logistFar = await mintPerson('logist far', ['logist', 'warehouse_operator'], [W.cn.id]);
  P.plannerAtA = await mintPerson('planner A', ['logist', 'warehouse_operator'], [W.a.id]);
  P.plannerAtB = await mintPerson('planner B', ['logist', 'warehouse_operator'], [W.b.id]);
  P.opA = await mintPerson('op A', ['warehouse_operator'], [W.a.id]);
  P.opB = await mintPerson('op B', ['warehouse_operator'], [W.b.id]);
  P.opC = await mintPerson('op C', ['warehouse_operator'], [W.c.id]);
  P.admin = await mintPerson('admin', ['admin']);
  // The VED: his «hammasi standart» answered 10d — no message, nothing reopened.
  P.ved = await mintPerson('ved', ['ved_manager']);

  const [client] = await db
    .insert(clients)
    .values({ clientCode: `RR${S}`, name: `Yo'nalish mijoz ${S}` })
    .returning({ id: clients.id });
  clientId = client!.id;
});

afterAll(async () => {
  const trucks = [...madeTrucks, ...demoTrucks];
  if (trucks.length) {
    const mine = await db
      .select({ id: events.id })
      .from(events)
      .where(sql`${events.entityId} IN (${sql.join(trucks.map((t) => sql`${t}::uuid`), sql`, `)})
              OR ${events.payload}->>'batchId' IN (${sql.join(trucks.map((t) => sql`${t}`), sql`, `)})`);
    if (mine.length) {
      await db.delete(notifications).where(inArray(notifications.eventId, mine.map((e) => e.id)));
      await db.delete(events).where(inArray(events.id, mine.map((e) => e.id)));
    }
  }
  if (demoTrucks.length) await db.delete(batches).where(inArray(batches.id, demoTrucks));
  if (madeUsers.length) {
    await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
    await db.delete(userWarehouses).where(inArray(userWarehouses.userId, madeUsers));
    await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  }
  if (clientId) await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  const whs = Object.values(W).map((w) => w.id);
  if (whs.length) await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, whs));
  await pgClient.end();
});

/** The three money predicates over the truck's own two ends — identical before and after (5a). */
async function moneyRules(id: string) {
  const [row] = await db.execute<{ internal: boolean; crosses: boolean; bears: boolean }>(sql`
    SELECT ${internalLegSql('o', 'd')} AS internal,
           ${crossesBorderSql('o', 'd')} AS crosses,
           ${bearsPriceSql('o', 'd', 'o')} AS bears
      FROM batches b
      JOIN warehouses o ON o.id = b.origin_warehouse_id
      JOIN warehouses d ON d.id = b.dest_warehouse_id
     WHERE b.id = ${id}`);
  return row;
}

describe('1 — the happy path: RRA → RRB', () => {
  it('moves the live destination and nothing else; one audit row, one event with what is coming', async () => {
    const t = await truckOnRoad(3);
    await db.update(batches).set({ vehiclePlate: '01 A 777 AA' }).where(eq(batches.id, t.id));
    const before = await truckRow(t.id);
    const money = await moneyRules(t.id);
    const departed = await db
      .select({ to: boxMovements.toWarehouseId })
      .from(boxMovements)
      .where(and(eq(boxMovements.refId, t.id), eq(boxMovements.cause, 'batch_departed')));
    const [plan] = await db.select().from(loadPlans).where(eq(loadPlans.batchId, t.id));

    const result = await reroute(P.logistA, t.id, W.a.id, W.b.id, '  Chegara   yopiq  ');
    expect(result.from).toEqual({ id: W.a.id, code: W.a.code });
    expect(result.to).toEqual({ id: W.b.id, code: W.b.code });

    const after = await truckRow(t.id);
    expect(after.destWarehouseId).toBe(W.b.id);
    expect(after.status).toBe('in_transit');
    for (const key of ['type', 'trackingCheckpoint', 'sentToAgentAt', 'customsClearedAt', 'departedAt', 'originWarehouseId', 'code'] as const) {
      expect(after[key], key).toEqual(before[key]);
    }
    // The departure is written once and never rewritten (#121).
    const departedAfter = await db
      .select({ to: boxMovements.toWarehouseId })
      .from(boxMovements)
      .where(and(eq(boxMovements.refId, t.id), eq(boxMovements.cause, 'batch_departed')));
    expect(departedAfter).toHaveLength(3);
    expect(departedAfter).toEqual(departed);
    expect(new Set(departedAfter.map((m) => m.to))).toEqual(new Set([W.a.id]));
    // The approved plan keeps the approved warehouse.
    expect((await db.select().from(loadPlans).where(eq(loadPlans.batchId, t.id)))[0]!.destWarehouseId).toBe(
      plan!.destWarehouseId,
    );
    expect(await moneyRules(t.id)).toEqual(money);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, t.id), sql`${auditLog.after}->>'destWarehouseId' IS NOT NULL`));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.before).toEqual({ destWarehouseId: W.a.id });
    // The reason is the person's sentence, whitespace folded, never cut.
    expect(audits[0]!.after).toEqual({ destWarehouseId: W.b.id, reason: 'Chegara yopiq' });
    expect(audits[0]!.action).toBe('update');

    const evs = await db.select().from(events).where(and(eq(events.type, 'BatchRerouted'), eq(events.entityId, t.id)));
    expect(evs).toHaveLength(1);
    const lotRow = await db.query.receiptLots.findFirst({ where: (l, { eq: e }) => e(l.id, t.lot.lotId) });
    expect(evs[0]!.payload).toMatchObject({
      batchId: t.id,
      batchCode: t.code,
      originCode: W.org.code,
      fromWarehouseId: W.a.id,
      fromCode: W.a.code,
      toWarehouseId: W.b.id,
      toCode: W.b.code,
      reason: 'Chegara yopiq',
      presserId: P.logistA.id,
      cartons: 3,
      kg: sumRounded([shareOf(Number(lotRow!.totalWeightKg), 3, 3)], roundKg),
      m3: sumRounded([shareOf(Number(lotRow!.totalVolumeM3), 3, 3)], roundM3),
      plate: '01 A 777 AA',
      fromWasTold: false,
    });
  });
});

describe('2 — every refusal, through the real service, writing nothing', () => {
  let t: Awaited<ReturnType<typeof truckOnRoad>>;
  beforeAll(async () => {
    t = await truckOnRoad(1);
  });

  async function refusedCleanly(press: () => Promise<unknown>, code: string, truckId = t.id) {
    const before = await footprint(truckId);
    expect(await codeOf(press())).toBe(code);
    expect(await footprint(truckId)).toEqual(before);
  }

  it('the power, then the scope at both ends', async () => {
    await refusedCleanly(() => reroute(P.opA, t.id, W.a.id, W.b.id), 'forbidden');
    await refusedCleanly(() => reroute(P.plannerAtB, t.id, W.a.id, W.b.id), 'out_of_scope');
    await refusedCleanly(() => reroute(P.plannerAtA, t.id, W.a.id, W.b.id), 'out_of_scope');
  });

  it('the reason, the chosen warehouse, and a truck that is not there', async () => {
    await refusedCleanly(() => reroute(P.logistA, t.id, W.a.id, W.b.id, ' ab '), 'reason_required');
    await refusedCleanly(() => reroute(P.logistA, t.id, W.a.id, W.b.id, 'x'.repeat(501)), 'reason_too_long');
    await refusedCleanly(() => reroute(P.logistA, t.id, W.a.id, 'x'), 'bad_target');
    expect(await codeOf(reroute(P.logistA, uuidv4(), W.a.id, W.b.id))).toBe('batch_not_found');
  });

  it('the truck’s own ends, the target’s state, and another country', async () => {
    await refusedCleanly(() => reroute(P.logistA, t.id, W.a.id, W.a.id), 'same_destination');
    await refusedCleanly(() => reroute(P.logistA, t.id, W.a.id, W.org.id), 'destination_is_origin');
    await refusedCleanly(() => reroute(P.logistA, t.id, W.a.id, W.off.id), 'target_inactive');
    await refusedCleanly(() => reroute(P.logistA, t.id, W.a.id, W.cn.id), 'other_country');
    await refusedCleanly(() => reroute(P.logistA, t.id, W.a.id, uuidv4()), 'bad_target');
  });

  it('a country nobody typed', async () => {
    await db.update(warehouses).set({ country: '' }).where(eq(warehouses.id, W.odd.id));
    try {
      await refusedCleanly(() => reroute(P.logistA, t.id, W.a.id, W.odd.id), 'country_unknown');
    } finally {
      await db.update(warehouses).set({ country: 'UZ' }).where(eq(warehouses.id, W.odd.id));
    }
  });

  it('a truck still loading, and one that has arrived', async () => {
    const [loading] = await db
      .insert(batches)
      .values({
        code: `RRL${S}`,
        originWarehouseId: W.org.id,
        destWarehouseId: W.a.id,
        status: 'loading',
        createdBy: P.logistA.id,
      })
      .returning({ id: batches.id });
    madeTrucks.push(loading!.id);
    await refusedCleanly(() => reroute(P.logistA, loading!.id, W.a.id, W.b.id), 'not_in_transit', loading!.id);

    const arrived = await truckOnRoad(2);
    const [ack] = await ingestUnloadScans([scan(arrived.id, arrived.lot.codes[0]!)], ctx(), NO_DOOR, {
      expectDest: new Map([[arrived.id, W.a.id]]),
    });
    expect(ack!.result).toBe('ok');
    await refusedCleanly(() => reroute(P.logistA, arrived.id, W.a.id, W.b.id), 'not_in_transit', arrived.id);
  });

  it('two presses that both saw RRA: the second is refused, never chained', async () => {
    const race = await truckOnRoad(1);
    await reroute(P.logistA, race.id, W.a.id, W.b.id);
    await refusedCleanly(() => reroute(P.logistB, race.id, W.a.id, W.c.id), 'dest_changed', race.id);
    expect((await truckRow(race.id)).destWarehouseId).toBe(W.b.id);
  });
});

describe('3 — the pin is kept, and read by the road', () => {
  it('a Kyrgyzstan pin on KA → TAS1 survives TAS2, hides on a road with no pins, and returns', async () => {
    const pin = { key: 'in_kg', at: new Date().toISOString() };
    const [row] = await db
      .insert(batches)
      .values({
        code: `RRP${S}`,
        originWarehouseId: demo.KA,
        destWarehouseId: demo.TAS1,
        status: 'in_transit',
        departedAt: new Date(),
        trackingCheckpoint: pin,
        createdBy: P.logistA.id,
      })
      .returning({ id: batches.id });
    demoTrucks.push(row!.id);

    const toTas2 = await reroute(P.logistA, row!.id, demo.TAS1, demo.TAS2);
    expect((await truckRow(row!.id)).trackingCheckpoint).toEqual(pin);
    expect(checkpointsFor('KA', 'TAS2', 'UZ')).toContain('in_kg');
    expect(pinOnRoute(pin, 'KA', 'TAS2', 'UZ')).toEqual(pin);
    expect(toTas2.pinOffRoute).toBe(false);
    expect(toTas2.noSchedule).toBe(false);

    // A warehouse the map has no road to: no pin drawn, no date anywhere.
    const toMinted = await reroute(P.logistA, row!.id, demo.TAS2, W.a.id);
    expect((await truckRow(row!.id)).trackingCheckpoint).toEqual(pin);
    expect(pinOnRoute(pin, 'KA', W.a.code, 'UZ')).toBeNull();
    expect(toMinted.pinOffRoute).toBe(true);
    expect(toMinted.noSchedule).toBe(true);

    // …and back: the pin reads again, because nothing deleted it.
    await reroute(P.logistA, row!.id, W.a.id, demo.TAS1);
    expect(pinOnRoute((await truckRow(row!.id)).trackingCheckpoint, 'KA', 'TAS1', 'UZ')).toEqual(pin);
  });
});

describe('4 — the first scan against a reroute, made deterministic', () => {
  it('a scan waiting on the truck row reads the new destination and refuses itself', async () => {
    const t = await truckOnRoad(1);
    const [ack] = await withTruckHeld(
      t.id,
      () =>
        ingestUnloadScans([scan(t.id, t.lot.codes[0]!)], ctx(), NO_DOOR, { expectDest: new Map([[t.id, W.a.id]]) }),
      async (held) => {
        await held`UPDATE batches SET dest_warehouse_id = ${W.b.id} WHERE id = ${t.id}`;
      },
    );
    expect(ack).toMatchObject({ result: 'rejected', detail: 'batch_rerouted', rerouteTo: W.b.code });
    const box = await boxRow(t.lot.boxIds[0]!);
    expect(box.status).toBe('in_transit');
    expect(box.currentWarehouseId).toBeNull();
    expect((await truckRow(t.id)).status).toBe('in_transit');
  });
});

describe('5 — every unload door judges the warehouse it was authorized at', () => {
  it('(a) a phone admitted at RRA after the truck went to RRB lands nothing', async () => {
    const t = await truckOnRoad(1);
    await reroute(P.logistA, t.id, W.a.id, W.b.id);
    const [ack] = await ingestUnloadScans([scan(t.id, t.lot.codes[0]!)], ctx(), NO_DOOR, {
      expectDest: new Map([[t.id, W.a.id]]),
    });
    expect(ack).toMatchObject({ result: 'rejected', detail: 'batch_rerouted', rerouteTo: W.b.code });
    expect((await boxRow(t.lot.boxIds[0]!)).status).toBe('in_transit');
    expect((await truckRow(t.id)).status).toBe('in_transit');
  });

  it('(b) arrived in between: RRB flipped it, and an RRA door still lands nothing at RRB', async () => {
    const t = await truckOnRoad(2);
    await reroute(P.logistA, t.id, W.a.id, W.b.id);
    const [first] = await ingestUnloadScans([scan(t.id, t.lot.codes[0]!)], ctx(), NO_DOOR, {
      expectDest: new Map([[t.id, W.b.id]]),
    });
    expect(first!.result).toBe('ok');
    expect((await truckRow(t.id)).status).toBe('arrived');
    const [late] = await ingestUnloadScans([scan(t.id, t.lot.codes[1]!)], ctx(), NO_DOOR, {
      expectDest: new Map([[t.id, W.a.id]]),
    });
    expect(late).toMatchObject({ result: 'rejected', detail: 'batch_rerouted' });
    const box = await boxRow(t.lot.boxIds[1]!);
    expect(box.status).toBe('in_transit');
    expect(box.currentWarehouseId).toBeNull();
  });

  it('(c) «Tushirish tugadi» from the old warehouse’s page refuses on the locked row', async () => {
    const t = await truckOnRoad(1);
    await reroute(P.logistA, t.id, W.a.id, W.b.id);
    expect(await codeOf(finishUnload(t.id, ctx(), { mayCloseWithMissing: true, expectDestId: W.a.id }))).toBe(
      'batch_rerouted',
    );
    const after = await truckRow(t.id);
    expect(after.status).toBe('in_transit');
    expect((await boxRow(t.lot.boxIds[0]!)).flags).toEqual([]);
  });

  it('(d) «Hammasini qabul qilish» from the old page refuses, with no «0 accepted» audit row', async () => {
    const t = await truckOnRoad(2);
    await reroute(P.logistA, t.id, W.a.id, W.b.id);
    expect(await codeOf(unloadRemaining(t.id, ctx(), { expectDestId: W.a.id }))).toBe('batch_rerouted');
    const bulk = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, t.id), sql`${auditLog.after} ? 'bulkUnload'`));
    expect(bulk).toEqual([]);
    expect((await boxRow(t.lot.boxIds[0]!)).status).toBe('in_transit');
  });

  it('(d′) …and when the reroute lands between its read and its first carton, still no audit row', async () => {
    const t = await truckOnRoad(2);
    const answer = await withTruckHeld(
      t.id,
      () => codeOf(unloadRemaining(t.id, ctx())),
      async (held) => {
        await held`UPDATE batches SET dest_warehouse_id = ${W.b.id} WHERE id = ${t.id}`;
      },
    );
    expect(answer).toBe('batch_rerouted');
    const bulk = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, t.id), sql`${auditLog.after} ? 'bulkUnload'`));
    expect(bulk).toEqual([]);
    for (const id of t.lot.boxIds) expect((await boxRow(id)).status).toBe('in_transit');
  });

  it('(e) the count doors minted at RRA answer «rerouted», not «no permission»', async () => {
    const t = await truckOnRoad(2);
    await reroute(P.logistA, t.id, W.a.id, W.b.id);
    const dest = countDoorFor(P.logistA, W.a.id)!;
    expect(dest).not.toBeNull();
    expect(
      await codeOf(
        countAcceptLot(
          { batchId: t.id, lotId: t.lot.lotId, target: 2, seenArrived: 0, pressId: uuidv4(), confirmArrival: true },
          ctx(),
          { dest, origin: null },
        ),
      ),
    ).toBe('batch_rerouted');
    expect(
      await codeOf(
        countAcceptCrate({ batchId: t.id, crateId: uuidv4(), pressId: uuidv4(), confirmArrival: true }, ctx(), { dest }),
      ),
    ).toBe('batch_rerouted');
    // Another person's door is still a plain refusal (#790).
    const foreign = countDoorFor(P.logistB, W.a.id)!;
    expect(
      await codeOf(
        countAcceptCrate({ batchId: t.id, crateId: uuidv4(), pressId: uuidv4(), confirmArrival: true }, ctx(), {
          dest: foreign,
        }),
      ),
    ).toBe('forbidden');
    for (const id of t.lot.boxIds) expect((await boxRow(id)).status).toBe('in_transit');
  });

  it('(f) a finish committed between the read and the lock: refused, nothing landed', async () => {
    const t = await truckOnRoad(1);
    const [ack] = await withTruckHeld(
      t.id,
      () =>
        ingestUnloadScans([scan(t.id, t.lot.codes[0]!)], ctx(), NO_DOOR, { expectDest: new Map([[t.id, W.a.id]]) }),
      async (held) => {
        await held`UPDATE batches SET status = 'unloaded' WHERE id = ${t.id}`;
      },
    );
    expect(ack).toMatchObject({ result: 'rejected', detail: 'batch_not_unloading' });
    expect((await boxRow(t.lot.boxIds[0]!)).status).toBe('in_transit');
  });
});

describe('6 — the phone’s sync, per truck (the blocker)', () => {
  it('a truck lost to a reroute is answered, a foreign one withheld, a missing one named — the rest land', async () => {
    const lost = await truckOnRoad(2); // A: rerouted RRA → RRB, scans queued at RRA
    const mine = await truckOnRoad(2); // B: heading to RRA
    const foreign = await truckOnRoad(1, W.c); // C: never RRA's
    await reroute(P.logistA, lost.id, W.a.id, W.b.id);
    const missing = uuidv4();
    const unload = (batchId: string, code: string): SyncItem => ({
      ...scan(batchId, code),
      addedOnSpot: false,
      scanType: 'unload',
    });
    const body: SyncItem[] = [
      ...lost.lot.codes.map((c) => unload(lost.id, c)),
      ...mine.lot.codes.map((c) => unload(mine.id, c)),
      unload(foreign.id, foreign.lot.codes[0]!),
      unload(missing, 'YW26-000001'),
    ];
    const result = await syncScans(P.opA, body, META);

    const byUuid = new Map(result.acks.map((a) => [a.clientEventUuid, a]));
    for (const row of body.slice(0, 2)) {
      expect(byUuid.get(row.clientEventUuid)).toMatchObject({
        result: 'rejected',
        detail: 'batch_rerouted',
        rerouteTo: W.b.code,
        scannedCode: row.code,
      });
    }
    for (const row of body.slice(2, 4)) expect(byUuid.get(row.clientEventUuid)?.result).toBe('ok');
    for (const id of mine.lot.boxIds) expect((await boxRow(id)).currentWarehouseId).toBe(W.a.id);
    // The foreign truck's row is not answered — it stays on the phone.
    expect(byUuid.has(body[4]!.clientEventUuid)).toBe(false);
    expect(result.withheld).toEqual([foreign.id]);
    expect(byUuid.get(body[5]!.clientEventUuid)).toMatchObject({ result: 'rejected', detail: 'batch_not_found' });
    // Nothing of the lost truck landed anywhere.
    for (const id of lost.lot.boxIds) expect((await boxRow(id)).status).toBe('in_transit');
    // The route answers 200 whenever something was acked.
    expect(result.acks.length > 0 || result.withheld.length === 0).toBe(true);
  });

  it('a row scanned for the OLD destination is refused for an unscoped logist too — judged at scan time', async () => {
    // The reroute review: the sync used to judge the destination when the
    // body ARRIVED. A logist or an admin passes at any warehouse, so the
    // cartons they scanned at RRA's gate — queued while the truck was still
    // heading there — landed at RRB, flipped the truck arrived at RRB and
    // told RRB's customers, while the cartons stood at RRA.
    const t = await truckOnRoad(3);
    const unloadRow = (code: string, expectDestId?: string): SyncItem => ({
      ...scan(t.id, code),
      addedOnSpot: false,
      scanType: 'unload',
      ...(expectDestId ? { expectDestId } : {}),
    });
    const atOldGate = [unloadRow(t.lot.codes[0]!, W.a.id), unloadRow(t.lot.codes[1]!, W.a.id)];
    await reroute(P.logistA, t.id, W.a.id, W.b.id);

    const first = await syncScans(P.logistB, atOldGate, META);
    expect(first.withheld).toEqual([]);
    for (const row of atOldGate) {
      expect(first.acks.find((a) => a.clientEventUuid === row.clientEventUuid)).toMatchObject({
        result: 'rejected',
        detail: 'batch_rerouted',
        rerouteTo: W.b.code,
        batchCode: t.code,
        scannedCode: row.code,
      });
    }
    for (const id of t.lot.boxIds.slice(0, 2)) {
      const box = await boxRow(id);
      expect(box.status).toBe('in_transit');
      expect(box.currentWarehouseId).toBeNull();
    }
    expect((await truckRow(t.id)).status).toBe('in_transit');

    // A scan drawn for RRB, after the reroute, lands there…
    const [atNewGate] = (await syncScans(P.logistB, [unloadRow(t.lot.codes[0]!, W.b.id)], META)).acks;
    expect(atNewGate!.result).toBe('ok');
    expect((await boxRow(t.lot.boxIds[0]!)).currentWarehouseId).toBe(W.b.id);
    // …and a row from an older phone, which names no destination, is judged
    // at the live one, as it always was.
    const [legacy] = (await syncScans(P.logistB, [unloadRow(t.lot.codes[2]!)], META)).acks;
    expect(legacy!.result).toBe('ok');
    expect((await boxRow(t.lot.boxIds[2]!)).currentWarehouseId).toBe(W.b.id);
  });
});

describe('7 — who hears it (the owner’s 4a)', () => {
  async function notified(truckId: string, nth: number) {
    const evs = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.type, 'BatchRerouted'), eq(events.entityId, truckId)))
      .orderBy(asc(events.id));
    const rows = await db
      .select({ userId: notifications.userId, payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.eventId, evs[nth]!.id), eq(notifications.channel, 'telegram')));
    return new Map(rows.map((r) => [r.userId, (r.payload as { audience?: string }).audience ?? null]));
  }

  it('the new warehouse’s staff and the logists; later, the warehouse the truck no longer comes to', async () => {
    const t = await truckOnRoad(2);
    await reroute(P.logistA, t.id, W.a.id, W.b.id);
    await processPendingEvents();
    const first = await notified(t.id, 0);
    expect(first.get(P.opB.id)).toBe('to');
    expect(first.get(P.logistB.id)).toBe('logist');
    // His «hammasi standart» (2026-09-30), pinned: the planned warehouse (6b),
    // a logist scoped only to it (8b), the admins (9b) and the VED (10d) —
    // none of them is told on a first reroute.
    for (const nobody of [P.opA.id, P.admin.id, P.logistA.id, P.logistFar.id, P.opC.id, P.plannerAtA.id, P.ved.id]) {
      expect(first.has(nobody), nobody).toBe(false);
    }

    await reroute(P.logistB, t.id, W.b.id, W.c.id);
    await processPendingEvents();
    const second = await notified(t.id, 1);
    expect(second.get(P.opC.id)).toBe('to');
    expect(second.get(P.opB.id)).toBe('from');
    expect(second.get(P.logistA.id)).toBe('logist');
    // The originally planned warehouse is not told (a question to the owner).
    expect(second.has(P.opA.id)).toBe(false);
    expect(second.has(P.logistB.id)).toBe(false);
    expect(second.has(P.plannerAtA.id)).toBe(false);
    expect(second.has(P.admin.id)).toBe(false);
    expect(second.has(P.ved.id)).toBe(false);

    const [event] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.type, 'BatchRerouted'), eq(events.entityId, t.id)))
      .orderBy(asc(events.id))
      .limit(1);
    const payload = event!.payload as Record<string, unknown>;
    for (const locale of ['uz', 'zh-CN']) {
      const to = renderTelegramText('BatchRerouted', { ...payload, audience: 'to' }, locale);
      expect(to).toContain('📦 2 ');
      expect(to).not.toContain(`${W.a.code} → ${W.b.code}`);
      expect(to).toContain(`${W.org.code} → ${W.b.code}`);
      const withdrawn = renderTelegramText('BatchRerouted', { ...payload, audience: 'from' }, locale);
      expect(withdrawn).not.toContain('/batches/');
    }
    expect(renderTelegramText('BatchRerouted', { ...payload, audience: 'from' }, 'uz')).toContain('endi sizga kelmaydi');
  });

  it('the planned warehouse told «coming to you» by a reroute BACK is told «not any more» when it goes again', async () => {
    // RRA (planned) → RRB → RRA → RRC: the second reroute promised RRA the
    // truck in words, so the third must withdraw it — «is it the planned
    // warehouse» is the wrong question, «did a reroute tell it» the right one.
    const t = await truckOnRoad(1);
    await reroute(P.logistA, t.id, W.a.id, W.b.id);
    await reroute(P.logistA, t.id, W.b.id, W.a.id);
    await reroute(P.logistA, t.id, W.a.id, W.c.id);
    await processPendingEvents();
    expect((await notified(t.id, 0)).has(P.opA.id)).toBe(false);
    const back = await notified(t.id, 1);
    expect(back.get(P.opA.id)).toBe('to');
    expect(back.get(P.opB.id)).toBe('from');
    const third = await notified(t.id, 2);
    expect(third.get(P.opA.id)).toBe('from');
    expect(third.get(P.opC.id)).toBe('to');
    // RRB was withdrawn on the way back; it is not told a second time.
    expect(third.has(P.opB.id)).toBe(false);
    const flags = await db
      .select({ told: sql<boolean>`(${events.payload}->>'fromWasTold')::boolean` })
      .from(events)
      .where(and(eq(events.type, 'BatchRerouted'), eq(events.entityId, t.id)))
      .orderBy(asc(events.id));
    expect(flags.map((f) => f.told)).toEqual([false, true, true]);
  });
});

describe('8 — the history and «Rejada»', () => {
  it('ordered by commit, dated, and the chip hides when the truck is sent back', async () => {
    const t = await truckOnRoad(1);
    await reroute(P.logistA, t.id, W.a.id, W.b.id, 'birinchi');
    await reroute(P.logistA, t.id, W.b.id, W.c.id, 'ikkinchi');
    const history = await rerouteHistory(t.id);
    expect(history.map((r) => [r.fromCode, r.toCode, r.reason])).toEqual([
      [W.a.code, W.b.code, 'birinchi'],
      [W.b.code, W.c.code, 'ikkinchi'],
    ]);
    expect(history[0]!.at).toBeInstanceOf(Date);
    expect(history[0]!.who).toBe(P.logistA.fullName);
    expect(BigInt(history[1]!.id) > BigInt(history[0]!.id)).toBe(true);
    const planned = (await departureDestination(t.id))?.code ?? history[0]!.fromCode;
    expect(planned).toBe(W.a.code);
    const chip = (dest: string) => planned !== dest;
    expect(chip(W.c.code)).toBe(true);
    await reroute(P.logistA, t.id, W.c.id, W.a.id, 'qaytdi');
    expect(chip((await db.query.warehouses.findFirst({ where: eq(warehouses.id, (await truckRow(t.id)).destWarehouseId) }))!.code)).toBe(false);
  });
});

describe('10 — the doors as the buttons press them', () => {
  async function signIn(person: Person) {
    const row = (await db.query.users.findFirst({ where: eq(users.id, person.id) }))!;
    session.user = {
      id: row.id,
      phone: row.phone,
      username: row.username,
      fullName: row.fullName,
      locale: row.locale,
      active: true,
      sessionId: '00000000-0000-4000-8000-0000000e0b00',
    };
  }

  it('authorize and mayAt give one answer over sampled people and warehouses', async () => {
    for (const person of [P.logistA, P.opA, P.opB, P.plannerAtA, P.admin]) {
      await signIn(person);
      for (const permission of ['scan.unload', 'plans.manage', 'scan.load'] as const) {
        for (const wh of [W.a.id, W.b.id, W.org.id]) {
          let gate = true;
          try {
            await authorize(permission, { warehouseId: wh });
          } catch (err) {
            if (!(err instanceof AuthError)) throw err;
            gate = false;
          }
          expect([person.fullName, permission, wh, gate]).toEqual([
            person.fullName,
            permission,
            wh,
            mayAt(person, permission, wh),
          ]);
        }
      }
    }
  });

  it('rerouteBatchAction: the grant, then the scope, in words — and a logist’s press goes through', async () => {
    const t = await truckOnRoad(1);
    const press = () =>
      rerouteBatchAction({ batchId: t.id, destWarehouseId: W.b.id, seenDestWarehouseId: W.a.id, reason: 'Yo‘l yopiq' });
    await signIn(P.opA);
    expect(await press()).toEqual({ ok: false, error: 'forbidden' });
    await signIn(P.plannerAtB);
    expect(await press()).toEqual({ ok: false, error: 'out_of_scope' });
    await signIn(P.logistA);
    expect(await rerouteBatchAction({ batchId: 'x' })).toEqual({ ok: false, error: 'validation' });
    expect(await press()).toEqual({ ok: true, toCode: W.b.code, pinOffRoute: false, noSchedule: true });
    expect((await truckRow(t.id)).destWarehouseId).toBe(W.b.id);
    // The same stale page again: the compare-and-set, in words.
    expect(await press()).toEqual({ ok: false, error: 'dest_changed' });
    // A planner scoped to the OLD destination, on the tab drawn before: the
    // card's door shut because somebody moved the truck — said as that, not
    // as «not assigned to you» (the reroute review).
    await signIn(P.plannerAtA);
    expect(await press()).toEqual({ ok: false, error: 'dest_changed' });
    // …and an expired session is «sign in again», not «only an admin or a logist».
    session.user = null;
    expect(await press()).toEqual({ ok: false, error: 'unauthenticated' });
  });

  it('an empty target list says whether there is none or none of them is yours', async () => {
    const t = await truckOnRoad(1);
    const truck = await truckRow(t.id);
    const head = { originCode: W.org.code, destCountry: 'UZ' };
    // Scoped to RRA only: every other UZ warehouse is admissible and not theirs.
    const scoped = await rerouteTargets(truck, head, P.plannerAtA);
    expect(scoped.options).toEqual([]);
    expect(scoped.hiddenByScope).toBeGreaterThan(0);
    const all = await rerouteTargets(truck, head, P.logistA);
    expect(all.hiddenByScope).toBe(0);
    expect(all.options.map((o) => o.id)).toEqual(expect.arrayContaining([W.b.id, W.c.id]));
    // 11a: another country is never offered, not merely refused on the press.
    expect(all.options.map((o) => o.id)).not.toContain(W.cn.id);
  });

  it('a page drawn for RRA before the reroute: every office button says «rerouted», none lands anything', async () => {
    const t = await truckOnRoad(2);
    await reroute(P.logistA, t.id, W.a.id, W.b.id);
    // The old warehouse's own operator: authorized at the page's warehouse,
    // refused by the service — «the destination changed», never «no right».
    // Every refusal names WHERE the truck goes now (the reroute review): the
    // buttons print the phone's own sentence and do not refresh into a 404.
    await signIn(P.opA);
    expect(await finishUnloadAction(t.id, W.a.id)).toEqual({ ok: false, error: 'batch_rerouted', to: W.b.code });
    // An unscoped logist on the stale page is refused the same way.
    await signIn(P.logistA);
    expect(await unloadRemainingAction(t.id, W.a.id)).toEqual({ ok: false, error: 'batch_rerouted', to: W.b.code });
    expect(
      await countAcceptLotAction({
        batchId: t.id,
        lotId: t.lot.lotId,
        target: 2,
        seenArrived: 0,
        pressId: uuidv4(),
        confirmArrival: true,
        seenDestWarehouseId: W.a.id,
      }),
    ).toMatchObject({ ok: false, error: 'batch_rerouted', detail: { to: W.b.code } });
    expect(
      await countAcceptCrateAction({
        batchId: t.id,
        crateId: uuidv4(),
        pressId: uuidv4(),
        confirmArrival: true,
        seenDestWarehouseId: W.a.id,
      }),
    ).toMatchObject({ ok: false, error: 'batch_rerouted', detail: { to: W.b.code } });
    for (const id of t.lot.boxIds) expect((await boxRow(id)).status).toBe('in_transit');
    expect((await truckRow(t.id)).status).toBe('in_transit');
    session.user = null;
  });
});

describe('9 — the customer’s records keep what happened', () => {
  it('the lenta still names the warehouse the truck left for; the journey’s rows are untouched', async () => {
    const t = await truckOnRoad(1);
    const departedRow = async () =>
      (await clientFeed(clientId, { money: false, limit: 200 })).find(
        (item) => item.kind === 'departed' && item.meta.batch === t.code,
      );
    const movements = () =>
      db
        .select({ cause: boxMovements.cause, to: boxMovements.toWarehouseId })
        .from(boxMovements)
        .where(eq(boxMovements.boxId, t.lot.boxIds[0]!))
        .orderBy(asc(boxMovements.createdAt));
    const before = { feed: await departedRow(), moves: await movements() };
    expect(before.feed?.meta.warehouse).toBe(W.a.code);
    await reroute(P.logistA, t.id, W.a.id, W.b.id);
    const after = { feed: await departedRow(), moves: await movements() };
    expect(after.feed?.meta.warehouse).toBe(W.a.code);
    expect(after.moves).toEqual(before.moves);
  });
});
