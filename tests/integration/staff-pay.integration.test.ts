import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  boxes,
  clientTransactions,
  clients,
  dealStages,
  deals,
  expenseCategories,
  expenses,
  kpiPayouts,
  kpiRates,
  moneyAccounts,
  receipts,
  recurringExpenses,
  settings,
  userWarehouses,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { writeAudit } from '@/modules/platform/audit/service';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { receiveStamped, removeStamped } from '../fixtures/stamped-cargo';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { assignReceiptClient } from '@/modules/wms/receipts/edit';
import { stampUnattributedCargo } from '@/modules/wms/staff/stamp';
import { stampedCargo } from '@/modules/wms/staff/cargo';
import { paidM3ByMonth } from '@/modules/wms/staff/kpi-paid';
import { KpiError, kpiPayable, lastClosedMonth, payKpi } from '@/modules/wms/staff/kpi-service';
import { KpiTableRefusal, saveKpiTable } from '@/modules/wms/staff/kpi-table';
import { ownerKpiCells } from '@/modules/wms/staff/kpi-seed';
import { monthRange } from '@/modules/wms/staff/month';
import { myMonth } from '@/modules/wms/staff/my-month';
import { uncoveredCtes, unpricedScopeSql } from '@/modules/wms/finance/unpriced';
import { sellerPerformanceOwn } from '@/modules/wms/crm/seller-report';
import { voidExpense } from '@/modules/wms/accounting/service';
import { candidatesSql } from '@/modules/wms/accounting/recurring-sql';
import { mergeCandidates, mergeDuplicate, MergeError } from '@/modules/wms/accounting/cost-merge';

/**
 * The staff pay package (0117) against a real database: the seller STAMP on
 * the receipt and its writers, the migration's backfill, the one carton-grain
 * cargo reader, the PAID part of a seller's cargo, and the KPI payout with
 * its per-seller netting.
 *
 * Three things here are the installation's CONFIGURATION and are put back
 * (#183, #653): the two category SETTINGS (snapshotted in beforeAll, set
 * back to this file's own values after each test and to the originals at the
 * end); a KPI table version at JANUARY 2019 — the months this file's cargo is
 * received in, so every figure below is anchored on his literal table and on
 * closed months whatever today is; and a salary template. Audited rows point
 * at the users, clients and the warehouse, so those are DEACTIVATED, never
 * deleted.
 *
 * His table, the literal every figure below is read against: a month of ≤30
 * m³ at a density ≤200 kg/m³ pays $2/m³; ≤30 m³ at ≤100 pays $1.
 */
const SUFFIX = String(Date.now()).slice(-6);
let counter = 0;
const next = () => (counter += 1);
const pad = (n: number) => String(n).padStart(2, '0');

const FIXTURE_MONTH = '2019-01-01';
const madeUsers: string[] = [];
const madeClients: string[] = [];
const madeDeals: string[] = [];
const stamped: string[] = [];
const madeExpenses: string[] = [];
const madeTemplates: string[] = [];
const settingsBefore = new Map<string, { exists: boolean; value: unknown }>();

let actorId = '';
let accountId = '';
let kpiCategoryId = '';
let salaryCategoryId = '';
let whId = '';
let openStageId = '';
const ctx = () => ({ actorId });

