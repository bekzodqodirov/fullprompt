import 'dotenv/config';
import { and, eq, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  clients,
  clientTransactions,
  expenses,
  partnerTypes,
  recurringExpenses,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { addDays } from '@/modules/platform/time/tashkent';
import {
  accountBalances,
  addExpense,
  addTransfer,
  saveAccount,
  saveCategory,
  saveRecurring,
  voidExpense,
} from '@/modules/wms/accounting/service';
import { addCostEntry, addReceiptCostsBulk } from '@/modules/wms/costing/service';
import { payUpsale, setUpsaleCategory } from '@/modules/wms/calc/upsale-service';
import { createDeal, deferPayment } from '@/modules/wms/deals/service';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { addTransaction, deferredBalanceUsd, voidTransaction } from '@/modules/wms/finance/service';
import { blockingDebtUsd } from '@/modules/wms/issue/approvals';
import { issueBoxes } from '@/modules/wms/issue/service';
import { addPartnerTx, savePartner, setPartnerActive } from '@/modules/wms/partners/service';
import { recordSettlement } from '@/modules/wms/partners/settlement';

/**
 * The finance audit's money DOORS, proven through the services they call
 * (the action halves are fenced in money-doors-wire.test.ts, #531).
 *
 * Money is parked in 1623, a year no other file writes (#713): the tills sum
 * every row whatever its date, so what this file leaves live is voided in
 * afterAll, and the configuration it touches (the upsale category setting,
 * its categories, tills and firm) is put back or retired (#183).
 */
const YEAR = '1623';
const DAY = `${YEAR}-06-10`;
/** The day after tomorrow in Tashkent — the first day every door refuses. */
const FUTURE = addDays(latestTxDate(), 1);
const SUFFIX = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

let actorId: string;
const ctx = () => ({ actorId });
let clientId: string;
let otherClientId: string;
/** U30's own client: its gate arithmetic must see no other test's money. */
let deferClientId: string;
let cashCategoryId: string;
let nonCashCategoryId: string;
let usdTillId: string;
let partnerId: string;
let warehouseId: string;
const tills: { id: string; name: string; currency: string }[] = [];
const liveClientTx: string[] = [];
const liveExpenses: string[] = [];
const deletableExpenses: string[] = [];
const templates: string[] = [];
let upsaleSetting: unknown;

async function mintTill(label: string, currency: string, openingBalance = 0) {
  const name = `U-doors ${label} ${SUFFIX}`;
  const row = await saveAccount(
    { name, currency, kind: 'cash', openingBalance, openingDate: '', sortOrder: 900, active: true },
    ctx(),
  );
  tills.push({ id: row.id, name, currency });
  return row.id;
}

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  upsaleSetting = await getSetting('upsale_expense_category_id');
  const [a, b, c] = await db
    .insert(clients)
    .values([
      { clientCode: `UD${SUFFIX.slice(-6)}`.toUpperCase(), name: 'Money doors client' },
      { clientCode: `UE${SUFFIX.slice(-6)}`.toUpperCase(), name: 'Money doors other client' },
      { clientCode: `UF${SUFFIX.slice(-6)}`.toUpperCase(), name: 'Money doors deferral client' },
    ])
    .returning();
  clientId = a!.id;
  otherClientId = b!.id;
  deferClientId = c!.id;
  cashCategoryId = (await saveCategory({ name: `Ijara doors ${SUFFIX}`, cash: true, sortOrder: 900, active: true }, ctx())).id;
  nonCashCategoryId = (
    await saveCategory({ name: `Amortizatsiya doors ${SUFFIX}`, cash: false, sortOrder: 900, active: true }, ctx())
  ).id;
  usdTillId = await mintTill('usd', 'USD');
  const [type] = await db.select().from(partnerTypes).where(eq(partnerTypes.code, 'transport')).limit(1);
  partnerId = await savePartner(null, { name: `Firma doors ${SUFFIX}`, typeId: type!.id }, ctx());
  warehouseId = (await db.select({ id: warehouses.id }).from(warehouses).limit(1))[0]!.id;
});

