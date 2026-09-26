import 'dotenv/config';
import { eq, inArray, sql, TransactionRollbackError } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  currencies,
  expenseCategories,
  expenses,
  moneyAccounts,
  partnerTransactions,
  partnerTypes,
  recurringExpenses,
  users,
} from '@/modules/platform/db/schema';
import { addDays, tashkentDay } from '@/modules/platform/time/tashkent';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { rateFor } from '@/modules/wms/costing/service';
import {
  accountBalances,
  addExpense,
  saveAccount,
  saveCategory,
  saveRecurring,
  updateRecurring,
  voidExpense,
} from '@/modules/wms/accounting/service';
import {
  advancePostedRecurring,
  linkRecurringPayment,
  payRecurring,
  recurringArrears,
  recurringDue,
  recurringDueCount,
  skipRecurring,
  unskipRecurring,
} from '@/modules/wms/accounting/recurring';
import { companyBalance } from '@/modules/wms/accounting/reports';
import { moneyFlowCounts } from '@/modules/wms/home/role-flows';
import { partnerBalanceUsd, savePartner, setPartnerActive, voidPartnerTx } from '@/modules/wms/partners/service';

/**
 * A recurring expense is paid when the kassa holder actually pays (owner's
 * Q6, 0106): nothing leaves a kassa by itself, «To'landi» writes what
 * happened on the day it happened, «Bog'lash» attaches a payment typed some
 * other way, «Bu oy yo'q» closes a month in words.
 *
 * On the REAL Tashkent calendar, never a private year: a template's window
 * runs from its `due_from` through next month, and a window reaching into
 * the 1700s would be centuries of open months, all counted company-wide.
 * So every assertion is a DELTA, every template is this file's own (its own
 * kind of expense, so one test's hand-typed row is never another's
 * candidate), and everything is removed in FK order at the end — an open
 * occurrence is configuration every counter reads (#183). Dates are chosen
 * so a proof cannot go green by calendar accident (G8).
 */

