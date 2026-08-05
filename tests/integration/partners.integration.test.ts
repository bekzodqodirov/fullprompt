import 'dotenv/config';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  batches,
  clients,
  clientTransactions,
  costEntries,
  costTypes,
  currencies,
  expenseCategories,
  expenses,
  fxRates,
  moneyAccounts,
  partners,
  receipts,
  partnerTransactions,
  partnerTypes,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { addCostEntry, recomputeAll, upsertFxRate, voidCostEntry } from '@/modules/wms/costing/service';
import { addExpense, saveAccount, voidExpense } from '@/modules/wms/accounting/service';
import { addTransaction, clientBalanceUsd, voidTransaction } from '@/modules/wms/finance/service';
import { moneyFlowCounts } from '@/modules/wms/home/role-flows';
import {
  addPartnerTx,
  groupPartnersByType,
  listPartnerTypes,
  listPartners,
  partnerBalanceUsd,
  savePartner,
  setPartnerActive,
  voidPartnerTx,
} from '@/modules/wms/partners/service';
import { recordSettlement } from '@/modules/wms/partners/settlement';
import { accountBalances } from '@/modules/wms/accounting/service';
import { cashFlow, companyBalance } from '@/modules/wms/accounting/reports';
import { effectiveCustoms, setReceiptCustoms } from '@/modules/wms/partners/customs';

/**
 * Kontragentlar — the owner's three cases, each proved against the database
 * because every one of them is a number he will read off a screen and act on.
 *
 * The rule under all of them: a COST and a DEBT are different facts. Entering
 * a cost against a partner must leave the cargo's tannarx alone and put the
 * money on that partner's account; paying the partner later must move cash
 * without becoming a second cost.
 */

const STAMP = String(Date.now()).slice(-6);
let actorId: string;
let warehouseId: string;
let destWarehouseId: string;
let transportTypeId: string;
const ctx = () => ({ actorId });

const madePartners: string[] = [];
const madeClients: string[] = [];
const madeCosts: string[] = [];
const madeExpenses: string[] = [];
const madeBatches: string[] = [];
const madeAccounts: string[] = [];
const madeTypes: string[] = [];
/** Minted here so no other suite's currency can decide these assertions. */
const TEST_CCY = 'QAA';
const DRIFT_CCY = 'QAC';
const NO_RATE_CCY = 'QAB';

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  const whRows = await db.select().from(warehouses).limit(2);
  warehouseId = whRows[0]!.id;
  // A batch must have two different ends (batches_route_check).
  destWarehouseId = whRows[1]!.id;
  transportTypeId = (
    await db.select().from(partnerTypes).where(eq(partnerTypes.code, 'transport')).limit(1)
  )[0]!.id;
});

afterAll(async () => {
  // Partner rows point at costs and expenses, so they go first.
  if (madePartners.length) {
    await db.delete(partnerTransactions).where(inArray(partnerTransactions.partnerId, madePartners));
  }
  if (madeCosts.length) await db.delete(costEntries).where(inArray(costEntries.id, madeCosts));
  if (madeBatches.length) await db.delete(batches).where(inArray(batches.id, madeBatches));
  if (madeExpenses.length) await db.delete(expenses).where(inArray(expenses.id, madeExpenses));
  if (madeClients.length) {
    await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
  }
  if (madePartners.length) await db.delete(partners).where(inArray(partners.id, madePartners));
  if (madeClients.length) await db.delete(clients).where(inArray(clients.id, madeClients));
  // A cash box and a currency are CONFIGURATION while they exist — a leftover
  // till changes what /accounting/balance and every money form render, and
  // vitest orders files by a DURATION cache, so the next reader is not even
  // predictable (#183, the VITEST half).
  if (madeAccounts.length) {
    await db.delete(moneyAccounts).where(inArray(moneyAccounts.id, madeAccounts));
  }
  if (madeTypes.length) await db.delete(partnerTypes).where(inArray(partnerTypes.id, madeTypes));
  await db.delete(fxRates).where(inArray(fxRates.currency, [TEST_CCY, NO_RATE_CCY, DRIFT_CCY]));
  await db.delete(currencies).where(inArray(currencies.code, [TEST_CCY, NO_RATE_CCY, DRIFT_CCY]));
  await pgClient.end();
});

