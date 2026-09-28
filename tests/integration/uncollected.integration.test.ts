import 'dotenv/config';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  boxes,
  boxMovements,
  cargoWaitAlerts,
  clients,
  clientTransactions,
  handovers,
  notifications,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { stockAging, unclaimedReport, unclaimedSummary, warehouseFill } from '@/modules/wms/reports/queries';
import { sendDailyDigest } from '@/modules/wms/reports/daily-digest';
import {
  readUncollectedFilters,
  rowsInTab,
  uncollectedCargo,
  uncollectedCount,
  uncollectedPageQuery,
  uncollectedScope,
  waitLevel,
  waitThresholds,
  waitingDebtors,
  waitingPriceGate,
  type UncollectedQuery,
} from '@/modules/wms/issue/waiting';
import { crossedOn, sweepCargoWaiting, waitingDigestSection } from '@/modules/wms/issue/waiting-alerts';
import { salesFlowCounts } from '@/modules/wms/home/role-flows';

/**
 * «Olib ketilmagan yuk» (0116, the owner's 3a) against a real database.
 *
 * Every clock is PINNED (`BASE` is 09:00 in Tashkent) and every landing is a
 * fixed instant relative to it — never «now minus N hours», which lands on
 * yesterday for the first five hours of a Tashkent day (R5, #1063). The file
 * mints its own warehouses, sellers and clients, passes its thresholds'
 * clients through the sweep's `clientIds` seam (#713: CI shares one database,
 * and an unbounded sweep would claim and message other files' fixtures), and
 * deactivates the configuration it made (#183 — deactivated, never deleted,
 * because of the audit FK).
 *
 * One seller's send can be POISONED: the sweep's per-seller try/catch is the
 * thing under test there (the design review's #4).
 */

const poison = vi.hoisted(() => ({ ids: new Set<string>() }));
vi.mock('@/modules/platform/notifications/staff', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/platform/notifications/staff')>();
  return {
    ...real,
    notifyStaffTelegram: async (input: Parameters<typeof real.notifyStaffTelegram>[0]) => {
      if (input.userIds.some((id) => poison.ids.has(id))) throw new Error('poisoned send');
      return real.notifyStaffTelegram(input);
    },
  };
});

const STAMP = String(Date.now()).slice(-6);
let seq = 0;
const next = () => `${STAMP}${String(++seq).padStart(2, '0')}`;

/** 09:00 on 2026-09-26 in Tashkent. */
const BASE = new Date('2026-09-26T04:00:00Z');
const DAY = 86_400_000;
const before = (days: number, from = BASE) => new Date(from.getTime() - days * DAY);

let actorId = '';
let whYw = '';
let whTas = '';
let whAnd = '';
const madeUsers: string[] = [];
const madeClients: { id: string; code: string }[] = [];
const madeReceipts: string[] = [];
const madeWarehouses: string[] = [];

async function mintUser(name: string, muted: string[] = []): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      phone: `+99897${next()}`,
      fullName: `${name} ${STAMP}`,
      passwordHash: 'x',
      active: true,
      mutedNotificationTypes: muted,
    })
    .returning({ id: users.id });
  madeUsers.push(u!.id);
  return u!.id;
}

async function mintWarehouse(
  prefix: string,
  opts: { country: string; type: string; issues: boolean },
): Promise<string> {
  const code = `${prefix}${next()}`;
  const [row] = await db
    .insert(warehouses)
    .values({
      code,
      name: `OK ${code}`,
      country: opts.country,
      type: opts.type,
      timezone: opts.country === 'CN' ? 'Asia/Shanghai' : 'Asia/Tashkent',
      batchPrefix: code,
      issuesToClients: opts.issues,
    })
    .returning({ id: warehouses.id });
  madeWarehouses.push(row!.id);
  return row!.id;
}

async function mintClient(sellerId: string | null): Promise<{ id: string; code: string }> {
  const tag = next();
  const code = `OK${tag}`;
  // A phone of this run's OWN: a fixed number is another file's fixture —
  // the Telegram bridge matches clients by phone, and vitest runs files side
  // by side on one database.
  const [row] = await db
    .insert(clients)
    .values({ clientCode: code, name: `Olib ${code}`, salesManagerId: sellerId, phones: [`+9989${tag.slice(-8)}`] })
    .returning({ id: clients.id });
  const made = { id: row!.id, code };
  madeClients.push(made);
  return made;
}

