import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clientTransactions, clients, moneyAccounts, users } from '@/modules/platform/db/schema';
import {
  addTransaction,
  balancesForClients,
  clientBalances,
  clientBalanceUsd,
  clientTotals,
} from '@/modules/wms/finance/service';
import { accountBalances } from '@/modules/wms/accounting/service';
import { arAging, cashFlow, companyBalance } from '@/modules/wms/accounting/reports';

/**
 * The owner's money answers of 2026-09-24 that live in the ledger:
 * R6a — a refund kind (money handed BACK to a client out of a kassa);
 * R4 (his «o'zing eng to'g'risini qil») — a kassa's opening count is a fact
 * as of its opening date, so an earlier row is not added to it again;
 * R7a — the Balans splits clients' debt from clients' advances.
 *
 * Dates live in 1690 so nothing here lands in a period another file reads.
 */

const STAMP = `${Date.now()}`.slice(-7);
const DAY = '1690-03-10';
let actorId: string;
const madeClients: string[] = [];
const codes = new Map<string, string>();
const madeAccounts: string[] = [];
const ctx = () => ({ actorId });

async function client(tag: string) {
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `MR${tag}${STAMP}`.slice(0, 10), name: `Pul qoidasi ${tag} ${STAMP}` })
    .returning();
  madeClients.push(row!.id);
  codes.set(row!.id, row!.clientCode);
  return row!.id;
}

async function till(name: string, over: Partial<typeof moneyAccounts.$inferInsert> = {}) {
  const [row] = await db
    .insert(moneyAccounts)
    .values({ name: `${name} ${STAMP}`, currency: 'USD', ...over })
    .returning();
  madeAccounts.push(row!.id);
  return row!.id;
}

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1))[0]!.id;
});

afterAll(async () => {
  if (madeClients.length) {
    await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
    await db.delete(clients).where(inArray(clients.id, madeClients));
  }
  if (madeAccounts.length) await db.delete(moneyAccounts).where(inArray(moneyAccounts.id, madeAccounts));
  await pgClient.end();
});

describe('R6a — a refund is money handed back out of a kassa', () => {
  it('names the kassa it left, and never a truck', async () => {
    const clientId = await client('A');
    await expect(
      addTransaction({ clientId, type: 'refund', amount: 5, currency: 'USD', txDate: DAY }, ctx()),
    ).rejects.toMatchObject({ code: 'account_required' });
    // The database says the same to anything that skips the service.
    await expect(
      db.execute(sql`
        INSERT INTO client_transactions (id, client_id, type, amount, currency, rate_to_usd, amount_usd, tx_date, created_by)
        VALUES (gen_random_uuid(), ${clientId}, 'refund', 5, 'USD', 1, 5, ${DAY}::date, ${actorId})
      `),
    ).rejects.toThrow(/client_transactions_refund_check/);
  });

  it('RAISES what the client owes, lowers the kassa, and is neither revenue nor a payment', async () => {
    const clientId = await client('B');
    const box = await till('R6 kassa');
    await addTransaction({ clientId, type: 'charge', amount: 100, currency: 'USD', txDate: DAY }, ctx());
    await addTransaction(
      { clientId, type: 'payment', amount: 150, currency: 'USD', txDate: DAY, accountId: box },
      ctx(),
    );
    // Overpaid by 50: an advance.
    expect(await clientBalanceUsd(clientId)).toBe(-50);
    const refund = await addTransaction(
      { clientId, type: 'refund', amount: 50, currency: 'USD', txDate: DAY, accountId: box, method: 'cash' },
      ctx(),
    );
    expect(refund.method).toBe('cash');

    // Every balance agrees: settled.
    expect(await clientBalanceUsd(clientId)).toBe(0);
    expect((await balancesForClients([clientId])).get(clientId)?.balanceUsd).toBe(0);
    const row = (await clientBalances()).find((r) => r.clientId === clientId)!;
    expect(row).toMatchObject({ chargesUsd: 100, paymentsUsd: 100, refundsUsd: 50, balanceUsd: 0 });
    // The AI's one money view restates the same rule (0101 replaced it).
    const [view] = (await db.execute<{ balance_usd: string }>(
      sql`SELECT balance_usd FROM v_client_balance_usd WHERE client_id = ${clientId}`,
    )) as unknown as { balance_usd: string }[];
    expect(Number(view!.balance_usd)).toBe(0);

    // The kassa: +150 in, −50 back out, and the row still adds up.
    const kassa = (await accountBalances()).find((r) => r.id === box)!;
    expect(kassa.refundedOut).toBe(50);
    expect(kassa.balance).toBe(100);
    const shownIn = kassa.paidIn + kassa.transferredIn + kassa.partnerIn;
    const shownOut = kassa.spent + kassa.transferredOut + kassa.partnerOut + kassa.refundedOut;
    expect(kassa.opening + shownIn - shownOut).toBe(kassa.balance);

    // The cash flow names it as money OUT; the P&L never sees it as revenue.
    const flow = await cashFlow(DAY, DAY);
    expect(flow.rows.find((r) => r.label === 'clientRefunds')?.amountUsd).toBeGreaterThanOrEqual(50);
  });

  it('a refund to a client who owed nothing ages as a debt from its own day', async () => {
    const clientId = await client('C');
    const box = await till('R6 aging');
    await addTransaction({ clientId, type: 'refund', amount: 30, currency: 'USD', txDate: DAY, accountId: box }, ctx());
    const aging = await arAging(DAY);
    const mine = aging.find((r) => r.clientCode === codes.get(clientId));
    expect(mine?.balance).toBe(30);
  });
});

