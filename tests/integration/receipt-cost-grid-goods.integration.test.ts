import 'dotenv/config';
import { ALL_COSTS } from '@/modules/wms/costing/cost-sight';
import { and, eq, inArray, or } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxMovements,
  boxes,
  clients,
  costAllocations,
  costEntries,
  costTypes,
  dealStages,
  deals,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { batchLots } from '@/modules/wms/batches/lots';
import {
  addCostEntry,
  addReceiptCostsBulk,
  batchLandedCostByClient,
  batchLandedCostByLot,
  batchReceiptRows,
  batchScopeCostByType,
  receiptCostMatrix,
  unconvertedCostCount,
} from '@/modules/wms/costing/service';

/**
 * The prixod cost grid learns the goods (owner, 2026-09-24: «jadval rasxod
 * kiritadigan joyda tovar nomi, karobka soni va rasmi kerak»), and three
 * things the grid's hint had been wrong about.
 *
 * The truck carries three prixods:
 *  - A — a client's, linked to a deal, two lots; lot A1 is SPLIT (6 of its
 *    10 boxes aboard), A2 rides whole;
 *  - B — unclaimed, known only by the marking written on the carton;
 *  - V — annulled: its box is void, but its `batch_departed` row stays for
 *    ever, which is exactly how an annulled prixod kept a grid row.
 */

const STAMP = String(Date.now()).slice(-7);
const today = new Date().toISOString().slice(0, 10);
const batchId = uuidv4();
/** Trucks this file mints — the fixture's own and the later leg. */
const madeBatches: string[] = [batchId];
let actorId: string;
let whA: string;
let whB: string;
let clientId: string;
let dealId: string;
let receiptA: string;
let receiptB: string;
let receiptV: string;
let lotA1: string;
let lotV1: string;
let voidBox: string;
let type1: string;
let type2: string;
const madeBoxes: string[] = [];
const madeLots: string[] = [];
const madeAttachments: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!
    .id;
  [whA, whB] = (await db.select({ id: warehouses.id }).from(warehouses).limit(2)).map((w) => w.id) as [
    string,
    string,
  ];
  const types = await db
    .select({ id: costTypes.id })
    .from(costTypes)
    .where(eq(costTypes.active, true))
    .limit(2);
  type1 = types[0]!.id;
  type2 = types[1]!.id;

  clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `GG${STAMP}`, name: `Jadval tovar ${STAMP}` })
      .returning({ id: clients.id })
  )[0]!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  dealId = (
    await db
      .insert(deals)
      .values({
        code: `GG-${STAMP}`,
        clientId,
        stageId: stage!.id,
        title: 'Jadval bitimi',
        createdBy: actorId,
      })
      .returning({ id: deals.id })
  )[0]!.id;
  await db.insert(batches).values({
    id: batchId,
    code: `GGB-${STAMP}`,
    originWarehouseId: whA,
    destWarehouseId: whB,
    status: 'in_transit',
    departedAt: new Date(),
    createdBy: actorId,
  });

  const receipt = async (over: Partial<typeof receipts.$inferInsert>) =>
    (
      await db
        .insert(receipts)
        .values({ warehouseId: whA, status: 'confirmed', createdBy: actorId, ...over })
        .returning({ id: receipts.id })
    )[0]!.id;
  receiptA = await receipt({ clientId, dealId, number: `GGR-${STAMP}-1` });
  receiptB = await receipt({ unclaimedMarking: `MK${STAMP}`, number: `GGR-${STAMP}-2` });
  receiptV = await receipt({ clientId, number: `GGR-${STAMP}-3` });

  const lot = async (receiptId: string, letter: string, boxCount: number, name: string) => {
    const id = (
      await db
        .insert(receiptLots)
        .values({
          receiptId,
          seq: letter.charCodeAt(0),
          letter,
          productNameZh: name,
          productNameRu: `${name} ru`,
          boxCount,
          dimsMode: 'mixed',
          totalWeightKg: String(boxCount * 10),
          totalVolumeM3: String(boxCount * 0.1),
        })
        .returning({ id: receiptLots.id })
    )[0]!.id;
    madeLots.push(id);
    return id;
  };
  lotA1 = await lot(receiptA, 'A', 10, `玩具${STAMP}`);
  const lotA2 = await lot(receiptA, 'B', 2, `杯子${STAMP}`);
  const lotB1 = await lot(receiptB, 'A', 1, `灯${STAMP}`);
  lotV1 = await lot(receiptV, 'A', 1, `作废${STAMP}`);

  const photo = async (entityType: string, entityId: string) => {
    const id = (
      await db
        .insert(attachments)
        .values({
          entityType,
          entityId,
          kind: 'photo',
          storageKey: `gg/${entityId}`,
          fileName: 'x.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 1,
          uploadedBy: actorId,
        })
        .returning({ id: attachments.id })
    )[0]!.id;
    madeAttachments.push(id);
    return id;
  };
  await photo('receipt_lot', lotA1);
  await photo('receipt', receiptA);

  let seq = 0;
  const box = async (lotId: string, status: string, aboard: boolean) => {
    seq += 1;
    const id = (
      await db
        .insert(boxes)
        .values({
          lotId,
          shortCode: `GGX${STAMP}${seq}`,
          seqInLot: seq,
          currentWarehouseId: aboard ? null : whA,
          currentBatchId: null,
          status,
        } as typeof boxes.$inferInsert)
        .returning({ id: boxes.id })
    )[0]!.id;
    madeBoxes.push(id);
    if (aboard) {
      await db.insert(boxMovements).values({
        boxId: id,
        fromWarehouseId: whA,
        toWarehouseId: whB,
        fromStatus: 'loading',
        toStatus: 'in_transit',
        cause: 'batch_departed',
        refType: 'batch',
        refId: batchId,
        actorId,
      });
    }
  };
  for (let i = 0; i < 10; i += 1) await box(lotA1, i < 6 ? 'in_transit' : 'in_stock', i < 6);
  for (let i = 0; i < 2; i += 1) await box(lotA2, 'in_transit', true);
  await box(lotB1, 'in_transit', true);
  await box(lotV1, 'void', true);
  voidBox = madeBoxes.at(-1)!;
});