interface Cargo {
  clientId: string | null;
  marking?: string;
  /** The day the goods came in — the receipt's `received_at`. */
  receivedAt: Date;
  /** Where the prixod was typed. */
  receiptWh: string;
  /** The receipt movement's own minute (an office prixod is typed late). */
  typedAt?: Date;
  boxes: number;
  kg: number;
  m3: number;
  /** Where the cartons stand now and how they got there. */
  standAt: string;
  status: 'in_stock' | 'ready_for_pickup';
  /** A road landing into `standAt`; absent = a walk-in there. */
  landedAt?: Date;
}

async function cargo(c: Cargo) {
  const [receipt] = await db
    .insert(receipts)
    .values({
      warehouseId: c.receiptWh,
      clientId: c.clientId,
      unclaimedMarking: c.marking ?? null,
      status: 'confirmed',
      receivedAt: c.receivedAt,
      confirmedAt: c.typedAt ?? c.receivedAt,
      createdBy: actorId,
    })
    .returning({ id: receipts.id });
  madeReceipts.push(receipt!.id);
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: receipt!.id,
      seq: 1,
      letter: 'A',
      dimsMode: 'mixed',
      productNameZh: '测试',
      productNameRu: `Tovar ${STAMP}`,
      boxCount: c.boxes,
      totalWeightKg: String(c.kg),
      totalVolumeM3: String(c.m3),
    })
    .returning({ id: receiptLots.id });
  const boxRows = await db
    .insert(boxes)
    .values(
      Array.from({ length: c.boxes }, (_, i) => ({
        lotId: lot!.id,
        shortCode: `OK${next()}-${i}`,
        seqInLot: i + 1,
        status: c.status,
        currentWarehouseId: c.standAt,
      })),
    )
    .returning({ id: boxes.id });
  const boxIds = boxRows.map((b) => b.id);
  // The receipt writes a movement from NULL, dated the minute it was TYPED.
  await db.insert(boxMovements).values(
    boxIds.map((boxId) => ({
      boxId,
      fromWarehouseId: null,
      toWarehouseId: c.receiptWh,
      fromStatus: null,
      toStatus: 'in_stock',
      cause: 'receipt',
      refType: 'receipt',
      refId: receipt!.id,
      actorId,
      createdAt: c.typedAt ?? c.receivedAt,
    })),
  );
  if (c.landedAt) {
    await db.insert(boxMovements).values(
      boxIds.map((boxId) => ({
        boxId,
        fromWarehouseId: c.receiptWh,
        toWarehouseId: c.standAt,
        fromStatus: 'in_transit',
        toStatus: c.status,
        cause: 'unload_scan',
        refType: 'batch',
        refId: null,
        actorId,
        createdAt: c.landedAt!,
      })),
    );
  }
  return { receiptId: receipt!.id, lotId: lot!.id, boxIds };
}

/** A client collected these cartons at `wh` at `at`. */
async function pickup(clientId: string, wh: string, at: Date, boxIds: string[]) {
  await db.insert(handovers).values({
    clientId,
    warehouseId: wh,
    kind: 'issued_to_client',
    personName: 'Olib ketuvchi',
    personPhone: '+998900000000',
    createdBy: actorId,
    createdAt: at,
  });
  if (boxIds.length) {
    await db.update(boxes).set({ status: 'issued', currentWarehouseId: null }).where(inArray(boxes.id, boxIds));
  }
}

/** The list for these clients, the way every caller asks it. */
function list(clientIds: string[], extra: Partial<UncollectedQuery> = {}, asOf = BASE) {
  return uncollectedCargo(db, {
    asOf,
    minDays: 0,
    ownerId: undefined,
    warehouseIds: undefined,
    clientIds,
    ...extra,
  });
}

async function waitingMessages(sellerId: string): Promise<{ text: string; status: string }[]> {
  // Oldest first, by an ORDER BY — an unordered read comes back in whatever
  // order the heap holds it (67b).
  const rows = await db
    .select({ payload: notifications.payload, status: notifications.status })
    .from(notifications)
    .where(and(eq(notifications.userId, sellerId), eq(notifications.type, 'CargoWaiting')))
    .orderBy(asc(notifications.createdAt), asc(notifications.id));
  return rows.map((r) => ({ text: String((r.payload as { text?: string }).text ?? ''), status: r.status }));
}

