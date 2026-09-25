import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
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
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

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
