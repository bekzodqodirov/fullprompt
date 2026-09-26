import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  boxMovements,
  boxes,
  clientTransactions,
  clients,
  costEntries,
  costTypes,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { addTransaction, batchCharges } from '@/modules/wms/finance/service';
import { clientCargo } from '@/modules/wms/finance/client-cargo';
import { addCostEntry, batchLandedCostByLot } from '@/modules/wms/costing/service';
import { batchLots } from '@/modules/wms/batches/lots';
import { pricingView } from '@/modules/wms/finance/pricing-view';
import { profitByBatch, profitByRoute } from '@/modules/wms/accounting/reports';
import { buildProfitXlsx } from '@/modules/wms/accounting/xlsx';
import { reportLabels } from '@/modules/wms/reports/labels';
import { tripTotals } from '@/modules/wms/reports/dashboard-math';
import ExcelJS from 'exceljs';
import { costMissingBatches, costMissingCount } from '@/modules/wms/reports/queries';
import { moneyFlowCounts, vedFlowCounts } from '@/modules/wms/home/role-flows';

/**
 * An internal leg is never priced (owner, 2026-09-24: «ichki partiyalarda biz
 * yuk tarqatmaymiz, shunda narx qo'yilmagan partiyalar deb ko'rinib qolyabti»
 * → C1a: never; C2: the warning should be «rasxodini yozmading»).
 *
 * Three warehouses of this file's own: two in China, one in Uzbekistan. The
 * client's cargo rides YW → KA (internal) and then KA → TAS (across).
 */

const S = String(Date.now()).slice(-6);
let actorId: string;
let cnA: string;
let cnB: string;
let uz: string;
let uz2: string;
let uzLeg: string;
let clientId: string;
let internalBatch: string;
let exportBatch: string;
let costTypeId: string;
const madeBatches: string[] = [];
const madeBoxes: string[] = [];
let receiptId: string;
let lotId: string;
const madeTx: string[] = [];
/** The R2a block's unclaimed cargo, cleaned up beside the client's. */
const madeReceipts: string[] = [];
const madeLots: string[] = [];
const ctx = () => ({ actorId });

async function mintWarehouse(code: string, country: string) {
  return (
    await db
      .insert(warehouses)
      .values({
        code,
        batchPrefix: code,
        name: `Ichki ${code}`,
        country,
        type: 'origin',
        timezone: 'Asia/Shanghai',
      })
      .returning({ id: warehouses.id })
  )[0]!.id;
}

async function mintBatch(code: string, origin: string, dest: string, over: Partial<typeof batches.$inferInsert> = {}) {
  const id = uuidv4();
  await db.insert(batches).values({
    id,
    code,
    originWarehouseId: origin,
    destWarehouseId: dest,
    status: 'in_transit',
    departedAt: new Date(Date.now() - 10 * 24 * 3600 * 1000),
    createdBy: actorId,
    // Marked «Partiya» (0107): this file is about how the profit tables
    // read a truck, and they read only marked ones.
    profitTracked: true,
    ...over,
  });
  madeBatches.push(id);
  return id;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  cnA = await mintWarehouse(`IA${S}`, 'CN');
  // Lower-case on purpose: the country column is free text, and the rule
  // must not care how somebody typed it on /admin/warehouses.
  cnB = await mintWarehouse(`IB${S}`, 'cn');
  uz = await mintWarehouse(`IU${S}`, 'UZ');
  uz2 = await mintWarehouse(`IV${S}`, 'UZ');
  clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `IL${S}`, name: `Ichki mijoz ${S}` })
      .returning({ id: clients.id })
  )[0]!.id;
  internalBatch = await mintBatch(`IA${S}-001`, cnA, cnB);
  exportBatch = await mintBatch(`IB${S}-001`, cnB, uz);
  // Andijan → Tashkent: inside Uzbekistan, and PRICED (owner U1b).
  uzLeg = await mintBatch(`IU${S}-001`, uz, uz2);

  receiptId = (
    await db
      .insert(receipts)
      .values({ warehouseId: cnA, clientId, status: 'confirmed', createdBy: actorId })
      .returning({ id: receipts.id })
  )[0]!.id;
  lotId = (
    await db
      .insert(receiptLots)
      .values({
        receiptId,
        seq: 1,
        letter: 'A',
        productNameZh: `货${S}`,
        boxCount: 1,
        dimsMode: 'mixed',
        totalWeightKg: '10',
        totalVolumeM3: '0.1',
      })
      .returning({ id: receiptLots.id })
  )[0]!.id;
  const boxId = (
    await db
      .insert(boxes)
      .values({ lotId, shortCode: `ILX${S}`, seqInLot: 1, currentWarehouseId: null, status: 'in_transit' })
      .returning({ id: boxes.id })
  )[0]!.id;
  madeBoxes.push(boxId);
  for (const [batch, from, to] of [
    [internalBatch, cnA, cnB],
    [exportBatch, cnB, uz],
    [uzLeg, uz, uz2],
  ] as const) {
    await db.insert(boxMovements).values({
      boxId,
      fromWarehouseId: from,
      toWarehouseId: to,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: batch,
      actorId,
    });
  }
});