beforeAll(async () => {
  actorId = await mintUser('Olib actor');
  whYw = await mintWarehouse('OY', { country: 'CN', type: 'origin', issues: false });
  whTas = await mintWarehouse('OT', { country: 'UZ', type: 'distribution', issues: true });
  whAnd = await mintWarehouse('OA', { country: 'UZ', type: 'customs', issues: true });
});

afterAll(async () => {
  const clientIds = madeClients.map((c) => c.id);
  if (clientIds.length) {
    await db.delete(cargoWaitAlerts).where(inArray(cargoWaitAlerts.clientId, clientIds));
    await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, clientIds));
    await db.delete(handovers).where(inArray(handovers.clientId, clientIds));
  }
  if (madeReceipts.length) {
    const lotIds = (
      await db.select({ id: receiptLots.id }).from(receiptLots).where(inArray(receiptLots.receiptId, madeReceipts))
    ).map((r) => r.id);
    if (lotIds.length) {
      const boxIds = (await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds))).map(
        (b) => b.id,
      );
      if (boxIds.length) {
        await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
        await db.delete(boxes).where(inArray(boxes.id, boxIds));
      }
      await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
    }
    await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  }
  if (madeUsers.length) await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
  // The svodka went to every office person in the database; its rows that
  // name this file's clients go with it.
  for (const c of madeClients) {
    await db
      .delete(notifications)
      .where(and(eq(notifications.type, 'DailyDigest'), sql`${notifications.payload}->>'text' LIKE ${`%${c.code}%`}`));
  }
  if (clientIds.length) await db.update(clients).set({ active: false }).where(inArray(clients.id, clientIds));
  if (madeWarehouses.length) {
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, madeWarehouses));
  }
  if (madeUsers.length) await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  await pgClient.end();
});

