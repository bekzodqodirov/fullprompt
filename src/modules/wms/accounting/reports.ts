import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  accountTransfers,
  batches,
  clients,
  clientTransactions,
  costAllocations,
  costEntries,
  expenseCategories,
  expenses,
  partnerTransactions,
  partners,
} from '../../platform/db/schema';
import { uzsRate } from './period';
// Every cash box converts through the generic rate lookup, not a per-currency
// branch — the branch is how a CNY till came to be worth nothing.
import {
  batchLandedCostTotals,
  rateFor,
  unplacedCostSince,
  unplacedCostSql,
  unplacedCostTotals,
} from '../costing/service';
import { clientBalances, clientTotals, unplacedPaymentSql } from '../finance/service';
import { internalLegSql } from '../batches/internal';
import { cashClientTxSql, cashCostSql, cashExpenseSql, costCashDay, mergedFrom } from './cash-rules';
import { tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * Management reports (Phase 2.4).
 *
 * Revenue is a client charge on its `tx_date` (owner's answer 6: the price is
 * agreed once customs is done, which is when the service is really finished).
 * Direct cost is a `cost_entries` row on its `cost_date`.
 *
 * IMPORTANT and stated on the report itself: in the monthly P&L each side
 * lands on its own date, so a batch whose costs fell in July and whose price
 * was agreed in August splits across two months. That is normal for a
 * period P&L — the question "did this trip earn?" is answered by
 * `profitByBatch`, which matches a batch's revenue against the landed cost of
 * the cargo it carried and is therefore free of any period effect.
 */

export interface PnlRow {
  key: string;
  label: string;
  /** USD per period key (YYYY-MM), plus a 'total'. */
  byPeriod: Record<string, number>;
  total: number;
}

const money = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100;

/** Every month between two dates, inclusive — empty months must still show. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let [year, month] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const [endYear, endMonth] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

export interface Pnl {
  months: string[];
  revenue: PnlRow;
  directCosts: PnlRow[];
  directTotal: PnlRow;
  grossProfit: PnlRow;
  grossMarginPct: Record<string, number>;
  opex: PnlRow[];
  opexTotal: PnlRow;
  netProfit: PnlRow;
}

/**
 * What a period's P&L cannot see, said beside it instead of silently
 * (audit 2026-09-24, A11 and A31).
 *
 * - A debt typed by hand on a partner's card before that kind left the card:
 *   a service we took, with no cost row behind it, so it is in the Balans as
 *   something we owe and in no cost line here. It is NOT added to the P&L,
 *   because some of those services were ALSO typed as a cost by hand — adding
 *   them would count those twice — so the screen names the sum and the fix.
 * - A cost with no dollar figure because its currency had no rate: the P&L
 *   reads it as $0 (`coalesce(amount_usd, 0)`). Named per currency in its own
 *   money, since there is no dollar figure to name.
 */
export interface PnlGaps {
  manualCharges: { count: number; usd: number };
  unconverted: { count: number; byCurrency: { currency: string; count: number; amount: number }[] };
}

export async function pnlGaps(from: string, to: string): Promise<PnlGaps> {
  const [manual, unconverted] = await Promise.all([
    db
      .select({
        count: sql<number>`count(*)::int`,
        usd: sql<string>`coalesce(sum(${partnerTransactions.amountUsd}), 0)`,
      })
      .from(partnerTransactions)
      .where(
        and(
          eq(partnerTransactions.type, 'charge'),
          isNull(partnerTransactions.costEntryId),
          isNull(partnerTransactions.expenseId),
          isNull(partnerTransactions.voidedAt),
          gte(partnerTransactions.txDate, from),
          lte(partnerTransactions.txDate, to),
        ),
      ),
    db
      .select({
        currency: costEntries.currency,
        count: sql<number>`count(*)::int`,
        amount: sql<string>`sum(${costEntries.amount})`,
      })
      .from(costEntries)
      .where(
        and(
          isNull(costEntries.amountUsd),
          isNull(costEntries.voidedAt),
          gte(costEntries.costDate, from),
          lte(costEntries.costDate, to),
        ),
      )
      .groupBy(costEntries.currency)
      .orderBy(costEntries.currency),
  ]);
  const byCurrency = unconverted.map((row) => ({
    currency: row.currency,
    count: Number(row.count),
    amount: money(row.amount),
  }));
  return {
    manualCharges: { count: Number(manual[0]?.count ?? 0), usd: money(manual[0]?.usd) },
    unconverted: { count: byCurrency.reduce((sum, row) => sum + row.count, 0), byCurrency },
  };
}

/** P&L for a period, one column per month (owner: "PNL va shunga o'xshagan"). */
export async function profitAndLoss(from: string, to: string): Promise<Pnl> {
  const months = monthsBetween(from, to);
  const empty = () => Object.fromEntries(months.map((m) => [m, 0]));

  const revenueRows = await db
    .select({
      month: sql<string>`to_char(${clientTransactions.txDate}, 'YYYY-MM')`,
      sum: sql<string>`sum(${clientTransactions.amountUsd})`,
    })
    .from(clientTransactions)
    .where(
      and(
        eq(clientTransactions.type, 'charge'),
        isNull(clientTransactions.voidedAt),
        gte(clientTransactions.txDate, from),
        lte(clientTransactions.txDate, to),
      ),
    )
    .groupBy(sql`to_char(${clientTransactions.txDate}, 'YYYY-MM')`);

  const revenue: PnlRow = { key: 'revenue', label: 'revenue', byPeriod: empty(), total: 0 };
  for (const row of revenueRows) {
    if (row.month in revenue.byPeriod) revenue.byPeriod[row.month] = money(row.sum);
  }
  revenue.total = money(Object.values(revenue.byPeriod).reduce((a, b) => a + b, 0));

  // Direct cargo costs, split by cost type so the P&L shows WHERE the money
  // went, not just a lump "cost of sales".
  const costRows = await db
    .select({
      month: sql<string>`to_char(${costEntries.costDate}, 'YYYY-MM')`,
      typeName: sql<string>`(SELECT name FROM cost_types ct WHERE ct.id = ${costEntries}.cost_type_id)`,
      sum: sql<string>`sum(coalesce(${costEntries.amountUsd}, 0))`,
    })
    .from(costEntries)
    // A voided cost HAPPENED and then was undone — the revenue and opex
    // sides of this report already exclude their voided rows; direct costs
    // silently did not, and every voided entry went on shrinking the profit.
    .where(
      and(
        isNull(costEntries.voidedAt),
        gte(costEntries.costDate, from),
        lte(costEntries.costDate, to),
      ),
    )
    .groupBy(
      sql`to_char(${costEntries.costDate}, 'YYYY-MM')`,
      sql`(SELECT name FROM cost_types ct WHERE ct.id = ${costEntries}.cost_type_id)`,
    );

  const directMap = new Map<string, PnlRow>();
  for (const row of costRows) {
    const label = row.typeName ?? '—';
    const bucket =
      directMap.get(label) ?? { key: `direct:${label}`, label, byPeriod: empty(), total: 0 };
    if (row.month in bucket.byPeriod) {
      bucket.byPeriod[row.month] = money((bucket.byPeriod[row.month] ?? 0) + money(row.sum));
    }
    directMap.set(label, bucket);
  }
  const directCosts = [...directMap.values()].map((row) => ({
    ...row,
    total: money(Object.values(row.byPeriod).reduce((a, b) => a + b, 0)),
  }));

  // Overheads, by the categories the owner maintains himself.
  const opexRows = await db
    .select({
      month: sql<string>`to_char(${expenses.expenseDate}, 'YYYY-MM')`,
      categoryId: expenses.categoryId,
      name: expenseCategories.name,
      sortOrder: expenseCategories.sortOrder,
      sum: sql<string>`sum(${expenses.amountUsd})`,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(
      and(
        isNull(expenses.voidedAt),
        gte(expenses.expenseDate, from),
        lte(expenses.expenseDate, to),
      ),
    )
    .groupBy(
      sql`to_char(${expenses.expenseDate}, 'YYYY-MM')`,
      expenses.categoryId,
      expenseCategories.name,
      expenseCategories.sortOrder,
    );

  const opexMap = new Map<string, PnlRow & { sortOrder: number }>();
  for (const row of opexRows) {
    const bucket =
      opexMap.get(row.categoryId) ?? {
        key: row.categoryId,
        label: row.name,
        byPeriod: empty(),
        total: 0,
        sortOrder: row.sortOrder,
      };
    if (row.month in bucket.byPeriod) {
      bucket.byPeriod[row.month] = money((bucket.byPeriod[row.month] ?? 0) + money(row.sum));
    }
    opexMap.set(row.categoryId, bucket);
  }
  const opex = [...opexMap.values()]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label))
    .map(({ sortOrder: _sortOrder, ...row }) => ({
      ...row,
      total: money(Object.values(row.byPeriod).reduce((a, b) => a + b, 0)),
    }));

  const sumRows = (key: string, label: string, rows: PnlRow[]): PnlRow => {
    const byPeriod = empty();
    for (const row of rows) {
      for (const month of months) byPeriod[month] = money(byPeriod[month]! + row.byPeriod[month]!);
    }
    return { key, label, byPeriod, total: money(rows.reduce((a, r) => a + r.total, 0)) };
  };

  const directTotal = sumRows('directTotal', 'directTotal', directCosts);
  const opexTotal = sumRows('opexTotal', 'opexTotal', opex);

  const combine = (key: string, a: PnlRow, b: PnlRow): PnlRow => {
    const byPeriod = empty();
    for (const month of months) byPeriod[month] = money(a.byPeriod[month]! - b.byPeriod[month]!);
    return { key, label: key, byPeriod, total: money(a.total - b.total) };
  };

  const grossProfit = combine('grossProfit', revenue, directTotal);
  const netProfit = combine('netProfit', grossProfit, opexTotal);
  const grossMarginPct = Object.fromEntries(
    months.map((month) => [
      month,
      revenue.byPeriod[month]
        ? Math.round((grossProfit.byPeriod[month]! / revenue.byPeriod[month]!) * 1000) / 10
        : 0,
    ]),
  );
  grossMarginPct.total = revenue.total
    ? Math.round((grossProfit.total / revenue.total) * 1000) / 10
    : 0;

  return {
    months,
    revenue,
    directCosts,
    directTotal,
    grossProfit,
    grossMarginPct,
    opex,
    opexTotal,
    netProfit,
  };
}

export interface CashFlowRow {
  label: string;
  kind: 'in' | 'out';
  amountUsd: number;
}

/**
 * Cash flow: money that actually moved, not what was billed.
 *
 * Transfers between our own accounts are excluded by construction — they are
 * not income or spending, and counting them would inflate both sides.
 * Non-cash categories (depreciation) are excluded too, which is exactly why
 * `expense_categories.cash` exists.
 */
export async function cashFlow(from: string, to: string) {
  const core = await cashFlowCore(from, to, false);
  const parts = core.parts.get('total') ?? emptyCashParts();
  const outRows = core.opexRows;

  const [transfers] = await db
    .select({ n: sql<number>`count(*)` })
    .from(accountTransfers)
    .where(
      and(
        isNull(accountTransfers.voidedAt),
        gte(accountTransfers.transferDate, from),
        lte(accountTransfers.transferDate, to),
      ),
    );

  const partnerInflow = parts.partnerIn;
  const partnerOutflow = parts.partnerOut;
  const refundOutflow = parts.clientRefunds;
  return {
    inflow: parts.inflow,
    outflow: parts.outflow,
    net: parts.net,
    /** Informational: transfers are excluded from both sides on purpose. */
    transferCount: Number(transfers?.n ?? 0),
    /**
     * Of `cargoCosts`, three parts that add up to it: the dollars a kassa
     * answered for; the accountant's QUEUE — the same predicate the queue
     * screen, the home counter and the Balans read (`unplacedCostSql`, audit
     * U23), so the linked figure is the queue's and can be cleared from it;
     * and the kassa-less rest nobody will be asked about — history typed
     * before kassas were asked for (inside the tills' counted openings, #1018)
     * and costs whose duplicate expense named no kassa (#1019).
     */
    cargoFromTillUsd: parts.cargoFromTill,
    cargoQueuedUsd: parts.cargoQueued,
    cargoKassaUnknownUsd: money(parts.cargoCosts - parts.cargoFromTill - parts.cargoQueued),
    /** The day the queue starts — the history line names it. */
    cargoQueueSince: core.since,
    /**
     * Costs the rows above read as $0 because their currency had no rate
     * (audit U24) — named per currency in its own money, never converted by
     * a guess (#86). `tillPaid` of them left a kassa, which the Balans already
     * shows in the kassa's own money.
     */
    unconverted: core.unconverted,
    /** Inflows and outflows no kassa answered for (the reconciliation's lines). */
    clientPaymentsNoKassaUsd: parts.clientPaymentsNoKassa,
    /**
     * Cash overheads saved with no kassa and no payer (U13): inside the
     * outflow — they were spent — and in no drawer. The door refuses new
     * ones now; the report names the ones already there.
     */
    cashOpexNoKassaUsd: parts.cashOpexNoKassa,
    cashOpexNoKassaCount: parts.cashOpexNoKassaCount,
    rows: [
      { label: 'clientPayments', kind: 'in' as const, amountUsd: parts.clientPayments },
      ...(partnerInflow
        ? [{ label: 'partnerIn', kind: 'in' as const, amountUsd: partnerInflow }]
        : []),
      { label: 'cargoCosts', kind: 'out' as const, amountUsd: parts.cargoCosts },
      ...(partnerOutflow
        ? [{ label: 'partnerOut', kind: 'out' as const, amountUsd: partnerOutflow }]
        : []),
      ...(refundOutflow
        ? [{ label: 'clientRefunds', kind: 'out' as const, amountUsd: refundOutflow }]
        : []),
      ...outRows.map((row) => ({
        label: row.label,
        kind: 'out' as const,
        amountUsd: row.amountUsd,
      })),
    ],
  };
}

/** The cash flow's parts for one period (a month, or the whole range). */
export interface CashParts {
  clientPayments: number;
  /** …of which reached no kassa: a payment saved before kassas were required. */
  clientPaymentsNoKassa: number;
  clientRefunds: number;
  partnerIn: number;
  partnerOut: number;
  cargoCosts: number;
  cargoFromTill: number;
  /** …of which wait in the accountant's queue (`unplacedCostSql`, U23). */
  cargoQueued: number;
  /** Cash overheads: the `cash` expense categories. */
  cashOpex: number;
  /**
   * …of which named no kassa and no payer: money the cash flow counts and no
   * drawer shows (U13). The door now demands one (the owner's answer A,
   * 2026-09-25); these are the ones already saved, named on the report.
   */
  cashOpexNoKassa: number;
  cashOpexNoKassaCount: number;
  /** Cargo costs read as $0 because their currency has no rate (U24). */
  unconvertedCount: number;
  inflow: number;
  outflow: number;
  net: number;
}

function emptyCashParts(): CashParts {
  return {
    clientPayments: 0,
    clientPaymentsNoKassa: 0,
    clientRefunds: 0,
    partnerIn: 0,
    partnerOut: 0,
    cargoCosts: 0,
    cargoFromTill: 0,
    cargoQueued: 0,
    cashOpex: 0,
    cashOpexNoKassa: 0,
    cashOpexNoKassaCount: 0,
    unconvertedCount: 0,
    inflow: 0,
    outflow: 0,
    net: 0,
  };
}

/**
 * The cash flow month by month (the dashboard's second chart), from the SAME
 * statements `cashFlow` runs — one core, bucketed by month instead of summed
 * over the range — so a month's bar and the report over that month cannot
 * disagree, and a correction to the report's rules moves both (#513). Eight
 * grouped statements whatever the number of months.
 */
export async function cashFlowByMonth(from: string, to: string): Promise<Map<string, CashParts>> {
  const core = await cashFlowCore(from, to, true);
  return new Map(monthsBetween(from, to).map((month) => [month, core.parts.get(month) ?? emptyCashParts()]));
}

/**
 * The cargo costs the cash flow counts over a period: live, not settled by a
 * counterparty, dated by the day the DRAWER paid (`costCashDay`, U07). ONE
 * fragment for the cost row and for its unconverted gap (U24), so the gap
 * names exactly the rows the $0 hides — `pnlGaps` is the P&L's and has no
 * partner clause, which would name partner-settled rows this report leaves
 * out on purpose. Needs `mergedFrom` LEFT JOINed.
 */
function cargoCashWhere(from: string, to: string) {
  return and(
    cashCostSql(),
    sql`${costCashDay} >= ${from}::date`,
    sql`${costCashDay} <= ${to}::date`,
  );
}

/**
 * Money that actually moved, not what was billed, per period key — 'total'
 * for the whole range, or 'YYYY-MM' when `byMonth`. Every rule of the report
 * lives here and only here; `cashFlow` and `cashFlowByMonth` only arrange it.
 */
async function cashFlowCore(from: string, to: string, byMonth: boolean) {
  const key = (column: unknown) =>
    byMonth ? sql<string>`to_char(${column}, 'YYYY-MM')` : sql<string>`'total'`;
  // A pooled setting read, outside any transaction (#714).
  const since = await unplacedCostSince();

  const receivedQ = db
    .select({
      period: key(clientTransactions.txDate),
      sum: sql<string>`coalesce(sum(${clientTransactions.amountUsd}), 0)`,
      noKassa: sql<string>`coalesce(sum(${clientTransactions.amountUsd}) FILTER (WHERE ${clientTransactions.accountId} IS NULL), 0)`,
    })
    .from(clientTransactions)
    .where(
      and(
        // A payment made into a PARTNER's account never reached a cash box of
        // ours (round 39). Counting it as money received would report cash we
        // cannot spend — the one lie a cash-flow report must not tell.
        cashClientTxSql(),
        eq(clientTransactions.type, 'payment'),
        gte(clientTransactions.txDate, from),
        lte(clientTransactions.txDate, to),
      ),
    );

  // Money handed BACK to clients (R6a). Always out of a kassa of ours — the
  // refund CHECK demands one — so it is cash that left, never a price.
  const refundedQ = db
    .select({
      period: key(clientTransactions.txDate),
      sum: sql<string>`coalesce(sum(${clientTransactions.amountUsd}), 0)`,
    })
    .from(clientTransactions)
    .where(
      and(
        cashClientTxSql(),
        eq(clientTransactions.type, 'refund'),
        gte(clientTransactions.txDate, from),
        lte(clientTransactions.txDate, to),
      ),
    );

  // Money a counterparty put INTO one of our accounts — the cash buyers' first
  // leg. It is real cash in, and we owe it, but the debt is not this report's
  // business; this report answers only "what moved".
  const partnerInQ = db
    .select({
      period: key(partnerTransactions.txDate),
      sum: sql<string>`coalesce(sum(${partnerTransactions.amountUsd}), 0)`,
    })
    .from(partnerTransactions)
    .where(
      and(
        eq(partnerTransactions.type, 'receipt'),
        isNull(partnerTransactions.voidedAt),
        gte(partnerTransactions.txDate, from),
        lte(partnerTransactions.txDate, to),
      ),
    );
  const partnerOutQ = db
    .select({
      period: key(partnerTransactions.txDate),
      sum: sql<string>`coalesce(sum(${partnerTransactions.amountUsd}), 0)`,
    })
    .from(partnerTransactions)
    .where(
      and(
        eq(partnerTransactions.type, 'payment'),
        isNull(partnerTransactions.voidedAt),
        gte(partnerTransactions.txDate, from),
        lte(partnerTransactions.txDate, to),
      ),
    );

  const opexQ = db
    .select({
      period: key(expenses.expenseDate),
      label: expenseCategories.name,
      sortOrder: expenseCategories.sortOrder,
      sum: sql<string>`sum(${expenses.amountUsd})`,
      noKassa: sql<string>`coalesce(sum(${expenses.amountUsd}) FILTER (WHERE ${expenses.accountId} IS NULL), 0)`,
      noKassaCount: sql<number>`(count(*) FILTER (WHERE ${expenses.accountId} IS NULL))::int`,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(
      and(
        // Cash categories only, and not settled by a partner out of their own
        // account: ours never opened (`cash-rules.ts`).
        cashExpenseSql(),
        gte(expenses.expenseDate, from),
        lte(expenses.expenseDate, to),
      ),
    );

  // ONE row, split for the reader (0101): the part a kassa has answered for,
  // the part waiting in the accountant's queue, and the rest — a cash-flow
  // line that hid the split would read as if every dollar had a drawer. The
  // total is unchanged.
  const cargoQ = db
    .select({
      period: key(costCashDay),
      sum: sql<string>`coalesce(sum(coalesce(${costEntries.amountUsd}, 0)), 0)`,
      fromTill: sql<string>`coalesce(sum(coalesce(${costEntries.amountUsd}, 0)) FILTER (WHERE ${costEntries.accountId} IS NOT NULL), 0)`,
      queued: sql<string>`coalesce(sum(coalesce(${costEntries.amountUsd}, 0)) FILTER (WHERE ${unplacedCostSql(since)}), 0)`,
    })
    .from(costEntries)
    .leftJoin(mergedFrom, eq(mergedFrom.id, costEntries.mergedExpenseId))
    // Same rule as the expenses above: a truck the transport company is
    // still owed for has cost us nothing in CASH yet.
    .where(cargoCashWhere(from, to));

  // The same rows with no dollar figure (U24): they add $0 above, and a $0
  // nobody names reads as «nothing was spent».
  const unconvertedQ = db
    .select({
      period: key(costCashDay),
      currency: costEntries.currency,
      count: sql<number>`count(*)::int`,
      amount: sql<string>`coalesce(sum(${costEntries.amount}), 0)`,
      tillPaid: sql<number>`(count(*) FILTER (WHERE ${costEntries.accountId} IS NOT NULL))::int`,
    })
    .from(costEntries)
    .leftJoin(mergedFrom, eq(mergedFrom.id, costEntries.mergedExpenseId))
    .where(and(cargoCashWhere(from, to), isNull(costEntries.amountUsd)));

  const [received, refunded, partnerIn, partnerOut, opex, cargo, unconverted] = await Promise.all(
    byMonth
      ? [
          receivedQ.groupBy(key(clientTransactions.txDate)),
          refundedQ.groupBy(key(clientTransactions.txDate)),
          partnerInQ.groupBy(key(partnerTransactions.txDate)),
          partnerOutQ.groupBy(key(partnerTransactions.txDate)),
          opexQ
            .groupBy(key(expenses.expenseDate), expenseCategories.name, expenseCategories.sortOrder)
            .orderBy(expenseCategories.sortOrder),
          cargoQ.groupBy(key(costCashDay)),
          unconvertedQ.groupBy(key(costCashDay), costEntries.currency).orderBy(costEntries.currency),
        ]
      : [
          receivedQ,
          refundedQ,
          partnerInQ,
          partnerOutQ,
          opexQ.groupBy(expenseCategories.name, expenseCategories.sortOrder).orderBy(expenseCategories.sortOrder),
          cargoQ,
          unconvertedQ.groupBy(costEntries.currency).orderBy(costEntries.currency),
        ],
  );

  const parts = new Map<string, CashParts>();
  const at = (period: string) => {
    let entry = parts.get(period);
    if (!entry) {
      entry = emptyCashParts();
      parts.set(period, entry);
    }
    return entry;
  };
  for (const row of received as { period: string; sum: string; noKassa: string }[]) {
    at(row.period).clientPayments += money(row.sum);
    at(row.period).clientPaymentsNoKassa += money(row.noKassa);
  }
  for (const row of refunded) at(row.period).clientRefunds += money(row.sum);
  for (const row of partnerIn) at(row.period).partnerIn += money(row.sum);
  for (const row of partnerOut) at(row.period).partnerOut += money(row.sum);
  for (const row of cargo as { period: string; sum: string; fromTill: string; queued: string }[]) {
    at(row.period).cargoCosts += money(row.sum);
    at(row.period).cargoFromTill += money(row.fromTill);
    at(row.period).cargoQueued += money(row.queued);
  }
  const byCurrency = new Map<string, { currency: string; count: number; amount: number; tillPaid: number }>();
  for (const row of unconverted as { period: string; currency: string; count: number; amount: string; tillPaid: number }[]) {
    at(row.period).unconvertedCount += Number(row.count);
    const entry = byCurrency.get(row.currency) ?? { currency: row.currency, count: 0, amount: 0, tillPaid: 0 };
    entry.count += Number(row.count);
    entry.amount = money(entry.amount + money(row.amount));
    entry.tillPaid += Number(row.tillPaid);
    byCurrency.set(row.currency, entry);
  }
  const opexRows = new Map<string, number>();
  for (const row of opex as { period: string; label: string; sum: string; noKassa: string; noKassaCount: number }[]) {
    at(row.period).cashOpex += money(row.sum);
    at(row.period).cashOpexNoKassa += money(row.noKassa);
    at(row.period).cashOpexNoKassaCount += Number(row.noKassaCount);
    opexRows.set(row.label, (opexRows.get(row.label) ?? 0) + money(row.sum));
  }
  for (const entry of parts.values()) {
    entry.cashOpex = money(entry.cashOpex);
    entry.cashOpexNoKassa = money(entry.cashOpexNoKassa);
    entry.clientPaymentsNoKassa = money(entry.clientPaymentsNoKassa);
    entry.cargoQueued = money(entry.cargoQueued);
    entry.inflow = money(entry.clientPayments + entry.partnerIn);
    entry.outflow = money(entry.cargoCosts + entry.partnerOut + entry.clientRefunds + entry.cashOpex);
    entry.net = money(entry.inflow - entry.outflow);
  }
  const unconvertedList = [...byCurrency.values()];
  return {
    parts,
    since,
    /** Per category over the whole range, in the categories' own order. */
    opexRows: [...opexRows.entries()].map(([label, amountUsd]) => ({ label, amountUsd: money(amountUsd) })),
    unconverted: {
      count: unconvertedList.reduce((sum, row) => sum + row.count, 0),
      tillPaid: unconvertedList.reduce((sum, row) => sum + row.tillPaid, 0),
      byCurrency: unconvertedList,
    },
  };
}

/** One named line of the cash reconciliation, signed as it moves the tills. */
export type ReconLineKey =
  | 'countedInPeriod'
  | 'noKassaPayments'
  | 'queuedCosts'
  | 'historyCosts'
  | 'noKassaExpenses'
  | 'beforeOpening'
  | 'tillOnly'
  | 'oneSidedTransfers'
  | 'unratedTills'
  | 'fx';

/**
 * Why the tills moved by a different amount than the cash flow says (audit
 * U13): opening cash + the cash flow + these lines = closing cash, in dollars,
 * to the cent. Every line is COMPUTED from its own rows, never the residual —
 * the residual is returned separately (`unexplained`) and is zero, which is
 * the test's whole assertion and the screen's proof that nothing is missing.
 *
 * Its own read and not a part of `cashFlow`: the admin home, the AI's
 * cash_flow tool (sliced at 6,000 characters) and the XLSX call that, and none
 * of them should pay for or be truncated by the kassa rows.
 *
 * - The cash flow counts rows no kassa counts: payments and cargo costs and
 *   overheads with no kassa, rows dated before their kassa's opening count
 *   (#1012 keeps them in the cash flow), and rows of a kassa whose currency
 *   has no rate (the kassa itself cannot be put in dollars).
 * - A kassa counts rows the cash flow does not: a non-cash category paid
 *   from it, its own opening count dated inside the period, and a transfer
 *   whose other end is outside the counted kassas.
 * - FX: a kassa's native money valued at the period's two rates against the
 *   dollars each row was frozen at — revaluation, exchange gains and costs
 *   paid out of a kassa in another currency.
 */
export async function cashReconciliation(from: string, to: string) {
  const { accountBalancesBetween, countedAccount } = await import('./service');
  // One after the other: each already runs its statements side by side, and
  // together they would ask for more connections than the pool of ten holds.
  const flow = await cashFlow(from, to);
  const kassas = await accountBalancesBetween(from, to);
  const dayBefore = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

  // A rate per (currency, day) the arithmetic needs: the two ends, and each
  // opening count dated inside the period. A handful, on the pool — this is
  // never inside a transaction (#714).
  const wanted = new Set<string>();
  for (const kassa of kassas) {
    wanted.add(`${kassa.currency}|${dayBefore}`);
    wanted.add(`${kassa.currency}|${to}`);
    if (kassa.countedInPeriod !== 0 && kassa.openingDate) wanted.add(`${kassa.currency}|${kassa.openingDate}`);
  }
  const rates = new Map(
    await Promise.all(
      [...wanted].map(async (pair) => {
        const [currency, day] = pair.split('|') as [string, string];
        return [pair, await rateFor(currency, day)] as const;
      }),
    ),
  );
  const rate = (currency: string, day: string) => rates.get(`${currency}|${day}`) ?? null;

  let openingUsd = 0;
  let closingUsd = 0;
  const raw: Record<ReconLineKey, number> = {
    countedInPeriod: 0,
    noKassaPayments: -flow.clientPaymentsNoKassaUsd,
    queuedCosts: flow.cargoQueuedUsd,
    historyCosts: flow.cargoKassaUnknownUsd,
    noKassaExpenses: flow.cashOpexNoKassaUsd,
    beforeOpening: 0,
    tillOnly: 0,
    oneSidedTransfers: 0,
    unratedTills: 0,
    fx: 0,
  };
  const unrated = new Map<string, number>();
  // EVERY kassa is added up — a box with nothing to show can still hold rows
  // dated before its count, which the cash flow counts — and only the ones
  // with something to show are listed.
  const all = kassas.map((kassa) => {
    const rOpen = rate(kassa.currency, dayBefore);
    const rTo = rate(kassa.currency, to);
    const rCount = kassa.openingDate ? rate(kassa.currency, kassa.openingDate) : null;
    if (rOpen === null || rTo === null) {
      // No rate for this currency anywhere (rateFor falls back to the
      // earliest one): the kassa stays out of the dollar totals — as the
      // Balans leaves it out — and the cash flow's rows through it are named.
      raw.unratedTills -= kassa.usd.cashCounted + kassa.usd.cashEarly;
      unrated.set(kassa.currency, (unrated.get(kassa.currency) ?? 0) + kassa.closing);
      return { ...kassa, openingUsd: null, closingUsd: null };
    }
    const open = kassa.opening * rOpen;
    const close = kassa.closing * rTo;
    const count = kassa.countedInPeriod * (rCount ?? rTo);
    const within = kassa.usd.cashCounted + kassa.usd.tillOnly + kassa.usd.transfers;
    openingUsd += open;
    closingUsd += close;
    raw.countedInPeriod += count;
    raw.beforeOpening -= kassa.usd.cashEarly;
    raw.tillOnly += kassa.usd.tillOnly;
    raw.oneSidedTransfers += kassa.usd.transfers;
    raw.fx += close - open - count - within;
    return { ...kassa, openingUsd: money(open), closingUsd: money(close) };
  });
  const rows = all.filter(
    (kassa) =>
      countedAccount({ active: kassa.active, balance: kassa.closing }) ||
      Math.abs(kassa.opening) > 0.009 ||
      Math.abs(kassa.inflow) + Math.abs(kassa.outflow) + Math.abs(kassa.countedInPeriod) > 0.009 ||
      kassa.beforeOpeningInPeriod > 0,
  );

  const explained = Object.values(raw).reduce((sum, value) => sum + value, 0);
  const unexplained = money(closingUsd - openingUsd - flow.net - explained);
  return {
    from,
    to,
    /** The cash flow the lines reconcile — the page and the file print it too. */
    flow,
    openingUsd: money(openingUsd),
    closingUsd: money(closingUsd),
    netFlowUsd: flow.net,
    /** Named lines, signed as they move the tills; zeros left out. */
    lines: (Object.keys(raw) as ReconLineKey[])
      .map((key) => ({ key, usd: money(raw[key]) }))
      .filter((line) => Math.abs(line.usd) > 0.004),
    /** closing − opening − net − Σ lines. Zero unless a rule above is missing. */
    unexplained,
    /** Kassas left out of the dollar totals for want of a rate, in their own money. */
    unratedTills: [...unrated.entries()].map(([currency, closing]) => ({ currency, closing: money(closing) })),
    /** The queue's start day, which the history line names. */
    queueSince: flow.cargoQueueSince,
    kassas: rows,
  };
}

/** Debtors by how long the money has been outstanding (0-30/31-60/61-90/90+). */
export async function arAging(asOf: string) {
  const rows = await db
    .select({
      clientId: clientTransactions.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      type: clientTransactions.type,
      txDate: clientTransactions.txDate,
      amountUsd: clientTransactions.amountUsd,
    })
    .from(clientTransactions)
    .innerJoin(clients, eq(clientTransactions.clientId, clients.id))
    .where(and(isNull(clientTransactions.voidedAt), lte(clientTransactions.txDate, asOf)));

  const asOfMs = new Date(`${asOf}T00:00:00Z`).getTime();
  const byClient = new Map<
    string,
    { clientId: string; clientCode: string; clientName: string; balance: number; buckets: number[] }
  >();

  // Payments settle the OLDEST charge first (standard AR practice), so a
  // client who pays regularly never looks 90 days overdue on new cargo.
  const charges = new Map<string, { date: string; amount: number }[]>();
  for (const row of rows) {
    const entry =
      byClient.get(row.clientId) ?? {
        clientId: row.clientId,
        clientCode: row.clientCode,
        clientName: row.clientName,
        balance: 0,
        buckets: [0, 0, 0, 0],
      };
    // A refund (R6a) RAISES what the client owes, like a charge: money handed
    // back is owed again from that day — it ages from its own date.
    if (row.type !== 'payment') {
      entry.balance += money(row.amountUsd);
      charges.set(row.clientId, [
        ...(charges.get(row.clientId) ?? []),
        { date: row.txDate, amount: money(row.amountUsd) },
      ]);
    } else {
      entry.balance -= money(row.amountUsd);
    }
    byClient.set(row.clientId, entry);
  }

  for (const [clientId, entry] of byClient) {
    if (entry.balance <= 0) continue;
    const open = (charges.get(clientId) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    let unpaid = entry.balance;
    // Walk the charges NEWEST first: what is still unpaid is the most recent
    // cargo, because the older ones were settled by the payments already made.
    for (const charge of [...open].reverse()) {
      if (unpaid <= 0) break;
      const applied = Math.min(unpaid, charge.amount);
      unpaid -= applied;
      const days = Math.floor((asOfMs - new Date(`${charge.date}T00:00:00Z`).getTime()) / 86_400_000);
      const bucket = days <= 30 ? 0 : days <= 60 ? 1 : days <= 90 ? 2 : 3;
      entry.buckets[bucket] = money(entry.buckets[bucket]! + applied);
    }
  }

  return [...byClient.values()]
    .filter((entry) => entry.balance > 0.004)
    .map((entry) => ({ ...entry, balance: money(entry.balance) }))
    .sort((a, b) => b.balance - a.balance);
}

/**
 * Profit per batch — revenue charged for it against what its cargo cost us.
 *
 * Period-free by construction: both sides belong to the same batch whatever
 * month they were entered, which is why this and not the monthly P&L answers
 * "did this trip earn money?".
 *
 * ONE truck, ONE profit (owner's R2a, 2026-09-24): the cost is the landed
 * cost «Partiya moliyasi» prints in its header — the same per-lot allocations
 * (`batchLandedCostTotals`), summed per lot in cents the way `pricingView`
 * sums them, unclaimed cargo included — so the two screens agree to the cent.
 * The report used to sum the cost ENTRIES stamped with the truck instead,
 * which missed every receipt, crate and pickup cost and every earlier leg
 * riding in the cargo, counted a stamped entry nobody could allocate, and
 * made each internal leg a pure red row while the export truck it fed read
 * that money as profit.
 *
 * An INTERNAL leg (`internalLegSql` — both ends in China) is never priced, so
 * it is a cost row and never a margin: its profit, margin and per-kg are
 * null. Its cost is already inside the export truck's figure as «shu
 * reysgacha» (`prevUsd`), which is why the screens leave internal rows out of
 * their totals — summing both counts that money twice.
 */
export async function profitByBatch(from: string, to: string) {
  const rows = await db
    .select({
      batchId: batches.id,
      code: batches.code,
      status: batches.status,
      departedAt: batches.departedAt,
      // NOTE: every correlated reference is written as `${batches}.column`,
      // never `${batches.column}`. In a single-table select drizzle renders a
      // column unqualified, so a bare `"id"` inside these subqueries binds to
      // the SUBQUERY's own table: revenue and cost silently came back as zero
      // and the box count died on `uuid = bigint`.
      originCode: sql<string>`(SELECT code FROM warehouses w WHERE w.id = ${batches}.origin_warehouse_id)`,
      destCode: sql<string>`(SELECT code FROM warehouses w WHERE w.id = ${batches}.dest_warehouse_id)`,
      internal: sql<boolean>`coalesce((
        SELECT ${internalLegSql('o', 'd')} FROM warehouses o, warehouses d
        WHERE o.id = ${batches}.origin_warehouse_id AND d.id = ${batches}.dest_warehouse_id
      ), false)`,
      revenueUsd: sql<string>`coalesce((
        SELECT sum(ct.amount_usd) FROM client_transactions ct
        WHERE ct.batch_id = ${batches}.id AND ct.type = 'charge' AND ct.voided_at IS NULL
      ), 0)`,
      // Money typed against this truck that reached NO box — the engine had
      // nothing to split it over — so no landed cost carries it. Named beside
      // the row rather than silently read as $0 («say what you cannot count»,
      // like `pnlGaps`).
      unallocatedUsd: sql<string>`coalesce((
        SELECT sum(ce.amount_usd) FROM cost_entries ce
        WHERE ce.batch_id = ${batches}.id AND ce.voided_at IS NULL AND ce.amount_usd IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM cost_allocations ca WHERE ca.cost_entry_id = ce.id)
      ), 0)`,
      boxCount: sql<number>`coalesce((
        SELECT count(*) FROM box_movements bm
        JOIN boxes b ON b.id = bm.box_id AND b.status <> 'void'
        WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batches}.id AND bm.cause = 'batch_departed'
      ), 0)`,
      kg: sql<string>`coalesce((
        SELECT sum(rl.total_weight_kg / rl.box_count) FROM box_movements bm
        JOIN boxes b ON b.id = bm.box_id AND b.status <> 'void'
        JOIN receipt_lots rl ON rl.id = b.lot_id
        WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batches}.id AND bm.cause = 'batch_departed'
      ), 0)`,
      m3: sql<string>`coalesce((
        SELECT sum(rl.total_volume_m3 / rl.box_count) FROM box_movements bm
        JOIN boxes b ON b.id = bm.box_id AND b.status <> 'void'
        JOIN receipt_lots rl ON rl.id = b.lot_id
        WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batches}.id AND bm.cause = 'batch_departed'
      ), 0)`,
    })
    .from(batches)
    .where(
      and(
        sql`${batches.departedAt} IS NOT NULL`,
        // Tashkent's days (R5): a bare `::date` against a timestamptz is a
        // UTC midnight, so a truck leaving Yiwu at 07:00 on the 1st (04:00 in
        // Tashkent, 23:00 UTC on the 31st) landed in the previous month's
        // report.
        sql`${batches.departedAt} >= ((${from}::date)::timestamp AT TIME ZONE 'Asia/Tashkent')`,
        sql`${batches.departedAt} < (((${to}::date + 1))::timestamp AT TIME ZONE 'Asia/Tashkent')`,
      ),
    )
    .orderBy(sql`${batches.departedAt} DESC`);

  const landed = await batchLandedCostTotals(rows.map((row) => row.batchId));

  return rows.map((row) => {
    const revenue = money(row.revenueUsd);
    // Per lot in cents first, then the sum — `pricingView`'s own order, or
    // the two screens could part by a cent on a truck of many lots.
    const lots = [...(landed.get(row.batchId)?.values() ?? [])];
    const cost = money(lots.reduce((sum, lot) => sum + lot.totalUsd, 0));
    const prev = money(lots.reduce((sum, lot) => sum + (lot.totalUsd - lot.batchUsd), 0));
    const internal = Boolean(row.internal);
    const profit = internal ? null : money(revenue - cost);
    const kg = Math.round(Number(row.kg) * 10) / 10;
    const m3 = Math.round(Number(row.m3) * 1000) / 1000;
    return {
      batchId: row.batchId,
      code: row.code,
      route: `${row.originCode} → ${row.destCode}`,
      status: row.status,
      departedAt: row.departedAt,
      internal,
      boxCount: Number(row.boxCount),
      kg,
      m3,
      revenueUsd: revenue,
      costUsd: cost,
      /** The part of `costUsd` the cargo brought with it — «shu reysgacha». */
      prevUsd: prev,
      unallocatedUsd: money(row.unallocatedUsd),
      profitUsd: profit,
      marginPct: profit === null ? null : revenue ? Math.round((profit / revenue) * 1000) / 10 : 0,
      profitPerKg: profit === null ? null : kg ? Math.round((profit / kg) * 100) / 100 : 0,
      profitPerM3: profit === null ? null : m3 ? Math.round((profit / m3) * 100) / 100 : 0,
    };
  });
}

/**
 * Profit per client — charges against the costs allocated to that client's
 * boxes by the M6 engine, so shared truck costs are split fairly by weight or
 * volume rather than guessed.
 */
/**
 * The money the batch and route tables cannot see, by the period's dates
 * (audit A8/A27). A price typed on a client's ledger names no truck, so it
 * belongs to no truck row in ANY period — named under the tables instead of
 * left to be discovered.
 *
 * Revenue only since R2a (2026-09-24): the COST half used to name every
 * receipt, receive-wizard, crate and pickup cost here, because the table
 * summed only entries stamped with a truck. It reads landed cost now, and
 * that money reaches the truck its cargo rode through the allocations — so
 * naming it here as well would describe the same dollars twice.
 */
export async function unbatchedMoney(from: string, to: string): Promise<{ revenueUsd: number }> {
  const [revenue] = await db
    .select({ sum: sql<string>`coalesce(sum(${clientTransactions.amountUsd}), 0)` })
    .from(clientTransactions)
    .where(
      and(
        eq(clientTransactions.type, 'charge'),
        isNull(clientTransactions.batchId),
        isNull(clientTransactions.voidedAt),
        gte(clientTransactions.txDate, from),
        lte(clientTransactions.txDate, to),
      ),
    );
  return { revenueUsd: money(revenue?.sum) };
}

export async function profitByClient(from: string, to: string) {
  const revenueRows = await db
    .select({
      clientId: clientTransactions.clientId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      revenueUsd: sql<string>`sum(${clientTransactions.amountUsd})`,
    })
    .from(clientTransactions)
    .innerJoin(clients, eq(clientTransactions.clientId, clients.id))
    .where(
      and(
        eq(clientTransactions.type, 'charge'),
        isNull(clientTransactions.voidedAt),
        gte(clientTransactions.txDate, from),
        lte(clientTransactions.txDate, to),
      ),
    )
    .groupBy(clientTransactions.clientId, clients.clientCode, clients.name);

  const costRows = await db
    .select({
      clientId: costAllocations.clientId,
      costUsd: sql<string>`sum(${costAllocations.amountUsd})`,
    })
    .from(costAllocations)
    .innerJoin(costEntries, eq(costAllocations.costEntryId, costEntries.id))
    // Belt and braces: voiding deletes the entry's allocations, but that
    // update+delete pair is not one transaction — an allocation orphaned by
    // a crash between them must not be counted for ever.
    .where(
      and(
        isNull(costEntries.voidedAt),
        gte(costEntries.costDate, from),
        lte(costEntries.costDate, to),
      ),
    )
    .groupBy(costAllocations.clientId);
  const costByClient = new Map(costRows.map((row) => [row.clientId, money(row.costUsd)]));

  // The UNION of both sides, not the revenue rows alone. Keyed on revenue,
  // the report dropped every client whose costs landed in the period while
  // the price was agreed the month after — routine here: costs are booked at
  // receipt and load, the charge when the truck is priced — so the totals row
  // was missing real cost and total profit read high by exactly that much,
  // while the P&L on the SAME hub counted every entry by cost_date. A client
  // with cost and no revenue is a red row, which is the point of looking.
  const revenueByClient = new Map(revenueRows.map((row) => [row.clientId, row]));
  const costOnly = [...costByClient.keys()].filter(
    (clientId) => clientId !== null && !revenueByClient.has(clientId),
  ) as string[];
  const names = costOnly.length
    ? await db
        .select({ id: clients.id, clientCode: clients.clientCode, name: clients.name })
        .from(clients)
        .where(inArray(clients.id, costOnly))
    : [];

  return [
    ...revenueRows.map((row) => ({
      clientId: row.clientId,
      clientCode: row.clientCode,
      clientName: row.clientName,
      revenueUsd: money(row.revenueUsd),
    })),
    ...names.map((row) => ({
      clientId: row.id,
      clientCode: row.clientCode,
      clientName: row.name,
      revenueUsd: 0,
    })),
  ]
    .map((row) => {
      const revenue = row.revenueUsd;
      const cost = costByClient.get(row.clientId) ?? 0;
      const profit = money(revenue - cost);
      return {
        clientId: row.clientId,
        clientCode: row.clientCode,
        clientName: row.clientName,
        revenueUsd: revenue,
        costUsd: cost,
        profitUsd: profit,
        marginPct: revenue ? Math.round((profit / revenue) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.profitUsd - a.profitUsd);
}

/**
 * The same numbers rolled up per corridor (YW → TAS and so on). A corridor
 * inside China is an internal leg on every truck it carries — the route is
 * its two warehouses — so it is a cost row too, never a margin.
 */
export async function profitByRoute(from: string, to: string) {
  const batchRows = await profitByBatch(from, to);
  const byRoute = new Map<
    string,
    {
      route: string;
      internal: boolean;
      batches: number;
      boxCount: number;
      kg: number;
      revenueUsd: number;
      costUsd: number;
    }
  >();
  for (const row of batchRows) {
    const entry =
      byRoute.get(row.route) ?? {
        route: row.route,
        internal: row.internal,
        batches: 0,
        boxCount: 0,
        kg: 0,
        revenueUsd: 0,
        costUsd: 0,
      };
    entry.batches += 1;
    entry.boxCount += row.boxCount;
    entry.kg = Math.round((entry.kg + row.kg) * 10) / 10;
    entry.revenueUsd = money(entry.revenueUsd + row.revenueUsd);
    entry.costUsd = money(entry.costUsd + row.costUsd);
    byRoute.set(row.route, entry);
  }
  return [...byRoute.values()]
    .map((entry) => {
      const profit = entry.internal ? null : money(entry.revenueUsd - entry.costUsd);
      return {
        ...entry,
        profitUsd: profit,
        marginPct:
          profit === null ? null : entry.revenueUsd ? Math.round((profit / entry.revenueUsd) * 1000) / 10 : 0,
        profitPerKg: profit === null ? null : entry.kg ? Math.round((profit / entry.kg) * 100) / 100 : 0,
      };
    })
    // Cost-only corridors after the priced ones, the costliest first.
    .sort((a, b) =>
      a.profitUsd === null || b.profitUsd === null
        ? Number(a.profitUsd === null) - Number(b.profitUsd === null) || b.costUsd - a.costUsd
        : b.profitUsd - a.profitUsd,
    );
}

/**
 * Balans — what the company holds against what it owes, on one screen.
 *
 * Round 39 made this answerable for the first time: until counterparties
 * existed, "we owe" had no number at all, so a page like this could only ever
 * have shown half the picture and would have flattered every month.
 *
 * Deliberately management accounting, not a balance sheet: cargo in the
 * warehouse is NOT valued here. It is not ours — it is the client's goods —
 * and the money side of it is already in what they owe us. Adding a stock
 * valuation would double-count the same shipment and read as profit that
 * belongs to somebody else.
 *
 * Cash boxes are converted at TODAY's rate for the total only; each box also
 * comes back in its own currency, because that is the figure someone counts
 * against the notes in the drawer.
 */
export async function companyBalance() {
  const { accountBalances, countedAccount } = await import('./service');
  const { upsaleLiability } = await import('../calc/upsale-service');
  const [accounts, rate] = await Promise.all([accountBalances(), uzsRate()]);

  // Per box in its own money, and a USD total. EVERY currency converts at
  // today's rate for that currency, not just USD and UZS: the comment here
  // used to claim "anything else is treated as dollars" and the code did the
  // opposite — a CNY till for Yiwu, the obvious thing to open once the Chinese
  // costs are in CNY, contributed nothing at all to the net figure while its
  // own row printed the yuan and the words «no rate». Only a currency with no
  // rate entered anywhere stays out, which is what `balanceUsd: null` means.
  // Retired boxes with money still in them COUNT — the partner register's
  // lesson (#428) on the accounts side: hiding a till is a menu decision,
  // deleting its balance from the Balans is a lie about what the company
  // holds. An emptied retired box adds zero and is not shown; one holding
  // money stays on the sheet, flagged, until somebody actually moves the
  // cash out.
  const counted = accounts.filter(countedAccount);
  const today = tashkentDay();
  const rates = new Map(
    await Promise.all(
      [...new Set(counted.map((account) => account.currency))].map(
        async (code) => [code, await rateFor(code, today)] as const,
      ),
    ),
  );

  let cashUsd = 0;
  const cashRows = counted
    .map((account) => {
      const boxRate = rates.get(account.currency);
      const usd = boxRate && boxRate > 0 ? account.balance * boxRate : null;
      if (usd !== null) cashUsd += usd;
      return {
        id: account.id,
        name: account.name,
        currency: account.currency,
        kind: account.kind,
        balance: account.balance,
        retired: !account.active,
        /** null when no rate has been entered for that currency yet. */
        balanceUsd: usd === null ? null : Math.round(usd * 100) / 100,
      };
    });

  // Money in a box whose currency has no rate is left out of the dollar
  // total — never guessed (#86, #426) — and SAID (audit U14): a transfer of
  // $1,000 into an unrated CNY till lowered the net by $1,000 with nothing on
  // the Balans to say where it went. Per currency in its own money; an empty
  // unrated box raises nothing, because it hides nothing.
  const unratedByCurrency = new Map<string, { currency: string; balance: number; count: number }>();
  for (const row of cashRows) {
    if (row.balanceUsd !== null || Math.abs(row.balance) <= 0.009) continue;
    const entry = unratedByCurrency.get(row.currency) ?? { currency: row.currency, balance: 0, count: 0 };
    entry.balance = money(entry.balance + row.balance);
    entry.count += 1;
    unratedByCurrency.set(row.currency, entry);
  }

  // A till below zero is ALLOWED (the owner's answer a, 2026-09-25 —
  // entries are typed out of order and a card or bank may overdraw) and
  // summed as it stands, but never silently: a cash drawer holding less than
  // nothing is a row somebody has not typed yet, so it is named (U14).
  const negativeTills = cashRows
    .filter((row) => row.balance < -0.009)
    .map((row) => ({ id: row.id, name: row.name, currency: row.currency, balance: row.balance, kind: row.kind }));

  // What clients owe us — split the way the partner side below always was
  // (R7a). One netted sum let a prepaid client's advance shrink «qarz», so
  // the Balans line read LESS than the /finance total it links to (audit
  // A3/A16/A28), while the advance — money we owe back in service — appeared
  // nowhere as a liability. `clientBalances` is the /finance screen's own
  // function and `clientTotals` its own arithmetic (U15), so the two lines
  // can be checked on the page they link to, to the cent.
  const clientSplit = clientTotals(await clientBalances());
  const receivable = clientSplit.receivable;
  const clientAdvances = clientSplit.advances;

  // What we owe counterparties. Negative balances (a firm that owes US) are
  // reported separately rather than netted off: one is a bill to pay and the
  // other is money to chase, and a single number hides which.
  const partnerRows = await db
    .select({
      partnerId: partnerTransactions.partnerId,
      name: partners.name,
      balance: sql<string>`sum(CASE WHEN ${partnerTransactions.type} IN ('charge', 'receipt', 'adjust') THEN ${partnerTransactions.amountUsd} ELSE -${partnerTransactions.amountUsd} END)`,
    })
    .from(partnerTransactions)
    .innerJoin(partners, eq(partnerTransactions.partnerId, partners.id))
    .where(isNull(partnerTransactions.voidedAt))
    .groupBy(partnerTransactions.partnerId, partners.name);

  let owedByUs = 0;
  let owedToUsByPartners = 0;
  for (const row of partnerRows) {
    const value = money(row.balance);
    if (value > 0) owedByUs += value;
    else owedToUsByPartners += -value;
  }

  // Payments that came in and sit in no till (audit A2): each took its amount
  // off the receivable above and added it to no kassa, so the net fell by the
  // payment although the cash flow counts it received. Placed ones leave this
  // line for their kassa (`placePayment`). Only while it is not already inside
  // a till's counted opening (`unplacedPaymentSql`, A2 and U09).
  const [unplaced] = await db
    .select({
      sum: sql<string>`coalesce(sum(${clientTransactions.amountUsd}), 0)`,
      n: sql<number>`count(*)::int`,
    })
    .from(clientTransactions)
    .where(
      and(
        eq(clientTransactions.type, 'payment'),
        isNull(clientTransactions.voidedAt),
        unplacedPaymentSql(),
      ),
    );
  const unplacedUsd = money(unplaced?.sum);

  // Cargo costs nobody has said the kassa of (0101) — SUBTRACTED (audit U02):
  // a cost we booked is money gone even when the kassa it left is unknown,
  // the mirror of the unplaced PAYMENTS added above. Left out, the net stood
  // too high by the whole queue and fell on the day the accountant PLACED
  // each cost instead of the day it was spent. Since `cost_kassa_since` only,
  // like the queue: older costs are inside the tills' counted openings
  // (#1018). One exception, said beside the line and not guessed at: a cost
  // also re-typed as an expense FROM a kassa is counted twice until it is
  // merged on the queue — the same double the P&L and the cash flow show.
  const unplacedCosts = await unplacedCostTotals();

  // What the sellers have earned on jobs the client has already paid for
  // (audit U10, #793 — derived, never stored): owed from money already in
  // the tills above, so until the payout it is a liability, not profit.
  const commissions = await upsaleLiability();

  const net =
    cashUsd +
    unplacedUsd +
    receivable +
    owedToUsByPartners -
    owedByUs -
    clientAdvances -
    unplacedCosts.usd -
    commissions.payableUsd;

  // The totals FIRST: the AI's company_balance tool cuts the JSON at 6,000
  // characters, and with ~86 tills the rows used to push every total past it.
  return {
    cashUsd: money(cashUsd),
    /** Payments received and placed in no till yet (A2). */
    unplacedUsd,
    unplacedCount: Number(unplaced?.n ?? 0),
    /** Clients' outstanding balance — Σ positive balances, the /finance total. */
    receivableUsd: receivable,
    /** Clients who paid ahead — money we owe them back in service (R7a). */
    clientAdvancesUsd: clientAdvances,
    /** Cargo costs waiting for the accountant to name their kassa (0101) — in the net (U02). */
    unplacedCostCount: unplacedCosts.count,
    unplacedCostUsd: unplacedCosts.usd,
    /** Counterparties we still have to pay. */
    payableUsd: money(owedByUs),
    /** Counterparties who are in front on their account. */
    partnerReceivableUsd: money(owedToUsByPartners),
    /** Seller commissions owed on jobs the client has paid for (U10) — in the net. */
    sellerCommissionsUsd: commissions.payableUsd,
    sellerCommissionsCount: commissions.payableCount,
    netUsd: money(net),
    uzsRate: rate,
    /** Money in boxes with no rate for their currency — OUT of the net, named (U14). */
    unratedTills: [...unratedByCurrency.values()],
    /** Boxes below zero — IN the net as they stand, flagged (U14, answer a). */
    negativeTills,
    cashRows,
  };
}
