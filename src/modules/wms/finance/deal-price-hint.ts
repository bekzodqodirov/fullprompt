/**
 * The price the seller SOLD this cargo at, beside the box where the truck's
 * price is typed (the owner, 2026-09-26: «partiyada narx berayotganda … bitim
 * … sotgan narxi … ogohlantirish bolib korib tursin kam yokida kop narx berib
 * qoymaslikni oldini oladi»), and his rule for when to stop the press: a
 * difference over 5 % asks for a confirmation, then saves.
 *
 * Pure, so the browser's check and its test are the same arithmetic. A deal
 * is quoted for its WHOLE cargo, and a truck may carry part of it, so the
 * expected price is the quote scaled by this truck's share of the quoted
 * measure — m³ first, then kg, else the whole quote. Only a dollar quote is
 * compared: a so'm quote has no honest dollar figure without a rate.
 */
export const PRICE_DEVIATION_LIMIT = 0.05;

export interface DealQuote {
  amount: number | null;
  currency: string | null;
  m3: number | null;
  kg: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function expectedPriceFor(quote: DealQuote, cargo: { m3: number; kg: number }): number | null {
  if (quote.amount === null || !(quote.amount > 0) || quote.currency !== 'USD') return null;
  if (quote.m3 !== null && quote.m3 > 0 && cargo.m3 > 0) return round2((quote.amount * cargo.m3) / quote.m3);
  if (quote.kg !== null && quote.kg > 0 && cargo.kg > 0) return round2((quote.amount * cargo.kg) / quote.kg);
  return round2(quote.amount);
}

/** Signed share of the difference, e.g. −0.12 = 12 % under the deal. */
export function deviationOf(typedUsd: number, expectedUsd: number): number | null {
  if (!Number.isFinite(typedUsd) || !(expectedUsd > 0)) return null;
  return (typedUsd - expectedUsd) / expectedUsd;
}

export function needsConfirmation(typedUsd: number, expectedUsd: number | null): boolean {
  if (expectedUsd === null) return false;
  const d = deviationOf(typedUsd, expectedUsd);
  return d !== null && Math.abs(d) > PRICE_DEVIATION_LIMIT;
}