describe('the svodka and the reports age a carton from where it stands', () => {
  it('a carton received in China 40 days ago that landed 2 days ago is NOT stale; one that landed 35 days ago is', async () => {
    const seller = await mintUser('Svodka seller');
    const c = await mintClient(seller);
    await cargo({
      clientId: c.id,
      receivedAt: before(40),
      receiptWh: whYw,
      boxes: 2,
      kg: 20,
      m3: 0.2,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: before(2),
    });
    await cargo({
      clientId: c.id,
      receivedAt: before(50),
      receiptWh: whYw,
      boxes: 3,
      kg: 30,
      m3: 0.3,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: before(35),
    });

    const [fill] = await warehouseFill([whTas], 30, BASE);
    // The received day would call BOTH stale; `in_stock` alone would call
    // neither, because every UZ warehouse lands cargo `ready_for_pickup`.
    expect(fill!.staleCount).toBe(3);
    expect(fill!.oldestDays).toBe(35);

    const aging = await stockAging([whTas], BASE);
    expect(aging.map((r) => r.days ?? -1).sort((a, b) => a - b)).toEqual([2, 35]);
  });

  it('a retired warehouse still holding cargo stays on the fill card and the svodka; a carton nobody can date reads «?», not «0»', async () => {
    const retired = await mintWarehouse('OR', { country: 'UZ', type: 'distribution', issues: false });
    const empty = await mintWarehouse('OE', { country: 'UZ', type: 'distribution', issues: false });
    const c = await mintClient(null);
    await cargo({
      clientId: c.id,
      receivedAt: before(60),
      receiptWh: whYw,
      boxes: 2,
      kg: 2,
      m3: 0.02,
      standAt: retired,
      status: 'in_stock',
      landedAt: before(40),
    });
    // A carton with no movement at all — no landing to count from.
    const ghost = await cargo({
      clientId: c.id,
      receivedAt: before(3),
      receiptWh: whYw,
      boxes: 1,
      kg: 1,
      m3: 0.01,
      standAt: retired,
      status: 'in_stock',
    });
    await db.delete(boxMovements).where(inArray(boxMovements.boxId, ghost.boxIds));
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, [retired, empty]));

    const fill = await warehouseFill([retired, empty], 30, BASE);
    // Switching the shed off moved none of its cargo; the empty one goes.
    expect(fill.map((w) => w.id)).toEqual([retired]);
    expect(fill[0]!.staleCount).toBe(2);
    expect(fill[0]!.oldestDays).toBe(40);

    const aging = await stockAging([retired], BASE);
    expect(aging.map((r) => r.days)).toEqual([null, 40]);
  });

  it('unclaimed cargo that crossed to Tashkent, or is on a truck, is still «egasiz yuk» — list and count agree', async () => {
    const marking = `MK${next()}`;
    await cargo({
      clientId: null,
      marking,
      receivedAt: before(20),
      receiptWh: whYw,
      boxes: 4,
      kg: 40,
      m3: 0.4,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: before(3),
    });
    // A second unclaimed prixod whose cartons are all on a TRUCK now: the road
    // is exactly when the office wants its owner named — it stays, «yo'lda».
    const onTruck = await cargo({
      clientId: null,
      marking: `MG${next()}`,
      receivedAt: before(20),
      receiptWh: whYw,
      boxes: 2,
      kg: 2,
      m3: 0.02,
      standAt: whYw,
      status: 'in_stock',
    });
    await db
      .update(boxes)
      .set({ status: 'in_transit', currentWarehouseId: null })
      .where(inArray(boxes.id, onTruck.boxIds));
    // A third, returned to its sender (`issued`, statusReason returned_to_sender):
    // resolved, and off every surface.
    const returned = await cargo({
      clientId: null,
      marking: `MR${next()}`,
      receivedAt: before(20),
      receiptWh: whYw,
      boxes: 3,
      kg: 3,
      m3: 0.03,
      standAt: whYw,
      status: 'in_stock',
    });
    await db
      .update(boxes)
      .set({ status: 'issued', statusReason: 'returned_to_sender', currentWarehouseId: null })
      .where(inArray(boxes.id, returned.boxIds));
    // A fourth, received at 23:30 Tashkent: its age is Tashkent CALENDAR days,
    // like every «N kun» in the svodka — eight at 09:00 on the 26th, not the
    // seven whole 24-hour periods since.
    const late = await cargo({
      clientId: null,
      marking: `ML${next()}`,
      receivedAt: new Date('2026-09-18T18:30:00Z'),
      receiptWh: whYw,
      boxes: 1,
      kg: 1,
      m3: 0.01,
      standAt: whYw,
      status: 'in_stock',
    });

    const report = await unclaimedReport([whYw], BASE);
    const row = report.find((r) => r.marking === marking);
    expect(row?.boxes).toBe(4);
    expect(row?.boxesOnRoad).toBe(0);
    expect(row?.days).toBe(20);
    const road = report.find((r) => r.id === onTruck.receiptId);
    expect(road?.boxes).toBe(2);
    expect(road?.boxesOnRoad).toBe(2);
    expect(report.map((r) => r.id)).not.toContain(returned.receiptId);
    expect(report.find((r) => r.id === late.receiptId)?.days).toBe(8);
    // The dashboard's row counts exactly what the list lists: the prixods with
    // cargo to resolve, and their cartons — never the one returned.
    expect(await unclaimedSummary([whYw])).toEqual({ receipts: 3, boxes: 7 });
    // …and the waiting list, which is about CLIENTS, does not carry it.
    const waiting = await uncollectedCargo(db, {
      asOf: BASE,
      minDays: 0,
      ownerId: undefined,
      warehouseIds: [whTas],
    });
    expect(waiting.rows.some((r) => r.clientCode.startsWith('MK'))).toBe(false);
  });
});

