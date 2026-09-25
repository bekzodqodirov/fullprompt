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
  costEntries,
  costTypes,
  crates,
  events,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import {
  addCostEntry,
  batchLandedCostByLot,
  boxLandedCost,
  recomputeAll,
} from '@/modules/wms/costing/service';
import { setBoxStatus } from '@/modules/wms/boxes/status';
import { pnlGaps } from '@/modules/wms/accounting/reports';
import { voidReceipt } from '@/modules/wms/receipts/service';

/**
 * Audit U20: a void box is a counting mistake and carries no cost share
 * anywhere (#530/#849) — but voidReceipt and the box card wrote `void` and
 * left every shared cost split over the phantom boxes, and since R1 a
 * converted cost has no «next recompute» to fix it. Each door now re-splits
 * after its commit; where the re-split would find no cargo at all it refuses
 * instead, and the nightly sweep repairs the backlog.
 *
 * Money parked in 1637 — a private year no other file uses.
 */
const STAMP = String(Date.now()).slice(-6);
const DAY = '1637-03-14';
let actorId = '';
/** A second manager — the race needs two people pressing at once. */
let otherActorId = '';
let whOrigin = '';
let whHub = '';
let whDest = '';
let clientG = '';
let clientY = '';
let customs = '';
let freight = '';
let crating = '';
const madeReceipts: string[] = [];
const madeBatches: string[] = [];
const madeCrates: string[] = [];
const madeCosts: string[] = [];
let seq = 0;

const ctx = () => ({ actorId, ip: null, userAgent: null });

async function mintWarehouse(code: string, country: string, type: string) {
  const [row] = await db
    .insert(warehouses)
    .values({
      code,
      name: `VR ${code}`,
      country,
      type,
      timezone: 'Asia/Tashkent',
      batchPrefix: code,
    })
    .returning();
  return row!.id;
}

/** A confirmed prixod of `count` boxes at `kg` each, standing `at` a warehouse. */
async function mintLot(clientId: string, count: number, kg: number, at: string) {
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
        shortCode: `VR${STAMP}-${(seq += 1)}`,
        seqInLot: i + 1,
        status: 'in_stock',
        currentWarehouseId: at,
      })),
    )
    .returning();
  return { receiptId: receipt!.id, lotId: lot!.id, boxIds: rows.map((b) => b.id) };
}