const SUFFIX = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const TODAY = tashkentDay();
const MONTH = TODAY.slice(0, 7);
const MONTH_START = `${MONTH}-01`;
function monthShift(month: string, by: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + by;
  const year = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${year}-${String(mm + 1).padStart(2, '0')}`;
}
const LAST = monthShift(MONTH, -1);
const NEXT = monthShift(MONTH, 1);

let actorId: string;
const ctx = () => ({ actorId });
let usdTill: string;
let uzsTill: string;
let firm: string;
let uzsRate: number;
let noRateCurrency: string;
const templates: string[] = [];
const handTyped: string[] = [];
const kinds: { id: string; name: string; cash: boolean }[] = [];
const tills: { id: string; name: string; currency: string }[] = [];

async function kind(label: string, cash = true): Promise<string> {
  const name = `Rec ${label} ${SUFFIX}`;
  const row = await saveCategory({ name, cash, sortOrder: 950, active: true }, ctx());
  kinds.push({ id: row.id, name, cash });
  return row.id;
}

async function till(label: string, currency: string): Promise<string> {
  const name = `Rec kassa ${label} ${SUFFIX}`;
  const row = await saveAccount(
    { name, currency, kind: 'cash', openingBalance: 0, openingDate: '', sortOrder: 950, active: true },
    ctx(),
  );
  tills.push({ id: row.id, name, currency });
  return row.id;
}

async function template(
  over: Partial<Parameters<typeof saveRecurring>[0]> & { categoryId: string; dayOfMonth: number },
  dueFrom?: string,
) {
  const row = await saveRecurring(
    { amount: 900, currency: 'USD', accountId: usdTill, active: true, ...over },
    ctx(),
  );
  templates.push(row.id);
  if (dueFrom) await db.update(recurringExpenses).set({ dueFrom }).where(eq(recurringExpenses.id, row.id));
  return row;
}

async function balanceOf(accountId: string): Promise<number> {
  return (await accountBalances()).find((row) => row.id === accountId)!.balance;
}

async function listed(recurringId: string, today = TODAY) {
  return (await recurringDue(today)).filter((row) => row.recurringId === recurringId);
}

async function postings(recurringId: string, live = true) {
  const rows = await db.select().from(expenses).where(eq(expenses.recurringId, recurringId));
  return live ? rows.filter((row) => row.voidedAt === null) : rows;
}

const pay = (
  recurringId: string,
  over: Partial<Parameters<typeof payRecurring>[0]> = {},
) =>
  payRecurring(
    { recurringId, month: MONTH, payer: `till:${usdTill}`, amount: 900, expenseDate: TODAY, ...over },
    ctx(),
  );

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  usdTill = await till('usd', 'USD');
  uzsTill = await till('uzs', 'UZS');
  const [type] = await db.select().from(partnerTypes).limit(1);
  firm = await savePartner(null, { name: `Rec firma ${SUFFIX}`, typeId: type!.id }, ctx());
  // The so'm rate the app will use today — read, never inserted: a dated
  // rate row would reprice every other file's so'm arithmetic (#824).
  uzsRate = (await rateFor('UZS', TODAY))!;
  expect(uzsRate).toBeGreaterThan(0);
  // A currency nobody has ever rated (U14's «named, never $0»), this file's own.
  noRateCurrency = `Q${SUFFIX.slice(-2).toUpperCase().replace(/[^A-Z]/g, 'X')}`;
  await db.insert(currencies).values({ code: noRateCurrency, name: 'Rec test' }).onConflictDoNothing();
});

afterAll(async () => {
  try {
    if (actorId) {
      const ids = templates.length > 0 ? templates : ['00000000-0000-0000-0000-000000000000'];
      const exp = await db
        .select({ id: expenses.id })
        .from(expenses)
        .where(inArray(expenses.recurringId, ids));
      const all = [...exp.map((row) => row.id), ...handTyped];
      if (all.length > 0) {
        await db.delete(partnerTransactions).where(inArray(partnerTransactions.expenseId, all));
        await db.delete(expenses).where(inArray(expenses.id, all));
      }
      if (templates.length > 0) {
        await db.execute(sql`DELETE FROM recurring_skips WHERE recurring_id IN (${sql.join(
          templates.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`);
        await db.delete(recurringExpenses).where(inArray(recurringExpenses.id, templates));
      }
      // A kassa and a kind are CONFIGURATION while they exist (#183), retired
      // or not: a leftover so'm till is the next file's unordered `limit(1)`
      // (partners.integration paid dollars out of this one and was refused).
      // Anything still written on this file's own tills and kinds is this
      // file's by construction, so it goes first; then the rows themselves.
      // Retired only if something the sweep does not know still points at them.
      const tillIds = tills.map((row) => row.id);
      const kindIds = kinds.map((row) => row.id);
      const stray = [
        ...(tillIds.length > 0
          ? await db.select({ id: expenses.id }).from(expenses).where(inArray(expenses.accountId, tillIds))
          : []),
        ...(kindIds.length > 0
          ? await db.select({ id: expenses.id }).from(expenses).where(inArray(expenses.categoryId, kindIds))
          : []),
      ].map((row) => row.id);
      if (stray.length > 0) {
        await db.delete(partnerTransactions).where(inArray(partnerTransactions.expenseId, stray));
        await db.delete(expenses).where(inArray(expenses.id, stray));
      }
      if (kindIds.length > 0) await db.delete(recurringExpenses).where(inArray(recurringExpenses.categoryId, kindIds));
      for (const row of tills) {
        await db
          .delete(moneyAccounts)
          .where(eq(moneyAccounts.id, row.id))
          .catch(() =>
            saveAccount(
              { name: row.name, currency: row.currency, kind: 'cash', openingBalance: 0, openingDate: '', sortOrder: 950, active: false, id: row.id },
              ctx(),
            ),
          )
          .catch(() => undefined);
      }
      for (const row of kinds) {
        await db
          .delete(expenseCategories)
          .where(eq(expenseCategories.id, row.id))
          .catch(() => saveCategory({ id: row.id, name: row.name, cash: row.cash, sortOrder: 950, active: false }, ctx()))
          .catch(() => undefined);
      }
      if (firm) await setPartnerActive(firm, false, ctx()).catch(() => undefined);
      if (noRateCurrency) await db.delete(currencies).where(eq(currencies.code, noRateCurrency)).catch(() => undefined);
    }
  } finally {
    await pgClient.end();
  }
});

describe("«To'landi» — money leaves a kassa only when a person says it did", () => {
  it('R1: a new active template is listed, moves no kassa and writes nothing by itself', async () => {
    const t = await template({ categoryId: await kind('r1'), dayOfMonth: 1 });
    const before = await balanceOf(usdTill);
    expect(await listed(t.id)).toHaveLength(2); // this month and next
    expect(await postings(t.id, false)).toHaveLength(0);
    expect(await balanceOf(usdTill)).toBe(before);
  });

  it('R2: writes one expense out of the chosen kassa, with the TYPED date and the month it answers, and one audit row', async () => {
    const yesterday = addDays(TODAY, -1);
    // Never yesterday's own day, so dating on the occurrence could not pass.
    const day = (Number(yesterday.slice(8)) % 28) + 1;
    const t = await template({ categoryId: await kind('r2'), dayOfMonth: day, amount: 640 });
    const before = await balanceOf(usdTill);
    const row = await pay(t.id, { amount: 640, expenseDate: yesterday, partial: false });
    expect(row.expenseDate).toBe(yesterday);
    expect(row.recurringId).toBe(t.id);
    expect(row.recurringMonth).toBe(MONTH_START);
    expect(row.accountId).toBe(usdTill);
    expect(await balanceOf(usdTill)).toBeCloseTo(before - 640, 2);
    expect((await listed(t.id)).some((r) => r.month === MONTH_START)).toBe(false);
    const audit = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE entity_type = 'expense' AND entity_id = ${row.id}::uuid AND action = 'create'
         AND after->>'recurringId' = ${t.id} AND after->>'recurringMonth' = ${MONTH_START}`);
    expect(audit[0]!.n).toBe(1);
  });

  it('R3: a date after tomorrow is refused, nothing written and no kassa moved; tomorrow itself is accepted (U21)', async () => {
    const t = await template({ categoryId: await kind('r3'), dayOfMonth: 1, amount: 10 });
    const before = await balanceOf(usdTill);
    await expect(pay(t.id, { amount: 10, expenseDate: addDays(latestTxDate(), 1) })).rejects.toMatchObject({
      code: 'future_date',
    });
    expect(await postings(t.id, false)).toHaveLength(0);
    expect(await balanceOf(usdTill)).toBe(before);
    const ok = await pay(t.id, { amount: 10, expenseDate: latestTxDate() });
    expect(ok.expenseDate).toBe(latestTxDate());
  });

  it('R4: the currency follows the kassa — a USD salary out of the so’m kassa is written in so’m', async () => {
    const t = await template({ categoryId: await kind('r4'), dayOfMonth: 1, amount: 700 });
    const usdBefore = await balanceOf(usdTill);
    const uzsBefore = await balanceOf(uzsTill);
    const row = await pay(t.id, { payer: `till:${uzsTill}`, amount: 8_900_000, currency: 'USD', partial: false });
    expect(row.currency).toBe('UZS');
    expect(await balanceOf(uzsTill)).toBeCloseTo(uzsBefore - 8_900_000, 2);
    expect(await balanceOf(usdTill)).toBe(usdBefore);
  });

  it('R5: a second final press on a closed month is refused in words; one live posting remains', async () => {
    const t = await template({ categoryId: await kind('r5'), dayOfMonth: 1, amount: 50 });
    await pay(t.id, { amount: 50 });
    await expect(pay(t.id, { amount: 50 })).rejects.toMatchObject({ code: 'recurring_already_paid' });
    expect(await postings(t.id)).toHaveLength(1);
  });

  it('R6: the template lock — a press that waits on it sees the other writer’s payment and refuses', async () => {
    const t = await template({ categoryId: await kind('r6'), dayOfMonth: 1, amount: 60 });
    const helper = postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
      max: 1,
      onnotice: () => {},
    });
    const held = await helper.reserve();
    try {
      await held`BEGIN`;
      await held`SELECT id FROM recurring_expenses WHERE id = ${t.id}::uuid FOR UPDATE`;
      const running = pay(t.id, { amount: 60 });
      const outcome = running.then(
        () => 'resolved',
        (err: { code?: string }) => err.code ?? 'rejected',
      );
      let waiting = false;
      // Observed through the POOL: pg_stat_activity freezes inside an open
      // transaction, so the holder cannot watch for the waiter itself.
      for (let i = 0; i < 250 && !waiting; i += 1) {
        const rows = await db.execute<{ pid: number }>(sql`
          SELECT pid FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND query ILIKE '%recurring_expenses%' AND pid <> pg_backend_pid()`);
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting, 'the press never waited on the template lock').toBe(true);
      // The other writer lands a final payment for the same month and commits.
      await held`INSERT INTO expenses (id, category_id, amount, currency, rate_to_usd, amount_usd, expense_date,
                   account_id, recurring_id, recurring_month, created_by)
                 VALUES (gen_random_uuid(), ${t.categoryId}::uuid, 60, 'USD', 1, 60, ${TODAY}::date,
                   ${usdTill}::uuid, ${t.id}::uuid, ${MONTH_START}::date, ${actorId}::uuid)`;
      await held`COMMIT`;
      expect(await outcome).toBe('recurring_already_paid');
    } finally {
      held.release();
      await helper.end();
    }
    const live = (await postings(t.id)).filter((row) => !row.recurringPartial);
    expect(live).toHaveLength(1);
  });

  it('R7: a short payment closes the month only when the person says so (O3)', async () => {
    const first = await template({ categoryId: await kind('r7a'), dayOfMonth: 1, amount: 900 });
    const counter = await recurringDueCount(TODAY);
    await pay(first.id, { amount: 500, partial: true });
    const row = (await listed(first.id)).find((r) => r.month === MONTH_START)!;
    expect(row.paidParts.map((p) => [p.amount, p.currency])).toEqual([[500, 'USD']]);
    expect(await recurringDueCount(TODAY)).toBe(counter);
    // 400 IS the remainder: the amount alone closes it.
    await pay(first.id, { amount: 400 });
    expect((await listed(first.id)).some((r) => r.month === MONTH_START)).toBe(false);

    const second = await template({ categoryId: await kind('r7b'), dayOfMonth: 1, amount: 900 });
    await expect(pay(second.id, { amount: 500 })).rejects.toMatchObject({ code: 'recurring_partial_unclear' });
    expect(await postings(second.id, false)).toHaveLength(0);

    const third = await template({ categoryId: await kind('r7c'), dayOfMonth: 1, amount: 900 });
    await pay(third.id, { amount: 500, partial: false });
    expect((await listed(third.id)).some((r) => r.month === MONTH_START)).toBe(false);
  });

  it("R8: «Bu oy yo'q» closes a month in words, with no money; «Qaytarish» re-lists it; allowed over a part payment", async () => {
    const t = await template({ categoryId: await kind('r8'), dayOfMonth: 1, amount: 300 });
    const before = await balanceOf(usdTill);
    await expect(skipRecurring({ recurringId: t.id, month: MONTH, reason: '   ' }, ctx())).rejects.toMatchObject({
      code: 'reason_required',
    });
    const skip = await skipRecurring({ recurringId: t.id, month: MONTH, reason: 'ishdan ketdi' }, ctx());
    expect((await listed(t.id)).some((r) => r.month === MONTH_START)).toBe(false);
    expect(await postings(t.id, false)).toHaveLength(0);
    expect(await balanceOf(usdTill)).toBe(before);
    await expect(pay(t.id, { amount: 300 })).rejects.toMatchObject({ code: 'recurring_skipped' });
    await unskipRecurring(skip.id, ctx());
    expect((await listed(t.id)).some((r) => r.month === MONTH_START)).toBe(true);
    // Over a part payment it means «the rest will not be paid».
    await pay(t.id, { amount: 100, partial: true });
    await skipRecurring({ recurringId: t.id, month: MONTH, reason: 'qolgani to‘lanmaydi' }, ctx());
    expect((await listed(t.id)).some((r) => r.month === MONTH_START)).toBe(false);
  });

  it("R9: a voided «To'landi» re-opens its month and a new press posts (Q6 reverses #999's voided half)", async () => {
    const t = await template({ categoryId: await kind('r9'), dayOfMonth: 1, amount: 120 });
    const before = await balanceOf(usdTill);
    const row = await pay(t.id, { amount: 120 });
    await voidExpense(row.id, 'xato kassa', ctx());
    expect(await balanceOf(usdTill)).toBe(before);
    expect((await listed(t.id)).some((r) => r.month === MONTH_START)).toBe(true);
    await pay(t.id, { amount: 120 });
    expect(await postings(t.id)).toHaveLength(1);
  });

  it("R10: a firm-paid template owes the firm nothing until the press, then exactly the payment, in the press's own transaction", async () => {
    const t = await template({ categoryId: await kind('r10'), dayOfMonth: 1, amount: 1200, partnerId: firm });
    const usdBefore = await balanceOf(usdTill);
    const firmBefore = await partnerBalanceUsd(firm);
    const row = await pay(t.id, { payer: `partner:${firm}`, amount: 1200 });
    expect(row.partnerId).toBe(firm);
    expect(row.accountId).toBeNull();
    // Already true when the press returns — no post-commit step (M7).
    expect(await partnerBalanceUsd(firm)).toBeCloseTo(firmBefore + 1200, 2);
    expect(await balanceOf(usdTill)).toBe(usdBefore);
    await voidExpense(row.id, 'sinov', ctx());
    expect(await partnerBalanceUsd(firm)).toBeCloseTo(firmBefore, 2);
  });
});