describe('the list', () => {
  it('counts Tashkent calendar days — a landing at 00:30 Tashkent belongs to that day, not the UTC one', async () => {
    const c = await mintClient(null);
    await cargo({
      clientId: c.id,
      receivedAt: new Date('2026-09-01T04:00:00Z'),
      receiptWh: whYw,
      boxes: 1,
      kg: 5,
      m3: 0.05,
      standAt: whTas,
      status: 'ready_for_pickup',
      // 2026-09-21 00:30 in Tashkent, still the 20th in UTC.
      landedAt: new Date('2026-09-20T19:30:00Z'),
    });
    const at9 = await list([c.id]);
    expect(at9.rows[0]!.days).toBe(5);
    expect(waitLevel(at9.rows[0]!.days, { warn: 5, alarm: 10 })).toBe(1);
    // 23:00 on the 25th in Tashkent: four days, not yet on the warn line.
    const lateEvening = await list([c.id], { minDays: 5 }, new Date('2026-09-25T18:00:00Z'));
    expect(lateEvening.rows).toHaveLength(0);
  });

  it('an office prixod typed six days late is six days old, not zero (the walk-in clock)', async () => {
    const c = await mintClient(null);
    await cargo({
      clientId: c.id,
      // Received at noon Tashkent six days ago, typed an hour before BASE.
      receivedAt: new Date('2026-09-20T07:00:00Z'),
      typedAt: new Date(BASE.getTime() - 3_600_000),
      receiptWh: whTas,
      boxes: 2,
      kg: 10,
      m3: 0.1,
      standAt: whTas,
      status: 'in_stock',
    });
    const got = await list([c.id]);
    expect(got.rows[0]!.days).toBe(6);
  });

  it('a partial pickup: the leftover is its SHARE of the lot, still aged from the landing, and marked', async () => {
    const seller = await mintUser('Share seller');
    const c = await mintClient(seller);
    const made = await cargo({
      clientId: c.id,
      receivedAt: before(30),
      receiptWh: whYw,
      boxes: 10,
      kg: 100,
      m3: 1,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: before(8),
    });
    const pickedAt = before(3);
    await pickup(c.id, whTas, pickedAt, made.boxIds.slice(0, 7));
    const [row] = (await list([c.id])).rows;
    expect(row!.boxes).toBe(3);
    // Three cartons' worth — never the lot's 100 kg on three leftover boxes.
    expect(row!.kg).toBe(30);
    expect(row!.m3).toBe(0.3);
    // A visit does not reset the age: one carton a week would otherwise hide
    // the rest for ever (the review's #6).
    expect(row!.days).toBe(8);
    expect(row!.leftover).toBe(true);
    expect(row!.lastPickupAt?.getTime()).toBe(pickedAt.getTime());
    expect(row!.clockFrom?.getTime()).toBe(pickedAt.getTime());
  });

  it('a seller reads their own clients; China cargo and marking cargo are not on it', async () => {
    const sellerA = await mintUser('Scope A');
    const sellerB = await mintUser('Scope B');
    const cA = await mintClient(sellerA);
    const cB = await mintClient(sellerB);
    for (const c of [cA, cB]) {
      await cargo({
        clientId: c.id,
        receivedAt: before(20),
        receiptWh: whYw,
        boxes: 1,
        kg: 1,
        m3: 0.01,
        standAt: whAnd,
        status: 'ready_for_pickup',
        landedAt: before(7),
      });
    }
    // Still in China, on the shelf: nobody is waiting to collect it there.
    await cargo({
      clientId: cA.id,
      receivedAt: before(9),
      receiptWh: whYw,
      boxes: 5,
      kg: 5,
      m3: 0.05,
      standAt: whYw,
      status: 'in_stock',
    });
    const mine = await list([cA.id, cB.id], { ownerId: sellerA });
    expect(mine.rows.map((r) => r.clientCode)).toEqual([cA.code]);
    expect(mine.rows[0]!.warehouseId).toBe(whAnd);
    expect(mine.rows[0]!.customs).toBe(true);
    expect(mine.rows[0]!.boxes).toBe(1);
    expect(mine.rows[0]!.phones).toHaveLength(1);
    expect(await uncollectedCount(db, { asOf: BASE, minDays: 5, ownerId: sellerA, warehouseIds: undefined, clientIds: [cA.id, cB.id] })).toBe(1);
    // The all-scope chip for «nobody's clients» names neither.
    expect((await list([cA.id, cB.id], { sellerId: 'none' })).rows).toHaveLength(0);
    // A scoped person with no warehouse reads nothing, never everything.
    expect((await list([cA.id, cB.id], { warehouseIds: [] })).rows).toHaveLength(0);
  });

  it('the price tag is the counter\'s own ban, and the debt tag its own debt', async () => {
    const c = await mintClient(null);
    const walkIn = await mintClient(null);
    await cargo({
      clientId: c.id,
      receivedAt: before(20),
      receiptWh: whYw,
      boxes: 2,
      kg: 2,
      m3: 0.02,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: before(6),
    });
    await cargo({
      clientId: walkIn.id,
      receivedAt: before(6),
      receiptWh: whTas,
      boxes: 2,
      kg: 2,
      m3: 0.02,
      standAt: whTas,
      status: 'in_stock',
    });
    const rows = [
      { clientId: c.id, warehouseId: whTas },
      { clientId: walkIn.id, warehouseId: whTas },
    ];
    const on = await waitingPriceGate(db, rows, { state: 'on', since: new Date('2000-01-01T00:00:00Z') });
    expect(on.get(`${c.id}|${whTas}`)).toBe(2);
    // A walk-in rode none of our roads: no truck price can exist, never gated.
    expect(on.get(`${walkIn.id}|${whTas}`)).toBeUndefined();
    expect((await waitingPriceGate(db, rows, { state: 'off' })).size).toBe(0);

    await db.insert(clientTransactions).values({
      clientId: c.id,
      type: 'charge',
      amount: '120',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '120',
      txDate: '2026-09-20',
      createdBy: actorId,
    });
    const debtors = await waitingDebtors([c.id, walkIn.id]);
    expect([...debtors]).toEqual([c.id]);
  });
});

