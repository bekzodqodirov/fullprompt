import { and, eq, gte, isNull, lte, sql } from 'drizzle-orm';
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
} from '../../platform/db/schema';

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
 * `profitByBatch`, which matches a batch's revenue against its own costs and
 * is therefore free of any period effect.
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
        gte(clientTransactions.txDate, from),
        lte(clientTransactions.txDate, to),
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

  const inflow = money(received?.sum);
  const outflow =
    money(cargoCosts?.sum) + outRows.reduce((acc, row) => acc + money(row.sum), 0);
  return {
    inflow,
    outflow: money(outflow),
    net: money(inflow - outflow),
    /** Informational: transfers are excluded from both sides on purpose. */
    transferCount: Number(transfers?.n ?? 0),
    rows: [
      { label: 'clientPayments', kind: 'in' as const, amountUsd: inflow },
      { label: 'cargoCosts', kind: 'out' as const, amountUsd: money(cargoCosts?.sum) },
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
    if (row.type === 'charge') {
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
 * Profit per batch — revenue charged for it against the costs booked to it.
 *
 * Period-free by construction: both sides belong to the same batch whatever
 * month they were entered, which is why this and not the monthly P&L answers
 * "did this trip earn money?".
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
      revenueUsd: sql<string>`coalesce((
        SELECT sum(ct.amount_usd) FROM client_transactions ct
        WHERE ct.batch_id = ${batches}.id AND ct.type = 'charge' AND ct.voided_at IS NULL
      ), 0)`,
      costUsd: sql<string>`coalesce((
        SELECT sum(coalesce(ce.amount_usd, 0)) FROM cost_entries ce
        WHERE ce.batch_id = ${batches}.id AND ce.voided_at IS NULL
      ), 0)`,
      boxCount: sql<number>`coalesce((
        SELECT count(*) FROM box_movements bm
        WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batches}.id AND bm.cause = 'batch_departed'
      ), 0)`,
      kg: sql<string>`coalesce((
        SELECT sum(rl.total_weight_kg / rl.box_count) FROM box_movements bm
        JOIN boxes b ON b.id = bm.box_id
        JOIN receipt_lots rl ON rl.id = b.lot_id
        WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batches}.id AND bm.cause = 'batch_departed'
      ), 0)`,
      m3: sql<string>`coalesce((
        SELECT sum(rl.total_volume_m3 / rl.box_count) FROM box_movements bm
        JOIN boxes b ON b.id = bm.box_id
        JOIN receipt_lots rl ON rl.id = b.lot_id
        WHERE bm.ref_type = 'batch' AND bm.ref_id = ${batches}.id AND bm.cause = 'batch_departed'
      ), 0)`,
    })
    .from(batches)
    .where(
      and(
        sql`${batches.departedAt} IS NOT NULL`,
        sql`${batches.departedAt} >= ${from}::date`,
        sql`${batches.departedAt} < (${to}::date + interval '1 day')`,
      ),
    )
    .orderBy(sql`${batches.departedAt} DESC`);

  return rows.map((row) => {
    const revenue = money(row.revenueUsd);
    const cost = money(row.costUsd);
    const profit = money(revenue - cost);
    const kg = Math.round(Number(row.kg) * 10) / 10;
    const m3 = Math.round(Number(row.m3) * 1000) / 1000;
    return {
      batchId: row.batchId,
      code: row.code,
      route: `${row.originCode} → ${row.destCode}`,
      status: row.status,
      departedAt: row.departedAt,
      boxCount: Number(row.boxCount),
      kg,
      m3,
      revenueUsd: revenue,
      costUsd: cost,
      profitUsd: profit,
      marginPct: revenue ? Math.round((profit / revenue) * 1000) / 10 : 0,
      profitPerKg: kg ? Math.round((profit / kg) * 100) / 100 : 0,
      profitPerM3: m3 ? Math.round((profit / m3) * 100) / 100 : 0,
    };
  });
}

/**
 * Profit per client — charges against the costs allocated to that client's
 * boxes by the M6 engine, so shared truck costs are split fairly by weight or
 * volume rather than guessed.
 */
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

  return revenueRows
    .map((row) => {
      const revenue = money(row.revenueUsd);
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

/** The same numbers rolled up per corridor (YW → TAS and so on). */
export async function profitByRoute(from: string, to: string) {
  const batchRows = await profitByBatch(from, to);
  const byRoute = new Map<
    string,
    { route: string; batches: number; boxCount: number; kg: number; revenueUsd: number; costUsd: number }
  >();
  for (const row of batchRows) {
    const entry =
      byRoute.get(row.route) ?? {
        route: row.route,
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
      const profit = money(entry.revenueUsd - entry.costUsd);
      return {
        ...entry,
        profitUsd: profit,
        marginPct: entry.revenueUsd ? Math.round((profit / entry.revenueUsd) * 1000) / 10 : 0,
        profitPerKg: entry.kg ? Math.round((profit / entry.kg) * 100) / 100 : 0,
      };
    })
    .sort((a, b) => b.profitUsd - a.profitUsd);
}