describe('one predicate for the counter, the list, the money and the stop guard (#513)', () => {
  it('R11: with a synthetic mid-month day, the counter, the list’s due rows and the arrears count agree; upcoming and next month are listed, never counted', async () => {
    const synthetic = `${MONTH}-15`;
    const before = {
      count: await recurringDueCount(synthetic),
      listed: (await recurringDue(synthetic)).filter((row) => row.dueNow).length,
      arrears: (await recurringArrears(synthetic)).count,
    };
    const a = await template({ categoryId: await kind('r11a'), dayOfMonth: 20 }, MONTH_START);
    const b = await template({ categoryId: await kind('r11b'), dayOfMonth: 5 }, MONTH_START);
    const c = await template({ categoryId: await kind('r11c'), dayOfMonth: 25 }, `${LAST}-01`);
    const d = await template({ categoryId: await kind('r11d'), dayOfMonth: 5, firstMonth: 'next' });
    expect(await recurringDueCount(synthetic)).toBe(before.count + 2);
    const list = await recurringDue(synthetic);
    expect(list.filter((row) => row.dueNow).length).toBe(before.listed + 2);
    expect((await recurringArrears(synthetic)).count).toBe(before.arrears + 2);
    const mine = (id: string) => list.filter((row) => row.recurringId === id);
    expect(mine(a.id).map((row) => [row.month, row.dueNow])).toEqual([
      [MONTH_START, false],
      [`${NEXT}-01`, false],
    ]);
    expect(mine(b.id).find((row) => row.month === MONTH_START)?.dueNow).toBe(true);
    expect(mine(c.id).find((row) => row.month === `${LAST}-01`)?.overdue).toBe(true);
    expect(mine(d.id).map((row) => [row.month, row.nextMonth])).toEqual([[`${NEXT}-01`, true]]);
    // The accountant's home asks the same function with the same day.
    expect((await moneyFlowCounts(TODAY)).recurringDue).toBe(await recurringDueCount(TODAY));
  });

  it('R12: the MONTH is the key — moving the day of a paid template does not make the month due again (T7)', async () => {
    const t = await template({ categoryId: await kind('r12'), dayOfMonth: 2, amount: 40 });
    await pay(t.id, { amount: 40 });
    // Never today's own day: keyed on the date, the proof could not go red.
    const moved = (Number(TODAY.slice(8)) % 28) + 1;
    await updateRecurring(t.id, { amount: 40, dayOfMonth: moved, active: true }, ctx());
    expect((await listed(t.id)).some((r) => r.month === MONTH_START)).toBe(false);
  });

  it('R13: a reactivated template starts at today’s month — the stopped months are not owed', async () => {
    const t = await template({ categoryId: await kind('r13'), dayOfMonth: 28, amount: 40, firstMonth: 'next' });
    await updateRecurring(t.id, { amount: 40, dayOfMonth: 28, active: false }, ctx());
    await db.update(recurringExpenses).set({ dueFrom: `${LAST}-01` }).where(eq(recurringExpenses.id, t.id));
    await updateRecurring(t.id, { amount: 40, dayOfMonth: 28, active: true }, ctx());
    const months = (await listed(t.id)).map((row) => row.month);
    expect(months).toEqual([MONTH_START, `${NEXT}-01`]);
  });

  it('R14: the stop guard is the counter’s own clause — a due item blocks the stop; a skip clears it; an upcoming-only template stops', async () => {
    const p = await template({ categoryId: await kind('r14p'), dayOfMonth: 1, amount: 40 });
    await expect(updateRecurring(p.id, { amount: 40, dayOfMonth: 1, active: false }, ctx())).rejects.toMatchObject({
      code: 'recurring_has_arrears',
    });
    expect((await listed(p.id)).some((r) => r.month === MONTH_START && r.dueNow)).toBe(true);
    await skipRecurring({ recurringId: p.id, month: MONTH, reason: 'shartnoma tugadi' }, ctx());
    await updateRecurring(p.id, { amount: 40, dayOfMonth: 1, active: false }, ctx());

    // Nor does a reshaping EDIT take the owed month off (review): the day
    // moved past today, the amount or the currency changed — each refused
    // while a month whose day has come is open, and the month still owed.
    const r = await template({ categoryId: await kind('r14r'), dayOfMonth: 1, amount: 40 });
    for (const patch of [
      { amount: 40, dayOfMonth: 28, active: true },
      { amount: 55, dayOfMonth: 1, active: true },
    ]) {
      await expect(updateRecurring(r.id, patch, ctx())).rejects.toMatchObject({ code: 'recurring_has_arrears_edit' });
    }
    expect((await listed(r.id)).some((row) => row.month === MONTH_START && row.dueNow)).toBe(true);
    await expect(updateRecurring(r.id, { amount: 40, dayOfMonth: 1, active: false }, ctx())).rejects.toMatchObject({
      code: 'recurring_has_arrears',
    });
    // Closed, the same edits go through.
    await skipRecurring({ recurringId: r.id, month: MONTH, reason: 'shartnoma o‘zgardi' }, ctx());
    await updateRecurring(r.id, { amount: 55, dayOfMonth: 28, active: true }, ctx());

    const q = await template({ categoryId: await kind('r14q'), dayOfMonth: 1, amount: 40, firstMonth: 'next' });
    await updateRecurring(q.id, { amount: 40, dayOfMonth: 1, active: false }, ctx());
    expect(await listed(q.id)).toHaveLength(0);
  });

  it('R23: arrears are MONEY — cash months at today’s rate less their parts, book entries counted and not subtracted, an unrated currency named', async () => {
    const before = await recurringArrears(TODAY);
    const netBefore = (await companyBalance()).netUsd;
    const a = await template({ categoryId: await kind('r23a'), dayOfMonth: 1, amount: 800 });
    await template({ categoryId: await kind('r23b'), dayOfMonth: 1, amount: 1_300_000, currency: 'UZS', accountId: uzsTill });
    await template({ categoryId: await kind('r23c', false), dayOfMonth: 1, amount: 50, accountId: '' });
    const expected = 800 + Math.round(1_300_000 * uzsRate * 100) / 100;
    const mid = await recurringArrears(TODAY);
    expect(mid.count - before.count).toBe(3);
    expect(mid.cashCount - before.cashCount).toBe(2);
    expect(mid.usd - before.usd).toBeCloseTo(expected, 2);
    // Sof holat falls by exactly what is owed.
    expect((await companyBalance()).netUsd).toBeCloseTo(netBefore - expected, 2);
    // A part payment moves money from «owed» to «gone»: the net does not move.
    await pay(a.id, { amount: 300, partial: true });
    const after = await recurringArrears(TODAY);
    expect(after.usd - before.usd).toBeCloseTo(expected - 300, 2);
    expect((await companyBalance()).netUsd).toBeCloseTo(netBefore - expected, 2);
    // A currency nobody has rated is named in its own money, never $0.
    const nr = await template({ categoryId: await kind('r23d'), dayOfMonth: 1, amount: 77, currency: noRateCurrency, accountId: '' });
    const named = await recurringArrears(TODAY);
    expect(named.usd).toBeCloseTo(after.usd, 2);
    expect(named.unrated.find((row) => row.currency === noRateCurrency)).toMatchObject({ amount: 77, count: 1 });
    expect(nr.currency).toBe(noRateCurrency);
  });
});