describe('the morning sweep', () => {
  it('announces a crossing ONCE, each client at its highest level — a 12-day backlog is one 10+ line', async () => {
    const seller = await mintUser('Once seller');
    const c = await mintClient(seller);
    await cargo({
      clientId: c.id,
      receivedAt: before(30),
      receiptWh: whYw,
      boxes: 4,
      kg: 40,
      m3: 0.4,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: before(12),
    });
    await sweepCargoWaiting({ asOf: BASE, clientIds: [c.id] });
    await sweepCargoWaiting({ asOf: BASE, clientIds: [c.id] });

    const messages = await waitingMessages(seller);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toContain('🔴 10+ kun:');
    expect(messages[0]!.text).not.toContain('🟡');
    expect(messages[0]!.text.split('\n').filter((l) => l.includes(c.code))).toHaveLength(1);
    const claims = await db
      .select({ level: cargoWaitAlerts.level })
      .from(cargoWaitAlerts)
      .where(eq(cargoWaitAlerts.clientId, c.id));
    expect(claims.map((r) => r.level).sort()).toEqual([1, 2]);
  });

  it('collected in full and landing again is announced again', async () => {
    const seller = await mintUser('Again seller');
    const c = await mintClient(seller);
    const first = await cargo({
      clientId: c.id,
      receivedAt: before(20),
      receiptWh: whYw,
      boxes: 2,
      kg: 2,
      m3: 0.02,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: before(6),
    });
    await sweepCargoWaiting({ asOf: BASE, clientIds: [c.id] });
    expect(await waitingMessages(seller)).toHaveLength(1);

    // Everything collected the next day; a new truck lands two days later.
    const later = new Date(BASE.getTime() + 1 * DAY);
    await pickup(c.id, whTas, later, first.boxIds);
    const landed2 = new Date(BASE.getTime() + 2 * DAY);
    await cargo({
      clientId: c.id,
      receivedAt: before(10),
      receiptWh: whYw,
      boxes: 1,
      kg: 1,
      m3: 0.01,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: landed2,
    });
    await sweepCargoWaiting({ asOf: new Date(landed2.getTime() + 6 * DAY), clientIds: [c.id] });
    expect(await waitingMessages(seller)).toHaveLength(2);
  });

  it('cartons left behind at a visit are announced again once they have waited the warn line since it, marked «qoldiq»', async () => {
    const seller = await mintUser('Qoldiq seller');
    const c = await mintClient(seller);
    const made = await cargo({
      clientId: c.id,
      receivedAt: before(20),
      receiptWh: whYw,
      boxes: 10,
      kg: 10,
      m3: 0.1,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: before(6),
    });
    await sweepCargoWaiting({ asOf: BASE, clientIds: [c.id] });
    // The client came an hour AFTER the morning's message and left three.
    await pickup(c.id, whTas, new Date(BASE.getTime() + 3_600_000), made.boxIds.slice(0, 7));
    // The visit buys the leftovers the same five quiet days the landing gave
    // the shipment: not the next morning, not on the fourth.
    for (const day of [1, 4]) {
      await sweepCargoWaiting({ asOf: new Date(BASE.getTime() + day * DAY), clientIds: [c.id] });
    }
    expect(await waitingMessages(seller)).toHaveLength(1);
    // The fifth morning after the visit: announced, aged from the LANDING.
    await sweepCargoWaiting({ asOf: new Date(BASE.getTime() + 5 * DAY), clientIds: [c.id] });
    const messages = await waitingMessages(seller);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.text).toContain('3 kor.');
    expect(messages[1]!.text).toContain('11 kun (qoldiq)');
    expect(messages[1]!.text).toContain('🔴 10+ kun:');
  });

  it('a client collecting a few cartons a day is announced ONCE, not every morning — and again once they stop coming', async () => {
    const seller = await mintUser('Portions seller');
    const c = await mintClient(seller);
    const made = await cargo({
      clientId: c.id,
      receivedAt: before(30),
      receiptWh: whYw,
      boxes: 10,
      kg: 10,
      m3: 0.1,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: before(8),
    });
    await sweepCargoWaiting({ asOf: BASE, clientIds: [c.id] });
    // Three afternoons in a row, two cartons each; a sweep every morning.
    for (let d = 0; d < 3; d += 1) {
      await pickup(c.id, whTas, new Date(BASE.getTime() + d * DAY + 2 * 3_600_000), made.boxIds.slice(d * 2, d * 2 + 2));
      await sweepCargoWaiting({ asOf: new Date(BASE.getTime() + (d + 1) * DAY), clientIds: [c.id] });
      // …and the office's «today» does not list them either.
      expect((await crossedOn(`2026-09-${27 + d}`, [c.id])).size).toBe(0);
    }
    expect(await waitingMessages(seller)).toHaveLength(1);
    // They stop coming after the third visit (the 28th): four quiet days are
    // still quiet, the fifth speaks — at the landing's age.
    await sweepCargoWaiting({ asOf: new Date(BASE.getTime() + 6 * DAY), clientIds: [c.id] });
    expect(await waitingMessages(seller)).toHaveLength(1);
    await sweepCargoWaiting({ asOf: new Date(BASE.getTime() + 7 * DAY), clientIds: [c.id] });
    const messages = await waitingMessages(seller);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.text).toContain('4 kor.');
    expect(messages[1]!.text).toContain('15 kun (qoldiq)');
  });

  it('a client with no seller reaches only the office; a muted seller\'s claim is written all the same', async () => {
    const muted = await mintUser('Muted seller', ['CrmFollowUps']);
    const lone = await mintClient(null);
    const quiet = await mintClient(muted);
    for (const c of [lone, quiet]) {
      await cargo({
        clientId: c.id,
        receivedAt: before(20),
        receiptWh: whYw,
        boxes: 1,
        kg: 1,
        m3: 0.01,
        standAt: whTas,
        status: 'ready_for_pickup',
        landedAt: before(6),
      });
    }
    const section = await waitingDigestSection({ asOf: BASE, clientIds: [lone.id, quiet.id] });
    const claimed = await crossedOn('2026-09-26', [lone.id, quiet.id]);
    expect(claimed.size).toBe(2);
    const messages = await waitingMessages(muted);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.status).toBe('muted');
    // Nobody was messaged about the managerless client.
    const anyAboutLone = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.type, 'CargoWaiting'), sql`${notifications.payload}->>'text' LIKE ${`%${lone.code}%`}`));
    expect(anyAboutLone).toHaveLength(0);
    // The office names it, as nobody's.
    expect(section[0]).toContain('⏳ Olib ketilmagan yuk (5+ kun): 2 mijoz, 2 kor.');
    expect(section.find((l) => l.includes(lone.code))).toContain('sotuvchisiz');
    expect(section.at(-1)).toMatch(/^🔗 .*\/my-clients\/olib-ketilmagan$/);
  });

  it('one seller\'s failed send costs that seller only — the next one is still told', async () => {
    const bad = await mintUser('Poisoned seller');
    const good = await mintUser('Healthy seller');
    const cBad = await mintClient(bad);
    const cGood = await mintClient(good);
    // The poisoned seller's client is older, so the sweep reaches them FIRST.
    await cargo({
      clientId: cBad.id,
      receivedAt: before(20),
      receiptWh: whYw,
      boxes: 1,
      kg: 1,
      m3: 0.01,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: before(8),
    });
    await cargo({
      clientId: cGood.id,
      receivedAt: before(20),
      receiptWh: whYw,
      boxes: 1,
      kg: 1,
      m3: 0.01,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: before(6),
    });
    poison.ids.add(bad);
    try {
      await sweepCargoWaiting({ asOf: BASE, clientIds: [cBad.id, cGood.id] });
    } finally {
      poison.ids.delete(bad);
    }
    expect(await waitingMessages(good)).toHaveLength(1);
    expect(await waitingMessages(bad)).toHaveLength(0);
    // Claimed before the send: the stated trade (#599) — never sent twice.
    const badClaims = await db
      .select({ level: cargoWaitAlerts.level })
      .from(cargoWaitAlerts)
      .where(eq(cargoWaitAlerts.clientId, cBad.id));
    expect(badClaims).toHaveLength(1);
  });

  it('the 09:00 svodka carries the section, sweeping first, with the list\'s link as its last line', async () => {
    const seller = await mintUser('Digest seller');
    const c = await mintClient(seller);
    await cargo({
      clientId: c.id,
      receivedAt: before(20),
      receiptWh: whYw,
      boxes: 2,
      kg: 3,
      m3: 0.03,
      standAt: whTas,
      status: 'ready_for_pickup',
      landedAt: before(11),
    });
    expect(await sendDailyDigest(BASE, { waitingClientIds: [c.id] })).toBe(true);
    const [digest] = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(
        and(
          eq(notifications.type, 'DailyDigest'),
          eq(notifications.channel, 'telegram'),
          sql`${notifications.payload}->>'text' LIKE ${`%${c.code}%`}`,
        ),
      )
      .limit(1);
    const text = String((digest!.payload as { text: string }).text);
    expect(text).toContain("Bugun ro'yxatga tushgan: 1");
    expect(text).toContain(`• ${c.code} `);
    expect(text).toContain('🔴 10+ kun:');
    expect(text.split('\n').at(-1)).toMatch(/^🔗 .*\/my-clients\/olib-ketilmagan$/);
    // The seller was told by the same run.
    expect(await waitingMessages(seller)).toHaveLength(1);
  });
});

