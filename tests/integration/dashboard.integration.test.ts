import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  boxMovements,
  boxes,
  clientTransactions,
  clients,
  expenseCategories,
  expenses,
  moneyAccounts,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { cashFlow, cashFlowByMonth } from '@/modules/wms/accounting/reports';
import { cargoPipeline, intakeByMonth, unbilledArrived } from '@/modules/wms/reports/business';
import { receiptsJournalTotals, stockByWarehouse } from '@/modules/wms/reports/queries';

/**
 * The dashboard draws the reports' OWN numbers (#513). These fences hold the
 * three places where it had to compute a shape the report did not have: the
 * cash flow by month (one core, bucketed), where the cargo stands (the shelf
 * stages must equal the stock table), and the arrived-but-not-billed list
 * (owner 8a: a price on ANY truck the prixod rode, or on its deal, covers
 * the whole prixod — his answer 7).
 *
 * Money lives in 1652 so no other file's period reads it; the cargo fixture
 * is a private UZ warehouse.
 */

const STAMP = `${Date.now()}`.slice(-6);
let actorId: string;
let tillId: string;
let categoryId: string;
let whId: string;
let whCnId: string;
let clientId: string;
let receiptId: string;
let batchId: string;
const madeBoxes: string[] = [];
const madeReceipts: string[] = [];

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  tillId = (
    await db
      .insert(moneyAccounts)
      .values({ name: `Dash kassa ${STAMP}`, currency: 'USD' })
      .returning({ id: moneyAccounts.id })
  )[0]!.id;
  categoryId = (
    await db
      .select({ id: expenseCategories.id })
      .from(expenseCategories)
      .where(eq(expenseCategories.cash, true))
      .limit(1)
  )[0]!.id;
  whId = (
    await db
      .insert(warehouses)
      .values({
        name: `Dash UZ ${STAMP}`,
        code: `DZ${STAMP}`,
        batchPrefix: `DZ${STAMP}`,
        country: 'UZ',
        type: 'distribution',
        timezone: 'Asia/Tashkent',
      })
      .returning({ id: warehouses.id })
  )[0]!.id;
  whCnId = (
    await db
      .insert(warehouses)
      .values({
        name: `Dash CN ${STAMP}`,
        code: `DC${STAMP}`,
        batchPrefix: `DC${STAMP}`,
        country: 'CN',
        type: 'origin',
        timezone: 'Asia/Shanghai',
      })
      .returning({ id: warehouses.id })
  )[0]!.id;
  clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `DB${STAMP}`, name: `Dashboard mijoz ${STAMP}` })
      .returning({ id: clients.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(clientTransactions).where(eq(clientTransactions.clientId, clientId));
  await db.delete(expenses).where(eq(expenses.accountId, tillId));
  if (madeBoxes.length) {
    await db.delete(boxMovements).where(inArray(boxMovements.boxId, madeBoxes));
    await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
  }
  const allReceipts = [...madeReceipts, ...(receiptId ? [receiptId] : [])];
  if (allReceipts.length) {
    await db.delete(receiptLots).where(inArray(receiptLots.receiptId, allReceipts));
    await db.delete(receipts).where(inArray(receipts.id, allReceipts));
  }
  if (batchId) await db.execute(sql`DELETE FROM batches WHERE id = ${batchId}`);
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(moneyAccounts).where(eq(moneyAccounts.id, tillId));
  // A warehouse an audited action never touched: delete it outright.
  await db.delete(warehouses).where(inArray(warehouses.id, [whId, whCnId]));
  await pgClient.end();
});

async function money(type: 'payment' | 'refund', usd: number, day: string) {
  await db.insert(clientTransactions).values({
    clientId,
    type,
    amount: String(usd),
    currency: 'USD',
    rateToUsd: '1',
    amountUsd: String(usd),
    txDate: day,
    accountId: tillId,
    createdBy: actorId,
  });
}

describe('the cash flow by month is the cash flow report, bucketed', () => {
  it('each month equals the report over that month, and the months sum to the range', async () => {
    await money('payment', 1200, '1652-01-10');
    await money('payment', 300, '1652-01-31');
    await money('refund', 50, '1652-03-02');
    await db.insert(expenses).values([
      {
        categoryId,
        amount: '400',
        currency: 'USD',
        rateToUsd: '1',
        amountUsd: '400',
        expenseDate: '1652-01-15',
        accountId: tillId,
        createdBy: actorId,
      },
      {
        categoryId,
        amount: '90',
        currency: 'USD',
        rateToUsd: '1',
        amountUsd: '90',
        expenseDate: '1652-03-20',
        accountId: tillId,
        createdBy: actorId,
      },
    ]);

    const months = await cashFlowByMonth('1652-01-01', '1652-03-31');
    expect([...months.keys()]).toEqual(['1652-01', '1652-02', '1652-03']);
    const bounds: Record<string, [string, string]> = {
      '1652-01': ['1652-01-01', '1652-01-31'],
      '1652-02': ['1652-02-01', '1652-02-29'],
      '1652-03': ['1652-03-01', '1652-03-31'],
    };
    for (const [month, [from, to]] of Object.entries(bounds)) {
      const report = await cashFlow(from, to);
      const part = months.get(month)!;
      expect(part.inflow, month).toBe(report.inflow);
      expect(part.outflow, month).toBe(report.outflow);
      expect(part.net, month).toBe(report.net);
    }
    expect(months.get('1652-01')).toMatchObject({ clientPayments: 1500, cashOpex: 400, net: 1100 });
    // An empty month is a month of zeros, never missing (the chart's x-axis).
    expect(months.get('1652-02')).toMatchObject({ inflow: 0, outflow: 0, net: 0 });
    expect(months.get('1652-03')).toMatchObject({ clientRefunds: 50, cashOpex: 90, net: -140 });

    const whole = await cashFlow('1652-01-01', '1652-03-31');
    const summed = [...months.values()].reduce((sum, part) => sum + part.net, 0);
    expect(Math.round(summed * 100) / 100).toBe(whole.net);
  });
});