describe('the doors refuse in words', () => {
  it('R15: a cash kind names where the money went; a book entry names nothing; a closed kassa or firm is refused', async () => {
    const t = await template({ categoryId: await kind('r15'), dayOfMonth: 1, amount: 30 });
    await expect(pay(t.id, { payer: '', amount: 30 })).rejects.toMatchObject({ code: 'account_or_payer_required' });
    expect(await postings(t.id, false)).toHaveLength(0);
    const book = await template({ categoryId: await kind('r15b', false), dayOfMonth: 1, amount: 30, accountId: '' });
    await expect(pay(book.id, { amount: 30 })).rejects.toMatchObject({ code: 'non_cash_category' });
    const closed = await till('closed', 'USD');
    await saveAccount(
      { name: tills.at(-1)!.name, currency: 'USD', kind: 'cash', openingBalance: 0, openingDate: '', sortOrder: 950, active: false, id: closed },
      ctx(),
    );
    await expect(pay(t.id, { payer: `till:${closed}`, amount: 30 })).rejects.toMatchObject({ code: 'account_not_found' });
    const [type] = await db.select().from(partnerTypes).limit(1);
    const gone = await savePartner(null, { name: `Rec yopiq firma ${SUFFIX}`, typeId: type!.id }, ctx());
    await setPartnerActive(gone, false, ctx());
    await expect(pay(t.id, { payer: `partner:${gone}`, amount: 30 })).rejects.toMatchObject({ code: 'partner_not_found' });
  });

  it('R16: month + 2, a month before due_from with nothing on it, and a stopped template’s empty month are not open; next month is payable today and counts nowhere', async () => {
    const t = await template({ categoryId: await kind('r16'), dayOfMonth: 1, amount: 30 });
    await expect(pay(t.id, { month: monthShift(MONTH, 2), amount: 30 })).rejects.toMatchObject({ code: 'recurring_not_due' });
    await expect(pay(t.id, { month: LAST, amount: 30 })).rejects.toMatchObject({ code: 'recurring_not_due' });
    const counter = await recurringDueCount(TODAY);
    const advance = await pay(t.id, { month: NEXT, amount: 30 });
    expect(advance.recurringMonth).toBe(`${NEXT}-01`);
    expect(advance.expenseDate).toBe(TODAY);
    expect(await recurringDueCount(TODAY)).toBe(counter);
    const stopped = await template({ categoryId: await kind('r16s'), dayOfMonth: 28, amount: 30, firstMonth: 'next' });
    await updateRecurring(stopped.id, { amount: 30, dayOfMonth: 28, active: false }, ctx());
    await expect(pay(stopped.id, { month: NEXT, amount: 30 })).rejects.toMatchObject({ code: 'recurring_not_due' });
  });

  it("R20: with a hand-typed candidate on the row, «To'landi» refuses to pay twice unless the person says it is another payment (M1)", async () => {
    const category = await kind('r20');
    const t = await template({ categoryId: category, dayOfMonth: 1, amount: 90 });
    const typed = await addExpense({ categoryId: category, amount: 90, currency: 'USD', expenseDate: TODAY, accountId: usdTill }, ctx());
    handTyped.push(typed.id);
    await expect(pay(t.id, { amount: 90 })).rejects.toMatchObject({ code: 'recurring_candidate_exists' });
    expect(await postings(t.id, false)).toHaveLength(0);
    await pay(t.id, { amount: 90, confirmNew: true });
    expect(await postings(t.id)).toHaveLength(1);
  });

  it('R26: the same part payment pressed twice within two minutes is written once — a real second instalment later is not refused (M10)', async () => {
    const t = await template({ categoryId: await kind('r26'), dayOfMonth: 1, amount: 900 });
    const first = await pay(t.id, { amount: 200, partial: true });
    await expect(pay(t.id, { amount: 200, partial: true })).rejects.toMatchObject({ code: 'recurring_duplicate_press' });
    expect((await postings(t.id)).filter((row) => row.recurringPartial)).toHaveLength(1);
    // The design's red proof for this one (drop the two-minute clause) could
    // never go red — removing a clause that NARROWS a refusal only widens it
    // (#166). The clause's own proof: the same 200 paid again once the first
    // is five minutes old is an ordinary second instalment, and is written.
    await db.execute(sql`UPDATE expenses SET created_at = now() - interval '5 minutes' WHERE id = ${first.id}::uuid`);
    await pay(t.id, { amount: 200, partial: true });
    expect((await postings(t.id)).filter((row) => row.recurringPartial)).toHaveLength(2);
  });

  it('bad_month: postgres would read «2031-3» as March — the door asks the shape itself', async () => {
    const t = await template({ categoryId: await kind('bad'), dayOfMonth: 1, amount: 5 });
    await expect(pay(t.id, { month: '2031-3', amount: 5 })).rejects.toMatchObject({ code: 'bad_month' });
    await expect(pay(t.id, { month: '2031-13', amount: 5 })).rejects.toMatchObject({ code: 'bad_month' });
  });
});

