import { z } from 'zod';

/**
 * How big one money row may be — ONE home for the bound every door asks.
 *
 * Every door capped a typed amount at 1,000,000,000 in the row's OWN
 * currency (audit U44). In dollars or yuan that is a ceiling nobody reaches;
 * in so'm it is about $80k, so a firm account holding more than a billion
 * so'm could not be opened at its true figure through any door, and a real
 * so'm payment had to be split into artificial rows. The screen said only
 * «Xatolik».
 *
 * So the NATIVE bound is the column's own — numeric(14,2), the same in every
 * currency — and the typo guard moves to the DOLLAR value, where the service
 * knows the rate: $1,000,000,000 per row, exactly today's ceiling for a USD
 * row. The dollar half is load-bearing, not cosmetic: `cost_allocations
 * .amount_usd` is numeric(14,4), just under $1e10, so a native cap raised
 * without it would let a $2e10 USD cost overflow inside the post-commit
 * recompute instead of being refused at the door.
 *
 * Zero imports besides zod: the schemas import it, and so could a form.
 */

/** numeric(14,2)'s largest value — every amount column the doors write. */
export const MAX_NATIVE_AMOUNT = 999_999_999_999.99;

/** The per-row ceiling in dollars — the old native cap, now asked in USD. */
export const MAX_ROW_USD = 1_000_000_000;

/** A typed positive amount, bounded by the column and nothing smaller. */
export const nativeAmount = () => z.number().positive().max(MAX_NATIVE_AMOUNT);

/**
 * A SIGNED amount — a partner correction (`adjust`) and a till's opening
 * count. Both bounds, because an unbounded negative reached postgres as 22003
 * and the counterparty door rendered it as an error page.
 */
export const signedNativeAmount = () => z.number().min(-MAX_NATIVE_AMOUNT).max(MAX_NATIVE_AMOUNT);

/** Is this row's dollar value past the ceiling? (sign ignored — an adjust may be negative) */
export function exceedsRowUsd(amountUsd: number): boolean {
  return !Number.isFinite(amountUsd) || Math.abs(amountUsd) > MAX_ROW_USD;
}

/**
 * The refusal a door returns when zod refused an AMOUNT for its size: the
 * sentence «bitta qatorga sig'maydi» instead of the generic «Xatolik». Only a
 * bound issue on a field named like money counts — a too-long note is still
 * the ordinary validation refusal.
 */
export function amountRefusal(error: z.ZodError): 'amount_too_large' | null {
  const hit = error.issues.some(
    (issue) =>
      (issue.code === 'too_big' || (issue.code === 'too_small' && issue.type === 'number' && Number(issue.minimum) < 0)) &&
      issue.path.some((part) => typeof part === 'string' && /amount|balance/i.test(part)),
  );
  return hit ? 'amount_too_large' : null;
}