afterAll(async () => {
  try {
    for (const id of liveClientTx) {
      await voidTransaction(id, 'money-doors tozalash', ctx(), { mayMoveTill: true }).catch(() => undefined);
    }
    for (const id of liveExpenses) await voidExpense(id, 'money-doors tozalash', ctx()).catch(() => undefined);
    for (const id of deletableExpenses) await db.delete(expenses).where(eq(expenses.id, id));
    for (const id of templates) {
      await db.delete(expenses).where(eq(expenses.recurringId, id));
      await db.delete(recurringExpenses).where(eq(recurringExpenses.id, id));
    }
    // Tills and categories are retired, never deleted (audit_log names them).
    for (const till of tills) {
      await saveAccount(
        { name: till.name, currency: till.currency, kind: 'cash', openingBalance: 0, openingDate: '', sortOrder: 900, active: false, id: till.id },
        ctx(),
      ).catch(() => undefined);
    }
    for (const [id, name, cash] of [
      [cashCategoryId, `Ijara doors ${SUFFIX}`, true],
      [nonCashCategoryId, `Amortizatsiya doors ${SUFFIX}`, false],
    ] as const) {
      await saveCategory({ id, name, cash, sortOrder: 900, active: false }, ctx()).catch(() => undefined);
    }
    await setPartnerActive(partnerId, false, ctx()).catch(() => undefined);
    await setSetting('upsale_expense_category_id', upsaleSetting ?? '', actorId);
  } finally {
    await pgClient.end();
  }
});

describe('U21 — no money row dated after tomorrow, at every door (#995)', () => {
  it('an expense, and so the upsale payout and the rasxod «Kiritish» that write through it', async () => {
    await expect(
      addExpense({ categoryId: cashCategoryId, amount: 5, currency: 'USD', expenseDate: FUTURE }, ctx()),
    ).rejects.toMatchObject({ code: 'future_date' });
    await expect(
      payUpsale([uuidv4()], { accountId: usdTillId, currency: 'USD', expenseDate: FUTURE }, ctx()),
    ).rejects.toMatchObject({ code: 'future_date' });
  });

  it('a transfer, a partner row and a settlement', async () => {
    await expect(
      addTransfer(
        { fromAccountId: usdTillId, toAccountId: uuidv4(), amountFrom: 5, amountTo: 5, transferDate: FUTURE },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'future_date' });
    await expect(
      addPartnerTx(
        { partnerId, type: 'payment', amount: 5, currency: 'USD', txDate: FUTURE, accountId: usdTillId },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'future_date' });
    await expect(
      recordSettlement(
        {
          txId: uuidv4(),
          clientId,
          partnerId,
          clientAmount: 5,
          clientCurrency: 'USD',
          partnerAmount: 5,
          partnerCurrency: 'USD',
          txDate: FUTURE,
          note: 'kelajak',
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'future_date' });
  });

  it('a cargo cost, and the grid before its first cell', async () => {
    await expect(
      addCostEntry(
        {
          scope: 'receipt',
          receiptId: uuidv4(),
          costTypeId: uuidv4(),
          amount: 5,
          currency: 'USD',
          costDate: FUTURE,
          allocationBasis: 'weight',
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'future_date' });
    await expect(
      addReceiptCostsBulk(
        {
          batchId: uuidv4(),
          currency: 'USD',
          costDate: FUTURE,
          cells: [{ receiptId: uuidv4(), costTypeId: uuidv4(), amount: 5 }],
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'future_date' });
  });

  it('the monthly run keeps posting a template on its own later day, exactly as before', async () => {
    // What «▶️ Oyni yozish» does from the 1st: a template dated the 28th posts
    // its expense dated the 28th. Whether that should change is the owner's
    // open A/B/C question, so the posting door (the only one carrying a
    // template id) keeps today's behaviour.
    const template = await saveRecurring(
      { categoryId: cashCategoryId, amount: 7, currency: 'USD', dayOfMonth: 28, active: false },
      ctx(),
    );
    templates.push(template.id);
    const posted = await addExpense(
      { categoryId: cashCategoryId, amount: 7, currency: 'USD', expenseDate: FUTURE },
      ctx(),
      { recurringId: template.id },
    );
    deletableExpenses.push(posted.id);
    expect(posted.expenseDate).toBe(FUTURE);
  });
});

describe('U44 — the native bound is the column, the ceiling is in dollars', () => {
  it('a so\'m till opens at 1.5 billion and reads it back', async () => {
    const till = await mintTill('uzs-big', 'UZS', 1_500_000_000);
    const row = (await accountBalances()).find((r) => r.id === till)!;
    expect(row.opening).toBe(1_500_000_000);
    expect(row.balance).toBe(1_500_000_000);
  });

  it('a dollar row past $1e9 is refused in words, not by postgres (22003)', async () => {
    const huge = 2_000_000_000;
    await expect(
      addCostEntry(
        { scope: 'receipt', receiptId: uuidv4(), costTypeId: uuidv4(), amount: huge, currency: 'USD', costDate: DAY, allocationBasis: 'weight' },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'amount_too_large' });
    await expect(
      addExpense({ categoryId: cashCategoryId, amount: huge, currency: 'USD', expenseDate: DAY }, ctx()),
    ).rejects.toMatchObject({ code: 'amount_too_large' });
    await expect(
      addTransaction({ clientId, type: 'charge', amount: huge, currency: 'USD', txDate: DAY }, ctx()),
    ).rejects.toMatchObject({ code: 'amount_too_large' });
    await expect(
      addPartnerTx({ partnerId, type: 'adjust', amount: -huge, currency: 'USD', txDate: DAY }, ctx()),
    ).rejects.toMatchObject({ code: 'amount_too_large' });
  });
});

describe('U29 — a kassa that holds money keeps its currency', () => {
  const edit = (id: string, name: string, currency: string, openingBalance = 0) =>
    saveAccount({ id, name, currency, kind: 'cash', openingBalance, openingDate: '', sortOrder: 900, active: true }, ctx());
  const nameOf = (id: string) => tills.find((till) => till.id === id)!.name;

  it('a till with one payment refuses a new currency and every figure stays put', async () => {
    const till = await mintTill('paid', 'USD');
    const payment = await addTransaction(
      { clientId, type: 'payment', amount: 150, currency: 'USD', txDate: DAY, accountId: till, method: 'cash' },
      ctx(),
    );
    liveClientTx.push(payment.id);
    const before = (await accountBalances()).find((r) => r.id === till)!;
    await expect(edit(till, nameOf(till), 'UZS')).rejects.toMatchObject({ code: 'currency_locked' });
    const after = (await accountBalances()).find((r) => r.id === till)!;
    expect(after.currency).toBe('USD');
    expect(after.balance).toBe(before.balance);

    // The same save with the same currency still works — a new name, a
    // corrected opening — and the history records what it was before.
    const renamed = `${nameOf(till)} yangi`;
    await edit(till, renamed, 'USD', 10);
    tills.find((t) => t.id === till)!.name = renamed;
    const [audit] = await db
      .select({ before: auditLog.before })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'money_account'), eq(auditLog.entityId, till), eq(auditLog.action, 'update')))
      .orderBy(sql`${auditLog.createdAt} DESC`)
      .limit(1);
    expect(audit?.before).toMatchObject({ currency: 'USD', openingBalance: '0.00' });
  });

  it('a VOIDED row locks it too — it is still printed in that currency', async () => {
    const till = await mintTill('voided', 'USD');
    const expense = await addExpense(
      { categoryId: cashCategoryId, amount: 9, currency: 'USD', expenseDate: DAY, accountId: till },
      ctx(),
    );
    await voidExpense(expense.id, 'xato', ctx());
    await expect(edit(till, nameOf(till), 'UZS')).rejects.toMatchObject({ code: 'currency_locked' });
  });

  it('a TEMPLATE locks it — re-read in another currency, every monthly post would fail', async () => {
    const till = await mintTill('template', 'USD');
    const template = await saveRecurring(
      { categoryId: cashCategoryId, amount: 40, currency: 'USD', dayOfMonth: 5, accountId: till, active: false },
      ctx(),
    );
    templates.push(template.id);
    await expect(edit(till, nameOf(till), 'UZS')).rejects.toMatchObject({ code: 'currency_locked' });
  });

  it('an empty till may still change its currency', async () => {
    const till = await mintTill('empty', 'USD');
    const row = await edit(till, nameOf(till), 'UZS');
    tills.find((t) => t.id === till)!.currency = 'UZS';
    expect(row.currency).toBe('UZS');
  });
});