async function newPartner(name: string, clientId?: string): Promise<string> {
  const id = await savePartner(
    null,
    { name: `${name} ${STAMP}`, typeId: transportTypeId, clientId: clientId ?? '', phone: '', note: '' },
    ctx(),
  );
  madePartners.push(id);
  return id;
}

async function newClient(code: string): Promise<string> {
  const [row] = await db
    .insert(clients)
    .values({ clientCode: code, name: `Mijoz ${code}`, phones: [`+9989${STAMP}1`] })
    .returning();
  madeClients.push(row!.id);
  return row!.id;
}

describe('what we owe a counterparty', () => {
  it('a truck taken on credit is a cost on the cargo AND a debt to the firm', async () => {
    const partnerId = await newPartner('Transport');
    const [type] = await db.select().from(costTypes).where(eq(costTypes.active, true)).limit(1);
    const [batch] = await db
      .insert(batches)
      .values({
        code: `PT-${STAMP}`,
        originWarehouseId: warehouseId,
        destWarehouseId,
        status: 'forming',
        createdBy: actorId,
      })
      .returning();

    const entry = await addCostEntry(
      {
        scope: 'batch',
        batchId: batch!.id,
        costTypeId: type!.id,
        amount: 3200,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'weight',
        partnerId,
        note: 'Fura, qarzga',
      },
      ctx(),
    );
    madeCosts.push(entry.id);

    // The cargo side is untouched by the partner: still an ordinary cost
    // entry with its allocation. Re-read, because addCostEntry returns the
    // row as INSERTED and the USD figure is filled by the recompute after.
    const [stored] = await db.select().from(costEntries).where(eq(costEntries.id, entry.id));
    expect(stored!.amountUsd).toBe('3200.00');
    // …and the debt appeared, pointing back at the cost it came from.
    expect(await partnerBalanceUsd(partnerId)).toBe(3200);
    const [charge] = await db
      .select()
      .from(partnerTransactions)
      .where(eq(partnerTransactions.costEntryId, entry.id));
    expect(charge!.type).toBe('charge');
    expect(charge!.batchId).toBe(batch!.id);

    // Paying it moves money, and is NOT a second cost.
    const [account] = await db.select().from(moneyAccounts).limit(1);
    await addPartnerTx(
      {
        partnerId,
        type: 'payment',
        amount: 1200,
        currency: 'USD',
        txDate: new Date().toISOString().slice(0, 10),
        accountId: account!.id,
        batchId: '',
        note: '',
      },
      ctx(),
    );
    expect(await partnerBalanceUsd(partnerId)).toBe(2000);

    // Cancelling the cost cancels the debt with it: a truck we are no longer
    // paying for must stop standing on the firm's account.
    await voidCostEntry(entry.id, 'mashina bekor qilindi', ctx());
    expect(await partnerBalanceUsd(partnerId)).toBe(-1200);

    madeBatches.push(batch!.id);
  });

  it('rent paid through the transport company is an expense of ours and a debt, never our cash', async () => {
    const partnerId = await newPartner('Arendachi');
    const [category] = await db.select().from(expenseCategories).limit(1);
    const row = await addExpense(
      {
        categoryId: category!.id,
        amount: 800,
        currency: 'USD',
        expenseDate: new Date().toISOString().slice(0, 10),
        warehouseId: '',
        employeeId: '',
        // Deliberately ALSO naming a cash box: a partner settled it, so the
        // account must be dropped or the cash-flow report doubles the money.
        accountId: (await db.select().from(moneyAccounts).limit(1))[0]!.id,
        partnerId,
        note: 'Ombor arendasi',
      },
      ctx(),
    );
    madeExpenses.push(row.id);

    expect(row.accountId, 'a partner-settled expense holds no cash box').toBeNull();
    expect(await partnerBalanceUsd(partnerId)).toBe(800);

    await voidExpense(row.id, 'xato kiritildi', ctx());
    expect(await partnerBalanceUsd(partnerId)).toBe(0);
  });
});

