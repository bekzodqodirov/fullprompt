/**
 * The client ledger's kinds and what each MEANS, said once (#513) — the one
 * vocabulary the FX package and the compensation package share. Zero imports:
 * the services, the screens and the unit fences all read it.
 *
 * A kind added to CLIENT_KINDS without its answers is a compile error, not a
 * silent «else»: every table below is a `Record` over the kinds.
 */

/** Every kind a row may STORE (the migrations' latest `client_transactions_type_check`). */
export const CLIENT_KINDS = ['charge', 'payment', 'refund', 'fx_diff'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/**
 * The kinds a PERSON types through the generic ledger form. `fx_diff` is the
 * system's (Q14) or the accountant's own close (Q24 b) — never the form's.
 */
export const LEDGER_TYPES = ['charge', 'payment', 'refund'] as const satisfies readonly ClientKind[];
export type LedgerType = (typeof LEDGER_TYPES)[number];

/**
 * balance:  +1 raises what the client owes, −1 lowers it, 'signed' = the
 *           row's own amount_usd carries the sign (a kurs farqi row)
 * revenue:  +1 a price, −1 a price taken back, 0 not revenue
 * received: +1 money the client handed us, −1 money handed back, 0 neither
 */
export const LEDGER_RULES = {
  charge: { balance: 1, revenue: 1, received: 0 },
  payment: { balance: -1, revenue: 0, received: 1 },
  refund: { balance: 1, revenue: 0, received: -1 },
  // Q14: native 0, dollars signed — it moves the balance and nothing else.
  fx_diff: { balance: 'signed', revenue: 0, received: 0 },
} as const satisfies Record<
  ClientKind,
  { balance: 1 | -1 | 'signed'; revenue: 1 | 0 | -1; received: 1 | 0 | -1 }
>;

/** Kinds whose amount_usd carries its own sign. */
export type SignedClientKind = {
  [K in ClientKind]: (typeof LEDGER_RULES)[K]['balance'] extends 'signed' ? K : never;
}[ClientKind];

/**
 * Which way each kind moves the account's OWN currency — the walk that finds
 * where a currency returns to zero (Q14). DERIVED from LEDGER_RULES, never
 * restated: a signed kind never walks (its native amount is 0 by CHECK).
 */
export const CLIENT_NATIVE_SIGN = Object.fromEntries(
  CLIENT_KINDS.filter((kind) => LEDGER_RULES[kind].balance !== 'signed').map((kind) => [
    kind,
    LEDGER_RULES[kind].balance,
  ]),
) as Record<Exclude<ClientKind, SignedClientKind>, 1 | -1>;

type Row = { type: string; amountUsd: number };
const rule = (type: string) => LEDGER_RULES[type as ClientKind];

/** +what the row adds to the balance: a charge +, a payment −, a kurs farqi signed. */
export function signedUsd(row: Row): number {
  const balance = rule(row.type)?.balance ?? 1;
  return balance === 'signed' ? row.amountUsd : balance * row.amountUsd;
}

/** A debit ages from its own day; a credit settles the oldest debit (arAging). */
export const isDebit = (row: Row) => signedUsd(row) > 0;

/** A PRICE row — what the trips' walk settles. */
export const isPrice = (type: string) => rule(type)?.revenue === 1;

/** The price kinds, DERIVED — for SQL that must say `isPrice` in a CASE. */
export const PRICE_KINDS = CLIENT_KINDS.filter((kind) => LEDGER_RULES[kind].revenue === 1);

/** What a non-price row takes off the balance: payment +, refund −, kurs farqi −signed. */
export const settlesUsd = (row: Row) => (isPrice(row.type) ? 0 : -signedUsd(row));