async function mintUser(label: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ phone: `+99893${SUFFIX}${pad(next())}`, fullName: `KPI ${label} ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  madeUsers.push(row!.id);
  return row!.id;
}

async function mintClient(managerId: string | null): Promise<string> {
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `SP${SUFFIX}${pad(next())}`, name: `KPI mijoz ${SUFFIX}`, salesManagerId: managerId })
    .returning({ id: clients.id });
  madeClients.push(row!.id);
  return row!.id;
}

async function mintDeal(clientId: string): Promise<string> {
  const [row] = await db
    .insert(deals)
    .values({ code: `SP-${SUFFIX}-${pad(next())}`, clientId, stageId: openStageId, title: 'KPI', createdBy: actorId })
    .returning({ id: deals.id });
  madeDeals.push(row!.id);
  return row!.id;
}

/** A priced prixod on its own deal, received on `day` (a Tashkent noon), stamped to `sellerId`. */
async function cargo(input: {
  clientId: string;
  sellerId: string | null;
  day: string;
  m3: number;
  kg: number;
  boxes?: number;
  dealId?: string;
}) {
  const made = await receiveStamped({
    clientId: input.clientId,
    actorId,
    sellerId: input.sellerId,
    m3: input.m3,
    kg: input.kg,
    boxes: input.boxes,
    dealId: input.dealId ?? null,
    receivedAt: new Date(`${input.day}T12:00:00+05:00`),
  });
  stamped.push(made.receiptId);
  return made;
}

async function ledger(
  clientId: string,
  type: 'charge' | 'payment' | 'compensation',
  amount: number,
  txDate: string,
  extra: { dealId?: string; receiptId?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(clientTransactions)
    .values({
      clientId,
      type,
      amount: amount.toFixed(2),
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: amount.toFixed(2),
      txDate,
      note: `KPI test ${type}`,
      dealId: extra.dealId ?? null,
      receiptId: extra.receiptId ?? null,
      createdBy: actorId,
    })
    .returning({ id: clientTransactions.id });
  return row!.id;
}

/** A price the lost-cargo door lowered to ZERO: voided, with the void's own audit words (0105). */
async function zeroCharge(chargeId: string) {
  await db
    .update(clientTransactions)
    .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: 'KPI test: compensation to zero' })
    .where(eq(clientTransactions.id, chargeId));
  await writeAudit(db, ctx(), {
    entityType: 'client_transaction',
    entityId: chargeId,
    action: 'void',
    after: { from: 'compensation', repricedTo: null },
  });
}

async function setSetting(key: string, value: string) {
  await db
    .insert(settings)
    .values({ key, value, updatedBy: null })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

const paidIn = (paid: Map<string, Map<string, number>>, seller: string, month: string) =>
  Math.round((paid.get(seller)?.get(month) ?? 0) * 10_000) / 10_000;

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no refusal';
  } catch (err) {
    if (err instanceof KpiError || err instanceof KpiTableRefusal || err instanceof MergeError) return err.code;
    throw err;
  }
}

beforeAll(async () => {
  actorId = await mintUser('admin');
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  openStageId = stage!.id;
  const [wh] = await db
    .insert(warehouses)
    .values({ code: `KP${SUFFIX}`, batchPrefix: `KP${SUFFIX}`, name: `KPI ${SUFFIX}`, country: 'CN', type: 'origin', timezone: 'Asia/Tashkent' })
    .returning({ id: warehouses.id });
  whId = wh!.id;
  const [acct] = await db
    .insert(moneyAccounts)
    .values({ name: `KPI kassa ${SUFFIX}`, currency: 'USD' })
    .returning({ id: moneyAccounts.id });
  accountId = acct!.id;
  const [kpiCat] = await db
    .insert(expenseCategories)
    .values({ name: `KPI to'lovi ${SUFFIX}`, cash: true })
    .returning({ id: expenseCategories.id });
  kpiCategoryId = kpiCat!.id;
  const [salaryCat] = await db
    .insert(expenseCategories)
    .values({ name: `Oylik ${SUFFIX}`, cash: true })
    .returning({ id: expenseCategories.id });
  salaryCategoryId = salaryCat!.id;

  for (const key of ['kpi_expense_category_id', 'salary_expense_category_id']) {
    const row = await db.query.settings.findFirst({ where: eq(settings.key, key) });
    settingsBefore.set(key, { exists: Boolean(row), value: row?.value });
  }
  await setSetting('kpi_expense_category_id', kpiCategoryId);
  await setSetting('salary_expense_category_id', salaryCategoryId);

  // His table, as a version at January 2019 — a crashed earlier run's copy
  // goes first, or the cell index refuses the insert.
  await db.delete(kpiRates).where(eq(kpiRates.effectiveMonth, FIXTURE_MONTH));
  await db.insert(kpiRates).values(
    ownerKpiCells().map((cell) => ({
      effectiveMonth: FIXTURE_MONTH,
      maxM3: cell.maxM3 === null ? null : cell.maxM3.toFixed(3),
      maxDensity: cell.maxDensity,
      rateUsd: cell.rateUsd.toFixed(2),
      createdBy: actorId,
    })),
  );
});

afterEach(async () => {
  await setSetting('kpi_expense_category_id', kpiCategoryId);
  await setSetting('salary_expense_category_id', salaryCategoryId);
});

