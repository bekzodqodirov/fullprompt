/**
 * Which way round an exchange rate is written.
 *
 * The database stores `rate_to_usd` — multiply by it to get dollars — because
 * that is what the costing engine needs. Nobody quotes rates that way: the
 * owner reads "1 USD = 12 500 so'm", and typing 0.00008 for the som was an
 * invitation to lose a zero. So the screens speak "how many X in one dollar"
 * and these two functions are the only place the two forms meet.
 */

/** rate_to_usd → "1 USD = N units". */
export function perUsd(rateToUsd: number): number | null {
  if (!Number.isFinite(rateToUsd) || rateToUsd <= 0) return null;
  const value = 1 / rateToUsd;
  // Round to a sane number of places for the size of the number: 12500 for
  // the som, 7.2 for the yuan — 1/0.13888889 must not display as 7.19999994.
  const places = value >= 1000 ? 0 : value >= 10 ? 2 : 4;
  return Math.round(value * 10 ** places) / 10 ** places;
}

/**
 * "1 USD = N units" → rate_to_usd, at the column's 12-decimal scale.
 *
 * Twelve, not eight: 1/12345 is 0.000081004459, and eight decimals rounded it
 * to 0.000081 — which reads back as 12 346 so'm per dollar. An off-by-one in
 * a rate the owner typed himself looks like a bug (migration 0023 widened the
 * column for exactly this).
 */
export function toRateToUsd(unitsPerUsd: number): number | null {
  if (!Number.isFinite(unitsPerUsd) || unitsPerUsd <= 0) return null;
  return Math.round((1 / unitsPerUsd) * 1e12) / 1e12;
}

/**
 * A new rate that moves more than a fifth from the one standing is asked
 * about before it is saved (audit A1). The form opened on CNY with the so'm's
 * «12500» as its placeholder, so typing the so'm figure without touching the
 * select stored CNY at 1/12500 — every CNY cost in the window re-priced about
 * 1750× lower, and every payment entered meanwhile frozen at it. No cap would
 * be right for every currency; a jump from the currency's OWN last rate is.
 */
export const RATE_JUMP = 0.2;

export function isRateJump(previousUnits: number | null, nextUnits: number): boolean {
  if (previousUnits === null || !Number.isFinite(previousUnits) || previousUnits <= 0) return false;
  if (!Number.isFinite(nextUnits) || nextUnits <= 0) return false;
  return Math.abs(nextUnits - previousUnits) / previousUnits > RATE_JUMP;
}
