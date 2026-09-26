import 'dotenv/config';
import { asc, eq, inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  boxMovements,
  boxes,
  clients,
  costEntries,
  costTypes,
  events,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { createClient } from '@/modules/platform/clients/service';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import {
  addCostEntry,
  addReceiptCostsBulk,
  batchCostSheet,
  batchScopeCostByType,
  costEntriesFor,
  receiptCostMatrix,
} from '@/modules/wms/costing/service';
import { ALL_COSTS } from '@/modules/wms/costing/cost-sight';
import { buildBatchRegisterXlsx } from '@/modules/wms/reports/xlsx';

/**
 * Q19 D1 (owner, 2026-09-25, «19 a»): the VED keeps entering batch costs and
 * sees ONLY the entries he typed — everybody's entries beside the truck's
 * kg/m³ are its tannarx one division away (#791). What a colleague wrote on
 * the same truck comes back as a count and its TYPE names, so «Rastamojka»
 * is visible without its amount and nobody types the bill twice.
 *
 * Proven through the four readers the cards and the grid call, with a real
 * truck: a VED user and a colleague each type a truck bill and a grid cell on
 * the same prixod. Cost dates in 1619, a year no other file writes (#713).
 */
const DAY = '1619-05-20';
const STAMP = Date.now();
let ved: string;
let colleague: string;
let warehouseId: string;
let clientId: string;
let receiptId: string;
let typeMine: { id: string; name: string };
let typeTheirs: { id: string; name: string };
const batchId = uuidv4();

async function receiveCargo(actorId: string): Promise<string> {
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `costsight/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: actorId,
  });
  const result = await confirmReceipt(
    {
      receiptId: uuidv4(),
      warehouseId,
      clientId,
      sourceNote: '',
      unclaimedMarking: '',
      dealId: null,
      lots: [
        {
          id: lotId,
          productNameZh: `成本 ${STAMP}`,
          productNameRu: '',
          boxCount: 1,
          dimsMode: 'mixed',
          totalWeightKg: 20,
          totalVolumeM3: 0.2,
          note: '',
        },
      ],
      extraCosts: [],
    } as Parameters<typeof confirmReceipt>[0],
    { actorId },
  );
  return result.receiptId;
}

beforeAll(async () => {
  const people = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.active, true))
    .orderBy(asc(users.id))
    .limit(2);
  ved = people[0]!.id;
  colleague = people[1]!.id;
  const cn = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(eq(warehouses.country, 'CN'))
    .orderBy(asc(warehouses.code))
    .limit(2);
  warehouseId = cn[0]!.id;
  clientId = (
    await createClient(
      { clientCode: `CS${String(STAMP).slice(-7)}`, name: `Cost sight ${STAMP}`, phones: [] },
      { actorId: ved },
    )
  ).id;
  receiptId = await receiveCargo(ved);
  await db.insert(batches).values({
    id: batchId,
    code: `CSB-${STAMP}`,
    originWarehouseId: warehouseId,
    destWarehouseId: cn[1]!.id,
    status: 'in_transit',
    departedAt: new Date(),
    createdBy: ved,
  });
  const [box] = await db
    .select({ id: boxes.id })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(eq(receiptLots.receiptId, receiptId));
  await db.insert(boxMovements).values({
    boxId: box!.id,
    fromWarehouseId: warehouseId,
    toWarehouseId: warehouseId,
    fromStatus: 'in_stock',
    toStatus: 'in_transit',
    cause: 'batch_departed',
    refType: 'batch',
    refId: batchId,
    actorId: ved,
  });
  const types = await db
    .select({ id: costTypes.id, name: costTypes.name })
    .from(costTypes)
    .where(eq(costTypes.active, true))
    .orderBy(asc(costTypes.code))
    .limit(2);
  typeMine = types[0]!;
  typeTheirs = types[1]!;

  // The VED types a truck bill and a grid cell; the colleague the same.
  await addCostEntry(
    { scope: 'batch', batchId, costTypeId: typeMine.id, amount: 70, currency: 'USD', costDate: DAY, allocationBasis: 'weight' },
    { actorId: ved },
  );
  await addCostEntry(
    { scope: 'batch', batchId, costTypeId: typeTheirs.id, amount: 90, currency: 'USD', costDate: DAY, allocationBasis: 'weight' },
    { actorId: colleague },
  );
  await addReceiptCostsBulk(
    { batchId, currency: 'USD', costDate: DAY, cells: [{ receiptId, costTypeId: typeMine.id, amount: 40 }] },
    { actorId: ved },
  );
  await addReceiptCostsBulk(
    { batchId, currency: 'USD', costDate: DAY, cells: [{ receiptId, costTypeId: typeTheirs.id, amount: 25 }] },
    { actorId: colleague },
  );
});

afterAll(async () => {
  try {
    await db.delete(costEntries).where(eq(costEntries.batchId, batchId));
    await db.delete(costEntries).where(eq(costEntries.receiptId, receiptId));
    const lots = await db.select({ id: receiptLots.id }).from(receiptLots).where(eq(receiptLots.receiptId, receiptId));
    const lotIds = lots.map((lot) => lot.id);
    if (lotIds.length) {
      const rows = await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds));
      if (rows.length) {
        await db.delete(boxMovements).where(inArray(boxMovements.boxId, rows.map((b) => b.id)));
        await db.delete(boxes).where(inArray(boxes.lotId, lotIds));
      }
      await db.delete(attachments).where(inArray(attachments.entityId, lotIds));
      await db.delete(receiptLots).where(eq(receiptLots.receiptId, receiptId));
    }
    await db.delete(events).where(eq(events.entityId, receiptId));
    await db.delete(receipts).where(eq(receipts.id, receiptId));
    await db.delete(batches).where(eq(batches.id, batchId));
    await db.delete(clients).where(eq(clients.id, clientId));
  } finally {
    await pgClient.end();
  }
});

describe('the VED reads his own cost entries and the TYPES of the rest (Q19 D1)', () => {
  it('the batch card: his rows, no truck total and no per-unit cost, the colleague’s as types', async () => {
    const sheet = await batchCostSheet(batchId, { ownOnly: ved });
    expect(sheet.entries.every((row) => row.entry.enteredBy === ved)).toBe(true);
    expect(sheet.entries.map((row) => Number(row.entry.amount)).sort((a, b) => a - b)).toEqual([40, 70]);
    expect(sheet.totalUsd).toBeNull();
    expect(sheet.usdPerKg).toBeNull();
    expect(sheet.usdPerM3).toBeNull();
    expect(sheet.others).toEqual({ count: 2, types: [typeTheirs.name] });
  });

  it('the accountant reads every row and the sum, and no «others» line', async () => {
    const sheet = await batchCostSheet(batchId, ALL_COSTS);
    expect(sheet.entries).toHaveLength(4);
    expect(sheet.totalUsd).toBe(225);
    expect(sheet.others).toEqual({ count: 0, types: [] });
  });

  it('the grid: his cell carries his sum, the colleague’s says «written» without one', async () => {
    const matrix = await receiptCostMatrix([receiptId], batchId, { ownOnly: ved });
    expect(matrix.get(`${receiptId}:${typeMine.id}`)).toEqual({ usd: 40, unconverted: false, hereUsd: 40, others: false });
    expect(matrix.get(`${receiptId}:${typeTheirs.id}`)).toEqual({ usd: 0, unconverted: false, hereUsd: 0, others: true });
    const whole = await receiptCostMatrix([receiptId], batchId, ALL_COSTS);
    expect(whole.get(`${receiptId}:${typeTheirs.id}`)).toEqual({ usd: 25, unconverted: false, hereUsd: 25, others: false });
    // The same prixod read on ANOTHER truck's grid: the colleague's cell is
    // that truck's, not this one's — no «✍», no column hidden as filled
    // (review of the VED unit: it was counted over every truck).
    const elsewhere = await receiptCostMatrix([receiptId], uuidv4(), { ownOnly: ved });
    expect(elsewhere.get(`${receiptId}:${typeTheirs.id}`)).toEqual({ usd: 0, unconverted: false, hereUsd: 0, others: false });
  });

  it('the grid header: the truck-wide bills per type, his summed, the colleague’s flagged', async () => {
    const own = await batchScopeCostByType(batchId, { ownOnly: ved });
    expect(own.get(typeMine.id)).toEqual({ usd: 70, others: false });
    expect(own.get(typeTheirs.id)).toEqual({ usd: 0, others: true });
    expect((await batchScopeCostByType(batchId, ALL_COSTS)).get(typeTheirs.id)).toEqual({ usd: 90, others: false });
  });

  it('the receipt card lists through the same reader', async () => {
    const { entries, others } = await costEntriesFor({ receiptId }, { ownOnly: ved });
    expect(entries.map((row) => Number(row.entry.amount))).toEqual([40]);
    expect(others).toEqual({ count: 1, types: [typeTheirs.name] });
    const all = await costEntriesFor({ receiptId }, ALL_COSTS);
    expect(all.entries).toHaveLength(2);
  });
});

describe('the batch register file (Q19)', () => {
  it('without costs it carries none of the three cost columns; with them, all three', async () => {
    const read = async (costs: boolean) => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(
        (await buildBatchRegisterXlsx(undefined, 'uz', { costs })) as unknown as Parameters<typeof workbook.xlsx.load>[0],
      );
      const sheet = workbook.worksheets[0]!;
      // Row 1 is the sheet's title line; the header is the first row with a
      // cell in column 10 (m³).
      const header = [...Array(sheet.rowCount).keys()]
        .map((i) => sheet.getRow(i + 1))
        .find((row) => row.cellCount >= 10)!;
      return (header.values as unknown[]).filter((v) => v !== undefined && v !== null && v !== '');
    };
    expect(await read(false)).toHaveLength(10);
    expect(await read(true)).toHaveLength(13);
  });
});
