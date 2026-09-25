import { createHash } from 'node:crypto';
import { desc, eq, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import { withoutJit } from '../../platform/db/no-jit';
import { fxRates } from '../../platform/db/schema';
import { writeAudit, writeAuditMany, type AuditContext } from '../../platform/audit/service';
import { toUsd } from './engine';
import { fxRateSchema, unplacedCostSql } from './service';
import { fxWindowTx, governingRateSql, windowSql } from './fx-window';
import {
  fxCyclesFor,
  fxSettingsTx,
  isAutomatic,
  lockOwnersTx,
  ownersSql,
  reconcileFxResidueTx,
  type FxChange,
  type FxLedger,
} from '../finance/fx-residue';
import { FX_PNL_SIGN } from '../finance/fx-sign';
import { partnerSignedSql } from '../partners/ledger-sign';

/**
 * Q18 (the owner's answer, 2026-09-25): «qarzdorliklarning qiymati o'zgarsa
 * bo'ladi, lekin biz uje to'lab bergan to'lovlar o'zgarmasligi kerak … saqlashdan
 * oldin nima o'zgarishini ko'rsat». A rate typed late or corrected re-prices
 * the DEBTS it governs — a firm's credit and its charge (together, A0), the
 * costs waiting for a kassa, a partner-settled expense and its charge, a
 * client's price — and the tannarx of a kassa-paid cost; it never moves a
 * payment (`account_amount_usd`, a ledger payment/receipt/refund, a transfer).
 *
 * The preview IS the apply, observed and undone: one transaction plans,
 * writes, reconciles the kurs farqi (§5.5) and measures the balances; when
 * something moved and the person has not yet confirmed THIS plan (its hash),
 * `ConfirmNeeded` rolls everything back — the rate row included. A plan that
 * changed between the preview and the press has another hash and is shown
 * again. The sweeps (`recomputeAll`, `recomputeEntry`) still never re-price
 * (R1, fence F4): this is the only writer, reached from /admin/fx alone.
 */

/** No limit on how far back a corrected rate reaches (open question 2, answer a). A month here would be the limit. */
export const REPRICE_OLDEST_MONTH: string | null = null;

export type FxWindow = { from: string | null; to: string | null };

export interface Change {
  id: string;
  ownerId: string | null;
  date: string;
  amount: number;
  oldRate: string;
  newRate: string;
  oldUsd: number;
  newUsd: number;
  /** A kassa-paid cost's cash day (the merged expense's, else its own) — where «Kurs farqi (kassa)» lands. */
  cashDay?: string;
}

export interface RepricePlan {
  currency: string;
  scope: { kind: 'rate'; date: string; window: FxWindow } | { kind: 'month'; month: string };
  /** Debt costs (a firm's or a colleague's credit) and the queue's (no kassa named yet). */
  costs: Change[];
  /** Kassa-paid and merged costs: the tannarx only — what left the kassa never moves. */
  kassaCosts: Change[];
  costCharges: Change[];
  manualCharges: Change[];
  expenses: Change[];
  expenseCharges: Change[];
  clientCharges: Change[];
  fx: FxChange[];
  balances: { ledger: FxLedger; ownerId: string; label: string; before: number; after: number }[];
  settledOld: number;
  kassaMissing: number;
  frozenPayments: number;
  waitingCount: number;
  months: Record<string, { revenue: number; direct: number; opex: number; fx: number; net: number }>;
  hash: string;
}

export class ConfirmNeeded extends Error {
  constructor(public readonly plan: RepricePlan) {
    super('confirm_needed');
  }
}

export class RepriceError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Anything that can run a read: the pool, a transaction, or `withoutJit`'s handle. */
type Handle = Pick<Db, 'execute'>;
const num = (value: unknown) => Number(value ?? 0);
/** Both rates are numeric(24,12): copied through Number, which U40 verified compares exactly. */
const rateText = (value: unknown) => String(Number(value));
const cents = (value: number) => Math.round(value * 100) / 100;
const rows = async <T>(handle: Handle, query: SQL) => [...((await handle.execute(query)) as unknown as T[])];
const ids = (list: string[]) =>
  sql.join(
    list.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
const gov = (table: string, dateCol: string) =>
  governingRateSql(sql.raw(`${table}.currency`), sql.raw(`${table}.${dateCol}`));

function clampWindow(win: FxWindow): FxWindow {
  if (!REPRICE_OLDEST_MONTH) return win;
  const floor = `${REPRICE_OLDEST_MONTH}-01`;
  return { from: !win.from || win.from < floor ? floor : win.from, to: win.to };
}

function monthWindow(month: string): FxWindow {
  const [year, mon] = month.split('-').map(Number);
  const next = mon === 12 ? `${year! + 1}-01-01` : `${year}-${String(mon! + 1).padStart(2, '0')}-01`;
  return { from: `${month}-01`, to: next };
}

type Filter = { currency: string | null; win: FxWindow | null; since: string; lock: boolean };

function currencyOf(table: string, currency: string | null): SQL {
  return currency ? sql` AND ${sql.raw(`${table}.currency`)} = ${currency}` : sql` AND ${sql.raw(`${table}.currency`)} <> 'USD'`;
}
function windowOf(table: string, col: string, win: FxWindow | null): SQL {
  return win ? windowSql(sql.raw(`${table}.${col}`), win) : sql``;
}
const lockOf = (table: string, lock: boolean) => (lock ? sql` FOR UPDATE OF ${sql.raw(table)}` : sql``);

type CostRow = {
  id: string;
  currency: string;
  partner_id: string | null;
  account_id: string | null;
  account_amount_usd: string | null;
  merged_expense_id: string | null;
  cost_date: string;
  cash_day: string | null;
  amount: string;
  fx_rate_used: string;
  amount_usd: string;
  rate: string;
};
type LedgerRow = { id: string; currency: string; owner_id: string; day: string; amount: string; rate_to_usd: string; amount_usd: string; rate: string };

/** Costs off their day's rate: debt, queue, kassa-paid and merged ones (the design's plan statement). */
function costCandidates(f: Filter): SQL {
  return sql`
    SELECT cost_entries.id, cost_entries.currency, cost_entries.partner_id, cost_entries.account_id,
           cost_entries.account_amount_usd, cost_entries.merged_expense_id,
           cost_entries.cost_date::text AS cost_date, me.expense_date::text AS cash_day,
           cost_entries.amount, cost_entries.fx_rate_used, cost_entries.amount_usd,
           ${gov('cost_entries', 'cost_date')} AS rate
      FROM cost_entries
      LEFT JOIN expenses me ON me.id = cost_entries.merged_expense_id
     WHERE cost_entries.voided_at IS NULL${currencyOf('cost_entries', f.currency)}
       AND cost_entries.amount_usd IS NOT NULL AND cost_entries.fx_rate_used IS NOT NULL
       AND (cost_entries.partner_id IS NOT NULL OR cost_entries.account_id IS NOT NULL
            OR cost_entries.merged_expense_id IS NOT NULL OR ${unplacedCostSql(f.since)})
       ${windowOf('cost_entries', 'cost_date', f.win)}
       AND cost_entries.fx_rate_used IS DISTINCT FROM ${gov('cost_entries', 'cost_date')}
     ORDER BY cost_entries.id${lockOf('cost_entries', f.lock)}`;
}

/** A partner-settled expense (a firm paid, we owe it) off its day's rate. */
function expenseCandidates(f: Filter): SQL {
  return sql`
    SELECT expenses.id, expenses.currency, expenses.partner_id AS owner_id, expenses.expense_date::text AS day,
           expenses.amount, expenses.rate_to_usd, expenses.amount_usd, ${gov('expenses', 'expense_date')} AS rate
      FROM expenses
     WHERE expenses.voided_at IS NULL AND expenses.partner_id IS NOT NULL${currencyOf('expenses', f.currency)}
       ${windowOf('expenses', 'expense_date', f.win)}
       AND expenses.rate_to_usd IS DISTINCT FROM ${gov('expenses', 'expense_date')}
     ORDER BY expenses.id${lockOf('expenses', f.lock)}`;
}

/** A firm's charge typed by hand before the kind left the card (no cost, no expense behind it). */
function manualChargeCandidates(f: Filter): SQL {
  return sql`
    SELECT partner_transactions.id, partner_transactions.currency, partner_transactions.partner_id AS owner_id,
           partner_transactions.tx_date::text AS day, partner_transactions.amount,
           partner_transactions.rate_to_usd, partner_transactions.amount_usd, ${gov('partner_transactions', 'tx_date')} AS rate
      FROM partner_transactions
     WHERE partner_transactions.voided_at IS NULL AND partner_transactions.type = 'charge'
       AND partner_transactions.cost_entry_id IS NULL AND partner_transactions.expense_id IS NULL
       ${currencyOf('partner_transactions', f.currency)}
       ${windowOf('partner_transactions', 'tx_date', f.win)}
       AND partner_transactions.rate_to_usd IS DISTINCT FROM ${gov('partner_transactions', 'tx_date')}
     ORDER BY partner_transactions.id${lockOf('partner_transactions', f.lock)}`;
}

/** A client's price off its day's rate. */
function clientChargeCandidates(f: Filter): SQL {
  return sql`
    SELECT client_transactions.id, client_transactions.currency, client_transactions.client_id AS owner_id,
           client_transactions.tx_date::text AS day, client_transactions.amount,
           client_transactions.rate_to_usd, client_transactions.amount_usd, ${gov('client_transactions', 'tx_date')} AS rate
      FROM client_transactions
     WHERE client_transactions.voided_at IS NULL AND client_transactions.type = 'charge'
       ${currencyOf('client_transactions', f.currency)}
       ${windowOf('client_transactions', 'tx_date', f.win)}
       AND client_transactions.rate_to_usd IS DISTINCT FROM ${gov('client_transactions', 'tx_date')}
     ORDER BY client_transactions.id${lockOf('client_transactions', f.lock)}`;
}

/** The charges a cost or an expense wrote — they move WITH it, never apart (A0). */
async function derivedCharges(handle: Handle, column: 'cost_entry_id' | 'expense_id', parents: string[], lock: boolean) {
  if (parents.length === 0) return [];
  return rows<{ id: string; owner_id: string; parent_id: string; day: string; amount: string; rate_to_usd: string; amount_usd: string }>(
    handle,
    sql`
    SELECT partner_transactions.id, partner_transactions.partner_id AS owner_id,
           partner_transactions.${sql.raw(column)} AS parent_id, partner_transactions.tx_date::text AS day,
           partner_transactions.amount, partner_transactions.rate_to_usd, partner_transactions.amount_usd
      FROM partner_transactions
     WHERE partner_transactions.voided_at IS NULL AND partner_transactions.type = 'charge'
       AND partner_transactions.${sql.raw(column)} IN (${ids(parents)})
     ORDER BY partner_transactions.id${lockOf('partner_transactions', lock)}`,
  );
}

const ledgerChange = (row: LedgerRow): Change => ({
  id: row.id,
  ownerId: row.owner_id,
  date: row.day,
  amount: num(row.amount),
  oldRate: rateText(row.rate_to_usd),
  newRate: rateText(row.rate),
  oldUsd: num(row.amount_usd),
  newUsd: toUsd(num(row.amount), Number(row.rate)),
});

type Candidates = {
  costs: Change[];
  kassaCosts: Change[];
  costCharges: Change[];
  manualCharges: Change[];
  expenses: Change[];
  expenseCharges: Change[];
  clientCharges: Change[];
  kassaMissing: number;
  settledOld: number;
  currencies: Map<string, string>;
};

/**
 * Every debt (and kassa tannarx) off its day's rate — the plan's rows, and
 * the stale review's — with the SETTLED history dropped: a ledger debt inside
 * a closed cycle the reconciler does not manage (a firm's pre-deploy history,
 * a flagged client cycle, anything with the switch off) would move a settled
 * account's balance with nothing to close the residue (money-4). Dropped with
 * its cost or expense (A0), and counted.
 */
async function candidates(handle: Handle, f: Filter): Promise<Candidates> {
  const costRows = await rows<CostRow>(handle, costCandidates(f));
  const currencies = new Map<string, string>();
  const costs: Change[] = [];
  const debtCosts: Change[] = [];
  const kassaCosts: Change[] = [];
  let kassaMissing = 0;
  for (const row of costRows) {
    currencies.set(row.id, row.currency);
    const change: Change = {
      id: row.id,
      ownerId: row.partner_id,
      date: row.cost_date,
      amount: num(row.amount),
      oldRate: rateText(row.fx_rate_used),
      newRate: rateText(row.rate),
      oldUsd: num(row.amount_usd),
      newUsd: toUsd(num(row.amount), Number(row.rate)),
      cashDay: row.cash_day ?? row.cost_date,
    };
    if (row.partner_id) debtCosts.push(change);
    else if (row.account_id || row.merged_expense_id) {
      // A kassa with no dollars yet (a rateless kassa): moving amount_usd would
      // move the kassa's dollars through `costKassaUsd`'s fallback — skipped.
      if (row.account_amount_usd === null) kassaMissing += 1;
      else kassaCosts.push(change);
    } else costs.push(change);
  }
  const expenseRows = await rows<LedgerRow>(handle, expenseCandidates(f));
  const manualRows = await rows<LedgerRow>(handle, manualChargeCandidates(f));
  const clientRows = await rows<LedgerRow>(handle, clientChargeCandidates(f));
  for (const row of [...expenseRows, ...manualRows, ...clientRows]) currencies.set(row.id, row.currency);
  let expenses = expenseRows.map(ledgerChange);
  let manualCharges = manualRows.map(ledgerChange);
  let clientCharges = clientRows.map(ledgerChange);

  const byCost = new Map(debtCosts.map((change) => [change.id, change]));
  const byExpense = new Map(expenses.map((change) => [change.id, change]));
  const follow = (parent: Change | undefined, row: { id: string; owner_id: string; day: string; amount: string; rate_to_usd: string; amount_usd: string }): Change => ({
    id: row.id,
    ownerId: row.owner_id,
    date: row.day,
    amount: num(row.amount),
    oldRate: rateText(row.rate_to_usd),
    newRate: parent!.newRate,
    oldUsd: num(row.amount_usd),
    newUsd: parent!.newUsd,
  });
  const costChargeRows = await derivedCharges(handle, 'cost_entry_id', [...byCost.keys()], f.lock);
  const expenseChargeRows = await derivedCharges(handle, 'expense_id', [...byExpense.keys()], f.lock);
  let costCharges = costChargeRows.map((row) => ({ ...follow(byCost.get(row.parent_id), row), parent: row.parent_id }));
  let expenseCharges = expenseChargeRows.map((row) => ({ ...follow(byExpense.get(row.parent_id), row), parent: row.parent_id }));

  // Settled history: walk the owners of the ledger debts.
  const { since: fxSince, autoOn } = await fxSettingsTx(handle);
  const settled = new Set<string>();
  const clientOwners = [...new Set(clientCharges.map((change) => change.ownerId!))];
  const partnerOwners = [...new Set([...costCharges, ...expenseCharges, ...manualCharges].map((change) => change.ownerId!))];
  for (const [ledger, owners, debts] of [
    ['client', clientOwners, clientCharges],
    ['partner', partnerOwners, [...costCharges, ...expenseCharges, ...manualCharges]],
  ] as const) {
    if (owners.length === 0) continue;
    const cycles = await fxCyclesFor(handle, ledger, ownersSql(ledger, owners), fxSince);
    const cycleOf = new Map<string, (typeof cycles)[number]>();
    for (const cycle of cycles) for (const id of cycle.rowIds) cycleOf.set(id, cycle);
    for (const debt of debts) {
      const cycle = cycleOf.get(debt.id);
      // «Would the reconciler close what this re-price leaves behind?» — asked
      // of the cycle as if it had a residue: a pair at one rate closes at $0
      // today, and a re-price is exactly what gives it one.
      if (cycle && cycle.closed && !isAutomatic({ ...cycle, residueCents: cycle.residueCents || 1 }, autoOn)) {
        settled.add(debt.id);
      }
    }
  }
  const droppedCosts = new Set(costCharges.filter((c) => settled.has(c.id)).map((c) => c.parent));
  const droppedExpenses = new Set(expenseCharges.filter((c) => settled.has(c.id)).map((c) => c.parent));
  const settledOld = settled.size;
  clientCharges = clientCharges.filter((change) => !settled.has(change.id));
  manualCharges = manualCharges.filter((change) => !settled.has(change.id));
  costCharges = costCharges.filter((change) => !settled.has(change.id));
  expenseCharges = expenseCharges.filter((change) => !settled.has(change.id));
  expenses = expenses.filter((change) => !droppedExpenses.has(change.id));
  const keptDebtCosts = debtCosts.filter((change) => !droppedCosts.has(change.id));

  const strip = (list: (Change & { parent?: string })[]): Change[] => list.map(({ parent: _parent, ...change }) => change);
  return {
    costs: [...keptDebtCosts, ...costs],
    kassaCosts,
    costCharges: strip(costCharges),
    manualCharges,
    expenses,
    expenseCharges: strip(expenseCharges),
    clientCharges,
    kassaMissing,
    settledOld,
    currencies,
  };
}

/**
 * The payments a re-price leaves alone and says so (regression-6): a client
 * payment or refund, a firm's payment/receipt/correction, a kassa expense,
 * a cost's KASSA side in this currency, a legacy kassa-less cost — whose
 * stored rate is not its day's. Never re-priced: a wrong one is voided and
 * entered again by the person.
 */
function frozenPaymentsSql(f: Filter): SQL {
  const kassaSide = sql`
    SELECT cost_entries.id, ma.currency, cost_entries.cost_date::text AS day, 'cost_kassa' AS kind,
           cost_entries.account_id AS owner_id, ma.name AS label, cost_entries.account_amount AS amount,
           cost_entries.account_rate_used AS stored_rate,
           ${governingRateSql(sql.raw('ma.currency'), sql.raw('cost_entries.cost_date'))} AS day_rate
      FROM cost_entries JOIN money_accounts ma ON ma.id = cost_entries.account_id
     WHERE cost_entries.voided_at IS NULL AND cost_entries.account_rate_used IS NOT NULL
       AND ${f.currency ? sql`ma.currency = ${f.currency}` : sql`ma.currency <> 'USD'`}
       ${windowOf('cost_entries', 'cost_date', f.win)}
       AND cost_entries.account_rate_used IS DISTINCT FROM ${governingRateSql(sql.raw('ma.currency'), sql.raw('cost_entries.cost_date'))}`;
  const legacyCosts = sql`
    SELECT cost_entries.id, cost_entries.currency, cost_entries.cost_date::text AS day, 'cost_legacy' AS kind,
           cost_entries.batch_id AS owner_id, NULL AS label, cost_entries.amount,
           cost_entries.fx_rate_used AS stored_rate, ${gov('cost_entries', 'cost_date')} AS day_rate
      FROM cost_entries
     WHERE cost_entries.voided_at IS NULL AND cost_entries.partner_id IS NULL AND cost_entries.account_id IS NULL
       AND cost_entries.merged_expense_id IS NULL AND cost_entries.fx_rate_used IS NOT NULL
       AND NOT ${unplacedCostSql(f.since)}${currencyOf('cost_entries', f.currency)}
       ${windowOf('cost_entries', 'cost_date', f.win)}
       AND cost_entries.fx_rate_used IS DISTINCT FROM ${gov('cost_entries', 'cost_date')}`;
  const ledger = (table: 'client_transactions' | 'partner_transactions', kinds: string[], owner: string) => sql`
    SELECT ${sql.raw(table)}.id, ${sql.raw(table)}.currency, ${sql.raw(table)}.tx_date::text AS day,
           ${sql.raw(table)}.type AS kind, ${sql.raw(`${table}.${owner}`)} AS owner_id, NULL AS label,
           ${sql.raw(table)}.amount, ${sql.raw(table)}.rate_to_usd AS stored_rate, ${gov(table, 'tx_date')} AS day_rate
      FROM ${sql.raw(table)}
     WHERE ${sql.raw(table)}.voided_at IS NULL AND ${sql.raw(table)}.type IN (${sql.join(
       kinds.map((kind) => sql`${kind}`),
       sql`, `,
     )})${currencyOf(table, f.currency)}
       ${windowOf(table, 'tx_date', f.win)}
       AND ${sql.raw(table)}.rate_to_usd IS DISTINCT FROM ${gov(table, 'tx_date')}`;
  const kassaExpenses = sql`
    SELECT expenses.id, expenses.currency, expenses.expense_date::text AS day, 'expense' AS kind,
           expenses.account_id AS owner_id, NULL AS label, expenses.amount,
           expenses.rate_to_usd AS stored_rate, ${gov('expenses', 'expense_date')} AS day_rate
      FROM expenses
     WHERE expenses.voided_at IS NULL AND expenses.partner_id IS NULL AND expenses.account_id IS NOT NULL
       ${currencyOf('expenses', f.currency)}
       ${windowOf('expenses', 'expense_date', f.win)}
       AND expenses.rate_to_usd IS DISTINCT FROM ${gov('expenses', 'expense_date')}`;
  return sql`(${ledger('client_transactions', ['payment', 'refund'], 'client_id')})
    UNION ALL (${ledger('partner_transactions', ['payment', 'receipt', 'adjust'], 'partner_id')})
    UNION ALL (${kassaExpenses}) UNION ALL (${kassaSide}) UNION ALL (${legacyCosts})`;
}

async function balancesTx(tx: Tx, ledger: FxLedger, owners: string[]): Promise<Map<string, number>> {
  if (owners.length === 0) return new Map();
  const found =
    ledger === 'client'
      ? await rows<{ id: string; b: string }>(
          tx,
          sql`SELECT client_id AS id, coalesce(sum(CASE WHEN type = 'payment' THEN -amount_usd ELSE amount_usd END), 0) AS b
                FROM client_transactions WHERE voided_at IS NULL AND client_id IN (${ids(owners)}) GROUP BY client_id`,
        )
      : await rows<{ id: string; b: string }>(
          tx,
          sql`SELECT t.partner_id AS id, coalesce(sum(${partnerSignedSql('amount_usd', 't')}), 0) AS b
                FROM partner_transactions t WHERE t.voided_at IS NULL AND t.partner_id IN (${ids(owners)}) GROUP BY t.partner_id`,
        );
  return new Map(found.map((row) => [row.id, cents(num(row.b))]));
}

/** One set-based UPDATE per table (regression-9); the kassa's own columns are never in the SET (fence F4). */
async function applyValues(
  tx: Tx,
  table: 'cost_entries' | 'partner_transactions' | 'expenses' | 'client_transactions',
  rateCol: 'fx_rate_used' | 'rate_to_usd',
  changes: Change[],
): Promise<void> {
  if (changes.length === 0) return;
  const values = sql.join(
    changes.map((c) => sql`(${c.id}::uuid, ${c.oldRate}::numeric, ${c.newRate}::numeric, ${c.newUsd.toFixed(2)}::numeric)`),
    sql`, `,
  );
  const done = await rows<{ id: string }>(
    tx,
    sql`UPDATE ${sql.raw(table)} t SET amount_usd = v.new_usd, ${sql.raw(rateCol)} = v.new_rate
          FROM (VALUES ${values}) AS v(id, old_rate, new_rate, new_usd)
         WHERE t.id = v.id AND t.voided_at IS NULL AND t.${sql.raw(rateCol)} = v.old_rate
        RETURNING t.id`,
  );
  // Locked FOR UPDATE above, so a missing row is a bug, not a race.
  if (done.length !== changes.length) throw new RepriceError('stale_plan');
}

const AUDIT_TYPE = {
  cost_entries: 'cost_entry',
  partner_transactions: 'partner_transaction',
  expenses: 'expense',
  client_transactions: 'client_transaction',
} as const;

function monthsOf(plan: Pick<RepricePlan, 'costs' | 'kassaCosts' | 'expenses' | 'clientCharges' | 'fx'>): RepricePlan['months'] {
  const months: RepricePlan['months'] = {};
  const add = (day: string, key: 'revenue' | 'direct' | 'opex' | 'fx', value: number) => {
    if (Math.abs(value) < 0.005) return;
    const month = day.slice(0, 7);
    const row = (months[month] ??= { revenue: 0, direct: 0, opex: 0, fx: 0, net: 0 });
    row[key] = cents(row[key] + value);
  };
  for (const c of plan.clientCharges) add(c.date, 'revenue', c.newUsd - c.oldUsd);
  for (const c of [...plan.costs, ...plan.kassaCosts]) add(c.date, 'direct', c.newUsd - c.oldUsd);
  // «Kurs farqi (kassa)» = tannarx − what left the kassa, on the cash day.
  for (const c of plan.kassaCosts) add(c.cashDay ?? c.date, 'fx', c.newUsd - c.oldUsd);
  for (const c of plan.expenses) add(c.date, 'opex', c.newUsd - c.oldUsd);
  for (const change of plan.fx) add(`${change.month}-01`, 'fx', FX_PNL_SIGN[change.ledger] * change.amountUsd);
  for (const row of Object.values(months)) row.net = cents(row.revenue - row.direct - row.opex + row.fx);
  return months;
}

function hashOf(plan: Omit<RepricePlan, 'hash' | 'months' | 'frozenPayments' | 'waitingCount'>): string {
  const list = (changes: Change[]) =>
    [...changes].sort((a, b) => a.id.localeCompare(b.id)).map((c) => [c.id, c.oldRate, c.newRate, c.newUsd]);
  return createHash('sha256')
    .update(
      JSON.stringify({
        currency: plan.currency,
        scope: plan.scope,
        costs: list(plan.costs),
        kassaCosts: list(plan.kassaCosts),
        costCharges: list(plan.costCharges),
        manualCharges: list(plan.manualCharges),
        expenses: list(plan.expenses),
        expenseCharges: list(plan.expenseCharges),
        clientCharges: list(plan.clientCharges),
        fx: [...plan.fx]
          .map((f) => [f.ledger, f.ownerId, f.anchorId, f.currency, f.amountUsd, f.action])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        balances: [...plan.balances]
          .map((b) => [b.ledger, b.ownerId, b.before, b.after])
          .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
        settledOld: plan.settledOld,
        kassaMissing: plan.kassaMissing,
      }),
    )
    .digest('hex');
}

/** Did the plan move anything? A plan that moves nothing commits with no question. */
export function planMoves(plan: RepricePlan): boolean {
  return (
    plan.costs.length +
      plan.kassaCosts.length +
      plan.costCharges.length +
      plan.manualCharges.length +
      plan.expenses.length +
      plan.expenseCharges.length +
      plan.clientCharges.length +
      plan.fx.length >
    0
  );
}

/** The plan, written — in the caller's transaction, after the currency lock. */
async function planApply(tx: Tx, currency: string, win: FxWindow, since: string, ctx: AuditContext) {
  const f: Filter = { currency, win, since, lock: false };
  // (a) Whose accounts the plan can touch, read plainly; (b) their money
  // locks, clients before partners (§5.5.3); (c) the rows, FOR UPDATE.
  const preview = await candidates(tx, f);
  const clientIds = [...new Set(preview.clientCharges.map((c) => c.ownerId!))];
  const partnerIds = [
    ...new Set(
      [...preview.costs, ...preview.costCharges, ...preview.manualCharges, ...preview.expenses]
        .map((c) => c.ownerId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  await lockOwnersTx(tx, { clientIds, partnerIds });
  const got = await candidates(tx, { ...f, lock: true });
  // An owner that appeared between (a) and (c) is locked late (re-entrant).
  const lateClients = [...new Set(got.clientCharges.map((c) => c.ownerId!))].filter((id) => !clientIds.includes(id));
  const latePartners = [
    ...new Set(
      [...got.costs, ...got.costCharges, ...got.manualCharges, ...got.expenses]
        .map((c) => c.ownerId)
        .filter((id): id is string => Boolean(id)),
    ),
  ].filter((id) => !partnerIds.includes(id));
  if (lateClients.length || latePartners.length) await lockOwnersTx(tx, { clientIds: lateClients, partnerIds: latePartners });
  const owners = {
    clientIds: [...new Set(got.clientCharges.map((c) => c.ownerId!))],
    partnerIds: [
      ...new Set(
        [...got.costs, ...got.costCharges, ...got.manualCharges, ...got.expenses, ...got.expenseCharges]
          .map((c) => c.ownerId)
          .filter((id): id is string => Boolean(id)),
      ),
    ],
  };
  const before = {
    client: await balancesTx(tx, 'client', owners.clientIds),
    partner: await balancesTx(tx, 'partner', owners.partnerIds),
  };

  await applyValues(tx, 'cost_entries', 'fx_rate_used', [...got.costs, ...got.kassaCosts]);
  await applyValues(tx, 'partner_transactions', 'rate_to_usd', [...got.costCharges, ...got.expenseCharges, ...got.manualCharges]);
  await applyValues(tx, 'expenses', 'rate_to_usd', got.expenses);
  await applyValues(tx, 'client_transactions', 'rate_to_usd', got.clientCharges);
  const audit = (table: keyof typeof AUDIT_TYPE, list: Change[]) =>
    list.map((c) => ({
      entityType: AUDIT_TYPE[table],
      entityId: c.id,
      action: 'update' as const,
      before: { amountUsd: c.oldUsd, rate: c.oldRate },
      after: { amountUsd: c.newUsd, rate: c.newRate, from: 'fx_reprice', fxRate: { currency, date: c.date } },
    }));
  await writeAuditMany(tx, ctx, [
    ...audit('cost_entries', [...got.costs, ...got.kassaCosts]),
    ...audit('partner_transactions', [...got.costCharges, ...got.expenseCharges, ...got.manualCharges]),
    ...audit('expenses', got.expenses),
    ...audit('client_transactions', got.clientCharges),
  ]);

  // A re-priced debt against a frozen same-currency payment becomes a kurs
  // farqi; a residue that already had one is re-issued at the new figure.
  const fx = await reconcileFxResidueTx(tx, owners, ctx);

  const after = {
    client: await balancesTx(tx, 'client', owners.clientIds),
    partner: await balancesTx(tx, 'partner', owners.partnerIds),
  };
  const moved: { ledger: FxLedger; ownerId: string; before: number; after: number }[] = [];
  for (const ledger of ['client', 'partner'] as const) {
    const ownerIds = ledger === 'client' ? owners.clientIds : owners.partnerIds;
    for (const id of ownerIds) {
      const b = before[ledger].get(id) ?? 0;
      const a = after[ledger].get(id) ?? 0;
      if (Math.abs(a - b) > 0.009) moved.push({ ledger, ownerId: id, before: b, after: a });
    }
  }
  const labels = new Map<string, string>();
  const movedClients = moved.filter((m) => m.ledger === 'client').map((m) => m.ownerId);
  const movedPartners = moved.filter((m) => m.ledger === 'partner').map((m) => m.ownerId);
  if (movedClients.length) {
    for (const row of await rows<{ id: string; label: string }>(
      tx,
      sql`SELECT id, client_code || ' — ' || name AS label FROM clients WHERE id IN (${ids(movedClients)})`,
    ))
      labels.set(row.id, row.label);
  }
  if (movedPartners.length) {
    for (const row of await rows<{ id: string; label: string }>(tx, sql`SELECT id, name AS label FROM partners WHERE id IN (${ids(movedPartners)})`))
      labels.set(row.id, row.label);
  }
  const balances = moved.map((m) => ({ ...m, label: labels.get(m.ownerId) ?? m.ownerId }));

  const [frozen] = await rows<{ n: number }>(tx, sql`SELECT count(*)::int AS n FROM (${frozenPaymentsSql(f)}) p`);
  const [waiting] = await rows<{ n: number }>(
    tx,
    sql`SELECT count(*)::int AS n FROM cost_entries
         WHERE cost_entries.voided_at IS NULL AND cost_entries.amount_usd IS NULL AND cost_entries.currency = ${currency}
         ${windowOf('cost_entries', 'cost_date', win)}`,
  );
  return {
    costs: got.costs,
    kassaCosts: got.kassaCosts,
    costCharges: got.costCharges,
    manualCharges: got.manualCharges,
    expenses: got.expenses,
    expenseCharges: got.expenseCharges,
    clientCharges: got.clientCharges,
    fx,
    balances,
    settledOld: got.settledOld,
    kassaMissing: got.kassaMissing,
    frozenPayments: Number(frozen?.n ?? 0),
    waitingCount: Number(waiting?.n ?? 0),
  };
}

function finish(body: Awaited<ReturnType<typeof planApply>>, currency: string, scope: RepricePlan['scope']): RepricePlan {
  const base = { ...body, currency, scope };
  return { ...base, months: monthsOf(base), hash: hashOf(base) };
}

async function lockCurrencyTx(tx: Tx, currency: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('fx-rate'), hashtext(${currency}::text))`);
}

/** `upsertFxRate`'s body on the caller's transaction, with the previous value in the audit. */
export async function upsertFxRateTx(tx: Tx, input: z.infer<typeof fxRateSchema>, ctx: AuditContext) {
  const [previous] = await tx
    .select({ rateToUsd: fxRates.rateToUsd })
    .from(fxRates)
    .where(sql`${fxRates.currency} = ${input.currency} AND ${fxRates.effectiveDate} = ${input.effectiveDate}::date`)
    .limit(1);
  const [row] = await tx
    .insert(fxRates)
    .values({
      currency: input.currency,
      rateToUsd: String(input.rateToUsd),
      effectiveDate: input.effectiveDate,
      enteredBy: ctx.actorId!,
    })
    .onConflictDoUpdate({
      target: [fxRates.currency, fxRates.effectiveDate],
      set: { rateToUsd: String(input.rateToUsd), enteredBy: ctx.actorId! },
    })
    .returning();
  await writeAudit(tx, ctx, {
    entityType: 'fx_rate',
    entityId: row!.id,
    action: 'update',
    before: previous ? { rateToUsd: Number(previous.rateToUsd) } : null,
    after: { currency: input.currency, rateToUsd: input.rateToUsd, date: input.effectiveDate },
  });
  return row!;
}

const BUSY = new Set(['40P01', '40001', '55P03']);
/** A deadlock, a serialisation failure or a lock timeout: «boshqa o'zgarish ketayotgan edi — qaytadan bosing». */
export function isBusyError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === 'string' && BUSY.has(code);
}

function summary(plan: RepricePlan) {
  const usd = (list: Change[]) => cents(list.reduce((sum, c) => sum + c.newUsd - c.oldUsd, 0));
  return {
    from: 'fx_reprice',
    currency: plan.currency,
    scope: plan.scope,
    counts: {
      costs: plan.costs.length,
      kassaCosts: plan.kassaCosts.length,
      costCharges: plan.costCharges.length,
      manualCharges: plan.manualCharges.length,
      expenses: plan.expenses.length,
      expenseCharges: plan.expenseCharges.length,
      clientCharges: plan.clientCharges.length,
      fx: plan.fx.length,
      settledOld: plan.settledOld,
      kassaMissing: plan.kassaMissing,
    },
    usd: {
      costs: usd(plan.costs),
      kassaCosts: usd(plan.kassaCosts),
      expenses: usd(plan.expenses),
      clientCharges: usd(plan.clientCharges),
    },
    months: plan.months,
  };
}

/**
 * The FX save: lock the currency → write the rate (audited, before/after) →
 * plan → apply → reconcile → the summary audit → when something moved and
 * `planHash` is not THIS plan's, `ConfirmNeeded` and the whole transaction —
 * the rate included — rolls back. `since` (`cost_kassa_since`) is read by the
 * caller on the pool first (#714).
 */
export async function saveFxRate(
  input: z.infer<typeof fxRateSchema>,
  ctx: AuditContext,
  opts: { planHash: string | null; since: string },
): Promise<RepricePlan> {
  if (!ctx.actorId) throw new RepriceError('unauthenticated');
  try {
    return await db.transaction(async (tx) => {
      await lockCurrencyTx(tx, input.currency);
      const rate = await upsertFxRateTx(tx, input, ctx);
      const window = clampWindow(await fxWindowTx(tx, input.currency, input.effectiveDate));
      const plan = finish(await planApply(tx, input.currency, window, opts.since, ctx), input.currency, {
        kind: 'rate',
        date: input.effectiveDate,
        window,
      });
      await writeAudit(tx, ctx, { entityType: 'fx_rate', entityId: rate.id, action: 'update', after: summary(plan) });
      if (planMoves(plan) && opts.planHash !== plan.hash) throw new ConfirmNeeded(plan);
      return plan;
    });
  } catch (err) {
    if (isBusyError(err)) throw new RepriceError('busy');
    throw err;
  }
}

/** The same without a rate write, over ONE month of one currency — the stale review (§6.6). */
export async function repriceStale(
  currency: string,
  month: string,
  ctx: AuditContext,
  opts: { planHash: string | null; since: string },
): Promise<RepricePlan> {
  if (!ctx.actorId) throw new RepriceError('unauthenticated');
  if (!/^\d{4}-\d{2}$/.test(month) || currency === 'USD') throw new RepriceError('validation');
  try {
    return await db.transaction(async (tx) => {
      await lockCurrencyTx(tx, currency);
      const [rate] = await tx
        .select({ id: fxRates.id })
        .from(fxRates)
        .where(eq(fxRates.currency, currency))
        .orderBy(desc(fxRates.effectiveDate))
        .limit(1);
      if (!rate) throw new RepriceError('no_rate');
      const window = clampWindow(monthWindow(month));
      const plan = finish(await planApply(tx, currency, window, opts.since, ctx), currency, { kind: 'month', month });
      await writeAudit(tx, ctx, { entityType: 'fx_rate', entityId: rate.id, action: 'update', after: summary(plan) });
      if (planMoves(plan) && opts.planHash !== plan.hash) throw new ConfirmNeeded(plan);
      return plan;
    });
  } catch (err) {
    if (isBusyError(err)) throw new RepriceError('busy');
    throw err;
  }
}

/**
 * Read-only, on the pool: per currency AND month, the debts off their day's
 * rate — what a rate saved before the fix, or a race with a save, left
 * behind (the stated race). Settled history is left out, the plan's rule.
 */
export async function staleDebtSummary(since: string): Promise<{ currency: string; month: string; count: number; usd: number }[]> {
  // Company-wide, so JIT is off for it (0104's measurement, and ours: on
  // 60k client rows 2.7 s with the compile, 1.5 s without — before the walk's
  // per-cycle scans became one join).
  const got = await withoutJit((exec) => candidates(exec, { currency: null, win: null, since, lock: false }));
  const groups = new Map<string, { currency: string; month: string; count: number; usd: number }>();
  for (const change of [
    ...got.costs,
    ...got.kassaCosts,
    ...got.manualCharges,
    ...got.expenses,
    ...got.clientCharges,
  ]) {
    const currency = got.currencies.get(change.id) ?? '';
    const month = change.date.slice(0, 7);
    const key = `${currency}|${month}`;
    const row = groups.get(key) ?? { currency, month, count: 0, usd: 0 };
    row.count += 1;
    row.usd = cents(row.usd + change.oldUsd);
    groups.set(key, row);
  }
  return [...groups.values()].sort((a, b) => a.currency.localeCompare(b.currency) || b.month.localeCompare(a.month));
}

export interface StalePayment {
  id: string;
  currency: string;
  day: string;
  kind: string;
  ownerId: string | null;
  label: string | null;
  amount: number;
  storedRate: number;
  dayRate: number | null;
}

/** Read-only, on the pool: payments off their day's rate — listed, never re-priced (regression-6). */
export async function stalePayments(currency: string | null, limit = 200): Promise<StalePayment[]> {
  const since = String(((await rows<{ v: string | null }>(db, sql`SELECT value #>> '{}' AS v FROM settings WHERE key = 'cost_kassa_since'`))[0]?.v) ?? '');
  // Company-wide: JIT off, like the summary beside it on the same page.
  const found = await withoutJit((exec) =>
    rows<{
      id: string;
      currency: string;
      day: string;
      kind: string;
      owner_id: string | null;
      label: string | null;
      amount: string;
      stored_rate: string;
      day_rate: string | null;
    }>(
      exec,
      sql`SELECT * FROM (${frozenPaymentsSql({ currency, win: null, since: /^\d{4}-\d{2}-\d{2}$/.test(since) ? since : '', lock: false })}) p
           ORDER BY p.day DESC LIMIT ${limit}`,
    ),
  );
  return found.map((row) => ({
    id: row.id,
    currency: row.currency,
    day: row.day,
    kind: row.kind,
    ownerId: row.owner_id,
    label: row.label,
    amount: num(row.amount),
    storedRate: num(row.stored_rate),
    dayRate: row.day_rate === null ? null : num(row.day_rate),
  }));
}