describe('where the cargo stands', () => {
  it('the shelf stages are exactly the stock table', async () => {
    const [pipeline, stock] = await Promise.all([cargoPipeline(), stockByWarehouse()]);
    const shelf = pipeline.cn.boxes + pipeline.uz.boxes + pipeline.other.boxes;
    expect(shelf).toBe(stock.reduce((sum, row) => sum + row.boxCount, 0));
    const shelfM3 = pipeline.cn.m3 + pipeline.uz.m3 + pipeline.other.m3;
    const stockM3 = stock.reduce((sum, row) => sum + row.m3, 0);
    // The stock table rounds per warehouse; a cent of m³ per row is the most
    // the two can differ by.
    expect(Math.abs(shelfM3 - stockM3)).toBeLessThanOrEqual(0.01 * Math.max(1, stock.length));
  });
});

describe('arrived, not billed (owner 8a)', () => {
  it('lists landed cargo with no price, and a price on a truck it rode covers the whole prixod', async () => {
    receiptId = (
      await db
        .insert(receipts)
        .values({ warehouseId: whId, clientId, status: 'confirmed', createdBy: actorId })
        .returning({ id: receipts.id })
    )[0]!.id;
    const lotId = (
      await db
        .insert(receiptLots)
        .values({
          receiptId,
          seq: 1,
          productNameZh: `货${STAMP}`,
          boxCount: 2,
          dimsMode: 'mixed',
          totalWeightKg: '40',
          totalVolumeM3: '0.4',
        })
        .returning({ id: receiptLots.id })
    )[0]!.id;
    const rows = await db
      .insert(boxes)
      .values(
        [1, 2].map((i) => ({
          lotId,
          shortCode: `DB${STAMP}${i}`,
          seqInLot: i,
          currentWarehouseId: whId,
          status: 'ready_for_pickup' as const,
        })),
      )
      .returning({ id: boxes.id });
    madeBoxes.push(...rows.map((row) => row.id));
    // Landed INTO the Uzbek warehouse from the road.
    await db.insert(boxMovements).values(
      rows.map((row) => ({
        boxId: row.id,
        fromWarehouseId: null,
        toWarehouseId: whId,
        fromStatus: 'in_transit',
        toStatus: 'ready_for_pickup',
        cause: 'unload_scan',
      })),
    );

    const before = (await unbilledArrived()).find((row) => row.clientId === clientId);
    expect(before).toMatchObject({ receipts: 1, boxes: 2, m3: 0.4, kg: 40, issuedBoxes: 0 });

    // A price typed on the client card with no truck and no deal names no
    // cargo: it covers nothing, and the list still says so.
    await db.insert(clientTransactions).values({
      clientId,
      type: 'charge',
      amount: '100',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '100',
      txDate: '1652-04-01',
      createdBy: actorId,
    });
    expect((await unbilledArrived()).some((row) => row.clientId === clientId)).toBe(true);

    // ONE box rode a truck; a price on that truck covers the whole prixod
    // (his answer 7: sometimes one bill, sometimes per truck).
    batchId = (
      await db.execute<{ id: string }>(sql`
        INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, created_by)
        VALUES (gen_random_uuid(), ${`DZB${STAMP}`}, ${whCnId}, ${whId}, 'closed', ${actorId})
        RETURNING id
      `)
    )[0]!.id;
    await db.insert(boxMovements).values({
      boxId: rows[0]!.id,
      fromWarehouseId: whCnId,
      toWarehouseId: null,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: batchId,
    });
    await db.insert(clientTransactions).values({
      clientId,
      type: 'charge',
      amount: '250',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '250',
      txDate: '1652-04-02',
      batchId,
      createdBy: actorId,
    });
    expect((await unbilledArrived()).some((row) => row.clientId === clientId)).toBe(false);
  });
});

describe('the intake tile and the receipts journal count the same thing', () => {
  it('a Tashkent month in intakeByMonth equals the journal header over that range', async () => {
    // One receipt at 23:30 Tashkent on the last day (18:30 UTC) and one at
    // 00:30 on the next month's first day (19:30 UTC the day before): the
    // month boundary is Tashkent's in BOTH readers (R5).
    for (const [at, count] of [
      ['1652-05-31T18:30:00Z', 3],
      ['1652-05-31T19:30:00Z', 5],
    ] as const) {
      const id = (
        await db
          .insert(receipts)
          .values({ warehouseId: whId, clientId, status: 'confirmed', createdBy: actorId, receivedAt: new Date(at) })
          .returning({ id: receipts.id })
      )[0]!.id;
      madeReceipts.push(id);
      await db.insert(receiptLots).values({
        receiptId: id,
        seq: 1,
        productNameZh: `货${STAMP}`,
        boxCount: count,
        dimsMode: 'mixed',
        totalWeightKg: String(count * 10),
        totalVolumeM3: String(count / 10),
      });
    }
    const [may] = await intakeByMonth('1652-05-01', '1652-05-31');
    const journal = await receiptsJournalTotals({ from: '1652-05-01', to: '1652-05-31' });
    expect(may).toMatchObject({ month: '1652-05', receipts: 1, boxes: 3 });
    expect(journal).toMatchObject({ receipts: may!.receipts, boxes: may!.boxes, m3: may!.m3, kg: may!.kg });
    expect((await receiptsJournalTotals({ from: '1652-06-01', to: '1652-06-30' })).boxes).toBe(5);
  });
});
