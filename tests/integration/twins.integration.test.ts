import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  batches,
  boxes,
  clientTransactions,
  clients,
  costEntries,
  costTypes,
  currencies,
  expenseCategories,
  expenses,
  moneyAccounts,
  partnerTransactions,
  partnerTypes,
  partners,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { addCostEntry, upsertFxRate } from '@/modules/wms/costing/service';
import { addExpense, voidExpense } from '@/modules/wms/accounting/service';
import {
  ackTwinPair,
  costCandidateFrom,
  mustWarn,
  twinGap,
  twinShape,
  twinsForCost,
  twinsForExpense,
  twinsForGrid,
  uncheckedTwinRows,
  type ReaderSight,
  type TwinCost,
  type TwinExpense,
} from '@/modules/wms/accounting/twins';
import { cancelBatch } from '@/modules/wms/scanning/unload';
import { addTransaction } from '@/modules/wms/finance/service';
import { companyMoneySight } from '@/modules/wms/finance/scope';

/**
 * «Bu pul allaqachon yozilganmi?» (docs/SARFLAR.md §3 + §8) against a real
 * database: the same payment on the cargo-cost book and the expense book,
 * found from either side, in the kassa's own currency, across a sum, and
 * never for a reader the expense book is closed to. Plus the write-path
 * fixes the round leans on (§4/§8.5): the scope's one target, the direct
 * client, and the cancelled-truck race, proven with a held lock.
 *
 * Its own currency (QTW, 1000 per dollar) and dates in 1640, so no rate or
 * period another file reads is touched (#653, #183).
 */

const STAMP = String(Date.now()).slice(-6);
const CCY = 'QTW';
/** A currency with NO rate at all — the «kurs yo'q» side. */
const NO_RATE = 'QTN';
const sight = companyMoneySight({ id: 'x', permissions: new Set(['finance.manage', 'finance.reports']) } as never)!;
const DAY = '1640-03-10';
let actorId = '';
let costTypeId = '';
let categoryId = '';
let bookCategoryId = '';
let batchId = '';
let receiptId = '';
let clientId = '';
let usdTill = '';
let qtwTill = '';
let firmId = '';
const madeWarehouses: string[] = [];
const madeCosts: string[] = [];
const madeExpenses: string[] = [];
const ctx = () => ({ actorId });

/** The accountant: the expense book's reader, so the twin check runs. */
const ACCOUNTANT = (): ReaderSight => ({
  id: actorId,
  permissions: new Set(['finance.expenses', 'finance.view']),
  ownOnly: null,
});
/** The logist: types truck bills, holds no expense book — no twin query at all. */
const LOGIST = (): ReaderSight => ({ id: actorId, permissions: new Set(['costs.enter_batch']), ownOnly: null });

async function bill(amount: number, currency: string, over: Record<string, unknown> = {}) {
  const entry = await addCostEntry(
    { scope: 'batch', batchId, costTypeId, amount, currency, costDate: DAY, allocationBasis: 'weight', ...over },
    ctx(),
  );
  madeCosts.push(entry.id);
  return entry.id;
}

async function spend(amount: number, currency: string, over: Record<string, unknown> = {}) {
  const row = await addExpense({ categoryId, amount, currency, expenseDate: DAY, ...over }, ctx());
  madeExpenses.push(row.id);
  return row.id;
}

const candidate = (amount: number, currency: string, over: Record<string, unknown> = {}) =>
  costCandidateFrom({
    scope: 'batch',
    batchId,
    costTypeId,
    amount,
    currency,
    costDate: DAY,
    ...over,
  } as Parameters<typeof costCandidateFrom>[0]);