afterAll(async () => {
  if (madeTx.length) await db.delete(clientTransactions).where(inArray(clientTransactions.id, madeTx));
  await db.delete(costEntries).where(inArray(costEntries.batchId, madeBatches));
  await db.delete(costEntries).where(inArray(costEntries.receiptId, [receiptId, ...madeReceipts]));
  await db.delete(boxMovements).where(inArray(boxMovements.boxId, madeBoxes));
  await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  await db.delete(receiptLots).where(inArray(receiptLots.id, [lotId, ...madeLots]));
  await db.delete(receipts).where(inArray(receipts.id, [receiptId, ...madeReceipts]));
  await db.delete(batches).where(inArray(batches.id, madeBatches));
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(warehouses).where(inArray(warehouses.id, [cnA, cnB, uz, uz2]));
  await pgClient.end();
});

describe('an internal leg is never priced', () => {
  it('refuses a price on the internal truck and takes it on the one that crosses', async () => {
    await expect(
      addTransaction(
        { clientId, type: 'charge', amount: 10, currency: 'USD', txDate: '2026-07-10', batchId: internalBatch },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'internal_batch' });

    const priced = await addTransaction(
      { clientId, type: 'charge', amount: 10, currency: 'USD', txDate: '2026-07-10', batchId: exportBatch },
      ctx(),
    );
    madeTx.push(priced.id);
  });

  it('still takes a PAYMENT that names the internal truck — money received is not a price', async () => {
    const paid = await addTransaction(
      { clientId, type: 'payment', amount: 1, currency: 'USD', txDate: '2026-07-10', batchId: internalBatch },
      ctx(),
    );
    madeTx.push(paid.id);
  });
});

describe('the client card', () => {
  it('marks the internal trip instead of «narx qo‘yilmagan», and names a missing cost', async () => {
    const cargo = await clientCargo(clientId);
    const internal = cargo.trips.find((trip) => trip.batchId === internalBatch)!;
    const across = cargo.trips.find((trip) => trip.batchId === exportBatch)!;
    expect(internal).toMatchObject({ internal: true, costMissing: true });
    expect(across).toMatchObject({ internal: false, costMissing: false });

    await addCostEntry(
      {
        scope: 'batch',
        batchId: internalBatch,
        costTypeId,
        amount: 30,
        currency: 'USD',
        costDate: '2026-07-10',
        allocationBasis: 'weight',
      },
      ctx(),
    );
    const after = (await clientCargo(clientId)).trips.find((trip) => trip.batchId === internalBatch)!;
    expect(after.costMissing).toBe(false);
  });
});