describe('uch tomonlama hisob — the client paid our supplier', () => {
  it('moves both balances, touches no cash box, and reports the rate gap', async () => {
    const partnerId = await newPartner('Xitoy transport');
    const clientId = await newClient(`PS${STAMP}`);

    // The client owes us: a charge on their ledger.
    await db.insert(clientTransactions).values({
      clientId,
      type: 'charge',
      amount: '500',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '500.00',
      txDate: new Date().toISOString().slice(0, 10),
      createdBy: actorId,
    });
    // And we owe the firm.
    await addPartnerTx(
      {
        partnerId,
        type: 'charge',
        amount: 900,
        currency: 'USD',
        txDate: new Date().toISOString().slice(0, 10),
        accountId: '',
        batchId: '',
        note: '',
      },
      ctx(),
    );

    const result = await recordSettlement(
      {
        txId: uuidv4(),
        clientId,
        partnerId,
        clientAmount: 100,
        clientCurrency: 'USD',
        // The firm counted it at its own rate and took off slightly less —
        // the owner's actual complaint, and the reason the two sides are
        // separate fields.
        partnerAmount: 98,
        partnerCurrency: 'USD',
        txDate: new Date().toISOString().slice(0, 10),
        note: 'Firma o‘z kursi bilan hisobladi',
      },
      ctx(),
    );

    expect(result.clientUsd).toBe(100);
    expect(result.partnerUsd).toBe(98);
    expect(result.differenceUsd).toBe(-2);
    expect(await clientBalanceUsd(clientId)).toBe(400);
    expect(await partnerBalanceUsd(partnerId)).toBe(802);

    // No cash box opened on either side — this is the whole point.
    const [clientRow] = await db
      .select()
      .from(clientTransactions)
      .where(eq(clientTransactions.id, result.clientTxId));
    expect(clientRow!.accountId).toBeNull();
    expect(clientRow!.partnerId).toBe(partnerId);

    // Cancelling one half cancels the other: a forgiven client debt with
    // nothing behind it is the worst outcome available here.
    await voidPartnerTx(result.partnerTxId, 'firma tasdiqlamadi', ctx());
    expect(await clientBalanceUsd(clientId)).toBe(500);
    expect(await partnerBalanceUsd(partnerId)).toBe(900);
  });

  it('refuses a settlement with neither a file nor a note', async () => {
    const partnerId = await newPartner('Hujjatsiz');
    const clientId = await newClient(`PN${STAMP}`);
    await expect(
      recordSettlement(
        {
          txId: uuidv4(),
          clientId,
          partnerId,
          clientAmount: 50,
          clientCurrency: 'USD',
          partnerAmount: 50,
          partnerCurrency: 'USD',
          txDate: new Date().toISOString().slice(0, 10),
          note: '   ',
        },
        ctx(),
      ),
    ).rejects.toThrow('proof_required');

    // …and accepts it the moment a file is standing behind it, even with no
    // note at all — the pre-bound upload is the evidence.
    const txId = uuidv4();
    await db.insert(attachments).values({
      entityType: 'partner_transaction',
      entityId: txId,
      kind: 'photo',
      storageKey: `partner_transaction/${txId}/kvitansiya.jpg`,
      fileName: 'kvitansiya.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1,
      uploadedBy: actorId,
    });
    const ok = await recordSettlement(
      {
        txId,
        clientId,
        partnerId,
        clientAmount: 50,
        clientCurrency: 'USD',
        partnerAmount: 50,
        partnerCurrency: 'USD',
        txDate: new Date().toISOString().slice(0, 10),
        note: '',
      },
      ctx(),
    );
    expect(ok.partnerTxId).toBe(txId);
    await db.delete(attachments).where(eq(attachments.entityId, txId));
  });
});

