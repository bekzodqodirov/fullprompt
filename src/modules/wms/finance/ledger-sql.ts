import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { clientTransactions } from '../../platform/db/schema';
import {
  CLIENT_KINDS,
  CREDIT_KINDS,
  HANDED_BACK_KINDS,
  LEDGER_RULES,
  PRICE_KINDS,
  RECEIVED_KINDS,
  REVENUE_BACK_KINDS,
} from './ledger-kinds';

/**
 * The client ledger's sign, revenue and «received» rules as SQL — BUILT from
 * `LEDGER_RULES` (ledger-kinds.ts), never restated. A module of its own with
 * no service imports, so the CRM's and the cargo card's raw subqueries can
 * ask it without pulling the finance service (and its cycles) in.
 * `finance/service.ts` re-exports every builder, so no importer moved.
 */

/** The two columns a sign rule reads — a table's, or `ledgerAlias` for raw SQL. */
export type LedgerCols = { type: AnyColumn | SQL; amountUsd: AnyColumn | SQL };

/** A constant kind list as SQL literals — only ever the arrays in ledger-kinds.ts. */
export function kindList(kinds: readonly string[]): SQL {
  for (const kind of kinds) {
    if (!(CLIENT_KINDS as readonly string[]).includes(kind)) throw new Error(`unknown ledger kind ${kind}`);
  }
  return sql.raw(kinds.map((kind) => `'${kind}'`).join(', '));
}

/**
 * The same columns on a raw alias (`ct.type`, `ct.amount_usd`) for the
 * correlated subqueries that restated the sign by hand; '' = unqualified.
 */
export function ledgerAlias(alias: string): LedgerCols {
  if (alias !== '' && !/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`bad alias ${alias}`);
  const prefix = alias ? `${alias}.` : '';
  return { type: sql.raw(`${prefix}type`), amountUsd: sql.raw(`${prefix}amount_usd`) };
}

/** +amount_usd for a kind that raises the balance, −amount_usd for one that lowers it. */
export function signedUsdSql(table: LedgerCols = clientTransactions): SQL {
  return sql`(CASE WHEN ${table.type} IN (${kindList(CREDIT_KINDS)}) THEN -${table.amountUsd} ELSE ${table.amountUsd} END)`;
}

/**
 * Money RECEIVED net of money handed back: +payment, −refund, 0 for a charge,
 * a compensation (not money — it moves no kassa) or a kurs farqi row.
 * «To'landi» on a screen that also shows a balance must be this, or the two
 * columns stop adding up to it.
 */
export function netPaidUsdSql(table: LedgerCols = clientTransactions): SQL {
  return sql`(CASE WHEN ${table.type} IN (${kindList(RECEIVED_KINDS)}) THEN ${table.amountUsd} WHEN ${table.type} IN (${kindList(HANDED_BACK_KINDS)}) THEN -${table.amountUsd} ELSE 0 END)`;
}

/**
 * REVENUE (0105): a price +, a price taken back (a compensation for lost
 * cargo) −, anything else 0 — the one expression every revenue reader sums,
 * so the P&L, a client's profit, a truck's and a deal's say the same net.
 */
export function revenueUsdSql(table: LedgerCols = clientTransactions): SQL {
  return sql`(CASE WHEN ${table.type} IN (${kindList(PRICE_KINDS)}) THEN ${table.amountUsd} WHEN ${table.type} IN (${kindList(REVENUE_BACK_KINDS)}) THEN -${table.amountUsd} ELSE 0 END)`;
}

/**
 * The positive magnitude of a row that RAISES the balance (a debit) or
 * LOWERS it (a credit) — for oldest-first readers. A signed kind (kurs farqi)
 * goes by the sign of its own dollars.
 */
export function debitUsdSql(table: LedgerCols = clientTransactions): SQL {
  const fixed = CLIENT_KINDS.filter((kind) => LEDGER_RULES[kind].balance === 1);
  const signed = CLIENT_KINDS.filter((kind) => LEDGER_RULES[kind].balance === 'signed');
  return sql`(CASE WHEN ${table.type} IN (${kindList(fixed)}) THEN ${table.amountUsd} WHEN ${table.type} IN (${kindList(signed)}) AND ${table.amountUsd} > 0 THEN ${table.amountUsd} ELSE 0 END)`;
}
export function creditUsdSql(table: LedgerCols = clientTransactions): SQL {
  const signed = CLIENT_KINDS.filter((kind) => LEDGER_RULES[kind].balance === 'signed');
  return sql`(CASE WHEN ${table.type} IN (${kindList(CREDIT_KINDS)}) THEN ${table.amountUsd} WHEN ${table.type} IN (${kindList(signed)}) AND ${table.amountUsd} < 0 THEN -${table.amountUsd} ELSE 0 END)`;
}

/**
 * What a row takes off the balance, in SQL (0103): payment +, refund −, a kurs
 * farqi −(its signed dollars), a charge 0 — for the walks that settle charges
 * oldest-first. The JS twin is `settlesUsd` in ledger-kinds.ts.
 */
export function settlesUsdSql(table: LedgerCols = clientTransactions): SQL {
  // −(the sign rule) for every non-price kind, exactly as the JS twin says:
  // derived from LEDGER_RULES, so a kind added there needs no second answer.
  const prices = sql.join(
    PRICE_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  );
  return sql`(CASE WHEN ${table.type} IN (${prices}) THEN 0 ELSE -${signedUsdSql(table)} END)`;
}
