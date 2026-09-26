/**
 * The arithmetic of a recurring expense's month (owner's Q6, 0106) — pure,
 * ZERO imports: the pay fold in the browser asks `closingRule` with the
 * typed amount to decide whether it may offer one button or must ask
 * «qisman or yopish», and the service asks the SAME function before it
 * writes (#513). Two copies of «is this the rest of the month» would drift
 * the day someone rounds differently.
 */

/** A part payment already recorded for the month, in its own money. */
export interface PaidPart {
  amount: number;
  currency: string;
}

/** Cents, so 0.1 + 0.2 never decides whether a month closed. */
const cents = (value: number) => Math.round(value * 100);

/**
 * What is still owed on the month in the template's own currency, or null
 * when it cannot be known: a part paid in another currency, or a payment
 * being made in another currency (a USD salary out of the so'm kassa). A
 * remainder «converted» at some rate would be a guess dressed as a figure,
 * and it would silently close — or silently keep open — a person's salary.
 */
export function remainderOf(
  template: { amount: number; currency: string },
  parts: readonly PaidPart[],
  payingCurrency: string,
): number | null {
  if (payingCurrency !== template.currency) return null;
  if (parts.some((part) => part.currency !== template.currency)) return null;
  const left = cents(template.amount) - parts.reduce((sum, part) => sum + cents(part.amount), 0);
  return Math.max(0, left) / 100;
}

/**
 * Does this payment close the month by its amount alone? (O3)
 *
 * `closes` when the remainder is known and the amount reaches it; `choose`
 * otherwise — a short amount, or one that cannot be compared. A `choose` is
 * never answered by the system: the person says «qisman — qolgani keyin» or
 * «shu summa bilan yopish», because a deliberately reduced last salary must be
 * able to close its month and a first instalment must not.
 */
export function closingRule(
  template: { amount: number; currency: string },
  parts: readonly PaidPart[],
  payment: { amount: number; currency: string },
): 'closes' | 'choose' {
  const remainder = remainderOf(template, parts, payment.currency);
  if (remainder === null) return 'choose';
  return cents(payment.amount) >= cents(remainder) ? 'closes' : 'choose';
}

/**
 * «Paid so far» as it can honestly be said: one sum when every part is in
 * the template's currency, else each part in its own money — adding so'm to
 * dollars would print a number nobody paid.
 */
export function paidSoFar(parts: PaidPart[], currency: string): string {
  if (parts.every((part) => part.currency === currency)) {
    const sum = parts.reduce((total, part) => total + Math.round(part.amount * 100), 0) / 100;
    return `${sum.toLocaleString('en-US')} ${currency}`;
  }
  return parts.map((part) => `${part.amount.toLocaleString('en-US')} ${part.currency}`).join(' + ');
}

/** One due, unpaid month as the Balans reads it. */
export interface ArrearsRow {
  /** The template's amount and currency — what the month costs. */
  amount: number;
  currency: string;
  /** A book entry (depreciation) moves no kassa, so it owes no money. */
  cash: boolean;
  /** Dollars already handed over on this month as part payments. */
  paidUsd: number;
}

export interface Arrears {
  /** Every due, unpaid month — the counter's N (book entries included). */
  count: number;
  /** The months whose money IS in `usd` — the Balans line's own count. */
  cashCount: number;
  /** What those months still owe, in dollars at today's rate. */
  usd: number;
  /** Months whose currency has no rate — named in their own money, never $0 (#86, U14). */
  unrated: { currency: string; amount: number; count: number }[];
}

/**
 * Due, unpaid recurring months as MONEY (M5): the Balans subtracts them like
 * the sellers' commissions owed (U10) — a debt whose day has come, owed out
 * of money already in the tills.
 *
 * Per cash month: the template's amount at today's rate, less the dollars
 * already paid on it, floored at zero (an overpaid part is not a credit the
 * Balans may book). A book entry counts in `count` and never in `usd`:
 * recording depreciation moves no kassa, so subtracting it while unrecorded
 * would make the net jump back up the day it is recorded. A currency with no
 * rate is named, never counted.
 */
export function arrearsUsd(rows: readonly ArrearsRow[], rates: ReadonlyMap<string, number | null>): Arrears {
  let cashCount = 0;
  let owed = 0;
  const unrated = new Map<string, { currency: string; amount: number; count: number }>();
  for (const row of rows) {
    if (!row.cash) continue;
    const rate = rates.get(row.currency) ?? null;
    if (rate === null || !(rate > 0)) {
      const entry = unrated.get(row.currency) ?? { currency: row.currency, amount: 0, count: 0 };
      entry.amount = cents(entry.amount + row.amount) / 100;
      entry.count += 1;
      unrated.set(row.currency, entry);
      continue;
    }
    cashCount += 1;
    owed += Math.max(0, cents(row.amount * rate) - cents(row.paidUsd));
  }
  return { count: rows.length, cashCount, usd: owed / 100, unrated: [...unrated.values()] };
}