describe('the cash buyers — som in, dollars out', () => {
  it('owes them from the moment the money lands, and the rate gain is what is left', async () => {
    const partnerId = await newPartner('Naqdchi');
    const accounts = await db.select().from(moneyAccounts).limit(2);
    const today = new Date().toISOString().slice(0, 10);

    // He wired money into our account: our cash is up and we owe him.
    await addPartnerTx(
      {
        partnerId,
        type: 'receipt',
        amount: 1000,
        currency: 'USD',
        txDate: today,
        accountId: accounts[0]!.id,
        batchId: '',
        note: 'Firma hisobiga tushdi',
      },
      ctx(),
    );
    expect(await partnerBalanceUsd(partnerId)).toBe(1000);

    // He collected dollars from the till.
    await addPartnerTx(
      {
        partnerId,
        type: 'payment',
        amount: 980,
        currency: 'USD',
        txDate: today,
        accountId: (accounts[1] ?? accounts[0])!.id,
        batchId: '',
        note: 'Naqd berildi',
      },
      ctx(),
    );
    // What is left is what we gained on the rate — visible, not swallowed.
    expect(await partnerBalanceUsd(partnerId)).toBe(20);

    // Closing it as profit is a deliberate, signed correction.
    await addPartnerTx(
      {
        partnerId,
        type: 'adjust',
        amount: -20,
        currency: 'USD',
        txDate: today,
        accountId: '',
        batchId: '',
        note: 'Kurs farqi — foyda',
      },
      ctx(),
    );
    expect(await partnerBalanceUsd(partnerId)).toBe(0);
  });

  it('refuses money that moved without saying which cash box, and the reverse', async () => {
    const partnerId = await newPartner('Qoida');
    const today = new Date().toISOString().slice(0, 10);
    await expect(
      addPartnerTx(
        { partnerId, type: 'payment', amount: 10, currency: 'USD', txDate: today, accountId: '', batchId: '', note: '' },
        ctx(),
      ),
    ).rejects.toThrow();
    const [account] = await db.select().from(moneyAccounts).limit(1);
    await expect(
      addPartnerTx(
        { partnerId, type: 'charge', amount: 10, currency: 'USD', txDate: today, accountId: account!.id, batchId: '', note: '' },
        ctx(),
      ),
    ).rejects.toThrow();
  });
});

describe('a counterparty who is also a client', () => {
  it('keeps one account per client', async () => {
    const clientId = await newClient(`PC${STAMP}`);
    await newPartner('Ikki tomonlama', clientId);
    await expect(newPartner('Ikkinchi hisob', clientId)).rejects.toThrow('client_taken');
  });
});

describe('the money reports know about counterparties', () => {
  it('a cash box moved by a partner reads right, and money that never moved is not claimed', async () => {
    const partnerId = await newPartner('Kassa');
    const clientId = await newClient(`PB${STAMP}`);
    const [account] = await db.select().from(moneyAccounts).limit(1);
    const today = new Date().toISOString().slice(0, 10);

    const before = (await accountBalances()).find((a) => a.id === account!.id)!.balance;
    const flowBefore = await cashFlow(today, today);

    // Real cash IN: the buyer wired money into this account.
    await addPartnerTx(
      { partnerId, type: 'receipt', amount: 700, currency: 'USD', txDate: today, accountId: account!.id, batchId: '', note: '' },
      ctx(),
    );
    // Real cash OUT of the same box.
    await addPartnerTx(
      { partnerId, type: 'payment', amount: 200, currency: 'USD', txDate: today, accountId: account!.id, batchId: '', note: '' },
      ctx(),
    );

    const after = (await accountBalances()).find((a) => a.id === account!.id)!.balance;
    expect(after - before, 'the till must reflect both legs').toBeCloseTo(500, 2);

    const flowAfter = await cashFlow(today, today);
    expect(flowAfter.inflow - flowBefore.inflow).toBeCloseTo(700, 2);
    expect(flowAfter.outflow - flowBefore.outflow).toBeCloseTo(200, 2);

    // A client settling through a partner moves NO cash of ours, so the
    // cash-flow report must not report money it never held.
    await db.insert(clientTransactions).values({
      clientId,
      type: 'charge',
      amount: '300',
      currency: 'USD',
      rateToUsd: '1',
      amountUsd: '300.00',
      txDate: today,
      createdBy: actorId,
    });
    await recordSettlement(
      {
        txId: uuidv4(),
        clientId,
        partnerId,
        clientAmount: 300,
        clientCurrency: 'USD',
        partnerAmount: 300,
        partnerCurrency: 'USD',
        txDate: today,
        note: 'firma hisobiga',
      },
      ctx(),
    );
    const flowSettled = await cashFlow(today, today);
    expect(
      flowSettled.inflow - flowAfter.inflow,
      'a settlement is not cash received',
    ).toBeCloseTo(0, 2);
    const settledBalance = (await accountBalances()).find((a) => a.id === account!.id)!.balance;
    expect(settledBalance).toBeCloseTo(after, 2);
  });

  it('the balance counts what we owe as well as what is owed to us', async () => {
    const partnerId = await newPartner('Balanschi');
    const today = new Date().toISOString().slice(0, 10);
    const before = await companyBalance();

    await addPartnerTx(
      { partnerId, type: 'charge', amount: 450, currency: 'USD', txDate: today, accountId: '', batchId: '', note: 'fura' },
      ctx(),
    );

    const after = await companyBalance();
    expect(after.payableUsd - before.payableUsd).toBeCloseTo(450, 2);
    // A debt lowers the net position by exactly its own size — nothing else
    // moved, so anything else here would be double counting.
    expect(before.netUsd - after.netUsd).toBeCloseTo(450, 2);
    // Cash is untouched: taking a truck on credit is not spending money.
    expect(after.cashUsd).toBeCloseTo(before.cashUsd, 2);
  });
});