afterAll(async () => {
  const payouts = await db
    .select({ expenseId: kpiPayouts.expenseId })
    .from(kpiPayouts)
    .where(inArray(kpiPayouts.sellerId, madeUsers.length ? madeUsers : [randomUUID()]));
  await db.delete(kpiPayouts).where(inArray(kpiPayouts.sellerId, madeUsers.length ? madeUsers : [randomUUID()]));
  const expenseIds = [...madeExpenses, ...payouts.map((p) => p.expenseId)];
  if (expenseIds.length) await db.delete(expenses).where(inArray(expenses.id, expenseIds));
  if (madeTemplates.length) await db.delete(recurringExpenses).where(inArray(recurringExpenses.id, madeTemplates));
  if (madeClients.length) await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
  await removeStamped(stamped);
  // Receipts the real writers made stay (audited); their deals are none.
  if (madeDeals.length) await db.delete(deals).where(inArray(deals.id, madeDeals));
  await db.delete(kpiRates).where(eq(kpiRates.effectiveMonth, FIXTURE_MONTH));
  // …and any version this file's own admin SAVED: the `kpi_version_paid`
  // test is refusal-shaped, so a red proof that turns the refusal into a
  // success writes a real version at the last closed month — CONFIGURATION
  // that reprices every later reader (#183). Swept by author, never by the
  // ids a passing run collected (#523).
  await db.delete(kpiRates).where(eq(kpiRates.createdBy, actorId));
  for (const [key, before] of settingsBefore) {
    if (before.exists) await db.update(settings).set({ value: before.value }).where(eq(settings.key, key));
    else await db.delete(settings).where(eq(settings.key, key));
  }
  await db.update(moneyAccounts).set({ active: false }).where(eq(moneyAccounts.id, accountId));
  await db
    .update(expenseCategories)
    .set({ active: false })
    .where(inArray(expenseCategories.id, [kpiCategoryId, salaryCategoryId]));
  if (madeClients.length) await db.update(clients).set({ active: false }).where(inArray(clients.id, madeClients));
  await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, whId));
  if (madeUsers.length) await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  await pgClient.end();
});

