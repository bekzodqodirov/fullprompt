import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxes,
  boxMovements,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import {
  addCostEntry,
  recomputeAll,
  recomputeEntry,
  recomputeForLot,
} from '@/modules/wms/costing/service';

/**
 * Audit U41: `recomputeEntry` autocommitted its DELETE of the shares before
 * it re-read the base, so a recompute killed in between left a converted
 * cost on NO box for ever, and two recomputes of one entry at once collided
 * on the (entry, box) unique index. It is one transaction under the entry's
 * row lock now; the nightly `orphaned` sweep heals what the old shape left.
 *
 * Money parked in 1637 — a private year no other file uses.
 */
const STAMP = String(Date.now()).slice(-6);
const DAY = '1637-05-20';
let actorId = '';
let whOrigin = '';
let whDest = '';
let clientA = '';
let clientB = '';
let freight = '';
const madeReceipts: string[] = [];
const madeBatches: string[] = [];
const madeCosts: string[] = [];
let seq = 0;

const ctx = () => ({ actorId, ip: null, userAgent: null });

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({
      code,
      name: `RA ${code}`,
      country,
      type,
      timezone: 'Asia/Tashkent',
      batchPrefix: code,
    })
    .returning();
  return row!.id;
}

async function mintLot(clientId: string, count: number, kg: number) {
  const [receipt] = await db
    .insert(receipts)
    .values({
      warehouseId: whOrigin,
      clientId,
      status: 'confirmed',
      confirmedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  madeReceipts.push(receipt!.id);
  const [lot] = await db
    .insert(receiptLots)
    .values({
      receiptId: receipt!.id,
      seq: 1,
      letter: 'A',
      dimsMode: 'mixed',
      productNameZh: '测试货',
      boxCount: count,
      totalWeightKg: String(kg * count),
      totalVolumeM3: String(0.1 * count),
    })
    .returning();
  const rows = await db
    .insert(boxes)
    .values(
      Array.from({ length: count }, (_, i) => ({
        lotId: lot!.id,
        shortCode: `RA${STAMP}-${(seq += 1)}`,
        seqInLot: i + 1,
        status: 'in_transit',
      })),
    )
    .returning();
  return { receiptId: receipt!.id, lotId: lot!.id, boxIds: rows.map((b) => b.id) };
}

async function mintDeparted(boxIds: string[]) {
  const [batch] = await db
    .insert(batches)
    .values({
      code: `RAB${STAMP}-${madeBatches.length}`,
      originWarehouseId: whOrigin,
      destWarehouseId: whDest,
      status: 'in_transit',
      departedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  madeBatches.push(batch!.id);
  await db.update(boxes).set({ currentBatchId: batch!.id }).where(inArray(boxes.id, boxIds));
  await db.insert(boxMovements).values(
    boxIds.map((boxId) => ({
      boxId,
      fromWarehouseId: whOrigin,
      toWarehouseId: whDest,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: batch!.id,
      actorId,
    })),
  );
  return batch!;
}

async function freightOn(batchId: string, amount: number) {
  const entry = await addCostEntry(
    {
      scope: 'batch',
      batchId,
      costTypeId: freight,
      amount,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'weight',
    },
    ctx(),
  );
  madeCosts.push(entry.id);
  return entry;
}

/** entryId → boxId → share, for a set of entries (the split as it stands). */
async function splitOf(entryIds: string[]) {
  const rows = await db
    .select({
      entry: costAllocations.costEntryId,
      box: costAllocations.boxId,
      usd: costAllocations.amountUsd,
    })
    .from(costAllocations)
    .where(inArray(costAllocations.costEntryId, entryIds));
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.entry] ??= {})[r.box] = Number(r.usd);
  return out;
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({
      phone: `+99893${STAMP}8`,
      fullName: `RA manager ${STAMP}`,
      passwordHash: 'x',
      active: true,
    })
    .returning();
  actorId = u!.id;
  whOrigin = await mintWarehouse(`RAO${STAMP}`.slice(0, 8), 'CN', 'origin');
  whDest = await mintWarehouse(`RAD${STAMP}`.slice(0, 8), 'UZ', 'customs');
  const [a] = await db
    .insert(clients)
    .values({ clientCode: `RA${STAMP}`, name: `RA A ${STAMP}` })
    .returning();
  const [b] = await db
    .insert(clients)
    .values({ clientCode: `RB${STAMP}`, name: `RA B ${STAMP}` })
    .returning();
  clientA = a!.id;
  clientB = b!.id;
  freight = (await db.query.costTypes.findFirst({ where: eq(costTypes.code, 'freight') }))!.id;
});

afterAll(async () => {
  if (madeCosts.length) await db.delete(costEntries).where(inArray(costEntries.id, madeCosts));
  const lotIds = (
    await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(inArray(receiptLots.receiptId, madeReceipts))
  ).map((r) => r.id);
  if (lotIds.length) {
    const boxIds = (
      await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds))
    ).map((b) => b.id);
    if (boxIds.length) {
      await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
      await db.delete(boxes).where(inArray(boxes.id, boxIds));
    }
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  }
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  if (madeBatches.length) await db.delete(batches).where(inArray(batches.id, madeBatches));
  await db
    .update(clients)
    .set({ active: false })
    .where(inArray(clients.id, [clientA, clientB]));
  await db
    .update(warehouses)
    .set({ active: false })
    .where(inArray(warehouses.id, [whOrigin, whDest]));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('a recompute is one transaction under the entry’s lock', () => {
  it('a recompute that fails half-way leaves the OLD split standing, not a cost on no box', async () => {
    const a = await mintLot(clientA, 3, 20);
    const b = await mintLot(clientB, 1, 40);
    const truck = await mintDeparted([...a.boxIds, ...b.boxIds]);
    const e = await freightOn(truck.id, 700);
    const before = await splitOf([e.id]);
    expect(Object.values(before[e.id] ?? {}).reduce((s, v) => s + v, 0)).toBeCloseTo(700, 6);

    // A helper holds the movement ledger so the recompute parks on its base
    // read, and that read is then cancelled — a statement failing half-way.
    // (A killed process is the same shape one layer down: postgres rolls back
    // whatever the dead connection had not committed. Cancelling keeps the
    // connection alive, so the test does not also exercise the driver's
    // handling of a socket dying under a transaction.)
    const helper = postgres(
      process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev',
      {
        max: 1,
        onnotice: () => {},
      },
    );
    const held = await helper.reserve();
    try {
      await held`BEGIN`;
      await held`LOCK TABLE box_movements IN ACCESS EXCLUSIVE MODE`;
      const running = recomputeEntry(e.id);
      const outcome = running.then(
        () => 'resolved',
        () => 'rejected',
      );
      let pid: number | null = null;
      // Observed through the POOL: pg_stat_activity freezes inside an open
      // transaction, so the helper cannot watch for the waiter itself.
      for (let i = 0; i < 250 && pid === null; i += 1) {
        const rows = await db.execute<{ pid: number }>(sql`
          SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query ILIKE '%box_movements%' AND pid <> pg_backend_pid()
        `);
        pid = rows[0]?.pid ?? null;
        if (pid === null) await new Promise((r) => setTimeout(r, 20));
      }
      expect(pid, 'the recompute never reached the base read').not.toBeNull();
      await held`SELECT pg_cancel_backend(${pid})`;
      expect(await outcome).toBe('rejected');
      await held`COMMIT`;
    } finally {
      held.release();
      await helper.end();
    }

    expect(await splitOf([e.id])).toEqual(before);
  });

  it('two recomputes of one truck at once: nobody is refused, and the last split is the fresh one', async () => {
    const lotsA = await Promise.all([mintLot(clientA, 5, 10), mintLot(clientA, 5, 12)]);
    const lotB = await mintLot(clientB, 5, 8);
    const truck = await mintDeparted([...lotsA.flatMap((l) => l.boxIds), ...lotB.boxIds]);
    const entries: string[] = [];
    for (const amount of [300, 410, 125.55, 999.99, 64, 1200])
      entries.push((await freightOn(truck.id, amount)).id);

    const failures: string[] = [];
    for (let round = 0; round < 10; round += 1) {
      // Two lot corrections land at once, each followed by its door's own
      // post-commit re-split of every cost on the truck.
      await db
        .update(receiptLots)
        .set({ totalWeightKg: String(50 + round * 7) })
        .where(eq(receiptLots.id, lotsA[0]!.lotId));
      await db
        .update(receiptLots)
        .set({ totalWeightKg: String(90 - round * 3) })
        .where(eq(receiptLots.id, lotB.lotId));
      const settled = await Promise.allSettled([
        recomputeForLot(lotsA[0]!.lotId),
        recomputeForLot(lotB.lotId),
      ]);
      for (const s of settled) if (s.status === 'rejected') failures.push(String(s.reason));
    }
    expect(failures).toEqual([]);

    // A serial recompute moves nothing: the split the race left behind is the
    // one the committed weights give.
    const raced = await splitOf(entries);
    await recomputeAll({ batchId: truck.id });
    expect(await splitOf(entries)).toEqual(raced);
    for (const id of entries) {
      const [row] = await db.select().from(costEntries).where(eq(costEntries.id, id));
      expect(Object.values(raced[id] ?? {}).reduce((s, v) => s + v, 0)).toBeCloseTo(
        Number(row!.amountUsd),
        6,
      );
    }
  });

  it('one entry that fails costs that entry: the lot’s others still re-split (recomputeForLot)', async () => {
    const a = await mintLot(clientA, 2, 10);
    const truck = await mintDeparted(a.boxIds);
    // The truck's freight first — the lower id, so it is walked FIRST — and
    // the prixod's own cost after it.
    const road = await freightOn(truck.id, 100);
    const own = await addCostEntry(
      {
        scope: 'receipt',
        receiptId: a.receiptId,
        costTypeId: freight,
        amount: 60,
        currency: 'USD',
        costDate: DAY,
        allocationBasis: 'weight',
      },
      ctx(),
    );
    madeCosts.push(own.id);
    const roadBefore = await splitOf([road.id]);
    // The prixod's cost has lost its shares (the pre-U41 crash window): the
    // re-split must put them back even though the entry before it fails.
    await db.delete(costAllocations).where(eq(costAllocations.costEntryId, own.id));

    // Only a TRUCK cost reads the customs types (its base depends on them), so
    // holding that table fails the freight's re-split and nothing else.
    const helper = postgres(
      process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev',
      { max: 1, onnotice: () => {} },
    );
    const held = await helper.reserve();
    try {
      await held`BEGIN`;
      await held`LOCK TABLE cost_types IN ACCESS EXCLUSIVE MODE`;
      const outcome = recomputeForLot(a.lotId).then(
        () => 'resolved',
        (err: Error) => err.message,
      );
      let pid: number | null = null;
      for (let i = 0; i < 250 && pid === null; i += 1) {
        const rows = await db.execute<{ pid: number }>(sql`
          SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query ILIKE '%cost_types%' AND pid <> pg_backend_pid()
        `);
        pid = rows[0]?.pid ?? null;
        if (pid === null) await new Promise((r) => setTimeout(r, 20));
      }
      expect(pid, 'the freight re-split never reached the customs types').not.toBeNull();
      await held`SELECT pg_cancel_backend(${pid})`;
      // ONE aggregated error naming the one entry, after the rest ran.
      expect(await outcome).toMatch(/recompute failed for 1 of 2 cost entries/);
      await held`COMMIT`;
    } finally {
      held.release();
      await helper.end();
    }

    expect(Object.values((await splitOf([own.id]))[own.id] ?? {})).toEqual([30, 30]);
    expect(await splitOf([road.id])).toEqual(roadBefore);
  });

  it('a void that lands first wins: the recompute after it puts no share back', async () => {
    const a = await mintLot(clientA, 2, 10);
    const truck = await mintDeparted(a.boxIds);
    const e = await freightOn(truck.id, 50);
    await db
      .update(costEntries)
      .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: 'x' })
      .where(eq(costEntries.id, e.id));
    await recomputeEntry(e.id);
    expect(await splitOf([e.id])).toEqual({});
  });
});

describe('the nightly orphan sweep', () => {
  it('re-splits a converted cost the old shape left with no share at all', async () => {
    const a = await mintLot(clientA, 2, 10);
    const truck = await mintDeparted(a.boxIds);
    const e = await freightOn(truck.id, 80);
    const healthy = await splitOf([e.id]);
    // The pre-fix crash window, planted: dollars, and nothing under them.
    await db.delete(costAllocations).where(eq(costAllocations.costEntryId, e.id));

    // The nightly payload, narrowed to this truck so the test says nothing
    // about anybody else's costs (#713).
    const n = await recomputeAll({
      unconverted: true,
      pickups: true,
      orphaned: true,
      batchId: truck.id,
    });

    expect(n).toBe(1);
    expect(await splitOf([e.id])).toEqual(healthy);
  });
});