describe('who clears which cargo', () => {
  it("a prixod's own answer wins over the truck's, and silence follows it", () => {
    const batch = { customsPartnerId: 'firm-a', customsByClient: false };

    // Silence: whatever the truck says.
    expect(effectiveCustoms({ customsPartnerId: null, customsByClient: null }, batch)).toEqual({
      partnerId: 'firm-a',
      byClient: false,
      fromBatch: true,
    });

    // The owner's case: this one client cleared their own goods, inside a
    // truck we cleared. `false` is an ANSWER and null is silence — mixing
    // them is what would make a client's own clearance invisible.
    expect(effectiveCustoms({ customsPartnerId: null, customsByClient: true }, batch)).toEqual({
      partnerId: null,
      byClient: true,
      fromBatch: false,
    });
    expect(
      effectiveCustoms({ customsPartnerId: 'firm-b', customsByClient: false }, batch),
    ).toEqual({ partnerId: 'firm-b', byClient: false, fromBatch: false });

    // «We clear this one ourselves», said explicitly with no firm named yet:
    // still an ANSWER, and it must not fall back to the truck's firm. This is
    // the case that separates `false` from `null`, and the column allows it
    // even though today's form always names a firm alongside.
    expect(
      effectiveCustoms({ customsPartnerId: null, customsByClient: false }, batch),
    ).toEqual({ partnerId: null, byClient: false, fromBatch: false });

    // A truck with no answer either leaves everything unanswered rather than
    // inventing one.
    expect(effectiveCustoms({ customsPartnerId: null, customsByClient: null }, null)).toEqual({
      partnerId: null,
      byClient: false,
      fromBatch: true,
    });
  });

  it('stores the three states and comes back to "follow the truck"', async () => {
    const partnerId = await newPartner('Rastamojkachi');
    const [receipt] = await db
      .insert(receipts)
      .values({
        number: `RC-${STAMP}`,
        warehouseId,
        status: 'confirmed',
        createdBy: actorId,
      })
      .returning();

    await setReceiptCustoms(receipt!.id, partnerId, ctx());
    let row = (await db.select().from(receipts).where(eq(receipts.id, receipt!.id)))[0]!;
    expect(row.customsPartnerId).toBe(partnerId);
    expect(row.customsByClient).toBe(false);

    await setReceiptCustoms(receipt!.id, 'client', ctx());
    row = (await db.select().from(receipts).where(eq(receipts.id, receipt!.id)))[0]!;
    expect(row.customsPartnerId).toBeNull();
    expect(row.customsByClient).toBe(true);

    // Back to silence — the state a person needs after a wrong answer.
    await setReceiptCustoms(receipt!.id, '', ctx());
    row = (await db.select().from(receipts).where(eq(receipts.id, receipt!.id)))[0]!;
    expect(row.customsPartnerId).toBeNull();
    expect(row.customsByClient).toBeNull();

    await db.delete(receipts).where(eq(receipts.id, receipt!.id));
  });
});

/**
 * The audit round: seven defects the counterparty feature shipped with, each
 * proved here against the database because each of them is a number the owner
 * reads off a screen and acts on.
 */