/** A one-lot prixod as the wizard posts it (receipt-on-behalf's shape); the photo is the confirm gate's. */
async function wizard(input: { clientId: string | null | undefined; marking?: string; uploadedBy: string; extra?: Record<string, unknown> }) {
  const receiptId = randomUUID();
  const lotId = randomUUID();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `kpi/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: input.uploadedBy,
  });
  return {
    receiptId,
    warehouseId: whId,
    clientId: input.clientId,
    dealId: null,
    unclaimedMarking: input.marking ?? '',
    lots: [
      {
        id: lotId,
        productNameZh: 'KPI',
        boxCount: 2,
        dimsMode: 'uniform' as const,
        boxLengthCm: 40,
        boxWidthCm: 30,
        boxHeightCm: 20,
        boxWeightKg: 5,
      },
    ],
    extraCosts: [],
    ...input.extra,
  };
}

const stampOf = async (receiptId: string) =>
  (await db.select({ s: receipts.salesManagerId }).from(receipts).where(eq(receipts.id, receiptId)))[0]!.s;

describe('the stamp — whose cargo it is on the day it came (his 2a)', () => {
  let sellerA = '';
  let sellerB = '';
  beforeAll(async () => {
    sellerA = await mintUser('stamp A');
    sellerB = await mintUser('stamp B');
  });

  it('confirm stamps the client’s seller in the same statement', async () => {
    const client = await mintClient(sellerA);
    const r = await confirmReceipt((await wizard({ clientId: client, uploadedBy: actorId })) as never, ctx());
    expect(await stampOf(r.receiptId)).toBe(sellerA);
  });

  it('the office door stamps the same way', async () => {
    const client = await mintClient(sellerA);
    const posted = await wizard({
      clientId: client,
      uploadedBy: actorId,
      extra: { receivedDay: tashkentDay(), receivedBy: { name: 'Zavod yukchisi' } },
    });
    const r = await confirmReceipt(posted as never, ctx(), { onBehalf: true });
    expect(await stampOf(r.receiptId)).toBe(sellerA);
  });

  it('unclaimed cargo stamps nobody, and the claim stamps the claimant’s seller', async () => {
    const client = await mintClient(sellerA);
    // The wizard posts NO client for unclaimed cargo — an absent id must
    // stamp NULL, not reach the statement as an empty bind (`= ::uuid`).
    const r = await confirmReceipt(
      (await wizard({ clientId: undefined, marking: `SP${SUFFIX}-MARK`, uploadedBy: actorId })) as never,
      ctx(),
    );
    expect(await stampOf(r.receiptId)).toBeNull();
    await assignReceiptClient(r.receiptId, client, ctx());
    expect(await stampOf(r.receiptId)).toBe(sellerA);
  });

  it('a correction to another client restamps to THAT client’s seller — the cargo was never A’s', async () => {
    const wrong = await mintClient(sellerA);
    const right = await mintClient(sellerB);
    const r = await confirmReceipt((await wizard({ clientId: wrong, uploadedBy: actorId })) as never, ctx());
    expect(await stampOf(r.receiptId)).toBe(sellerA);
    await assignReceiptClient(r.receiptId, right, ctx());
    expect(await stampOf(r.receiptId)).toBe(sellerB);
  });

  it('moving a client from A to B leaves the old cargo with A', async () => {
    const client = await mintClient(sellerA);
    const r = await confirmReceipt((await wizard({ clientId: client, uploadedBy: actorId })) as never, ctx());
    await db.update(clients).set({ salesManagerId: sellerB }).where(eq(clients.id, client));
    // The first-seller rule touches NULL stamps only.
    expect(await stampUnattributedCargo(db, client, sellerB, ctx())).toBe(0);
    expect(await stampOf(r.receiptId)).toBe(sellerA);
  });

  it('naming a client’s FIRST seller stamps the cargo nobody was named on, once, audited', async () => {
    const client = await mintClient(null);
    const r = await confirmReceipt((await wizard({ clientId: client, uploadedBy: actorId })) as never, ctx());
    expect(await stampOf(r.receiptId)).toBeNull();
    expect(await stampUnattributedCargo(db, client, sellerA, ctx())).toBe(1);
    expect(await stampOf(r.receiptId)).toBe(sellerA);
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'client'), eq(auditLog.entityId, client), eq(auditLog.action, 'update')));
    expect(audit!.after).toEqual({ cargoStampedTo: sellerA, receipts: 1 });
    // A second seller later takes nothing: the cargo is A's now.
    expect(await stampUnattributedCargo(db, client, sellerB, ctx())).toBe(0);
    expect(await stampOf(r.receiptId)).toBe(sellerA);
  });
});

describe('the backfill — the migration’s own statement, run and rolled back', () => {
  it('reads the manager in force on each receipt day off the client’s audit history', async () => {
    const [A, B, C, D] = [await mintUser('bf A'), await mintUser('bf B'), await mintUser('bf C'), await mintUser('bf D')];
    // X: A until March 2018, then B. Y: nobody, then A in March, then B in May.
    // Z: C, never audited. W: created with A, then changed to D with no audit.
    const X = await mintClient(B);
    const Y = await mintClient(B);
    const Z = await mintClient(C);
    const W = await mintClient(D);
    const rx1 = (await cargo({ clientId: X, sellerId: null, day: '2018-02-01', m3: 1, kg: 100 })).receiptId;
    const rx2 = (await cargo({ clientId: X, sellerId: null, day: '2018-04-01', m3: 1, kg: 100 })).receiptId;
    const ry = (await cargo({ clientId: Y, sellerId: null, day: '2018-02-01', m3: 1, kg: 100 })).receiptId;
    const rz = (await cargo({ clientId: Z, sellerId: null, day: '2018-02-01', m3: 1, kg: 100 })).receiptId;
    const rw = (await cargo({ clientId: W, sellerId: null, day: '2018-02-01', m3: 1, kg: 100 })).receiptId;

    const audit = (entityId: string, action: 'create' | 'update', at: string, before: unknown, after: unknown) => ({
      actorId,
      entityType: 'client',
      entityId,
      action,
      before: before as Record<string, unknown> | null,
      after: after as Record<string, unknown>,
      createdAt: new Date(`${at}T00:00:00+05:00`),
    });
    const migration = readFileSync('src/modules/platform/db/migrations/0117_staff_pay.sql', 'utf8');
    const backfill = migration.slice(migration.indexOf('UPDATE receipts r SET sales_manager_id = s.m'));
    expect(backfill.length).toBeGreaterThan(100);

    let seen = new Map<string, string | null>();
    await db
      .transaction(async (tx) => {
        await tx.insert(auditLog).values([
          audit(X, 'create', '2018-01-01', null, { salesManagerId: A }),
          audit(X, 'update', '2018-03-01', { salesManagerId: A }, { salesManagerId: B }),
          audit(Y, 'create', '2018-01-01', null, { salesManagerId: null }),
          audit(Y, 'update', '2018-03-01', { salesManagerId: null }, { salesManagerId: A }),
          audit(Y, 'update', '2018-05-01', { salesManagerId: A }, { salesManagerId: B }),
          audit(W, 'create', '2018-01-01', null, { salesManagerId: A }),
        ]);
        await tx.execute(sql`UPDATE receipts SET sales_manager_id = NULL WHERE id IN (${sql.join(
          [rx1, rx2, ry, rz, rw].map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`);
        await tx.execute(sql.raw(backfill));
        const rows = await tx
          .select({ id: receipts.id, s: receipts.salesManagerId })
          .from(receipts)
          .where(inArray(receipts.id, [rx1, rx2, ry, rz, rw]));
        seen = new Map(rows.map((row) => [row.id, row.s]));
        tx.rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof TransactionRollbackError)) throw err;
      });

    // A → B: split by the day of the change.
    expect(seen.get(rx1)).toBe(A);
    expect(seen.get(rx2)).toBe(B);
    // Nobody in force → the FIRST seller named afterwards (A), not the current one (B).
    expect(seen.get(ry)).toBe(A);
    // No audit at all → the current seller.
    expect(seen.get(rz)).toBe(C);
    // After the last audited event the CURRENT seller — an unaudited change is not lost.
    expect(seen.get(rw)).toBe(D);
  });
});

describe('one reader, carton grain', () => {
  it('a lost carton drops out, and the report and the KPI read the same literal m³', async () => {
    const seller = await mintUser('grain');
    const client = await mintClient(seller);
    // 4 cartons, 2 m³, 300 kg: each carton is 0.5 m³ — one is lost.
    const made = await cargo({ clientId: client, sellerId: seller, day: '2019-12-10', m3: 2, kg: 300, boxes: 4 });
    await db.update(boxes).set({ status: 'lost' }).where(eq(boxes.id, made.boxIds[0]!));

    const range = monthRange('2019-12');
    const [row] = await stampedCargo(db, range, { kind: 'own', userId: seller });
    expect(row!.m3).toBeCloseTo(1.5, 6);
    expect(row!.kg).toBeCloseTo(225, 6);
    expect(row!.receipts).toBe(1);

    const report = await sellerPerformanceOwn(seller, { ...range, dan: '2019-12-01', gacha: '2019-12-31' });
    expect(report.volumeM3).toBeCloseTo(1.5, 6);

    // …and the unpriced rule's own carton set, which the paid part walks.
    const [recon] = (await db.execute(sql`
      WITH ${uncoveredCtes(unpricedScopeSql({ kind: 'stamped', sellerId: seller, from: range.from, to: range.to }), { landedOnly: false })}
      SELECT coalesce(sum(m3), 0)::text AS m3, count(*)::int AS n FROM u_box`)) as unknown as { m3: string; n: number }[];
    expect(Number(recon!.m3)).toBeCloseTo(1.5, 6);
    expect(recon!.n).toBe(3);
  });
});

describe('the PAID part of a seller’s cargo (his 6b)', () => {
  let seller = '';
  let paid = new Map<string, Map<string, number>>();

  beforeAll(async () => {
    seller = await mintUser('paid');

    // (a) FIFO: two trucks' prices, money for one — the OLDER one is paid.
    const c1 = await mintClient(seller);
    const d1 = await mintDeal(c1);
    const d2 = await mintDeal(c1);
    await cargo({ clientId: c1, sellerId: seller, day: '2019-03-05', m3: 10, kg: 1500, dealId: d1 });
    await cargo({ clientId: c1, sellerId: seller, day: '2019-04-05', m3: 10, kg: 1500, dealId: d2 });
    await ledger(c1, 'charge', 100, '2019-03-10', { dealId: d1 });
    await ledger(c1, 'charge', 100, '2019-04-10', { dealId: d2 });
    await ledger(c1, 'payment', 100, '2019-04-20');

    // (b) A deferral counts against ITS deal only.
    const c2 = await mintClient(seller);
    const d3 = await mintDeal(c2);
    const d4 = await mintDeal(c2);
    await cargo({ clientId: c2, sellerId: seller, day: '2019-05-05', m3: 10, kg: 1500, dealId: d3 });
    await cargo({ clientId: c2, sellerId: seller, day: '2019-06-05', m3: 10, kg: 1500, dealId: d4 });
    await ledger(c2, 'charge', 100, '2019-05-10', { dealId: d3 });
    await ledger(c2, 'charge', 100, '2019-06-10', { dealId: d4 });
    await db
      .update(deals)
      .set({ deferredAt: new Date(), deferredBy: actorId, deferralReason: 'KPI test', deferUntilAllArrived: true })
      .where(eq(deals.id, d4));

    // (c) His example: A $1000 unpaid, B $1000 compensated — A stays open.
    const c3 = await mintClient(seller);
    const d5 = await mintDeal(c3);
    const d6 = await mintDeal(c3);
    await cargo({ clientId: c3, sellerId: seller, day: '2019-07-05', m3: 10, kg: 1500, dealId: d5 });
    const rB = await cargo({ clientId: c3, sellerId: seller, day: '2019-08-05', m3: 10, kg: 1500, dealId: d6 });
    await ledger(c3, 'charge', 1000, '2019-07-10', { dealId: d5 });
    await ledger(c3, 'charge', 1000, '2019-08-10', { dealId: d6 });
    await ledger(c3, 'compensation', 1000, '2019-08-20', { receiptId: rB.receiptId });

    // (d) Money but no price: nothing covers the carton.
    const c4 = await mintClient(seller);
    await cargo({ clientId: c4, sellerId: seller, day: '2019-09-05', m3: 10, kg: 1500 });
    await ledger(c4, 'payment', 500, '2019-09-10');

    // (e) Covered only by a price lowered to zero: nobody paid for it.
    const c5 = await mintClient(seller);
    const d7 = await mintDeal(c5);
    await cargo({ clientId: c5, sellerId: seller, day: '2019-10-05', m3: 10, kg: 1500, dealId: d7 });
    await zeroCharge(await ledger(c5, 'charge', 100, '2019-10-10', { dealId: d7 }));
    await ledger(c5, 'payment', 500, '2019-10-20');

    // (f) A zeroed price AND a live one that is settled: paid.
    const c6 = await mintClient(seller);
    const d8 = await mintDeal(c6);
    await cargo({ clientId: c6, sellerId: seller, day: '2019-11-05', m3: 10, kg: 1500, dealId: d8 });
    await zeroCharge(await ledger(c6, 'charge', 100, '2019-11-10', { dealId: d8 }));
    await ledger(c6, 'charge', 50, '2019-11-11', { dealId: d8 });
    await ledger(c6, 'payment', 50, '2019-11-20');

    paid = await paidM3ByMonth(db, { sellerId: seller, from: monthRange('2019-01').from, to: monthRange('2019-12').to });
  });

  it('money settles the OLDEST price first', () => {
    expect(paidIn(paid, seller, '2019-03')).toBe(10);
    expect(paidIn(paid, seller, '2019-04')).toBe(0);
  });

  it('a deferral settles its own deal, never another', () => {
    expect(paidIn(paid, seller, '2019-05')).toBe(0);
    expect(paidIn(paid, seller, '2019-06')).toBe(10);
  });

  it('a compensation settles its own prixod’s price', () => {
    expect(paidIn(paid, seller, '2019-07')).toBe(0);
    expect(paidIn(paid, seller, '2019-08')).toBe(10);
  });

  it('a carton no price covers is not paid, whatever money came', () => {
    expect(paidIn(paid, seller, '2019-09')).toBe(0);
  });

  it('a carton covered only by a price lowered to zero is not paid', () => {
    expect(paidIn(paid, seller, '2019-10')).toBe(0);
  });

  it('a zeroed price beside a live, settled one does not block the carton', () => {
    expect(paidIn(paid, seller, '2019-11')).toBe(10);
  });
});

describe('the payout', () => {
  let seller = '';
  let client = '';
  let firstExpense = '';
  const today = () => tashkentDay();

  beforeAll(async () => {
    seller = await mintUser('pay');
    client = await mintClient(seller);
    const deal = await mintDeal(client);
    // 10 m³ at 150 kg/m³ in February 2020, priced and paid: ≤30 × ≤200 = $2 → $20.
    await cargo({ clientId: client, sellerId: seller, day: '2020-02-10', m3: 10, kg: 1500, dealId: deal });
    await ledger(client, 'charge', 100, '2020-02-12', { dealId: deal });
    await ledger(client, 'payment', 100, '2020-02-20');
  });

  const pay = (expectedUsd: number) =>
    payKpi(seller, { accountId, currency: 'USD', expenseDate: today(), expectedUsd }, ctx());

  it('a month is payable only once it closes on the 8th of the next', async () => {
    expect((await kpiPayable(db, seller, '2019-02-05')).throughMonth).toBeNull();
    const before = await kpiPayable(db, seller, '2020-03-07');
    expect(before.throughMonth).toBe('2020-01');
    expect(before.payableUsd).toBe(0);
    const after = await kpiPayable(db, seller, '2020-03-08');
    expect(after.throughMonth).toBe('2020-02');
    expect(after.payableUsd).toBe(20);
  });

  it('refuses while no KPI category is chosen', async () => {
    await setSetting('kpi_expense_category_id', '');
    expect(await refusal(pay(20))).toBe('kpi_category_unset');
  });

  it('refuses an amount that is not the one the server derives now', async () => {
    expect(await refusal(pay(19))).toBe('amount_moved');
  });

  it('pays the derived amount once — the next press has nothing to pay', async () => {
    const res = await pay(20);
    expect(res.paidUsd).toBe(20);
    expect(res.throughMonth).toBe(lastClosedMonth(today()));
    firstExpense = res.expenseId;
    const [expense] = await db.select().from(expenses).where(eq(expenses.id, res.expenseId));
    expect(Number(expense!.amountUsd)).toBe(20);
    expect(expense!.employeeId).toBe(seller);
    expect(expense!.categoryId).toBe(kpiCategoryId);
    expect(await refusal(pay(0))).toBe('nothing_to_pay');
    expect((await kpiPayable(db, seller, today())).payableUsd).toBe(0);
  });

  it('a voided payout re-opens its money, by derivation', async () => {
    await voidExpense(firstExpense, 'KPI test: wrong till', ctx());
    expect((await kpiPayable(db, seller, today())).payableUsd).toBe(20);
    expect((await pay(20)).paidUsd).toBe(20);
  });

  it('the current month is never payable', async () => {
    const deal = await mintDeal(client);
    await cargo({ clientId: client, sellerId: seller, day: today(), m3: 10, kg: 1500, dealId: deal });
    await ledger(client, 'charge', 100, today(), { dealId: deal });
    await ledger(client, 'payment', 100, today());
    const payable = await kpiPayable(db, seller, today());
    expect(payable.payableUsd).toBe(0);
    expect(payable.months.map((m) => m.month)).not.toContain(today().slice(0, 7));
  });

  it('a table version may not start at or before a month already paid', async () => {
    const through = lastClosedMonth(today());
    expect(await refusal(saveKpiTable(ownerKpiCells(), through, ctx()))).toBe('kpi_version_paid');
    expect(await refusal(saveKpiTable(ownerKpiCells(), '2019-01', ctx()))).toBe('kpi_version_paid');
  });

  it('«To’landi» never offers a KPI payout as the seller’s salary, and the merge never absorbs it', async () => {
    const [live] = await db
      .select({ expenseId: kpiPayouts.expenseId })
      .from(kpiPayouts)
      .innerJoin(expenses, eq(expenses.id, kpiPayouts.expenseId))
      .where(and(eq(kpiPayouts.sellerId, seller), sql`${expenses.voidedAt} IS NULL`));
    const payout = live!.expenseId;
    // A control: an ordinary cash expense of the same kind, person and day.
    const [control] = await db
      .insert(expenses)
      .values({
        categoryId: kpiCategoryId,
        amount: '20.00',
        currency: 'USD',
        rateToUsd: '1',
        amountUsd: '20.00',
        expenseDate: today(),
        employeeId: seller,
        accountId,
        note: 'KPI test control',
        createdBy: actorId,
      })
      .returning({ id: expenses.id });
    madeExpenses.push(control!.id);
    const [template] = await db
      .insert(recurringExpenses)
      .values({
        categoryId: kpiCategoryId,
        amount: '20.00',
        currency: 'USD',
        dayOfMonth: 1,
        employeeId: seller,
        active: false,
        dueFrom: `${today().slice(0, 7)}-01`,
        createdBy: actorId,
      })
      .returning({ id: recurringExpenses.id });
    madeTemplates.push(template!.id);

    const offered = (await db.execute(sql`
      SELECT id FROM (${candidatesSql(sql`${template!.id}::uuid`, sql`${`${today().slice(0, 7)}-01`}::date`)}) c`)) as unknown as {
      id: string;
    }[];
    const ids = [...offered].map((row) => row.id);
    expect(ids).toContain(control!.id);
    expect(ids).not.toContain(payout);

    const mergeable = (await mergeCandidates(today(), today(), 500)).map((row) => row.id);
    expect(mergeable).toContain(control!.id);
    expect(mergeable).not.toContain(payout);
    expect(await refusal(mergeDuplicate({ costIds: [randomUUID()], expenseId: payout }, ctx()))).toBe('not_candidate');
    // The control passes the expense fence and stops at the (missing) cost.
    expect(await refusal(mergeDuplicate({ costIds: [randomUUID()], expenseId: control!.id }, ctx()))).toBe('cost_taken');
  });
});

describe('netting, per seller — a correction from A to B after A was paid', () => {
  it('A shows the overpayment and is not payable, B is, and nothing is paid twice in the end', async () => {
    const A = await mintUser('net A');
    const B = await mintUser('net B');
    const clientA = await mintClient(A);
    const clientB = await mintClient(B);
    const dealA = await mintDeal(clientA);
    // March 2021: 10 m³ at 150 kg/m³ = $20, priced and paid.
    const moved = await cargo({ clientId: clientA, sellerId: A, day: '2021-03-05', m3: 10, kg: 1500, dealId: dealA });
    await ledger(clientA, 'charge', 100, '2021-03-10', { dealId: dealA });
    await ledger(clientA, 'payment', 100, '2021-03-20');
    const payA1 = await payKpi(A, { accountId, currency: 'USD', expenseDate: tashkentDay(), expectedUsd: 20 }, ctx());
    expect(payA1.paidUsd).toBe(20);

    // The prixod was B's client's all along: the correction restamps it, and
    // B's client is charged for it and pays.
    const dealB = await mintDeal(clientB);
    await db
      .update(receipts)
      .set({ clientId: clientB, salesManagerId: B, dealId: dealB })
      .where(eq(receipts.id, moved.receiptId));
    await ledger(clientB, 'charge', 100, '2021-03-12', { dealId: dealB });
    await ledger(clientB, 'payment', 100, '2021-03-22');

    const a = await kpiPayable(db, A, tashkentDay());
    expect(a.payableUsd).toBe(0);
    expect(a.overpaidUsd).toBe(20);
    const b = await kpiPayable(db, B, tashkentDay());
    expect(b.payableUsd).toBe(20);

    // A's next month nets the overpayment: May 2021, 20 m³ at 150 = $40 → $20 due.
    const dealA2 = await mintDeal(clientA);
    await cargo({ clientId: clientA, sellerId: A, day: '2021-05-05', m3: 20, kg: 3000, dealId: dealA2 });
    await ledger(clientA, 'charge', 100, '2021-05-10', { dealId: dealA2 });
    await ledger(clientA, 'payment', 100, '2021-05-20');
    const a2 = await kpiPayable(db, A, tashkentDay());
    expect(a2.earnedPaidUsd).toBe(40);
    expect(a2.payableUsd).toBe(20);
    expect(a2.overpaidUsd).toBe(0);

    const payB = await payKpi(B, { accountId, currency: 'USD', expenseDate: tashkentDay(), expectedUsd: 20 }, ctx());
    const payA2 = await payKpi(A, { accountId, currency: 'USD', expenseDate: tashkentDay(), expectedUsd: 20 }, ctx());
    const paidTotal = payA1.paidUsd + payB.paidUsd + payA2.paidUsd;
    const earnedTotal = (await kpiPayable(db, A, tashkentDay())).earnedPaidUsd + (await kpiPayable(db, B, tashkentDay())).earnedPaidUsd;
    expect(paidTotal).toBe(60);
    expect(earnedTotal).toBe(60);
  });
});

describe('«Bu oy» on the profile', () => {
  it('two sellers in one fixture: each reads their own cargo and salary, never the other’s', async () => {
    const PA = await mintUser('profile A');
    const PB = await mintUser('profile B');
    const ca = await mintClient(PA);
    const cb = await mintClient(PB);
    const now = tashkentDay();
    await cargo({ clientId: ca, sellerId: PA, day: now, m3: 3, kg: 450 });
    await cargo({ clientId: cb, sellerId: PB, day: now, m3: 7, kg: 1050 });
    const [template] = await db
      .insert(recurringExpenses)
      .values({
        categoryId: salaryCategoryId,
        amount: '700.00',
        currency: 'USD',
        dayOfMonth: 5,
        employeeId: PA,
        dueFrom: `${now.slice(0, 7)}-01`,
        createdBy: actorId,
      })
      .returning({ id: recurringExpenses.id });
    madeTemplates.push(template!.id);

    const a = await myMonth({ id: PA, permissions: new Set<string>() });
    const b = await myMonth({ id: PB, permissions: new Set<string>() });
    expect(a.kpi?.m3).toBe(3);
    expect(b.kpi?.m3).toBe(7);
    expect(a.salary.map((s) => s.amount)).toEqual([700]);
    expect(b.salary).toEqual([]);
  });

  it('counts the prixod for the person who RECEIVED it, not the desk that typed it', async () => {
    const office = await mintUser('office');
    const operator = await mintUser('operator');
    await db.insert(userWarehouses).values({ userId: operator, warehouseId: whId });
    const client = await mintClient(null);
    // The office enters two prixods for the floor: one taken in by the
    // operator, one by a factory loader known only by name.
    await confirmReceipt(
      (await wizard({
        clientId: client,
        uploadedBy: office,
        extra: { receivedDay: tashkentDay(), receivedBy: { userId: operator } },
      })) as never,
      { actorId: office },
      { onBehalf: true },
    );
    await confirmReceipt(
      (await wizard({
        clientId: client,
        uploadedBy: office,
        extra: { receivedDay: tashkentDay(), receivedBy: { name: 'Zavod yukchisi' } },
      })) as never,
      { actorId: office },
      { onBehalf: true },
    );
    // …and the operator receives one himself at the counter.
    await confirmReceipt((await wizard({ clientId: client, uploadedBy: operator })) as never, { actorId: operator });

    expect((await myMonth({ id: operator, permissions: new Set<string>() })).work.receipts).toBe(2);
    expect((await myMonth({ id: office, permissions: new Set<string>() })).work.receipts).toBe(0);
  });
});
