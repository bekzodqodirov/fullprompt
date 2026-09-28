import { addDays, tashkentDayStart } from '../../platform/time/tashkent';
import { fxResidueAllowance } from '../finance/money-bounds';

/**
 * Qarz nazorati's pure rules (0114) — no database, so the unit tests call the
 * real functions (#166) and the services cannot restate them.
 */

/** Below a cent is nothing — the ledger's own threshold everywhere. */
export const CENT = 0.009;

/** How far ahead a promise may be dated: a quarter, never «some day». */
export const PROMISE_HORIZON_DAYS = 90;

export type PromiseStatus = 'open' | 'kept' | 'settled' | 'broken' | 'cancelled';

/** What the sweep may decide about an open promise (a person cancels). */
export type PromiseVerdict = 'open' | 'kept' | 'settled' | 'broken';

/**
 * The moment an unpaid promise counts as broken: NOON Tashkent on the day
 * AFTER its due date. The due day itself is the client's whole day to pay,
 * and the morning after is when yesterday's cash is typed into the ledger —
 * judging at midnight would call a promise kept at 18:00 and entered at
 * 09:00 «buzildi» and wake the seller for nothing (the owner's default,
 * design open point 3).
 */
export function promiseBrokenAt(dueOn: string): Date {
  return new Date(tashkentDayStart(addDays(dueOn, 1)).getTime() + 12 * 3_600_000);
}

/**
 * One open promise, judged against the ledger — never against a status a
 * person set.
 *
 *  - **kept**: what came in since the promise covers the amount. A payment
 *    in so'm is converted at the day's rate and routinely lands a few dollars
 *    short of the dollar figure the client said (the judge's #11), so when
 *    any payment since was not in dollars the tolerance is the ledger's own
 *    rate-residue allowance (`fxResidueAllowance`, 2 % or $5) and not a cent.
 *  - **settled**: the debt is gone without that payment — a voided charge, a
 *    compensation. Not «kept» (the judge's #16): nobody paid what was said.
 *  - **broken**: neither, and `promiseBrokenAt` has passed.
 *  - **open**: still waiting.
 */
export function promiseVerdict(input: {
  amountUsd: number;
  paidSinceUsd: number;
  /** Did any payment since the promise arrive in a currency other than USD? */
  foreignSince: boolean;
  balanceUsd: number;
  dueOn: string;
  now: Date;
}): PromiseVerdict {
  const allowance = input.foreignSince ? fxResidueAllowance(input.amountUsd) : CENT;
  if (input.paidSinceUsd >= input.amountUsd - allowance) return 'kept';
  if (input.balanceUsd <= CENT) return 'settled';
  if (input.now.getTime() >= promiseBrokenAt(input.dueOn).getTime()) return 'broken';
  return 'open';
}

export interface DeferralPart {
  dealId: string;
  code: string;
  /** Who granted the deal's «muddat» — the person the register names. */
  by: string | null;
  usd: number;
}

/**
 * Which deferred jobs let how much of a release's balance through (0114, the
 * judge's #1: cargo that went out under a deal «muddat» is a release on debt
 * too, and the seller who granted it is who allowed it).
 *
 * The balance is covered job by job in the order given (oldest deferral
 * first) until nothing is left: a client who owes $500 with $600 deferred on
 * one job and $300 on another released $500 under the first and nothing under
 * the second. A client who owes nothing (or has an advance) released nothing
 * on anybody's «muddat». Parts under a cent are dropped, and each part is
 * rounded to the cent it is stored at.
 */
export function deferralCover(
  owedUsd: number,
  deals: { dealId: string; code: string; by: string | null; owedUsd: number }[],
): DeferralPart[] {
  let left = Math.max(owedUsd, 0);
  const parts: DeferralPart[] = [];
  for (const deal of deals) {
    if (left <= CENT) break;
    const usd = Math.round(Math.min(Math.max(deal.owedUsd, 0), left) * 100) / 100;
    if (usd <= CENT) continue;
    parts.push({ dealId: deal.dealId, code: deal.code, by: deal.by, usd });
    left -= usd;
  }
  return parts;
}
