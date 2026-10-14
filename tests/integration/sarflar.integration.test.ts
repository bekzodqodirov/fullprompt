import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  batches,
  clients,
  costEntries,
  costTypes,
  crates,
  expenseCategories,
  expenses,
  moneyAccounts,
  partners,
  partnerTypes,
  partnerTransactions,
  pickups,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { addCostEntry } from '@/modules/wms/costing/service';
import { addExpense } from '@/modules/wms/accounting/service';
import { profitAndLoss } from '@/modules/wms/accounting/reports';
import { readSpendFilters, spendMap, spendRegister, spendTrucks } from '@/modules/wms/accounting/sarflar';
import { uncheckedTwinRows } from '@/modules/wms/accounting/twins';
import { companyMoneySight } from '@/modules/wms/finance/scope';
import { ALL_COSTS } from '@/modules/wms/costing/cost-sight';

/**
 * «Pul qayerga ketdi» against a real database (docs/SARFLAR.md §1, §8.3):
 * every block is a regrouping of the money the P&L adds up, so each one
 * reconciles to the P&L's own direct + opex to the cent — measured against
 * `profitAndLoss` itself, never against a second sum written here.
 *
 * Its own period in 1630, so the P&L of that window holds this file's rows
 * and nothing else.
 */

const STAMP = String(Date.now()).slice(-6);
const FROM = '1630-05-01';
const TO = '1630-05-31';
const DAY = '1630-05-12';
let actorId = '';
let costTypeId = '';
let categoryId = '';
let batchId = '';
let receiptId = '';
let crateId = '';
let pickupId = '';
let clientId = '';
let till = '';
let firmId = '';
const madeWarehouses: string[] = [];
const madeCosts: string[] = [];
const madeExpenses: string[] = [];
const ctx = () => ({ actorId });
const sight = companyMoneySight({ id: 'x', permissions: new Set(['finance.manage', 'finance.reports']) } as never)!;

const cost = async (over: Record<string, unknown>) => {
  const row = await addCostEntry(
    { scope: 'batch', batchId, costTypeId, amount: 1, currency: 'USD', costDate: DAY, allocationBasis: 'weight', ...over } as never,
    ctx(),
    over.stampTruck ? { stampTruck: over.stampTruck as string } : {},
  );
  madeCosts.push(row.id);
  return row.id;
};
const spend = async (over: Record<string, unknown>) => {
  const row = await addExpense({ categoryId, amount: 1, currency: 'USD', expenseDate: DAY, ...over } as never, ctx());
  madeExpenses.push(row.id);
  return row.id;
};

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  categoryId = (await db.insert(expenseCategories).values({ name: `Sarf test ${STAMP}` }).returning())[0]!.id;
  for (const [code, country] of [
    [`SQ${STAMP}`, 'CN'],
    [`SR${STAMP}`, 'UZ'],
  ] as const) {
    const [row] = await db
      .insert(warehouses)
      .values({ code, batchPrefix: code, name: code, country, type: 'origin', timezone: 'Asia/Shanghai' })
      .returning();
    madeWarehouses.push(row!.id);
  }
  batchId = uuidv4();
  await db.insert(batches).values({
    id: batchId,
    code: `SQ${STAMP}-001`,
    originWarehouseId: madeWarehouses[0]!,
    destWarehouseId: madeWarehouses[1]!,
    status: 'forming',
    createdBy: actorId,
  });
  clientId = (await db.insert(clients).values({ clientCode: `SF${STAMP}`, name: `Sarf ${STAMP}` }).returning())[0]!.id;
  receiptId = (
    await db
      .insert(receipts)
      .values({ number: `SF-${STAMP}`, warehouseId: madeWarehouses[0]!, clientId, status: 'confirmed', createdBy: actorId })
      .returning()
  )[0]!.id;
  crateId = (
    await db
      .insert(crates)
      .values({ code: `CR-SF${STAMP}`, warehouseId: madeWarehouses[0]!, clientId, createdBy: actorId })
      .returning()
  )[0]!.id;
  pickupId = (
    await db.insert(pickups).values({ code: `ZR-SF${STAMP}`, destWarehouseId: madeWarehouses[1]!, createdBy: actorId }).returning()
  )[0]!.id;
  till = (await db.insert(moneyAccounts).values({ name: `Sarf kassa ${STAMP}`, currency: 'USD' }).returning())[0]!.id;
  const [firmType] = await db.select().from(partnerTypes).where(eq(partnerTypes.code, 'transport'));
  firmId = (
    await db.insert(partners).values({ name: `Sarf firma ${STAMP}`, typeId: firmType!.id, createdBy: actorId }).returning()
  )[0]!.id;

  // The period's money: one of every kind, place and payer.
  await cost({ amount: 1000 }); // truck, no payer said
  await cost({ amount: 300, accountId: till }); // truck, kassa
  await cost({ scope: 'receipt', receiptId, batchId: undefined, amount: 200, stampTruck: batchId }); // grid cell → truck
  await cost({ scope: 'receipt', receiptId, batchId: undefined, amount: 150 }); // prixod
  await cost({ scope: 'crate', crateId, batchId: undefined, amount: 40, partnerId: firmId }); // yashik, firm
  await cost({ scope: 'pickup', pickupId, batchId: undefined, amount: 60 }); // zavod reysi
  await cost({ amount: 25, costDate: '1630-04-20' }); // outside the period — the truck's all-time Σ only
  await spend({ amount: 80, accountId: till, warehouseId: madeWarehouses[1]! });
  await spend({ amount: 45 }); // no kassa, no warehouse
});