describe('R4 — the opening count is a fact as of its date', () => {
  it('a row dated before the opening date is inside the count and not added again', async () => {
    const box = await till('R4 kassa', { openingBalance: '1000', openingDate: '1690-04-01' });
    const clientId = await client('D');
    // Back-entered to catch the client's ledger up: it is on the ledger, and
    // it was already in the drawer the day the 1000 was counted.
    await addTransaction(
      { clientId, type: 'payment', amount: 200, currency: 'USD', txDate: '1690-03-20', accountId: box },
      ctx(),
    );
    let kassa = (await accountBalances()).find((r) => r.id === box)!;
    expect(kassa.balance).toBe(1000);
    expect(kassa.beforeOpening).toBe(1);
    expect(await clientBalanceUsd(clientId)).toBe(-200);

    // On or after the opening date it counts as it always did.
    await addTransaction(
      { clientId, type: 'payment', amount: 50, currency: 'USD', txDate: '1690-04-01', accountId: box },
      ctx(),
    );
    kassa = (await accountBalances()).find((r) => r.id === box)!;
    expect(kassa.balance).toBe(1050);
  });

  it('a kassa with no opening date counts every row, exactly as before', async () => {
    const box = await till('R4 no date', { openingBalance: '10' });
    const clientId = await client('E');
    await addTransaction(
      { clientId, type: 'payment', amount: 5, currency: 'USD', txDate: '1690-01-02', accountId: box },
      ctx(),
    );
    const kassa = (await accountBalances()).find((r) => r.id === box)!;
    expect(kassa.balance).toBe(15);
    expect(kassa.beforeOpening).toBe(0);
  });
});

describe('R7a — the Balans splits debtors from advances', () => {
  it('a debtor raises «qarz», a prepaid client raises «avans», and the net moves by the debt alone', async () => {
    const before = await companyBalance();
    const debtor = await client('F');
    const prepaid = await client('G');
    const box = await till('R7 kassa');
    await addTransaction({ clientId: debtor, type: 'charge', amount: 100, currency: 'USD', txDate: DAY }, ctx());
    await addTransaction(
      { clientId: prepaid, type: 'payment', amount: 40, currency: 'USD', txDate: DAY, accountId: box },
      ctx(),
    );
    const after = await companyBalance();
    expect(Math.round((after.receivableUsd - before.receivableUsd) * 100) / 100).toBe(100);
    expect(Math.round((after.clientAdvancesUsd - before.clientAdvancesUsd) * 100) / 100).toBe(40);
    // +40 cash, +100 owed, −40 owed back in service.
    expect(Math.round((after.netUsd - before.netUsd) * 100) / 100).toBe(100);
  });

  it('both client lines on the Balans are the /finance page\'s own two totals, to the cent (U15)', async () => {
    // The page calls `clientTotals` over `clientBalances` and so does the
    // Balans: the test calls the same function rather than restating the
    // page's arithmetic (#166), and the advances half — the Balans line that
    // links to /finance — is checked where it is printed.
    const balance = await companyBalance();
    const page = clientTotals(await clientBalances());
    expect(balance.receivableUsd).toBe(page.receivable);
    expect(balance.clientAdvancesUsd).toBe(page.advances);
    expect(page.advances).toBeGreaterThan(0);
  });

  it('clientTotals puts debtors in one total and advances, as positive money, in the other', () => {
    expect(clientTotals([{ balanceUsd: 100 }, { balanceUsd: -40 }, { balanceUsd: 0 }, { balanceUsd: -0.004 }])).toEqual({
      receivable: 100,
      advances: 40,
    });
  });
});