describe('U06 — a non-cash kind names no kassa and no payer', () => {
  it('the expense door refuses a kassa and a payer on it, and still takes the book entry itself', async () => {
    await expect(
      addExpense(
        { categoryId: nonCashCategoryId, amount: 3, currency: 'USD', expenseDate: DAY, accountId: usdTillId },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'non_cash_category' });
    await expect(
      addExpense({ categoryId: nonCashCategoryId, amount: 3, currency: 'USD', expenseDate: DAY, partnerId }, ctx()),
    ).rejects.toMatchObject({ code: 'non_cash_category' });
    const book = await addExpense({ categoryId: nonCashCategoryId, amount: 3, currency: 'USD', expenseDate: DAY }, ctx());
    deletableExpenses.push(book.id);
    expect(book.accountId).toBeNull();
  });

  it('a template refuses it while the person is still on the form', async () => {
    await expect(
      saveRecurring(
        { categoryId: nonCashCategoryId, amount: 3, currency: 'USD', dayOfMonth: 1, accountId: usdTillId, active: false },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'non_cash_category' });
  });

  it('the upsale payout category must move money — at the setting and at the payout', async () => {
    await expect(setUpsaleCategory(nonCashCategoryId, ctx())).rejects.toMatchObject({ code: 'non_cash_category' });
    // A setting chosen before the rule existed: the payout refuses it too.
    await setSetting('upsale_expense_category_id', nonCashCategoryId, actorId);
    try {
      await expect(
        payUpsale([uuidv4()], { accountId: usdTillId, currency: 'USD', expenseDate: DAY }, ctx()),
      ).rejects.toMatchObject({ code: 'non_cash_category' });
    } finally {
      await setSetting('upsale_expense_category_id', upsaleSetting ?? '', actorId);
    }
  });
});