describe("«Bog'lash» and the union — what a void puts back", () => {
  it("R19: a hand-typed payment of the kind is offered as a candidate; «Bog'lash» closes the month without moving a cent; a void re-opens it", async () => {
    const category = await kind('r19');
    const other = await kind('r19x');
    const t = await template({ categoryId: category, dayOfMonth: 1, amount: 700 });
    const typed = await addExpense(
      { categoryId: category, amount: 8_900_000, currency: 'UZS', expenseDate: TODAY, accountId: uzsTill },
      ctx(),
    );
    const foreign = await addExpense({ categoryId: other, amount: 5, currency: 'USD', expenseDate: TODAY, accountId: usdTill }, ctx());
    handTyped.push(typed.id, foreign.id);
    const row = (await listed(t.id)).find((r) => r.month === MONTH_START)!;
    expect(row.candidates.map((c) => c.id)).toEqual([typed.id]);
    const uzsBefore = await balanceOf(uzsTill);
    // Another kind, and a row that does not exist as a candidate, are refused.
    await expect(
      linkRecurringPayment({ recurringId: t.id, month: MONTH, expenseId: foreign.id }, ctx()),
    ).rejects.toMatchObject({ code: 'recurring_not_candidate' });
    // So'm against a dollar template cannot be compared: the person says it closes.
    await expect(
      linkRecurringPayment({ recurringId: t.id, month: MONTH, expenseId: typed.id }, ctx()),
    ).rejects.toMatchObject({ code: 'recurring_partial_unclear' });
    await linkRecurringPayment({ recurringId: t.id, month: MONTH, expenseId: typed.id, partial: false }, ctx());
    expect(await balanceOf(uzsTill)).toBe(uzsBefore);
    expect((await listed(t.id)).some((r) => r.month === MONTH_START)).toBe(false);
    const audit = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE entity_type = 'expense' AND entity_id = ${typed.id}::uuid AND action = 'update'
         AND after->>'recurringId' = ${t.id}`);
    expect(audit[0]!.n).toBe(1);
    // Already linked → no longer a candidate.
    await expect(
      linkRecurringPayment({ recurringId: t.id, month: NEXT, expenseId: typed.id, partial: false }, ctx()),
    ).rejects.toMatchObject({ code: 'recurring_not_candidate' });
    await voidExpense(typed.id, 'boshqa to‘lov', ctx());
    expect((await listed(t.id)).some((r) => r.month === MONTH_START)).toBe(true);
  });

  it('R21: a void re-lists its month on a STOPPED template and before due_from — a month that once carried a payment was owed (M2)', async () => {
    const t = await template({ categoryId: await kind('r21'), dayOfMonth: 1, amount: 45 });
    const paid = await pay(t.id, { amount: 45 });
    await updateRecurring(t.id, { amount: 45, dayOfMonth: 1, active: false }, ctx());
    await voidExpense(paid.id, 'xato', ctx());
    const row = (await listed(t.id)).find((r) => r.month === MONTH_START);
    expect(row?.templateActive).toBe(false);
    expect(row?.dueNow).toBe(true);
    await pay(t.id, { amount: 45 });
    expect((await listed(t.id)).some((r) => r.month === MONTH_START)).toBe(false);
    // …and a posting in a month before due_from, voided, is owed again too.
    await db.execute(sql`
      INSERT INTO expenses (id, category_id, amount, currency, rate_to_usd, amount_usd, expense_date,
                            account_id, recurring_id, recurring_month, voided_at, voided_by, void_reason, created_by)
      VALUES (gen_random_uuid(), ${t.categoryId}::uuid, 45, 'USD', 1, 45, ${`${LAST}-01`}::date,
              ${usdTill}::uuid, ${t.id}::uuid, ${`${LAST}-01`}::date, now(), ${actorId}::uuid, 'xato', ${actorId}::uuid)`);
    expect((await listed(t.id)).some((r) => r.month === `${LAST}-01`)).toBe(true);
  });

  it("R22: a firm's charge for a recurring payment is voided on the EXPENSE, never on the partner card (M4)", async () => {
    const t = await template({ categoryId: await kind('r22'), dayOfMonth: 1, amount: 210, partnerId: firm });
    const row = await pay(t.id, { payer: `partner:${firm}`, amount: 210 });
    const [charge] = await db
      .select()
      .from(partnerTransactions)
      .where(eq(partnerTransactions.expenseId, row.id));
    await expect(voidPartnerTx(charge!.id, 'firma to‘lamadi', ctx())).rejects.toMatchObject({ code: 'recurring_payment' });
    const [still] = await db.select().from(expenses).where(eq(expenses.id, row.id));
    expect(still!.partnerId).toBe(firm);
    await voidExpense(row.id, 'firma to‘lamadi', ctx());
    const [voided] = await db.select().from(partnerTransactions).where(eq(partnerTransactions.id, charge!.id));
    expect(voided!.voidedAt).not.toBeNull();
    expect((await listed(t.id)).some((r) => r.month === MONTH_START)).toBe(true);
  });

  it('R25: a template payment with no month (the old app during migrate) still closes its date’s month (M8)', async () => {
    const t = await template({ categoryId: await kind('r25'), dayOfMonth: 1, amount: 15 });
    await db.execute(sql`
      INSERT INTO expenses (id, category_id, amount, currency, rate_to_usd, amount_usd, expense_date,
                            account_id, recurring_id, created_by)
      VALUES (gen_random_uuid(), ${t.categoryId}::uuid, 15, 'USD', 1, 15, ${MONTH_START}::date,
              ${usdTill}::uuid, ${t.id}::uuid, ${actorId}::uuid)`);
    expect((await listed(t.id)).some((r) => r.month === MONTH_START)).toBe(false);
  });
});

describe('the template doors and the old button’s leftovers', () => {
  it('R17: a posting the old button made before its day is named until voided — then its month is on the list (G7)', async () => {
    const t = await template({ categoryId: await kind('r17'), dayOfMonth: 1, amount: 25 });
    const yesterday = addDays(TODAY, -1);
    const before = (await advancePostedRecurring()).count;
    const [made] = await db.execute<{ id: string }>(sql`
      INSERT INTO expenses (id, category_id, amount, currency, rate_to_usd, amount_usd, expense_date,
                            account_id, recurring_id, recurring_month, created_by, created_at)
      VALUES (gen_random_uuid(), ${t.categoryId}::uuid, 25, 'USD', 1, 25, ${yesterday}::date,
              ${usdTill}::uuid, ${t.id}::uuid, ${`${yesterday.slice(0, 7)}-01`}::date, ${actorId}::uuid,
              now() - interval '10 days')
      RETURNING id`);
    const named = await advancePostedRecurring();
    expect(named.count).toBe(before + 1);
    expect(named.rows.map((row) => row.id)).toContain(made!.id);
    await voidExpense(made!.id, 'pul chiqmagan', ctx());
    expect((await advancePostedRecurring()).count).toBe(before);
    expect((await listed(t.id)).some((r) => r.month === `${yesterday.slice(0, 7)}-01`)).toBe(true);
  });

  it('R24: a book entry is dated on its occurrence’s own day, whatever date is posted (M6)', async () => {
    const t = await template({ categoryId: await kind('r24', false), dayOfMonth: 3, amount: 12, accountId: '' }, `${LAST}-01`);
    const row = await pay(t.id, { month: LAST, payer: '', amount: 12, expenseDate: TODAY });
    expect(row.expenseDate).toBe(`${LAST}-03`);
    expect(row.accountId).toBeNull();
  });

  it("R27: «Birinchi to'lov» — 'next' starts the window next month; absent starts it this month (G10)", async () => {
    const next = await template({ categoryId: await kind('r27n'), dayOfMonth: 5, firstMonth: 'next' });
    expect((await listed(next.id)).map((row) => row.month)).toEqual([`${NEXT}-01`]);
    const now = await template({ categoryId: await kind('r27t'), dayOfMonth: 5 });
    expect((await listed(now.id)).map((row) => row.month)).toEqual([MONTH_START, `${NEXT}-01`]);
  });

  it('R28: an edit never re-asks what did not change — a stop or an amount edit survives a closed default kassa (G1, G2)', async () => {
    const own = await till('r28', 'USD');
    const t = await template({ categoryId: await kind('r28'), dayOfMonth: 5, accountId: own, firstMonth: 'next' });
    await saveAccount(
      { name: tills.at(-1)!.name, currency: 'USD', kind: 'cash', openingBalance: 0, openingDate: '', sortOrder: 950, active: false, id: own },
      ctx(),
    );
    await updateRecurring(t.id, { amount: 950, dayOfMonth: 5, active: true }, ctx());
    await updateRecurring(t.id, { amount: 950, dayOfMonth: 5, active: false }, ctx());
    await updateRecurring(t.id, { amount: 950, dayOfMonth: 5, active: false, payer: `till:${own}` }, ctx());
    await expect(
      updateRecurring(t.id, { amount: 950, dayOfMonth: 5, active: true, payer: '' }, ctx()),
    ).rejects.toMatchObject({ code: 'account_or_payer_required' });
    await expect(
      updateRecurring(t.id, { amount: 950, dayOfMonth: 5, active: false, currency: 'UZS' }, ctx()),
    ).rejects.toMatchObject({ code: 'account_currency_mismatch' });
    const [stored] = await db.select().from(recurringExpenses).where(eq(recurringExpenses.id, t.id));
    expect(stored!.accountId).toBe(own);
    expect(stored!.currency).toBe('USD');
  });

  it("R18: 0106's skip backfill, run from the migration's own text, marks only the months whose every payment was voided (G9)", async () => {
    const x = await template({ categoryId: await kind('r18x'), dayOfMonth: 1, amount: 11, active: false });
    const y = await template({ categoryId: await kind('r18y'), dayOfMonth: 1, amount: 11, active: false });
    const z = await template({ categoryId: await kind('r18z'), dayOfMonth: 1, amount: 11, active: false });
    const w = await template({ categoryId: await kind('r18w'), dayOfMonth: 1, amount: 11, active: false });
    const insert = async (tpl: { id: string; categoryId: string }, voided: boolean, month: string | null) =>
      db.execute(sql`
        INSERT INTO expenses (id, category_id, amount, currency, rate_to_usd, amount_usd, expense_date,
                              account_id, recurring_id, recurring_month, voided_at, voided_by, void_reason, created_by)
        VALUES (gen_random_uuid(), ${tpl.categoryId}::uuid, 11, 'USD', 1, 11, ${`${LAST}-10`}::date,
                ${usdTill}::uuid, ${tpl.id}::uuid, ${month}::date,
                ${voided ? sql`now()` : sql`NULL`}, ${voided ? actorId : null}::uuid,
                ${voided ? 'eski' : null}, ${actorId}::uuid)`);
    await insert(x, true, `${LAST}-01`);
    await insert(y, true, `${LAST}-01`);
    await insert(y, false, `${LAST}-01`);
    await insert(z, false, `${LAST}-01`);
    await insert(w, true, null);
    const migration = readFileSync('src/modules/platform/db/migrations/0106_recurring_paid.sql', 'utf8');
    const marker = '-- 0106:skip-backfill';
    expect(migration.split(marker)).toHaveLength(2);
    const backfill = migration.slice(migration.indexOf(marker));
    let seen: { recurring_id: string; month: string }[] = [];
    await db
      .transaction(async (tx) => {
        await tx.execute(sql.raw(backfill));
        seen = await tx.execute<{ recurring_id: string; month: string }>(sql`
          SELECT recurring_id, to_char(month, 'YYYY-MM-DD') AS month FROM recurring_skips
           WHERE voided_at IS NULL AND recurring_id IN (${x.id}::uuid, ${y.id}::uuid, ${z.id}::uuid, ${w.id}::uuid)`);
        tx.rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof TransactionRollbackError)) throw err;
      });
    const by = (id: string) => seen.filter((row) => row.recurring_id === id).map((row) => row.month);
    expect(by(x.id)).toEqual([`${LAST}-01`]);
    expect(by(y.id)).toEqual([]);
    expect(by(z.id)).toEqual([]);
    // A voided row with no month groups under its date's month — no NULL.
    expect(by(w.id)).toEqual([`${LAST}-01`]);
  });
});