/** A truck the given boxes departed on (the movement ledger is the membership). */
async function mintDeparted(boxIds: string[], from: string, to: string) {
  const [batch] = await db
    .insert(batches)
    .values({
      code: `VRB${STAMP}-${madeBatches.length}`,
      originWarehouseId: from,
      destWarehouseId: to,
      status: 'unloaded',
      departedAt: new Date(),
      createdBy: actorId,
    })
    .returning();
  madeBatches.push(batch!.id);
  await db.insert(boxMovements).values(
    boxIds.map((boxId) => ({
      boxId,
      fromWarehouseId: from,
      toWarehouseId: to,
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

async function mintCrate(clientId: string, boxIds: string[]) {
  const [crate] = await db
    .insert(crates)
    .values({
      code: `CR-VR${STAMP}-${madeCrates.length}`,
      warehouseId: whOrigin,
      clientId,
      createdBy: actorId,
    })
    .returning();
  madeCrates.push(crate!.id);
  await db.update(boxes).set({ crateId: crate!.id }).where(inArray(boxes.id, boxIds));
  await db.insert(boxMovements).values(
    boxIds.map((boxId) => ({
      boxId,
      fromStatus: 'in_stock',
      toStatus: 'in_stock',
      cause: 'crate_packed',
      refType: 'crate',
      refId: crate!.id,
      actorId,
    })),
  );
  return crate!;
}

async function cost(input: Parameters<typeof addCostEntry>[0]) {
  const entry = await addCostEntry(input, ctx());
  madeCosts.push(entry.id);
  return entry;
}

/** boxId → its share of one entry. */
async function shares(entryId: string) {
  const rows = await db.execute<{ box_id: string; usd: string }>(sql`
    SELECT box_id, amount_usd AS usd FROM cost_allocations WHERE cost_entry_id = ${entryId}
  `);
  return new Map(rows.map((r) => [r.box_id, Number(r.usd)]));
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({
      phone: `+99893${STAMP}7`,
      fullName: `VR manager ${STAMP}`,
      passwordHash: 'x',
      active: true,
    })
    .returning();
  actorId = u!.id;
  const [other] = await db
    .insert(users)
    .values({
      phone: `+99893${STAMP}6`,
      fullName: `VR manager 2 ${STAMP}`,
      passwordHash: 'x',
      active: true,
    })
    .returning();
  otherActorId = other!.id;
  whOrigin = await mintWarehouse(`VRO${STAMP}`.slice(0, 8), 'CN', 'origin');
  whHub = await mintWarehouse(`VRH${STAMP}`.slice(0, 8), 'CN', 'hub');
  whDest = await mintWarehouse(`VRD${STAMP}`.slice(0, 8), 'UZ', 'customs');
  const [g] = await db
    .insert(clients)
    .values({ clientCode: `VG${STAMP}`, name: `VR G ${STAMP}` })
    .returning();
  const [y] = await db
    .insert(clients)
    .values({ clientCode: `VY${STAMP}`, name: `VR Y ${STAMP}` })
    .returning();
  clientG = g!.id;
  clientY = y!.id;
  const typeId = async (code: string) =>
    (await db.query.costTypes.findFirst({ where: eq(costTypes.code, code) }))!.id;
  customs = await typeId('customs');
  freight = await typeId('freight');
  crating = await typeId('crating');
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
      await db.delete(events).where(inArray(events.entityId, boxIds));
      await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
      await db.delete(boxes).where(inArray(boxes.id, boxIds));
    }
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  }
  if (madeCrates.length) await db.delete(crates).where(inArray(crates.id, madeCrates));
  await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  if (madeBatches.length) await db.delete(batches).where(inArray(batches.id, madeBatches));
  await db
    .update(clients)
    .set({ active: false })
    .where(inArray(clients.id, [clientG, clientY]));
  await db
    .update(warehouses)
    .set({ active: false })
    .where(inArray(warehouses.id, [whOrigin, whHub, whDest]));
  await db
    .update(users)
    .set({ active: false })
    .where(inArray(users.id, [actorId, otherActorId].filter(Boolean)));
  await pgClient.end();
});

/**
 * The backend that is waiting on a given backend — read through the POOL:
 * pg_stat_activity freezes inside an open transaction (#873).
 */
async function blockedBy(pid: number): Promise<number | null> {
  const rows = await db.execute<{ pid: number }>(sql`
    SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))
  `);
  return rows[0] ? Number(rows[0].pid) : null;
}

async function until<T>(probe: () => Promise<T | null | false>, what: string): Promise<T> {
  for (let i = 0; i < 250; i += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`never happened: ${what}`);
}

describe('the box card: a void re-splits, and refuses to orphan money', () => {
  it('A1 — the real box takes the void box’s share, and the truck’s tannarx is whole', async () => {
    const lot = await mintLot(clientG, 2, 10, whOrigin);
    const e = await cost({
      scope: 'receipt',
      receiptId: lot.receiptId,
      costTypeId: customs,
      amount: 100,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'weight',
    });
    expect([...(await shares(e.id)).values()]).toEqual([50, 50]);

    await setBoxStatus(
      { boxId: lot.boxIds[1]!, to: 'void', reason: 'counted twice by mistake' },
      ctx(),
    );

    const after = await shares(e.id);
    expect(after.get(lot.boxIds[0]!)).toBe(100);
    expect(after.has(lot.boxIds[1]!)).toBe(false);
    expect((await boxLandedCost(lot.boxIds[1]!)).totalUsd).toBe(0);

    // The real box rides a truck with $300 of freight: the pricing screen's
    // Σ is everything spent on this cargo — 400, not the 350 it read.
    const truck = await mintDeparted([lot.boxIds[0]!], whOrigin, whDest);
    await cost({
      scope: 'batch',
      batchId: truck.id,
      costTypeId: freight,
      amount: 300,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'weight',
    });
    const sigma = [...(await batchLandedCostByLot(truck.id)).values()].reduce(
      (a, l) => a + l.totalUsd,
      0,
    );
    expect(Math.round(sigma * 100) / 100).toBe(400);
  });

  it('C — voiding a prixod’s ONLY live box while it has its own costs is refused, receipt_has_costs', async () => {
    const lot = await mintLot(clientG, 1, 10, whOrigin);
    const e = await cost({
      scope: 'receipt',
      receiptId: lot.receiptId,
      costTypeId: customs,
      amount: 100,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'weight',
    });
    await expect(
      setBoxStatus({ boxId: lot.boxIds[0]!, to: 'void', reason: 'duplicate label' }, ctx()),
    ).rejects.toMatchObject({ code: 'receipt_has_costs' });
    expect((await db.query.boxes.findFirst({ where: eq(boxes.id, lot.boxIds[0]!) }))?.status).toBe(
      'in_stock',
    );
    expect([...(await shares(e.id)).values()]).toEqual([100]);
  });

  it('refuses when the box is the last cargo of a truck’s cost, naming the truck', async () => {
    const lot = await mintLot(clientY, 1, 20, whHub);
    const truck = await mintDeparted(lot.boxIds, whOrigin, whHub);
    await cost({
      scope: 'batch',
      batchId: truck.id,
      costTypeId: freight,
      amount: 90,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'weight',
    });
    await expect(
      setBoxStatus({ boxId: lot.boxIds[0]!, to: 'void', reason: 'duplicate label' }, ctx()),
    ).rejects.toMatchObject({ code: 'shared_cost_orphaned', detail: truck.code });
  });

  it('a lost carton keeps its share — lost is not void (owner, 6a)', async () => {
    const lot = await mintLot(clientG, 2, 10, whOrigin);
    const e = await cost({
      scope: 'receipt',
      receiptId: lot.receiptId,
      costTypeId: customs,
      amount: 40,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'weight',
    });
    await setBoxStatus(
      { boxId: lot.boxIds[1]!, to: 'lost', reason: 'crushed on the shelf' },
      ctx(),
    );
    expect([...(await shares(e.id)).values()]).toEqual([20, 20]);
  });
});

describe('voidReceipt: the shared costs re-split, and orphaning is refused', () => {
  it('B1 — two prixods share a $40 crate fee; voiding one puts 20/20 on the other', async () => {
    const r1 = await mintLot(clientG, 2, 10, whOrigin);
    const r2 = await mintLot(clientG, 2, 10, whOrigin);
    const crate = await mintCrate(clientG, [...r1.boxIds, ...r2.boxIds]);
    const e = await cost({
      scope: 'crate',
      crateId: crate.id,
      costTypeId: crating,
      amount: 40,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'boxes',
    });
    expect([...(await shares(e.id)).values()]).toEqual([10, 10, 10, 10]);

    await voidReceipt(r1.receiptId, 'duplicate prixod', ctx());

    const after = await shares(e.id);
    expect([...after.keys()].sort()).toEqual([...r2.boxIds].sort());
    expect([...after.values()]).toEqual([20, 20]);
  });

  it('B3 — a duplicate prixod voided at the hub: the leg’s $800 goes 266.67 / 533.33, all of it', async () => {
    const h1 = await mintLot(clientG, 1, 50, whHub);
    const h2 = await mintLot(clientG, 1, 50, whHub);
    const y = await mintLot(clientY, 1, 100, whHub);
    const leg = await mintDeparted([...h1.boxIds, ...h2.boxIds, ...y.boxIds], whOrigin, whHub);
    const e = await cost({
      scope: 'batch',
      batchId: leg.id,
      costTypeId: freight,
      amount: 800,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'weight',
    });
    expect((await shares(e.id)).get(h2.boxIds[0]!)).toBe(200);

    await voidReceipt(h2.receiptId, 'the same cargo received twice', ctx());

    const after = await shares(e.id);
    expect(after.has(h2.boxIds[0]!)).toBe(false);
    expect(after.get(h1.boxIds[0]!)).toBeCloseTo(266.6667, 4);
    expect(after.get(y.boxIds[0]!)).toBeCloseTo(533.3333, 4);
    expect([...after.values()].reduce((a, v) => a + v, 0)).toBeCloseTo(800, 6);
  });

  it('B2 — the crate of ONE prixod: the void is refused, naming the crate, and nothing moved', async () => {
    const r = await mintLot(clientG, 2, 10, whOrigin);
    const crate = await mintCrate(clientG, r.boxIds);
    const e = await cost({
      scope: 'crate',
      crateId: crate.id,
      costTypeId: crating,
      amount: 30,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'boxes',
    });
    await expect(voidReceipt(r.receiptId, 'duplicate prixod', ctx())).rejects.toMatchObject({
      code: 'shared_cost_orphaned',
      detail: crate.code,
    });
    expect(
      (await db.query.receipts.findFirst({ where: eq(receipts.id, r.receiptId) }))?.status,
    ).toBe('confirmed');
    expect([...(await shares(e.id)).values()]).toEqual([15, 15]);
  });

  it('a feeless crate does not block the void (m2-stock-ops «lets go of the crate»)', async () => {
    const r = await mintLot(clientG, 2, 10, whOrigin);
    await mintCrate(clientG, r.boxIds);
    await voidReceipt(r.receiptId, 'duplicate prixod', ctx());
    const rows = await db.select().from(boxes).where(inArray(boxes.id, r.boxIds));
    expect(rows.every((b) => b.status === 'void' && b.crateId === null)).toBe(true);
  });

  it('the prixod’s own costs still refuse first — money first, receipt_has_costs', async () => {
    const r = await mintLot(clientG, 2, 10, whOrigin);
    await cost({
      scope: 'receipt',
      receiptId: r.receiptId,
      costTypeId: customs,
      amount: 10,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'weight',
    });
    await expect(voidReceipt(r.receiptId, 'duplicate prixod', ctx())).rejects.toMatchObject({
      code: 'receipt_has_costs',
    });
  });
});

describe('the nightly repair', () => {
  it('re-splits a share left on a void box by the doors that did not re-split', async () => {
    const lot = await mintLot(clientG, 2, 10, whOrigin);
    const e = await cost({
      scope: 'receipt',
      receiptId: lot.receiptId,
      costTypeId: customs,
      amount: 10,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'weight',
    });
    // The pre-fix shape, planted: the box went void and nothing re-split.
    await db.update(boxes).set({ status: 'void' }).where(eq(boxes.id, lot.boxIds[1]!));
    expect((await shares(e.id)).get(lot.boxIds[1]!)).toBe(5);

    const touched = await recomputeAll({ orphaned: true, receiptId: lot.receiptId });

    expect(touched).toBe(1);
    const after = await shares(e.id);
    expect(after.has(lot.boxIds[1]!)).toBe(false);
    expect(after.get(lot.boxIds[0]!)).toBe(10);
  });

  it('leaves a healthy split out of the sweep', async () => {
    const lot = await mintLot(clientY, 2, 10, whOrigin);
    await cost({
      scope: 'receipt',
      receiptId: lot.receiptId,
      costTypeId: customs,
      amount: 10,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'weight',
    });
    expect(await recomputeAll({ orphaned: true, receiptId: lot.receiptId })).toBe(0);
  });
});

describe('two voids at once — the guard holds its costs while it judges them', () => {
  it('the second void of a cost’s last cargo waits for the first, then is refused', async () => {
    const lot = await mintLot(clientG, 2, 10, whOrigin);
    const e = await cost({
      scope: 'receipt',
      receiptId: lot.receiptId,
      costTypeId: customs,
      amount: 400,
      currency: 'USD',
      costDate: DAY,
      allocationBasis: 'weight',
    });
    const [first, second] = lot.boxIds as [string, string];

    // A helper holds the FIRST void's actor row, so that void parks on its
    // movement row's foreign key — after its guard passed, before its commit:
    // the window in which the second void used to read the first carton as
    // live, pass, and leave $400 on no box. Deterministic, not a burst.
    const helper = postgres(
      process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev',
      { max: 1, onnotice: () => {} },
    );
    const held = await helper.reserve();
    try {
      await held`BEGIN`;
      await held`SELECT 1 FROM users WHERE id = ${actorId} FOR UPDATE`;
      const holder = Number((await held`SELECT pg_backend_pid() AS pid`)[0]!.pid);
      const one = setBoxStatus({ boxId: first, to: 'void', reason: 'counted twice' }, ctx())
        .then(() => 'ok')
        .catch((err: { code?: string }) => err.code ?? String(err));
      const firstPid = await until(() => blockedBy(holder), 'the first void to park');

      let twoDone = false;
      const two = setBoxStatus(
        { boxId: second, to: 'void', reason: 'counted twice' },
        { actorId: otherActorId, ip: null, userAgent: null },
      )
        .then(() => 'ok')
        .catch((err: { code?: string }) => err.code ?? String(err))
        .finally(() => {
          twoDone = true;
        });
      // Fixed, it waits on the first void's lock on the cost; unfixed, it
      // finishes on its own. Either way the helper lets the first one go.
      await until(async () => twoDone || (await blockedBy(firstPid)), 'the second void to wait');
      await held`ROLLBACK`;

      expect(await one).toBe('ok');
      expect(await two).toBe('receipt_has_costs');
    } finally {
      held.release();
      await helper.end();
    }
    expect((await db.query.boxes.findFirst({ where: eq(boxes.id, second) }))?.status).toBe(
      'in_stock',
    );
    expect([...(await shares(e.id)).entries()]).toEqual([[second, 400]]);
  });
});

describe('the P&L says what stands on no box', () => {
  // A month nothing else in the suite writes into, so the deltas are ours (#713).
  const FROM = '1647-06-01';
  const TO = '1647-06-30';

  it('a cost with dollars and no share is named beside the P&L; a split one is not', async () => {
    const before = await pnlGaps(FROM, TO);
    // A truck cost typed before anything was loaded: dollars, and no cargo to
    // split them over — in the P&L, in nobody's tannarx.
    const [bare] = await db
      .insert(batches)
      .values({
        code: `VRB${STAMP}-bare`,
        originWarehouseId: whOrigin,
        destWarehouseId: whDest,
        status: 'forming',
        createdBy: actorId,
      })
      .returning();
    madeBatches.push(bare!.id);
    await cost({
      scope: 'batch',
      batchId: bare!.id,
      costTypeId: freight,
      amount: 77,
      currency: 'USD',
      costDate: '1647-06-15',
      allocationBasis: 'weight',
    });
    // …and the same month, a cost that did split — none of the note's business.
    const lot = await mintLot(clientY, 2, 10, whOrigin);
    await cost({
      scope: 'receipt',
      receiptId: lot.receiptId,
      costTypeId: customs,
      amount: 5,
      currency: 'USD',
      costDate: '1647-06-16',
      allocationBasis: 'weight',
    });

    const after = await pnlGaps(FROM, TO);
    expect(after.onNoBox.count - before.onNoBox.count).toBe(1);
    expect(Math.round((after.onNoBox.usd - before.onNoBox.usd) * 100) / 100).toBe(77);
  });
});