describe('what the audit found', () => {
  it('voiding the CLIENT half of a settlement takes the firm’s half with it', async () => {
    const clientId = await newClient(`GSV${STAMP}`);
    const partnerId = await newPartner('Uch tomonlama');
    const today = new Date().toISOString().slice(0, 10);

    // We owe the firm $1000; the client owes us $1000.
    await addPartnerTx(
      { partnerId, type: 'charge', amount: 1000, currency: 'USD', txDate: today, accountId: '', batchId: '', note: '' },
      ctx(),
    );
    await addTransaction(
      { clientId, type: 'charge', amount: 1000, currency: 'USD', txDate: today },
      ctx(),
    );
    expect(await partnerBalanceUsd(partnerId)).toBe(1000);
    expect(await clientBalanceUsd(clientId)).toBe(1000);

    // The client pays our supplier instead of us: both debts close.
    const txId = uuidv4();
    await recordSettlement(
      {
        txId,
        clientId,
        partnerId,
        clientAmount: 1000,
        clientCurrency: 'USD',
        partnerAmount: 1000,
        partnerCurrency: 'USD',
        txDate: today,
        note: 'Kvitansiya',
      },
      ctx(),
    );
    expect(await partnerBalanceUsd(partnerId)).toBe(0);
    expect(await clientBalanceUsd(clientId)).toBe(0);

    // Wrong client. Voided from the CLIENT ledger, which is the screen the
    // accountant is on — and the only direction that was not guarded.
    const [offset] = await db
      .select()
      .from(partnerTransactions)
      .where(eq(partnerTransactions.id, txId));
    const clientTxId = offset!.clientTxId!;
    await voidTransaction(clientTxId, 'noto‘g‘ri mijoz', ctx());

    expect(await clientBalanceUsd(clientId)).toBe(1000);
    // Was 0 for ever: our debt to the firm stayed forgiven with nothing
    // standing behind it, and /accounting/balance read $1000 healthier.
    expect(await partnerBalanceUsd(partnerId)).toBe(1000);
    const [after] = await db
      .select()
      .from(partnerTransactions)
      .where(eq(partnerTransactions.id, txId));
    expect(after!.voidedAt).not.toBeNull();
  });

  it('voids an ordinary client payment without touching anybody else', async () => {
    const clientId = await newClient(`GSP${STAMP}`);
    const today = new Date().toISOString().slice(0, 10);
    await addTransaction(
      { clientId, type: 'charge', amount: 500, currency: 'USD', txDate: today },
      ctx(),
    );
    const payment = await addTransaction(
      { clientId, type: 'payment', amount: 500, currency: 'USD', txDate: today },
      ctx(),
    );
    expect(await clientBalanceUsd(clientId)).toBe(0);
    await voidTransaction(payment.id, 'xato summa', ctx());
    expect(await clientBalanceUsd(clientId)).toBe(500);
  });

  it('counts a cash box in any currency the owner has a rate for', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await db.insert(currencies).values({ code: TEST_CCY, name: 'Audit test currency' }).onConflictDoNothing();
    await upsertFxRate({ currency: TEST_CCY, rateToUsd: 0.5, effectiveDate: '2020-01-01' }, ctx());
    // Read AFTER the rate exists: entering a rate is itself a change to this
    // total, and the delta being measured here is the payment, not the rate.
    const before = await companyBalance();

    const account = await saveAccount(
      { name: `Yiwu kassa ${STAMP}`, currency: TEST_CCY, kind: 'cash', openingBalance: 0, sortOrder: 900, active: true },
      ctx(),
    );
    const accountId = account.id;
    madeAccounts.push(accountId);
    const clientId = await newClient(`GSC${STAMP}`);
    await addTransaction(
      { clientId, type: 'payment', amount: 300, currency: TEST_CCY, txDate: today, accountId },
      ctx(),
    );

    const after = await companyBalance();
    const row = after.cashRows.find((r) => r.id === accountId);
    // Was null — every currency but USD and UZS fell out of the total, so a
    // CNY till for Yiwu would have been worth exactly nothing on the screen
    // that says what the company holds.
    expect(row?.balanceUsd).toBe(150);
    // A delta, not an absolute: the seeded tills carry whatever the suites
    // before this one left in them, and only the movement is this test's.
    expect(Math.round((after.cashUsd - before.cashUsd) * 100) / 100).toBe(150);
  });

  it('refuses a cost that names a payer in a currency with no rate, and repairs the old ones', async () => {
    const partnerId = await newPartner('Kursi yo‘q');
    const [type] = await db.select().from(costTypes).where(eq(costTypes.active, true)).limit(1);
    const today = new Date().toISOString().slice(0, 10);
    const [batch] = await db
      .insert(batches)
      .values({
        code: `PF-${STAMP}`,
        originWarehouseId: warehouseId,
        destWarehouseId,
        status: 'forming',
        createdBy: actorId,
      })
      .returning();
    madeBatches.push(batch!.id);
    await db.insert(currencies).values({ code: NO_RATE_CCY, name: 'No rate at all' }).onConflictDoNothing();

    // Naming a payer means recording a debt, and a debt needs a dollar figure.
    await expect(
      addCostEntry(
        {
          scope: 'batch',
          batchId: batch!.id,
          costTypeId: type!.id,
          amount: 100,
          currency: NO_RATE_CCY,
          costDate: today,
          allocationBasis: 'weight',
          partnerId,
        },
        ctx(),
      ),
    ).rejects.toThrow('fx_missing');

    // A row entered before that refusal existed: the cost carries the firm's
    // name, the firm's account has never heard of it.
    const [orphan] = await db
      .insert(costEntries)
      .values({
        scope: 'batch',
        batchId: batch!.id,
        costTypeId: type!.id,
        amount: '100',
        currency: NO_RATE_CCY,
        costDate: today,
        allocationBasis: 'weight',
        partnerId,
        enteredBy: actorId,
      })
      .returning();
    madeCosts.push(orphan!.id);
    expect(await partnerBalanceUsd(partnerId)).toBe(0);

    // The owner enters the rate; /admin/fx recomputes. The debt appears.
    await upsertFxRate({ currency: NO_RATE_CCY, rateToUsd: 0.25, effectiveDate: '2020-01-01' }, ctx());
    await recomputeAll({ currency: NO_RATE_CCY });
    expect(await partnerBalanceUsd(partnerId)).toBe(25);

    // And a second sweep does not post it twice.
    await recomputeAll({ currency: NO_RATE_CCY });
    expect(await partnerBalanceUsd(partnerId)).toBe(25);
  });

  it('does not put a settlement on the accountant’s "place this payment" queue', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const before = await moneyFlowCounts(today);

    const clientId = await newClient(`GSQ${STAMP}`);
    const partnerId = await newPartner('Navbat');
    await addPartnerTx(
      { partnerId, type: 'charge', amount: 200, currency: 'USD', txDate: today, accountId: '', batchId: '', note: '' },
      ctx(),
    );
    await recordSettlement(
      {
        txId: uuidv4(),
        clientId,
        partnerId,
        clientAmount: 200,
        clientCurrency: 'USD',
        partnerAmount: 200,
        partnerCurrency: 'USD',
        txDate: today,
        note: 'Kvitansiya',
      },
      ctx(),
    );
    // No cash box of ours opened and none ever can, so it is not work.
    expect((await moneyFlowCounts(today)).unassignedPayments).toBe(before.unassignedPayments);

    // A genuinely unplaced payment still counts, or the guard is too wide.
    await addTransaction(
      { clientId, type: 'payment', amount: 10, currency: 'USD', txDate: today },
      ctx(),
    );
    expect((await moneyFlowCounts(today)).unassignedPayments).toBe(
      before.unassignedPayments + 1,
    );
  });

  it('keeps the counterparty register and the balance sheet agreeing after a retire', async () => {
    const partnerId = await newPartner('Yashiriladigan');
    const today = new Date().toISOString().slice(0, 10);
    await addPartnerTx(
      { partnerId, type: 'charge', amount: 8000, currency: 'USD', txDate: today, accountId: '', batchId: '', note: '' },
      ctx(),
    );
    await setPartnerActive(partnerId, false, ctx());

    // The register's own expression, read the way the page reads it. Active
    // rows only — which is what shipped — loses the retired firm's $8,000
    // while /accounting/balance goes on counting it.
    const shown = (await listPartners({ includeInactive: true })).filter(
      (row) => row.active || Math.abs(row.balanceUsd) > 0.009,
    );
    const owed = shown.filter((r) => r.balanceUsd > 0).reduce((a, r) => a + r.balanceUsd, 0);
    expect(shown.some((row) => row.id === partnerId)).toBe(true);
    expect(Math.round(owed * 100) / 100).toBe((await companyBalance()).payableUsd);
  });

  it('keeps an account whose TYPE was hidden inside the register', async () => {
    const [type] = await db
      .insert(partnerTypes)
      .values({ code: `zz${STAMP}`, name: `Yashirin tur ${STAMP}`, sortOrder: 990 })
      .returning();
    madeTypes.push(type!.id);
    const id = await savePartner(
      null,
      { name: `Turi yashirin ${STAMP}`, typeId: type!.id, clientId: '', phone: '', note: '' },
      ctx(),
    );
    madePartners.push(id);
    await db.update(partnerTypes).set({ active: false }).where(eq(partnerTypes.id, type!.id));

    // Grouping over the ACTIVE types dropped this row from every section
    // while its debt stayed in the total above them.
    const rows = await listPartners({ includeInactive: true });
    const grouped = groupPartnersByType(rows, await listPartnerTypes(true));
    expect(grouped.flatMap((g) => g.rows).some((row) => row.id === id)).toBe(true);
  });
});