describe('the home rows', () => {
  it("a both-hats viewer's «mine» row opens exactly the rows it counted (the owner's own setup, round 109)", async () => {
    const owner = await mintUser('Both hats');
    const other = await mintUser('Other seller');
    const mine = await mintClient(owner);
    const theirs = await mintClient(other);
    for (const c of [mine, theirs]) {
      await cargo({
        clientId: c.id,
        receivedAt: before(20),
        receiptWh: whYw,
        boxes: 1,
        kg: 1,
        m3: 0.01,
        standAt: whTas,
        status: 'ready_for_pickup',
        landedAt: before(7),
      });
    }
    const viewer = {
      id: owner,
      permissions: new Set(['clients.manage', 'crm.leads', 'crm.leads.view_all']),
      warehouseScoped: false,
      warehouseIds: [] as string[],
    };
    const scope = uncollectedScope(viewer);
    expect(scope.seesAll).toBe(true);
    const flow = await salesFlowCounts(owner, '2026-09-26', { seesAllClients: scope.seesAll, asOf: BASE });
    expect(flow.uncollected).toBe(1);

    // The page, reading the link the row carries: its filters, its query, its tab.
    const params = Object.fromEntries(new URL(flow.uncollectedHref, 'https://gsr.test').searchParams);
    const filters = readUncollectedFilters(params, { seesAll: scope.seesAll, warehouseIds: [whTas] });
    const page = await uncollectedCargo(db, uncollectedPageQuery(scope, filters, BASE));
    const tab = rowsInTab(page.rows, filters.tab, await waitThresholds());
    expect(new Set(tab.map((r) => r.clientId)).size).toBe(flow.uncollected);
    expect(tab.map((r) => r.clientCode)).toEqual([mine.code]);
  });
});
