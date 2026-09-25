import { sql, type SQL } from 'drizzle-orm';
import { partnerTransactions } from '../../platform/db/schema';

/**
 * The partner ledger's kinds and signs, said once (0103) — a module of its
 * own so the kurs farqi walk (`finance/fx-residue.ts`) and the partner
 * service can both read it without importing each other.
 */

/**
 * Every kind a partner row may STORE. `fx_diff` (0103, the owner's Q14 A) is
 * the system's own «kurs farqi»: native 0, a signed dollar figure that closes
 * the residue of an account back at zero in its own currency. Nobody types it.
 */
export const PARTNER_TX_TYPES = ['charge', 'receipt', 'payment', 'offset', 'adjust', 'fx_diff'] as const;
export type PartnerTxType = (typeof PARTNER_TX_TYPES)[number];

/**
 * The partner ledger's one sign rule, in SQL (it was restated inline in four
 * readers): + raises what WE owe, − lowers it; `adjust` and `fx_diff` carry
 * their sign in the amount. `column` names the native amount or the dollars;
 * `alias` the table alias of a raw correlated subquery (#128), omitted for
 * the drizzle table itself.
 */
export function partnerSignedSql(column: 'amount_usd' | 'amount', alias?: string): SQL {
  const col = (name: string) =>
    alias ? sql.raw(`${alias}.${name}`) : sql`${partnerTransactions}.${sql.raw(name)}`;
  return sql`(CASE WHEN ${col('type')} IN ('charge', 'receipt', 'adjust', 'fx_diff') THEN ${col(column)} ELSE -${col(column)} END)`;
}

/**
 * Which way each kind moves the account's OWN currency — the walk that finds
 * where a currency returns to zero (Q14). `fx_diff` never walks (native 0).
 * A kind added to PARTNER_TX_TYPES without its sign is a compile error.
 */
export const PARTNER_NATIVE_SIGN: Record<Exclude<PartnerTxType, 'fx_diff'>, 1 | -1 | 'signed'> = {
  charge: 1,
  receipt: 1,
  payment: -1,
  offset: -1,
  adjust: 'signed',
};