describe('the counters', () => {
  it('the homes count every truck with no cost, not the first twenty', async () => {
    // Twenty-one bare trucks of this file's own, departed ten days ago. The
    // homes used to print the LENGTH of the 20-row list (#977's shape).
    const today = new Date().toISOString().slice(0, 10);
    const before = await costMissingCount(3);
    for (let i = 0; i < 21; i += 1) {
      await mintBatch(`IC${S}-${String(i).padStart(3, '0')}`, cnA, uz);
    }
    expect(before + 21).toBeGreaterThan(20);
    expect((await moneyFlowCounts(today)).costMissing).toBe(before + 21);
    // The LIST stays a page of twenty — it is the number that must not.
    expect((await costMissingBatches(3)).length).toBeLessThanOrEqual(20);
  });

  it('the VED’s «papers not sent» skips an internal leg', async () => {
    const before = (await vedFlowCounts()).docsPending;
    await mintBatch(`ID${S}-001`, cnA, cnB); // internal: no export papers
    expect((await vedFlowCounts()).docsPending).toBe(before);
    await mintBatch(`ID${S}-002`, cnB, uz); // across the border
    expect((await vedFlowCounts()).docsPending).toBe(before + 1);
  });
});

describe('a truck inside Uzbekistan is priced (owner U1b: «Andijondan berilganda qo‘yiladi»)', () => {
  it('takes a price, and the client card reads it as an ordinary trip', async () => {
    const priced = await addTransaction(
      { clientId, type: 'charge', amount: 7, currency: 'USD', txDate: '2026-07-11', batchId: uzLeg },
      ctx(),
    );
    madeTx.push(priced.id);
    const trip = (await clientCargo(clientId)).trips.find((row) => row.batchId === uzLeg)!;
    expect(trip).toMatchObject({ internal: false });
  });

  it('still carries no export papers for the VED to send', async () => {
    const before = (await vedFlowCounts()).docsPending;
    await mintBatch(`ID${S}-003`, uz, uz2);
    expect((await vedFlowCounts()).docsPending).toBe(before);
  });
});

/**
 * «Bitta mashina bitta foyda» (owner's R2a, 2026-09-24): «Partiya foydasi»
 * reads the SAME landed cost «Partiya moliyasi» prints in its header, and an
 * internal leg is a cost row, never a margin. The report used to sum the
 * cost entries stamped with the truck — so the internal leg was a pure red
 * row, the export truck never saw the internal leg's money, the receipt's
 * money or the unclaimed cargo's, and an entry that reached no box counted.
 */