describe('the pair rule holds in BOTH directions', () => {
  it('voiding the derived charge takes the payer off the cost, and the recompute stays quiet', async () => {
    const partnerId = await newPartner('Bekor qilingan qarz');
    const [type] = await db.select().from(costTypes).where(eq(costTypes.active, true)).limit(1);
    const [batch] = await db
      .insert(batches)
      .values({
        code: `PV-${STAMP}`,
        originWarehouseId: warehouseId,
        destWarehouseId,
        status: 'forming',
        createdBy: actorId,
      })
      .returning();
    madeBatches.push(batch!.id);

    const entry = await addCostEntry(
      {
        scope: 'batch',
        batchId: batch!.id,
        costTypeId: type!.id,
        amount: 900,
        currency: 'USD',
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'weight',
        partnerId,
        note: 'Fura — firma keyin rad etdi',
      },
      ctx(),
    );
    madeCosts.push(entry.id);
    expect(await partnerBalanceUsd(partnerId)).toBe(900);

    // The accountant voids the DEBT from the ledger — the firm does not
    // answer for this truck. The cost must stay (it is a P&L fact) but must
    // lose its payer…
    const [charge] = await db
      .select()
      .from(partnerTransactions)
      .where(and(eq(partnerTransactions.costEntryId, entry.id), isNull(partnerTransactions.voidedAt)));
    await voidPartnerTx(charge!.id, 'firma rad etdi', ctx());
    expect(await partnerBalanceUsd(partnerId)).toBe(0);
    const [cost] = await db.select().from(costEntries).where(eq(costEntries.id, entry.id));
    expect(cost!.partnerId).toBeNull();
    expect(cost!.voidedAt).toBeNull();

    // …because otherwise THIS is what resurrected it: any FX save or a batch
    // departure re-runs the recompute, and the recompute re-derives a charge
    // for every partner-named cost. The void must survive the sweep.
    await recomputeAll({ batchId: batch!.id });
    expect(await partnerBalanceUsd(partnerId)).toBe(0);
    const live = await db
      .select()
      .from(partnerTransactions)
      .where(and(eq(partnerTransactions.costEntryId, entry.id), isNull(partnerTransactions.voidedAt)));
    expect(live).toHaveLength(0);
  });

  it('re-pricing the cost re-prices the derived charge — the debt follows its cost', async () => {
    const partnerId = await newPartner('Kurs drift');
    const [type] = await db.select().from(costTypes).where(eq(costTypes.active, true)).limit(1);
    const [batch] = await db
      .insert(batches)
      .values({
        code: `PD-${STAMP}`,
        originWarehouseId: warehouseId,
        destWarehouseId,
        status: 'forming',
        createdBy: actorId,
      })
      .returning();
    madeBatches.push(batch!.id);
    await db.insert(currencies).values({ code: DRIFT_CCY, name: 'Drift test' }).onConflictDoNothing();
    await upsertFxRate({ currency: DRIFT_CCY, rateToUsd: 0.25, effectiveDate: '2020-01-01' }, ctx());

    const entry = await addCostEntry(
      {
        scope: 'batch',
        batchId: batch!.id,
        costTypeId: type!.id,
        amount: 100,
        currency: DRIFT_CCY,
        costDate: new Date().toISOString().slice(0, 10),
        allocationBasis: 'weight',
        partnerId,
      },
      ctx(),
    );
    madeCosts.push(entry.id);
    expect(await partnerBalanceUsd(partnerId)).toBe(25);

    // The rate was typed wrong and corrected. The P&L follows the recompute;
    // the firm's account must not go on holding yesterday's number.
    await upsertFxRate({ currency: DRIFT_CCY, rateToUsd: 0.5, effectiveDate: '2020-01-01' }, ctx());
    await recomputeAll({ currency: DRIFT_CCY });
    const [cost] = await db.select().from(costEntries).where(eq(costEntries.id, entry.id));
    expect(cost!.amountUsd).toBe('50.00');
    expect(await partnerBalanceUsd(partnerId)).toBe(50);
  });
});
