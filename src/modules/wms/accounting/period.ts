import { rateFor } from '../costing/service';

/**
 * Period handling shared by every accounting screen and export.
 *
 * Default range is the current year to date: an owner opening the P&L wants
 * "how are we doing this year", not an empty form.
 */
export function resolvePeriod(params: { from?: string; to?: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const valid = (value?: string) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null);
  const to = valid(params.to) ?? today;
  const from = valid(params.from) ?? `${to.slice(0, 4)}-01-01`;
  // A backwards range would silently return nothing; swap instead.
  return from <= to ? { from, to } : { from: to, to: from };
}

/**
 * Today's UZS rate, for showing sums in soʻm next to the USD ones (owner's
 * answer 10). Deliberately TODAY's rate and not the rate of each row: this is
 * a convenience conversion for reading, while the USD figures are the ones
 * frozen at entry and the ones the reports actually add up.
 */
export async function uzsRate(): Promise<number | null> {
  const rate = await rateFor('UZS', new Date().toISOString().slice(0, 10));
  return rate && rate > 0 ? rate : null;
}

/** USD → UZS at the given rate; null when no rate has been entered yet. */
export function toUzs(amountUsd: number, rate: number | null): number | null {
  if (!rate) return null;
  return Math.round(amountUsd / rate);
}