describe('one truck, one profit (R2a)', () => {
  const day = (offset: number) => new Date(Date.now() + offset * 24 * 3600 * 1000);
  const iso = (offset: number) => day(offset).toISOString().slice(0, 10);

  /** What «Partiya moliyasi» prints in its header, assembled as the page does. */
  const header = async (batchId: string) =>
    pricingView(
      await batchLots(batchId),
      await batchLandedCostByLot(batchId),
      (await batchCharges(batchId)).map(({ tx, clientCode, clientName }) => ({
        clientId: tx.clientId,
        clientCode,
        clientName,
        type: tx.type,
        amountUsd: Number(tx.amountUsd),
      })),
    ).totals;

  beforeAll(async () => {
    // The legs in the order the cargo rode them: «shu reysgacha» is decided
    // by departure, and three trucks minted in one millisecond would tie.
    await db.update(batches).set({ departedAt: day(-12) }).where(eq(batches.id, internalBatch));
    await db.update(batches).set({ departedAt: day(-10) }).where(eq(batches.id, exportBatch));
    await db.update(batches).set({ departedAt: day(-8) }).where(eq(batches.id, uzLeg));

    // The receipt's own money (no truck): rides every leg.
    await addCostEntry(
      { scope: 'receipt', receiptId, costTypeId, amount: 5, currency: 'USD', costDate: '2026-07-09', allocationBasis: 'weight' },
      ctx(),
    );
    // The export truck's own customs.
    await addCostEntry(
      { scope: 'batch', batchId: exportBatch, costTypeId, amount: 100, currency: 'USD', costDate: '2026-07-10', allocationBasis: 'weight' },
      ctx(),
    );
    // A LATER leg's money must not reach the export truck.
    await addCostEntry(
      { scope: 'batch', batchId: uzLeg, costTypeId, amount: 7, currency: 'USD', costDate: '2026-07-11', allocationBasis: 'weight' },
      ctx(),
    );
    // Stamped with the export truck and allocated to NOBODY: no landed cost
    // carries it, so the report must name it instead of counting it.
    await db.insert(costEntries).values({
      scope: 'batch',
      batchId: exportBatch,
      costTypeId,
      amount: '11',
      currency: 'USD',
      amountUsd: '11',
      fxRateUsed: '1',
      costDate: '2026-07-10',
      allocationBasis: 'weight',
      enteredBy: actorId,
    });

    // Cargo nobody has claimed, on the export truck, with a receipt cost.
    const unclaimed = (
      await db
        .insert(receipts)
        .values({ warehouseId: cnA, clientId: null, unclaimedMarking: `MK${S}`, status: 'confirmed', createdBy: actorId })
        .returning({ id: receipts.id })
    )[0]!.id;
    madeReceipts.push(unclaimed);
    const unclaimedLot = (
      await db
        .insert(receiptLots)
        .values({
          receiptId: unclaimed,
          seq: 1,
          letter: 'A',
          productNameZh: `无主${S}`,
          boxCount: 1,
          dimsMode: 'mixed',
          totalWeightKg: '4',
          totalVolumeM3: '0.04',
        })
        .returning({ id: receiptLots.id })
    )[0]!.id;
    madeLots.push(unclaimedLot);
    const unclaimedBox = (
      await db
        .insert(boxes)
        .values({ lotId: unclaimedLot, shortCode: `ILU${S}`, seqInLot: 1, currentWarehouseId: null, status: 'in_transit' })
        .returning({ id: boxes.id })
    )[0]!.id;
    madeBoxes.push(unclaimedBox);
    await db.insert(boxMovements).values({
      boxId: unclaimedBox,
      fromWarehouseId: cnB,
      toWarehouseId: uz,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: exportBatch,
      actorId,
    });
    await addCostEntry(
      { scope: 'receipt', receiptId: unclaimed, costTypeId, amount: 3, currency: 'USD', costDate: '2026-07-09', allocationBasis: 'weight' },
      ctx(),
    );

    // The price, on the truck that crosses (the $10 of the first block stays).
    madeTx.push(
      (
        await addTransaction(
          { clientId, type: 'charge', amount: 200, currency: 'USD', txDate: '2026-07-12', batchId: exportBatch },
          ctx(),
        )
      ).id,
    );
  });

  it('the export truck reads exactly the pricing screen’s header', async () => {
    const rows = await profitByBatch(iso(-20), iso(0));
    const row = rows.find((entry) => entry.batchId === exportBatch)!;
    const totals = await header(exportBatch);
    expect(row.costUsd).toBe(totals.costUsd);
    expect(row.profitUsd).toBe(totals.marginUsd);
    expect(row.revenueUsd).toBe(totals.chargedUsd);
    expect(row.prevUsd).toBe(totals.prevUsd);
    // And the figures themselves: the internal leg's 30 + the receipt's 5 +
    // its own 100 on the client's goods, the unclaimed cargo's 3; NOT the
    // later leg's 7 and NOT the 11 nobody could allocate.
    expect(row).toMatchObject({
      internal: false,
      costUsd: 138,
      prevUsd: 38,
      revenueUsd: 210,
      profitUsd: 72,
      unallocatedUsd: 11,
    });
  });

  it('the Uzbek leg carries its own road only — the earlier legs are the export truck’s (U16)', async () => {
    const rows = await profitByBatch(iso(-20), iso(0));
    const row = rows.find((entry) => entry.batchId === uzLeg)!;
    expect(row.costUsd).toBe((await header(uzLeg)).costUsd);
    // Its own $7, and NOT the receipt's 5, the internal 30 and the export's
    // 100 again: the export truck is the box's previous PRICED truck, so
    // everything before it stops there.
    expect(row).toMatchObject({ internal: false, revenueUsd: 7, costUsd: 7, prevUsd: 0, profitUsd: 0 });
    const across = rows.find((entry) => entry.batchId === exportBatch)!;
    // The priced rows are disjoint: together they are every allocated dollar
    // once — 5 + 30 + 100 + 7 on the client's box, 3 on the unclaimed one.
    expect(Math.round((across.costUsd + row.costUsd) * 100) / 100).toBe(145);
  });

  it('the internal leg is a cost row: its own header’s cost, and no profit at all', async () => {
    const rows = await profitByBatch(iso(-20), iso(0));
    const row = rows.find((entry) => entry.batchId === internalBatch)!;
    expect(row.costUsd).toBe((await header(internalBatch)).costUsd);
    expect(row).toMatchObject({
      internal: true,
      costUsd: 35,
      profitUsd: null,
      marginPct: null,
      profitPerKg: null,
    });
  });

  it('the file sums like the screen: the internal leg has its own column, the total is the page’s JAMI (U22)', async () => {
    const L = reportLabels('uz');
    const read = async (view: 'batch' | 'route') => {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load((await buildProfitXlsx(view, iso(-20), iso(0), 'uz')) as unknown as ArrayBuffer);
      const out: unknown[][] = [];
      workbook.worksheets[0]!.eachRow((row) => out.push((row.values as unknown[]).slice(1)));
      return out;
    };
    for (const view of ['batch', 'route'] as const) {
      // The file's set (0107): trucks marked «Partiya» — another file's
      // unmarked truck in the same window is named in a note, not a row.
      const rows =
        view === 'batch'
          ? (await profitByBatch(iso(-20), iso(0))).filter((row) => row.tracked)
          : await profitByRoute(iso(-20), iso(0));
      const totals = tripTotals(rows);
      const table = await read(view);
      const head = table.findIndex((row) => row.includes(`${L.cost} $`));
      const col = (label: string) => table[head]!.indexOf(label);
      const jami = table.findIndex((row) => row[0] === L.total);
      const data = table.slice(head + 1, jami);
      const sum = (at: number) =>
        Math.round(data.reduce((acc: number, row) => acc + (typeof row[at] === 'number' ? (row[at] as number) : 0), 0) * 100) / 100;
      // A hand SUM of «Xarajat $» is the screen's JAMI — the internal leg is
      // not in it twice — and the file's own total row says the same.
      expect(sum(col(`${L.cost} $`)), view).toBe(totals.cost);
      expect(table[jami]![col(`${L.cost} $`)], view).toBe(totals.cost);
      expect(table[jami]![col(`${L.profit} $`)], view).toBe(totals.profit);
      // …and the internal leg's money is still in the file, in its own column.
      expect(sum(col(L.internalCost)), view).toBeGreaterThan(0);
    }
    const batch = await read('batch');
    expect(batch.some((row) => String(row[0]).startsWith(`⚠ ${L.unallocatedNote}`))).toBe(true);
    expect(batch.some((row) => row[0] === L.internalRowsNote)).toBe(true);
  });

  it('the corridor roll-up carries the same money, and a Chinese corridor stays cost-only', async () => {
    const rows = await profitByBatch(iso(-20), iso(0));
    const routes = await profitByRoute(iso(-20), iso(0));
    const across = rows.find((entry) => entry.batchId === exportBatch)!;
    const inside = rows.find((entry) => entry.batchId === internalBatch)!;
    const sum = (route: string, pick: (entry: (typeof rows)[number]) => number) =>
      Math.round(
        rows.filter((entry) => entry.route === route && entry.tracked).reduce((a, entry) => a + pick(entry), 0) * 100,
      ) / 100;

    const acrossRoute = routes.find((entry) => entry.route === across.route)!;
    expect(acrossRoute.internal).toBe(false);
    expect(acrossRoute.costUsd).toBe(sum(across.route, (entry) => entry.costUsd));
    expect(acrossRoute.profitUsd).toBe(
      Math.round((acrossRoute.revenueUsd - acrossRoute.costUsd) * 100) / 100,
    );

    const insideRoute = routes.find((entry) => entry.route === inside.route)!;
    expect(insideRoute).toMatchObject({ internal: true, profitUsd: null, marginPct: null, profitPerKg: null });
    expect(insideRoute.costUsd).toBe(sum(inside.route, (entry) => entry.costUsd));
  });
});
