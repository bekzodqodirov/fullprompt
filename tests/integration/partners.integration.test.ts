import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
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
  expenseCategories,
  expenses,
  moneyAccounts,
  partners,
  partnerTransactions,
  partnerTypes,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { addCostEntry, voidCostEntry } from '@/modules/wms/costing/service';
import { addExpense, voidExpense } from '@/modules/wms/accounting/service';
import { clientBalanceUsd } from '@/modules/wms/finance/service';
import {
  addPartnerTx,
  partnerBalanceUsd,
  savePartner,
  voidPartnerTx,
} from '@/modules/wms/partners/service';
import { recordSettlement } from '@/modules/wms/partners/settlement';
import { accountBalances } from '@/modules/wms/accounting/service';
import { cashFlow, companyBalance } from '@/modules/wms/accounting/reports';

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