afterAll(async () => {
  await db.delete(partnerTransactions).where(eq(partnerTransactions.partnerId, firmId));
  if (madeCosts.length) await db.delete(costEntries).where(inArray(costEntries.id, madeCosts));
  if (madeExpenses.length) await db.delete(expenses).where(inArray(expenses.id, madeExpenses));
  await db.delete(partners).where(eq(partners.id, firmId));
  await db.delete(moneyAccounts).where(eq(moneyAccounts.id, till));
  await db.delete(pickups).where(eq(pickups.id, pickupId));
  await db.delete(crates).where(eq(crates.id, crateId));
  await db.delete(receipts).where(eq(receipts.id, receiptId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(batches).where(eq(batches.id, batchId));
  await db.delete(warehouses).where(inArray(warehouses.id, madeWarehouses));
  await db.delete(expenseCategories).where(eq(expenseCategories.id, categoryId));
  await pgClient.end();
});

const sum = (rows: { usd: number }[]) => Math.round(rows.reduce((s, r) => s + r.usd, 0) * 100) / 100;

describe('every block reconciles to the P&L’s own book total', () => {
  it('kinds = direct, categories = opex, and the truck stamp goes first', async () => {
    const [map, pnl] = await Promise.all([spendMap(sight, FROM, TO, { seesStaff: true }), profitAndLoss(FROM, TO)]);
    expect(map.direct).toBe(pnl.directTotal.total);
    expect(map.opex).toBe(pnl.opexTotal.total);
    expect(sum(map.kinds)).toBe(pnl.directTotal.total);
    const kind = Object.fromEntries(map.kinds.map((k) => [k.key, k.usd]));
    // The grid cell stamped on the truck is the truck's money, not its prixod's.
    expect(kind).toEqual({ batch: 1500, receipt: 150, crate: 40, pickup: 60 });
  });

  it('the warehouse block plus the truck line = the book; truck money sits under no warehouse', async () => {
    const map = await spendMap(sight, FROM, TO, { seesStaff: true });
    expect(Math.round((sum(map.warehouses) + map.trucksUsd) * 100) / 100).toBe(map.direct + map.opex);
    const at = Object.fromEntries(map.warehouses.map((w) => [w.key, w.usd]));
    expect(at[madeWarehouses[0]!]).toBe(150); // the prixod at its receiving warehouse
    expect(at[madeWarehouses[1]!]).toBe(140); // the zavod reysi at its destination + the overhead
    // A yashik with no packing movement and an overhead with no warehouse: the honest row.
    expect(at['']).toBe(85);
  });

  it('the payer buckets = the book, in the ordered CASE', async () => {
    const map = await spendMap(sight, FROM, TO, { seesStaff: true });
    expect(sum(map.payers)).toBe(map.direct + map.opex);
    const by = Object.fromEntries(map.payers.map((p) => [p.key, p.usd]));
    expect(by.kassa).toBe(380);
    expect(by.firm).toBe(40);
    expect(by.noKassa).toBe(45);
    // A cost with no payer is the queue or history depending on the deploy day — together they are the rest.
    expect(Math.round(((by.queue ?? 0) + (by.history ?? 0)) * 100) / 100).toBe(1410);
  });
});

describe('the «Partiyalar» fold', () => {
  it('a truck’s period dollars beside its all-time Σ', async () => {
    const { rows, total } = await spendTrucks(sight, FROM, TO, { limit: 10, offset: 0 });
    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({ id: batchId, periodUsd: 1500, allTimeUsd: 1525, internal: false, tracked: false });
  });
});

describe('the register', () => {
  const reader = { id: '', seesStaff: true, expenseRows: true, costs: ALL_COSTS };

  it('lists both books newest first with an uncapped count, and filters by the SAME kind', async () => {
    const all = await spendRegister(sight, { from: FROM, to: TO }, readSpendFilters({}, reader), { ...reader, id: actorId }, {
      limit: 3,
      offset: 0,
    });
    expect(all.total).toBe(8);
    expect(all.rows).toHaveLength(3);
    const trucks = await spendRegister(
      sight,
      { from: FROM, to: TO },
      readSpendFilters({ joy: 'batch' }, reader),
      { ...reader, id: actorId },
      { limit: 100, offset: 0 },
    );
    expect(trucks.rows.map((r) => Number(r.usd)).sort((a, b) => a - b)).toEqual([200, 300, 1000]);
  });

  it('expense ROWS are the expense book readers’ alone; the filter cannot ask for them either', async () => {
    const blind = { id: actorId, seesStaff: false, expenseRows: false, costs: ALL_COSTS };
    const filters = readSpendFilters({ kitob: 'expense', joy: 'expense', payer: 'own' }, blind);
    expect(filters).toMatchObject({ book: null, kind: null, payer: null });
    const out = await spendRegister(sight, { from: FROM, to: TO }, filters, blind, { limit: 100, offset: 0 });
    expect(out.rows.every((r) => r.book === 'cost')).toBe(true);
    expect(out.total).toBe(6);
  });

  it('drops a garbage id instead of passing it to postgres', () => {
    expect(readSpendFilters({ sklad: "x'; drop", partiya: '123', turi: 't:nope' }, reader)).toMatchObject({
      warehouseId: null,
      batchId: null,
      type: null,
    });
  });
});

describe('«N ta yozuv tekshirilmagan»', () => {
  it('counts ROWS with an unanswered twin, and an acknowledged pair stops counting', async () => {
    const before = await uncheckedTwinRows(sight, FROM, TO);
    // The 80 kassa expense twins nothing; type the same 80 as a kassa truck bill.
    const costId = await cost({ amount: 80, accountId: till });
    const after = await uncheckedTwinRows(sight, FROM, TO);
    expect(after.rows).toBe(before.rows + 2);
    expect(after.pairs.find((p) => p.costId === costId)).toMatchObject({ shape: 'same_kassa' });
    // Acknowledged at the save: the next bill carries the expense in its audit.
    const expenseId = after.pairs.find((p) => p.costId === costId)!.expenseId;
    const acked = await addCostEntry(
      { scope: 'batch', batchId, costTypeId, amount: 80, currency: 'USD', costDate: DAY, allocationBasis: 'weight', accountId: till },
      ctx(),
      { twinAck: [expenseId] },
    );
    madeCosts.push(acked.id);
    const third = await uncheckedTwinRows(sight, FROM, TO);
    expect(third.pairs.some((p) => p.costId === acked.id)).toBe(false);
  });
});