afterAll(async () => {
  await db
    .delete(costEntries)
    .where(
      or(
        inArray(costEntries.receiptId, [receiptA, receiptB, receiptV]),
        inArray(costEntries.batchId, madeBatches),
      ),
    );
  await db.delete(boxMovements).where(inArray(boxMovements.boxId, madeBoxes));
  await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  await db.delete(attachments).where(inArray(attachments.id, madeAttachments));
  await db.delete(receiptLots).where(inArray(receiptLots.id, madeLots));
  await db.delete(receipts).where(inArray(receipts.id, [receiptA, receiptB, receiptV]));
  await db.delete(batches).where(inArray(batches.id, madeBatches));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

describe('batchLots — the goods on the truck', () => {
  it('one row per lot, the annulled prixod gone, the client first and the unclaimed last', async () => {
    const lots = await batchLots(batchId);
    expect(lots.map((lot) => [lot.receiptId, lot.letter])).toEqual([
      [receiptA, 'A'],
      [receiptA, 'B'],
      [receiptB, 'A'],
    ]);
  });

  it('a split lot is weighed by its share, and names the deal and both photos', async () => {
    const a1 = (await batchLots(batchId)).find((lot) => lot.lotId === lotA1)!;
    expect(a1).toMatchObject({
      onBatch: 6,
      lotBoxCount: 10,
      // 100 kg / 1 m³ for ten boxes, six of them aboard.
      kg: 60,
      m3: 0.6,
      dealId,
      dealCode: `GG-${STAMP}`,
      clientCode: `GG${STAMP}`,
    });
    expect(a1.goodsPhotoId).not.toBeNull();
    expect(a1.boxPhotoId).not.toBeNull();
    const b = (await batchLots(batchId)).find((lot) => lot.receiptId === receiptB)!;
    expect(b).toMatchObject({ clientId: null, marking: `MK${STAMP}` });
  });

  it('the grid no longer offers a cell to an annulled prixod', async () => {
    const rows = await batchReceiptRows(batchId);
    expect(rows.map((row) => row.receiptId).sort()).toEqual([receiptA, receiptB].sort());
  });
});

describe("the grid's hints", () => {
  it("separates this truck's part of a cell from what was written elsewhere", async () => {
    // Written on the receipt card: no truck stamp.
    await addCostEntry(
      {
        scope: 'receipt',
        receiptId: receiptA,
        costTypeId: type1,
        amount: 40,
        currency: 'USD',
        costDate: today,
        allocationBasis: 'weight',
      },
      ctx(),
    );
    await addReceiptCostsBulk(
      {
        batchId,
        currency: 'USD',
        costDate: today,
        cells: [{ receiptId: receiptA, costTypeId: type1, amount: 60 }],
      },
      ctx(),
    );
    const cell = (await receiptCostMatrix([receiptA], batchId, ALL_COSTS)).get(`${receiptA}:${type1}`);
    expect(cell).toEqual({ usd: 100, unconverted: false, hereUsd: 60, others: false });
  });

  it("names the truck's own batch-wide bill, which no cell shows", async () => {
    await addCostEntry(
      {
        scope: 'batch',
        batchId,
        costTypeId: type2,
        amount: 500,
        currency: 'USD',
        costDate: today,
        allocationBasis: 'weight',
      },
      ctx(),
    );
    expect((await batchScopeCostByType(batchId, ALL_COSTS)).get(type2)?.usd).toBe(500);
  });
});

describe('a save that fails part-way says what it saved', () => {
  it('names the landed cells and leaves the rest unwritten', async () => {
    const ghostType = uuidv4(); // no such cost type: the FK refuses the second cell
    const result = await addReceiptCostsBulk(
      {
        batchId,
        currency: 'USD',
        costDate: today,
        cells: [
          { receiptId: receiptB, costTypeId: type1, amount: 11 },
          { receiptId: receiptB, costTypeId: ghostType, amount: 12 },
          { receiptId: receiptA, costTypeId: type2, amount: 13 },
        ],
      },
      ctx(),
    );
    expect(result.saved).toEqual([`${receiptB}:${type1}`]);
    expect(result.error).not.toBeNull();
    // The third cell was never attempted, so a second press cannot double it.
    const third = await db
      .select({ id: costEntries.id })
      .from(costEntries)
      .where(and(eq(costEntries.receiptId, receiptA), eq(costEntries.amount, '13.00')));
    expect(third).toHaveLength(0);
  });
});

describe('«Partiya moliyasi» by goods — the tannarx per lot', () => {
  it('is the same allocations as the client figure, grouped finer', async () => {
    const byLot = await batchLandedCostByLot(batchId);
    const byClient = (await batchLandedCostByClient(batchId)).get(clientId)!;
    const lotsOfA = (await batchLots(batchId)).filter((lot) => lot.receiptId === receiptA);
    const total = lotsOfA.reduce((a, lot) => a + (byLot.get(lot.lotId)?.totalUsd ?? 0), 0);
    const trip = lotsOfA.reduce((a, lot) => a + (byLot.get(lot.lotId)?.batchUsd ?? 0), 0);
    expect(Math.round(total * 100) / 100).toBeCloseTo(byClient.totalUsd, 1);
    expect(Math.round(trip * 100) / 100).toBeCloseTo(byClient.batchUsd, 1);
  });

  it('«shu reysgacha» on a split lot is the lot\'s share of the unstamped prixod cost', async () => {
    // The receipt card's $40 has no truck stamp, so it is money the cargo
    // brought with it. It spreads by weight over prixod A's twelve 10 kg
    // boxes; lot A1 has six of them aboard — 60 of 120 kg — so $20.
    const a1 = (await batchLandedCostByLot(batchId)).get(lotA1)!;
    expect(Math.round((a1.totalUsd - a1.batchUsd) * 100) / 100).toBe(20);
  });

  it('does not read a LATER truck\'s bill into this truck\'s goods', async () => {
    // The same cartons ride on an hour later, and that truck has its own
    // $999. Membership is for ever, so without the «shu reysgacha» fence
    // this truck's goods would carry money spent after it had left.
    const laterId = uuidv4();
    madeBatches.push(laterId);
    await db.insert(batches).values({
      id: laterId,
      code: `GGL-${STAMP}`,
      originWarehouseId: whB,
      destWarehouseId: whA,
      status: 'in_transit',
      departedAt: new Date(Date.now() + 60 * 60 * 1000),
      createdBy: actorId,
    });
    const before = (await batchLandedCostByLot(batchId)).get(lotA1)!.totalUsd;
    const a1Aboard = await db
      .select({ boxId: boxMovements.boxId })
      .from(boxMovements)
      .innerJoin(boxes, eq(boxMovements.boxId, boxes.id))
      .where(and(eq(boxMovements.refId, batchId), eq(boxes.lotId, lotA1)));
    await db.insert(boxMovements).values(
      a1Aboard.map((row) => ({
        boxId: row.boxId,
        fromWarehouseId: whB,
        toWarehouseId: whA,
        fromStatus: 'loading',
        toStatus: 'in_transit',
        cause: 'batch_departed',
        refType: 'batch',
        refId: laterId,
        actorId,
      })),
    );
    await addCostEntry(
      {
        scope: 'batch',
        batchId: laterId,
        costTypeId: type1,
        amount: 999,
        currency: 'USD',
        costDate: today,
        allocationBasis: 'weight',
      },
      ctx(),
    );
    expect((await batchLandedCostByLot(batchId)).get(lotA1)!.totalUsd).toBe(before);
  });

  it('an annulled box is not cargo, even if an allocation still points at it', async () => {
    const [entry] = await db
      .select({ id: costEntries.id })
      .from(costEntries)
      .where(and(eq(costEntries.batchId, batchId), eq(costEntries.scope, 'batch')))
      .limit(1);
    await db
      .insert(costAllocations)
      .values({ costEntryId: entry!.id, boxId: voidBox, clientId, amountUsd: '999' });
    try {
      expect((await batchLandedCostByLot(batchId)).has(lotV1)).toBe(false);
    } finally {
      await db
        .delete(costAllocations)
        .where(and(eq(costAllocations.costEntryId, entry!.id), eq(costAllocations.boxId, voidBox)));
    }
  });

  it('counts the costs that have no dollar figure, which the tannarx silently lacks', async () => {
    // Every entry the fixture wrote so far was USD and converted — so the
    // count starts at zero, and a count of ALL entries could not pass.
    const before = await unconvertedCostCount(batchId, [receiptA, receiptB]);
    expect(before).toBe(0);
    await db.insert(costEntries).values({
      scope: 'receipt',
      receiptId: receiptB,
      costTypeId: type1,
      amount: '5',
      currency: 'USD',
      costDate: today,
      allocationBasis: 'weight',
      enteredBy: actorId,
    });
    expect(await unconvertedCostCount(batchId, [receiptA, receiptB])).toBe(before + 1);
  });
});
