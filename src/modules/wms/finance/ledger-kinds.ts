/**
 * The client ledger's kinds and what each MEANS, said once (#513) — the one
 * vocabulary the FX package and the compensation package share. Zero imports:
 * the services, the screens and the unit fences all read it.
 *
 * A kind added to CLIENT_KINDS without its answers is a compile error, not a
 * silent «else»: every table below is a `Record` over the kinds.
 */

/** Every kind a row may STORE (the migrations' latest `client_transactions_type_check`). */
export const CLIENT_KINDS = ['charge', 'payment', 'refund', 'fx_diff', 'compensation'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/**
 * The kinds a PERSON types through the generic ledger form. `fx_diff` is the
 * system's (Q14) or the accountant's own close (Q24 b) — never the form's;
 * `compensation` has its own door, the lost-cargo form (`addCompensation`),
 * because it names a prixod and may lower prices in the same press.
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
  // Q15 (2) A, 0105: what we owe a client for LOST cargo above our own price.
  // It lowers what he owes like a payment and is a price TAKEN BACK — never
  // money (no kassa: the cash leaves by the refund that follows) and never
  // an expense (DEALS.md answer 3: «bitim foydasi to'g'ri qolsin»).
  compensation: { balance: -1, revenue: -1, received: 0 },
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

/** Kinds whose balance sign is −1 — the credit list every SQL sign CASE is built from. */
export const CREDIT_KINDS = CLIENT_KINDS.filter((kind) => LEDGER_RULES[kind].balance === -1);

/** Kinds that are revenue at all (+1 a price, −1 a price taken back). */
export const REVENUE_TYPES = CLIENT_KINDS.filter((kind) => LEDGER_RULES[kind].revenue !== 0);

/** A price taken back (revenue −1) — the compensation. */
export const REVENUE_BACK_KINDS = CLIENT_KINDS.filter((kind) => LEDGER_RULES[kind].revenue === -1);

/** Money the client handed us (+1) and money handed back (−1). */
export const RECEIVED_KINDS = CLIENT_KINDS.filter((kind) => LEDGER_RULES[kind].received === 1);
export const HANDED_BACK_KINDS = CLIENT_KINDS.filter((kind) => LEDGER_RULES[kind].received === -1);

/**
 * Money the company GIVES a client — the kassa holders' pair (Q15): the
 * refund that moves the cash, and the compensation that funds it. Written and
 * voided by the kassa holders only (`mayPickTill`), one decision's two halves.
 */
export const CLIENT_PAYOUT_TYPES = ['refund', 'compensation'] as const satisfies readonly ClientKind[];
export const isClientPayout = (type: string) => (CLIENT_PAYOUT_TYPES as readonly string[]).includes(type);

/** The row's revenue: a price +, a price taken back −, anything else 0. */
export const revenueUsd = (row: Row) => (rule(row.type)?.revenue ?? 0) * row.amountUsd;

/** Money received net of money handed back: payment +, refund −, anything else 0. */
export const receivedUsd = (row: Row) => (rule(row.type)?.received ?? 0) * row.amountUsd;

/**
 * Which kinds the client's lenta and the cabinet SHOW — keyed by every stored
 * kind, so a new kind is a compile error until it decides. A kurs farqi row
 * is the system's bookkeeping (Q14), hidden there. How each kind is DRAWN
 * stays a literal map on each screen (#163: a label key assembled at runtime
 * is invisible to the i18n fence and throws at render).
 */
export const LEDGER_FEED = {
  charge: true,
  payment: true,
  refund: true,
  fx_diff: false,
  compensation: true,
} as const satisfies Record<ClientKind, boolean>;

/** The kinds the lenta and the cabinet show. */
export const FEED_KINDS = CLIENT_KINDS.filter((kind) => LEDGER_FEED[kind]);