/** Void every twin a test made, so the next test asks about its own rows only. */
async function clearBooks() {
  const liveCosts = madeCosts.length
    ? await db.select({ id: costEntries.id }).from(costEntries).where(inArray(costEntries.id, madeCosts))
    : [];
  if (liveCosts.length) {
    await db
      .update(costEntries)
      .set({ voidedAt: new Date(), voidedBy: actorId, voidReason: 'test' })
      .where(inArray(costEntries.id, liveCosts.map((r) => r.id)));
  }
  for (const id of madeExpenses) {
    await voidExpense(id, 'test', ctx()).catch(() => undefined);
  }
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
  costTypeId = (await db.select({ id: costTypes.id }).from(costTypes).limit(1))[0]!.id;
  categoryId = (await db.insert(expenseCategories).values({ name: `Twin test ${STAMP}` }).returning())[0]!.id;
  bookCategoryId = (
    await db.insert(expenseCategories).values({ name: `Twin book ${STAMP}`, cash: false }).returning()
  )[0]!.id;
  await db.insert(currencies).values({ code: CCY, name: 'Twin test' }).onConflictDoNothing();
  await db.insert(currencies).values({ code: NO_RATE, name: 'Twin no rate' }).onConflictDoNothing();
  await upsertFxRate({ currency: CCY, rateToUsd: 0.001, effectiveDate: '1601-01-01' }, ctx());
  for (const [code, country] of [
    [`TQ${STAMP}`, 'CN'],
    [`TR${STAMP}`, 'UZ'],
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
    code: `TQ${STAMP}-001`,
    originWarehouseId: madeWarehouses[0]!,
    destWarehouseId: madeWarehouses[1]!,
    status: 'forming',
    createdBy: actorId,
  });
  clientId = (
    await db.insert(clients).values({ clientCode: `TW${STAMP}`, name: `Twin ${STAMP}` }).returning()
  )[0]!.id;
  receiptId = (
    await db
      .insert(receipts)
      .values({ number: `TW-${STAMP}`, warehouseId: madeWarehouses[0]!, clientId, status: 'confirmed', createdBy: actorId })
      .returning()
  )[0]!.id;
  usdTill = (await db.insert(moneyAccounts).values({ name: `Twin USD ${STAMP}`, currency: 'USD' }).returning())[0]!.id;
  qtwTill = (await db.insert(moneyAccounts).values({ name: `Twin QTW ${STAMP}`, currency: CCY }).returning())[0]!.id;
  const [firmType] = await db.select().from(partnerTypes).where(eq(partnerTypes.code, 'transport'));
  firmId = (
    await db.insert(partners).values({ name: `Twin firma ${STAMP}`, typeId: firmType!.id, createdBy: actorId }).returning()
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(partnerTransactions).where(eq(partnerTransactions.partnerId, firmId));
  if (madeCosts.length) await db.delete(costEntries).where(inArray(costEntries.id, madeCosts));
  if (madeExpenses.length) await db.delete(expenses).where(inArray(expenses.id, madeExpenses));
  // A currency with no rate is configuration every currency picker would offer.
  await db.delete(currencies).where(eq(currencies.code, NO_RATE));
  await db.delete(partners).where(eq(partners.id, firmId));
  await db.delete(moneyAccounts).where(inArray(moneyAccounts.id, [usdTill, qtwTill]));
  await db.delete(receipts).where(eq(receipts.id, receiptId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(batches).where(eq(batches.id, batchId));
  await db.delete(warehouses).where(inArray(warehouses.id, madeWarehouses));
  await db.delete(expenseCategories).where(inArray(expenseCategories.id, [categoryId, bookCategoryId]));
  await pgClient.end();
});

describe('a truck bill whose money is already an expense', () => {
  it('one kassa on both books is found in the KASSA’s currency — a dollar bill against a so’m expense', async () => {
    await clearBooks();
    const expenseId = await spend(630_000, CCY, { accountId: qtwTill });
    const answer = await twinsForCost(ACCOUNTANT(), await candidate(630, 'USD', { accountId: qtwTill, accountAmount: 630_000 }));
    expect(answer!.ids).toEqual([expenseId]);
    expect(answer!.lines[0]).toMatchObject({ shape: 'same_kassa', cure: 'void', book: 'expense', currency: CCY });
    expect(answer!.lines[0]!.kassa).toBe(`Twin QTW ${STAMP}`);
  });

  it('a kassa-less bill against a cash expense is the merge’s own pair', async () => {
    await clearBooks();
    const expenseId = await spend(410, 'USD', { accountId: usdTill });
    const answer = await twinsForCost(ACCOUNTANT(), await candidate(410, 'USD'));
    expect(answer!.ids).toEqual([expenseId]);
    expect(answer!.lines[0]).toMatchObject({ shape: 'mergeable', cure: 'merge' });
  });

  it('runs NO twin query for a reader the expense book is closed to', async () => {
    await clearBooks();
    await spend(415, 'USD', { accountId: usdTill });
    expect(await twinsForCost(LOGIST(), await candidate(415, 'USD'))).toBeNull();
  });

  it('a book entry, a voided expense and a day outside the window are not twins', async () => {
    await clearBooks();
    const book = await addExpense({ categoryId: bookCategoryId, amount: 420, currency: 'USD', expenseDate: DAY }, ctx());
    madeExpenses.push(book.id);
    const gone = await spend(420, 'USD', { accountId: usdTill });
    await voidExpense(gone, 'xato', ctx());
    const far = await spend(420, 'USD', { accountId: usdTill, expenseDate: '1640-03-30' });
    const answer = await twinsForCost(ACCOUNTANT(), await candidate(420, 'USD'));
    expect(answer!.ids).not.toContain(book.id);
    expect(answer!.ids).not.toContain(gone);
    expect(answer!.ids).not.toContain(far);
  });

  it('two bills of one truck, one day and one payer that add up to one expense (the completing-sum)', async () => {
    await clearBooks();
    await bill(300, 'USD');
    const expenseId = await spend(500, 'USD', { accountId: usdTill });
    const answer = await twinsForCost(ACCOUNTANT(), await candidate(200, 'USD'));
    expect(answer!.ids).toEqual([expenseId]);
    expect(answer!.lines[0]).toMatchObject({ sum: true, shape: 'mergeable' });
  });

  it('the grid’s sheet: every cell, and the sheet’s Σ, named by cell', async () => {
    await clearBooks();
    const sheetTwin = await spend(900, 'USD', { accountId: usdTill });
    const cellTwin = await spend(250, 'USD', { accountId: usdTill });
    const otherType = (await db.select({ id: costTypes.id }).from(costTypes).limit(2))[1]!.id;
    const cells = [
      await costCandidateFrom({ scope: 'receipt', receiptId, costTypeId, amount: 650, currency: 'USD', costDate: DAY }, batchId),
      await costCandidateFrom({ scope: 'receipt', receiptId, costTypeId: otherType, amount: 250, currency: 'USD', costDate: DAY }, batchId),
    ];
    const answer = await twinsForGrid(ACCOUNTANT(), cells);
    expect(answer!.ids.sort()).toEqual([sheetTwin, cellTwin].sort());
    const byCell = new Map(answer!.lines.map((line) => [line.sum ? 'sheet' : line.cell, line]));
    expect(byCell.get(`${receiptId}:${otherType}`)).toBeDefined();
    expect(byCell.get('sheet')).toMatchObject({ cell: null });
  });

  it('the acknowledgement answers ONE save: the next identical bill is asked again', async () => {
    await clearBooks();
    await spend(430, 'USD', { accountId: usdTill });
    const first = await twinsForCost(ACCOUNTANT(), await candidate(430, 'USD'));
    expect(mustWarn(first, null)).toBe(true);
    expect(mustWarn(first, first!.ackToken)).toBe(false);
    await bill(430, 'USD');
    const second = await twinsForCost(ACCOUNTANT(), await candidate(430, 'USD'));
    expect(second!.ackToken).not.toBe(first!.ackToken);
    expect(mustWarn(second, first!.ackToken)).toBe(true);
  });
});

describe('an expense whose money is already a truck bill', () => {
  it('finds the bill, kassa to kassa', async () => {
    await clearBooks();
    const costId = await bill(77, 'USD', { accountId: qtwTill, accountAmount: 77_000 });
    const answer = await twinsForExpense(ACCOUNTANT(), {
      categoryId,
      amount: 77_000,
      currency: CCY,
      expenseDate: DAY,
      accountId: qtwTill,
      partnerId: null,
      warehouseId: null,
    });
    expect(answer!.ids).toEqual([costId]);
    expect(answer!.lines[0]).toMatchObject({ shape: 'same_kassa', book: 'cost', redacted: false, where: `TQ${STAMP}-001` });
  });

  it('a colleague’s bill is REDACTED for a reader who sees only their own costs — never dropped', async () => {
    await clearBooks();
    const costId = await bill(88, 'USD');
    const answer = await twinsForExpense(
      { id: uuidv4(), permissions: new Set(['finance.expenses']), ownOnly: uuidv4() },
      { categoryId, amount: 88, currency: 'USD', expenseDate: DAY, accountId: usdTill, partnerId: null, warehouseId: null },
    );
    expect(answer!.ids).toEqual([costId]);
    expect(answer!.lines[0]).toMatchObject({ redacted: true, label: null, where: null, who: null, kassa: null });
  });

  it('several bills of one truck’s day that add up to it', async () => {
    await clearBooks();
    const a = await bill(120, 'USD');
    const b = await bill(80, 'USD');
    const answer = await twinsForExpense(ACCOUNTANT(), {
      categoryId,
      amount: 200,
      currency: 'USD',
      expenseDate: DAY,
      accountId: usdTill,
      partnerId: null,
      warehouseId: null,
    });
    expect(answer!.ids.sort()).toEqual([a, b].sort());
    expect(answer!.lines.every((line) => line.sum)).toBe(true);
  });

  it('a saved twin carries the acknowledgement in its create audit', async () => {
    await clearBooks();
    const costId = await bill(66, 'USD');
    const row = await addExpense(
      { categoryId, amount: 66, currency: 'USD', expenseDate: DAY, accountId: usdTill },
      ctx(),
      { twinAck: [costId] },
    );
    madeExpenses.push(row.id);
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(sql`${auditLog.entityType} = 'expense' AND ${auditLog.entityId} = ${row.id} AND ${auditLog.action} = 'create'`);
    expect((audit!.after as { twinAck?: string[] }).twinAck).toEqual([costId]);
  });
});

describe('the cost door writes the scope’s own target and nothing else (§8.5)', () => {
  it('a receipt cost posted with a truck id lands on no truck, and a weight-basis client is not stored', async () => {
    const id = await bill(5, 'USD', { scope: 'receipt', receiptId, batchId, clientId, allocationBasis: 'weight' });
    const [row] = await db
      .select({ batchId: costEntries.batchId, receiptId: costEntries.receiptId, clientId: costEntries.clientId })
      .from(costEntries)
      .where(eq(costEntries.id, id));
    expect(row).toEqual({ batchId: null, receiptId, clientId: null });
  });

  it('a direct bill keeps its client', async () => {
    const id = await bill(6, 'USD', { allocationBasis: 'direct_to_client', clientId });
    const [row] = await db.select({ clientId: costEntries.clientId }).from(costEntries).where(eq(costEntries.id, id));
    expect(row!.clientId).toBe(clientId);
  });

  it('a voided prixod takes no new cost', async () => {
    await db.update(receipts).set({ status: 'voided' }).where(eq(receipts.id, receiptId));
    try {
      await expect(bill(7, 'USD', { scope: 'receipt', receiptId })).rejects.toMatchObject({ code: 'receipt_voided' });
    } finally {
      await db.update(receipts).set({ status: 'confirmed' }).where(eq(receipts.id, receiptId));
    }
  });
});

/**
 * The cancelled-truck race, deterministically: a second connection holds the
 * lock one side takes, the other side is started and SEEN waiting on it in
 * `pg_stat_activity` (polled through the pool — the holder's own snapshot
 * freezes inside its transaction), then the holder commits.
 */
describe('a bill and a cancellation of one truck can no longer both succeed', () => {
  const holderUrl = process.env.DATABASE_URL!;

  async function waitingOnLock(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const rows = (await db.execute(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND datname = current_database()`)) as unknown as { n: number }[];
      if ([...rows][0]!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('nobody waited on the lock');
  }

  async function freshTruck(): Promise<string> {
    const id = uuidv4();
    await db.insert(batches).values({
      id,
      code: `TQ${STAMP}-${String(Math.floor(Math.random() * 900) + 100)}`,
      originWarehouseId: madeWarehouses[0]!,
      destWarehouseId: madeWarehouses[1]!,
      status: 'forming',
      createdBy: actorId,
    });
    return id;
  }

  it('the cancel commits first: the bill, waiting on the truck, finds it cancelled', async () => {
    const truck = await freshTruck();
    const holder = postgres(holderUrl, { max: 1 });
    try {
      let pending: Promise<unknown> = Promise.resolve();
      // The holder's transaction commits when the callback returns.
      await holder.begin(async (tx) => {
        await tx`SELECT status FROM batches WHERE id = ${truck}::uuid FOR NO KEY UPDATE`;
        await tx`UPDATE batches SET status = 'cancelled' WHERE id = ${truck}::uuid`;
        pending = addCostEntry(
          { scope: 'batch', batchId: truck, costTypeId, amount: 9, currency: 'USD', costDate: DAY, allocationBasis: 'weight' },
          ctx(),
        );
        pending.catch(() => undefined);
        await waitingOnLock();
      });
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
      const [n] = await db.select({ n: sql<number>`count(*)::int` }).from(costEntries).where(eq(costEntries.batchId, truck));
      expect(n!.n).toBe(0);
    } finally {
      await holder.end();
      // A red proof (the lock stripped) writes the bill this test refuses —
      // removed first, or the truck's FK keeps both behind for the next file.
      await db.delete(costEntries).where(eq(costEntries.batchId, truck));
      await db.delete(batches).where(eq(batches.id, truck));
    }
  });

  it('an annul-shaped holder (the prixod, then the truck) makes a stamped grid cell WAIT — never a deadlock', async () => {
    const truck = await freshTruck();
    const holder = postgres(holderUrl, { max: 1 });
    try {
      let pending: ReturnType<typeof addCostEntry> | null = null;
      await holder.begin(async (tx) => {
        await tx`SELECT id FROM receipts WHERE id = ${receiptId}::uuid FOR UPDATE`;
        await tx`SELECT status FROM batches WHERE id = ${truck}::uuid FOR NO KEY UPDATE`;
        pending = addCostEntry(
          { scope: 'receipt', receiptId, costTypeId, amount: 11, currency: 'USD', costDate: DAY, allocationBasis: 'weight' },
          ctx(),
          { stampTruck: truck },
        );
        pending.catch(() => undefined);
        await waitingOnLock();
      });
      const entry = await pending!;
      madeCosts.push(entry.id);
      const [row] = await db.select({ batchId: costEntries.batchId }).from(costEntries).where(eq(costEntries.id, entry.id));
      expect(row!.batchId).toBe(truck);
    } finally {
      await holder.end();
      await db.delete(costEntries).where(eq(costEntries.batchId, truck));
      await db.delete(batches).where(eq(batches.id, truck));
    }
  });

  it('a phone-shaped holder (it updates the forming truck) makes a bill wait, then lets it through', async () => {
    const truck = await freshTruck();
    const holder = postgres(holderUrl, { max: 1 });
    try {
      let pending: ReturnType<typeof addCostEntry> | null = null;
      await holder.begin(async (tx) => {
        await tx`UPDATE batches SET status = 'loading' WHERE id = ${truck}::uuid`;
        pending = addCostEntry(
          { scope: 'batch', batchId: truck, costTypeId, amount: 12, currency: 'USD', costDate: DAY, allocationBasis: 'weight' },
          ctx(),
        );
        pending.catch(() => undefined);
        await waitingOnLock();
      });
      const entry = await pending!;
      expect(entry.batchId).toBe(truck);
    } finally {
      await holder.end();
      await db.delete(costEntries).where(eq(costEntries.batchId, truck));
      await db.delete(batches).where(eq(batches.id, truck));
    }
  });

  it('a truck with a bill is refused BEFORE a carton is locked — a split still key-sharing the cartons cannot deadlock it', async () => {
    const truck = await freshTruck();
    const [lot] = await db
      .insert(receiptLots)
      .values({ receiptId, seq: 2, productNameZh: `锁${STAMP}`, boxCount: 1, totalWeightKg: '10', totalVolumeM3: '0.1' })
      .returning({ id: receiptLots.id });
    const [box] = await db
      .insert(boxes)
      .values({
        lotId: lot!.id,
        shortCode: `TQ${STAMP}L1`,
        seqInLot: 1,
        status: 'planned',
        currentWarehouseId: madeWarehouses[0]!,
        currentBatchId: truck,
      })
      .returning({ id: boxes.id });
    const costId = uuidv4();
    await db.execute(sql`
      INSERT INTO cost_entries (id, scope, batch_id, cost_type_id, amount, currency, cost_date, allocation_basis, entered_by)
      VALUES (${costId}::uuid, 'batch', ${truck}::uuid, ${costTypeId}::uuid, 9, 'USD', ${DAY}::date, 'weight', ${actorId}::uuid)`);
    const holder = postgres(holderUrl, { max: 1 });
    try {
      await holder.begin(async (tx) => {
        // The bill's own split, mid-flight: its allocation INSERT key-shares
        // the carton until it commits.
        await tx`SELECT id FROM boxes WHERE id = ${box!.id}::uuid FOR KEY SHARE`;
        const outcome = await Promise.race([
          cancelBatch(truck, 'test bekor', ctx()).then(
            () => 'cancelled',
            (err: { code?: string }) => err.code ?? 'error',
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('waited on the carton'), 3000)),
        ]);
        expect(outcome).toBe('batch_has_costs');
      });
    } finally {
      await holder.end();
      await db.delete(costEntries).where(eq(costEntries.id, costId));
      await db.delete(boxes).where(eq(boxes.id, box!.id));
      await db.delete(receiptLots).where(eq(receiptLots.id, lot!.id));
      await db.delete(batches).where(eq(batches.id, truck));
    }
  });

  it('the bill commits first: the cancel, waiting on the truck, counts it and refuses', async () => {
    const truck = await freshTruck();
    const holder = postgres(holderUrl, { max: 1 });
    let costId = '';
    try {
      let pending: Promise<unknown> = Promise.resolve();
      await holder.begin(async (tx) => {
        await tx`SELECT status FROM batches WHERE id = ${truck}::uuid FOR SHARE`;
        const [row] = await tx`
          INSERT INTO cost_entries (id, scope, batch_id, cost_type_id, amount, currency, cost_date, allocation_basis, entered_by)
          VALUES (${uuidv4()}::uuid, 'batch', ${truck}::uuid, ${costTypeId}::uuid, 9, 'USD', ${DAY}::date, 'weight', ${actorId}::uuid)
          RETURNING id`;
        costId = row!.id as string;
        pending = cancelBatch(truck, 'test bekor', ctx());
        pending.catch(() => undefined);
        await waitingOnLock();
      });
      await expect(pending).rejects.toMatchObject({ code: 'batch_has_costs' });
      const [after] = await db.select({ status: batches.status }).from(batches).where(eq(batches.id, truck));
      expect(after!.status).toBe('forming');
    } finally {
      await holder.end();
      if (costId) await db.delete(costEntries).where(eq(costEntries.id, costId));
      await db.delete(batches).where(eq(batches.id, truck));
    }
  });
});

describe('the second review: what the alarm compares, and how it is answered', () => {
  it('a typed 1.005 is compared as the 1.01 the column will store', async () => {
    await clearBooks();
    const expenseId = await spend(1.01, 'USD', { accountId: usdTill });
    const answer = await twinsForCost(ACCOUNTANT(), await candidate(1.005, 'USD'));
    expect(answer!.ids).toEqual([expenseId]);
  });

  it('a kassa-less cost the merge already joined is offered a void, not the merge that refuses it', async () => {
    await clearBooks();
    const joinedTo = await spend(461, 'USD');
    const costId = await bill(461, 'USD');
    await db.update(costEntries).set({ mergedExpenseId: joinedTo }).where(eq(costEntries.id, costId));
    await voidExpense(joinedTo, 'merged', ctx());
    const answer = await twinsForExpense(ACCOUNTANT(), {
      categoryId,
      amount: 461,
      currency: 'USD',
      expenseDate: DAY,
      accountId: usdTill,
      partnerId: null,
      warehouseId: null,
    });
    expect(answer!.ids).toEqual([costId]);
    expect(answer!.lines[0]).toMatchObject({ shape: 'kassa_cash', cure: 'void' });
  });

  it('a bill with no rate says it could not be weighed against another currency', async () => {
    await clearBooks();
    const answer = await twinsForCost(ACCOUNTANT(), await candidate(3600, NO_RATE));
    expect(answer!.ids).toEqual([]);
    expect(twinGap(answer)).toEqual({ unchecked: true, uncheckedOthers: 0 });
  });

  it('an expense counts the rate-less truck bills in its window it could not weigh', async () => {
    await clearBooks();
    await bill(7000, NO_RATE);
    const answer = await twinsForExpense(ACCOUNTANT(), {
      categoryId,
      amount: 9,
      currency: 'USD',
      expenseDate: DAY,
      accountId: usdTill,
      partnerId: null,
      warehouseId: null,
    });
    expect(answer!.ids).toEqual([]);
    expect(twinGap(answer)).toEqual({ unchecked: false, uncheckedOthers: 1 });
  });

  it('on the expense door, the bill at the expense’s warehouse is listed first — before a nearer day elsewhere', async () => {
    await clearBooks();
    // The prixod's bill (the CN warehouse) is the same day; the truck's (it
    // ends at the UZ one) three days off. The expense is the UZ warehouse's.
    const atReceipt = await bill(462, 'USD', { scope: 'receipt', receiptId });
    const onTruck = await bill(462, 'USD', { costDate: '1640-03-13' });
    const answer = await twinsForExpense(ACCOUNTANT(), {
      categoryId,
      amount: 462,
      currency: 'USD',
      expenseDate: DAY,
      accountId: usdTill,
      partnerId: null,
      warehouseId: madeWarehouses[1]!,
    });
    expect(answer!.ids).toEqual([onTruck, atReceipt]);
  });

  it('«✓ Ikki xil pul» takes a pair off the map’s count, and refuses a pair that is not one', async () => {
    await clearBooks();
    const costId = await bill(463, 'USD');
    const expenseId = await spend(463, 'USD', { accountId: usdTill });
    const before = await uncheckedTwinRows(sight, '1640-03-01', '1640-03-31');
    expect(before.pairs.some((p) => p.cost.id === costId && p.expense.id === expenseId)).toBe(true);
    await ackTwinPair(costId, expenseId, ctx());
    const after = await uncheckedTwinRows(sight, '1640-03-01', '1640-03-31');
    expect(after.pairs.some((p) => p.cost.id === costId)).toBe(false);
    expect(after.rows).toBe(before.rows - 2);
    const other = await spend(470, 'USD', { accountId: usdTill });
    await expect(ackTwinPair(costId, other, ctx())).rejects.toMatchObject({ code: 'not_a_twin' });
  });

  it('the map’s count is EXACTLY a brute-force twinShape over every pair of the same rows — the prefilter drops none', async () => {
    await clearBooks();
    const mine = new Set<string>();
    const c = async (amount: number, currency: string, day: string, over: Record<string, unknown> = {}) => {
      const id = await bill(amount, currency, { costDate: day, ...over });
      mine.add(id);
    };
    const e = async (amount: number, currency: string, day: string, over: Record<string, unknown> = {}) => {
      const id = await spend(amount, currency, { expenseDate: day, ...over });
      mine.add(id);
    };
    await c(250, 'USD', '1640-04-05');
    await c(250_000, CCY, '1640-04-06');
    await c(99, 'USD', '1640-04-07', { accountId: usdTill });
    await c(50, 'USD', '1640-04-08', { partnerId: firmId });
    await c(245, 'USD', '1640-04-09');
    // Paid out of the QTW kassa at the desk's own rate: only the KASSA arm sees
    // it (the dollars, $1.01 against $1.10, are 9 % apart).
    await c(1.01, 'USD', '1640-04-10', { accountId: qtwTill, accountAmount: 1100 });
    await e(250, 'USD', '1640-04-10', { accountId: usdTill });
    await e(252_000, CCY, '1640-04-12', { accountId: qtwTill });
    await e(99, 'USD', '1640-04-07', { accountId: usdTill });
    await e(50, 'USD', '1640-04-08', { partnerId: firmId });
    await e(249, 'USD', '1640-04-20');
    await e(240_000, CCY, '1640-04-28');
    await e(1100, CCY, '1640-04-11', { accountId: qtwTill });

    const sqlPairs = (await uncheckedTwinRows(sight, '1640-04-01', '1640-04-30')).pairs
      .map((p) => `${p.cost.id}:${p.expense.id}`)
      .sort();

    const costRows = await db.select().from(costEntries).where(inArray(costEntries.id, [...mine]));
    const expenseRows = await db.select().from(expenses).where(inArray(expenses.id, [...mine]));
    const bookIds = new Set(
      (await db.select({ id: expenseCategories.id }).from(expenseCategories).where(eq(expenseCategories.cash, false))).map((r) => r.id),
    );
    const brute: string[] = [];
    for (const row of costRows) {
      if (row.voidedAt) continue;
      // Built from the stored columns by hand — the arbiter is `twinShape`, the
      // thing under test is the SQL that is meant never to hide a pair from it.
      const cost: TwinCost = {
        amount: Number(row.amount),
        currency: row.currency,
        amountUsd: row.amountUsd === null ? null : Number(row.amountUsd),
        costDate: row.costDate,
        accountId: row.accountId,
        accountAmount: row.accountAmount === null ? null : Number(row.accountAmount),
        partnerId: row.partnerId,
        payer: row.accountId ? 'kassa' : row.partnerId ? 'firm' : 'none',
        merged: row.mergedExpenseId !== null,
      };
      for (const ex of expenseRows) {
        if (ex.voidedAt) continue;
        const expense: TwinExpense = {
          amount: Number(ex.amount),
          currency: ex.currency,
          amountUsd: Number(ex.amountUsd),
          expenseDate: ex.expenseDate,
          accountId: ex.accountId,
          partnerId: ex.partnerId,
          payer: bookIds.has(ex.categoryId) ? 'book' : ex.accountId ? 'kassa' : ex.partnerId ? 'firm' : 'cash',
          restored: false,
        };
        const later = cost.costDate > expense.expenseDate ? cost.costDate : expense.expenseDate;
        if (later < '1640-04-01' || later > '1640-04-30') continue;
        if (twinShape(cost, expense)) brute.push(`${row.id}:${ex.id}`);
      }
    }
    brute.sort();
    expect(brute.length, 're-anchor: the fixture must hold twins of several shapes').toBeGreaterThanOrEqual(4);
    expect(sqlPairs).toEqual(brute);
  });
});

describe('a price and a cancellation of one truck can no longer both succeed', () => {
  it('the cancel commits first: the price, waiting on the truck, finds it cancelled', async () => {
    const truck = uuidv4();
    await db.insert(batches).values({
      id: truck,
      code: `TQ${STAMP}-P${String(Math.floor(Math.random() * 90) + 10)}`,
      originWarehouseId: madeWarehouses[0]!,
      destWarehouseId: madeWarehouses[1]!,
      status: 'forming',
      createdBy: actorId,
    });
    const [lot] = await db
      .insert(receiptLots)
      .values({ receiptId, seq: 1, productNameZh: `价${STAMP}`, boxCount: 1, totalWeightKg: '10', totalVolumeM3: '0.1' })
      .returning({ id: receiptLots.id });
    const [box] = await db
      .insert(boxes)
      .values({
        lotId: lot!.id,
        shortCode: `TQ${STAMP}P1`,
        seqInLot: 1,
        status: 'planned',
        currentWarehouseId: madeWarehouses[0]!,
        currentBatchId: truck,
      })
      .returning({ id: boxes.id });
    const holder = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      let pending: Promise<unknown> = Promise.resolve();
      await holder.begin(async (tx) => {
        await tx`SELECT status FROM batches WHERE id = ${truck}::uuid FOR NO KEY UPDATE`;
        await tx`UPDATE batches SET status = 'cancelled' WHERE id = ${truck}::uuid`;
        pending = addTransaction(
          { clientId, type: 'charge', amount: 25, currency: 'USD', txDate: DAY, batchId: truck } as Parameters<typeof addTransaction>[0],
          ctx(),
        );
        pending.catch(() => undefined);
        for (let i = 0; i < 200; i += 1) {
          const rows = (await db.execute(sql`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND datname = current_database()`)) as unknown as { n: number }[];
          if ([...rows][0]!.n > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('nobody waited on the lock');
      });
      await expect(pending).rejects.toMatchObject({ code: 'batch_cancelled' });
      const [n] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(clientTransactions)
        .where(eq(clientTransactions.batchId, truck));
      expect(n!.n).toBe(0);
    } finally {
      await holder.end();
      // A red proof writes the price this test refuses: removed first (the FK).
      await db.delete(clientTransactions).where(eq(clientTransactions.batchId, truck));
      await db.delete(boxes).where(eq(boxes.id, box!.id));
      await db.delete(receiptLots).where(eq(receiptLots.id, lot!.id));
      await db.delete(batches).where(eq(batches.id, truck));
    }
  });
});