describe('U30 — a settlement can name the deferred job it pays', () => {
  it('money paid through the firm for a deferred job stops excusing the other debt', async () => {
    const dealId = await createDeal(
      { clientId: deferClientId, title: `Kechiktirilgan ${SUFFIX}` } as Parameters<typeof createDeal>[0],
      ctx(),
    );
    const deferredCharge = await addTransaction(
      { clientId: deferClientId, dealId, type: 'charge', amount: 1000, currency: 'USD', txDate: DAY },
      ctx(),
    );
    const otherDebt = await addTransaction({ clientId: deferClientId, type: 'charge', amount: 500, currency: 'USD', txDate: DAY }, ctx());
    liveClientTx.push(deferredCharge.id, otherDebt.id);
    await deferPayment(dealId, { reason: 'hammasi kelganda', untilAllArrived: true }, ctx());
    expect(await deferredBalanceUsd(deferClientId)).toBeCloseTo(1000, 2);

    const settled = await recordSettlement(
      {
        txId: uuidv4(),
        clientId: deferClientId,
        partnerId,
        clientAmount: 1000,
        clientCurrency: 'USD',
        partnerAmount: 1000,
        partnerCurrency: 'USD',
        txDate: DAY,
        note: 'mijoz Xitoydagi firmaga to‘ladi',
        dealId,
      },
      ctx(),
    );
    liveClientTx.push(settled.clientTxId);
    const [row] = await db
      .select({ dealId: clientTransactions.dealId })
      .from(clientTransactions)
      .where(eq(clientTransactions.id, settled.clientTxId));
    expect(row?.dealId).toBe(dealId);
    // The job is paid; the $500 is genuinely owed and the gate must see it.
    expect(await deferredBalanceUsd(deferClientId)).toBeCloseTo(0, 2);
    expect(await blockingDebtUsd(deferClientId)).toBeCloseTo(500, 2);
    await expect(
      issueBoxes(
        {
          handoverId: uuidv4(),
          clientId: deferClientId,
          warehouseId,
          boxIds: [uuidv4()],
          personName: 'Test Person',
          personPhone: '+998901112233',
          debtOk: false,
          note: '',
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'debt_block' });
  });

  it("another client's deal is refused before anything is written", async () => {
    const foreignDeal = await createDeal(
      { clientId: otherClientId, title: `Begona ${SUFFIX}` } as Parameters<typeof createDeal>[0],
      ctx(),
    );
    const txId = uuidv4();
    await expect(
      recordSettlement(
        {
          txId,
          clientId,
          partnerId,
          clientAmount: 10,
          clientCurrency: 'USD',
          partnerAmount: 10,
          partnerCurrency: 'USD',
          txDate: DAY,
          note: 'begona bitim',
          dealId: foreignDeal,
        },
        ctx(),
      ),
    ).rejects.toMatchObject({ code: 'deal_mismatch' });
    const written = await db
      .select({ id: clientTransactions.id })
      .from(clientTransactions)
      .where(and(eq(clientTransactions.clientId, clientId), eq(clientTransactions.note, 'begona bitim')));
    expect(written).toHaveLength(0);
  });
});

describe('U33 — voiding a refund asks the grant that created it (#1014)', () => {
  it('without the kassa grant a refund stays; a payment may still be voided; the holder voids the refund', async () => {
    const refund = await addTransaction(
      { clientId, type: 'refund', amount: 20, currency: 'USD', txDate: DAY, accountId: usdTillId, method: 'cash' },
      ctx(),
    );
    liveClientTx.push(refund.id);
    await expect(voidTransaction(refund.id, 'VED bekor qildi', ctx(), { mayMoveTill: false })).rejects.toMatchObject({
      code: 'forbidden',
    });
    const [still] = await db
      .select({ voidedAt: clientTransactions.voidedAt })
      .from(clientTransactions)
      .where(eq(clientTransactions.id, refund.id));
    expect(still?.voidedAt).toBeNull();

    // Money coming IN is the VED's door by design (m9-client-money) — its void too.
    const payment = await addTransaction(
      { clientId, type: 'payment', amount: 20, currency: 'USD', txDate: DAY, accountId: usdTillId, method: 'cash' },
      ctx(),
    );
    await voidTransaction(payment.id, 'xato summa', ctx(), { mayMoveTill: false });

    await voidTransaction(refund.id, 'buxgalter bekor qildi', ctx(), { mayMoveTill: true });
    const [gone] = await db
      .select({ voidedAt: clientTransactions.voidedAt })
      .from(clientTransactions)
      .where(eq(clientTransactions.id, refund.id));
    expect(gone?.voidedAt).not.toBeNull();
  });
});
