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
import { batchLandedCostTotals, rateFor } from '../costing/service';
import { clientBalances, unplacedPaymentSql } from '../finance/service';
import { internalLegSql } from '../batches/internal';
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
  const [received] = await db
    .select({ sum: sql<string>`coalesce(sum(${clientTransactions.amountUsd}), 0)` })
    .from(clientTransactions)
    .where(
      and(
        eq(clientTransactions.type, 'payment'),
        isNull(clientTransactions.voidedAt),
        // A payment made into a PARTNER's account never reached a cash box of
        // ours (round 39). Counting it as money received would report cash we
        // cannot spend — the one lie a cash-flow report must not tell.
        isNull(clientTransactions.partnerId),
        gte(clientTransactions.txDate, from),
        lte(clientTransactions.txDate, to),
      ),
    );

  // Money handed BACK to clients (R6a). Always out of a kassa of ours — the
  // refund CHECK demands one — so it is cash that left, never a price.
  const [refunded] = await db
    .select({ sum: sql<string>`coalesce(sum(${clientTransactions.amountUsd}), 0)` })
    .from(clientTransactions)
    .where(
      and(
        eq(clientTransactions.type, 'refund'),
        isNull(clientTransactions.voidedAt),
        gte(clientTransactions.txDate, from),
        lte(clientTransactions.txDate, to),
      ),
    );

  // Money a counterparty put INTO one of our accounts — the cash buyers' first
  // leg. It is real cash in, and we owe it, but the debt is not this report's
  // business; this report answers only "what moved".
  const [partnerIn] = await db
    .select({ sum: sql<string>`coalesce(sum(${partnerTransactions.amountUsd}), 0)` })
    .from(partnerTransactions)
    .where(
      and(
        eq(partnerTransactions.type, 'receipt'),
        isNull(partnerTransactions.voidedAt),
        gte(partnerTransactions.txDate, from),
        lte(partnerTransactions.txDate, to),
      ),
    );
  const [partnerOut] = await db
    .select({ sum: sql<string>`coalesce(sum(${partnerTransactions.amountUsd}), 0)` })
    .from(partnerTransactions)
    .where(
      and(
        eq(partnerTransactions.type, 'payment'),
        isNull(partnerTransactions.voidedAt),
        gte(partnerTransactions.txDate, from),
        lte(partnerTransactions.txDate, to),
      ),
    );

  const outRows = await db
    .select({
      label: expenseCategories.name,
      sum: sql<string>`sum(${expenses.amountUsd})`,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenses.categoryId, expenseCategories.id))
    .where(
      and(
        isNull(expenses.voidedAt),
        eq(expenseCategories.cash, true),
        // Settled by a partner out of their own account: ours never opened.
        isNull(expenses.partnerId),
        gte(expenses.expenseDate, from),
        lte(expenses.expenseDate, to),
      ),
    )
    .groupBy(expenseCategories.name, expenseCategories.sortOrder)
    .orderBy(expenseCategories.sortOrder);

  const [cargoCosts] = await db
    .select({ sum: sql<string>`coalesce(sum(coalesce(${costEntries.amountUsd}, 0)), 0)` })
    .from(costEntries)
    .where(
      and(
        isNull(costEntries.voidedAt),
        // Same rule as the expenses above: a truck the transport company is
        // still owed for has cost us nothing in CASH yet.
        isNull(costEntries.partnerId),
        gte(costEntries.costDate, from),
        lte(costEntries.costDate, to),
      ),
    );

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

  const partnerInflow = money(partnerIn?.sum);
  const partnerOutflow = money(partnerOut?.sum);
  const refundOutflow = money(refunded?.sum);
  const inflow = money(received?.sum) + partnerInflow;
  const outflow =
    money(cargoCosts?.sum) +
    partnerOutflow +
    refundOutflow +
    outRows.reduce((acc, row) => acc + money(row.sum), 0);
  return {
    inflow: money(inflow),
    outflow: money(outflow),
    net: money(inflow - outflow),
    /** Informational: transfers are excluded from both sides on purpose. */
    transferCount: Number(transfers?.n ?? 0),
    rows: [
      { label: 'clientPayments', kind: 'in' as const, amountUsd: money(received?.sum) },
      ...(partnerInflow
        ? [{ label: 'partnerIn', kind: 'in' as const, amountUsd: partnerInflow }]
        : []),
      { label: 'cargoCosts', kind: 'out' as const, amountUsd: money(cargoCosts?.sum) },
      ...(partnerOutflow
        ? [{ label: 'partnerOut', kind: 'out' as const, amountUsd: partnerOutflow }]
        : []),
      ...(refundOutflow
        ? [{ label: 'clientRefunds', kind: 'out' as const, amountUsd: refundOutflow }]
        : []),
      ...outRows.map((row) => ({
        label: row.label,
        kind: 'out' as const,
        amountUsd: money(row.sum),
      })),
    ],
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
    { clientCode: string; clientName: string; balance: number; buckets: number[] }
  >();

  // Payments settle the OLDEST charge first (standard AR practice), so a
  // client who pays regularly never looks 90 days overdue on new cargo.
  const charges = new Map<string, { date: string; amount: number }[]>();
  for (const row of rows) {
    const entry =
      byClient.get(row.clientId) ?? {
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
  const { accountBalances } = await import('./service');
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
  const counted = accounts.filter(
    (account) => account.active || Math.abs(account.balance) > 0.009,
  );
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
        balance: account.balance,
        retired: !account.active,
        /** null when no rate has been entered for that currency yet. */
        balanceUsd: usd === null ? null : Math.round(usd * 100) / 100,
      };
    });

  // What clients owe us — split the way the partner side below always was
  // (R7a). One netted sum let a prepaid client's advance shrink «qarz», so
  // the Balans line read LESS than the /finance total it links to (audit
  // A3/A16/A28), while the advance — money we owe back in service — appeared
  // nowhere as a liability. `clientBalances` is the /finance screen's own
  // function, so the two cannot drift: debtors are its positive balances,
  // advances its negative ones. The net is unchanged; its parts become true.
  const clientRows = await clientBalances();
  let receivable = 0;
  let clientAdvances = 0;
  for (const row of clientRows) {
    if (row.balanceUsd > 0) receivable += row.balanceUsd;
    else clientAdvances += -row.balanceUsd;
  }

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
  // line for their kassa (`placePayment`). Only since cash boxes exist — a
  // payment from before then is inside some box's counted opening balance.
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

  const net = cashUsd + unplacedUsd + receivable + owedToUsByPartners - owedByUs - clientAdvances;

  // The totals FIRST: the AI's company_balance tool cuts the JSON at 6,000
  // characters, and with ~86 tills the rows used to push every total past it.
  return {
    cashUsd: money(cashUsd),
    /** Payments received and placed in no till yet (A2). */
    unplacedUsd,
    unplacedCount: Number(unplaced?.n ?? 0),
    /** Clients' outstanding balance — Σ positive balances, the /finance total. */
    receivableUsd: money(receivable),
    /** Clients who paid ahead — money we owe them back in service (R7a). */
    clientAdvancesUsd: money(clientAdvances),
    /** Counterparties we still have to pay. */
    payableUsd: money(owedByUs),
    /** Counterparties who are in front on their account. */
    partnerReceivableUsd: money(owedToUsByPartners),
    netUsd: money(net),
    uzsRate: rate,
    cashRows,
  };
}
