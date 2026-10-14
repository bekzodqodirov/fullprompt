import { batchTabHref } from '../batches/card-door';

/**
 * Where «money on no box» leads (docs/YOLKIRA-TAQSIMOT.md §6.3.6-7) — ONE
 * answer for the dashboard's attention row and the Balans sentence, so the
 * two cannot send the same money to two places (#513). Pure: the attention
 * facts and the Telegram words import it without a database.
 *
 * One truck → its Xarajatlar tab, where the bill and its ⚠ are, for a reader
 * the tab admits. Several (or a reader the tab would bounce) → «Partiya
 * foydasi»'s batch view with `bolinmagan=1`, which lists EVERY trip with such
 * money — tracked or not: the plain table holds only the trucks marked
 * «Partiya», and a held bill on an unmarked one was a row it never drew.
 */
export const UNSPLIT_PARAM = 'bolinmagan';

export function unsplitHref(
  batchIds: readonly string[],
  window: { from: string; to: string },
  canCosts: boolean,
): string {
  const only = new Set(batchIds).size === 1 ? batchIds[0] : undefined;
  if (only && canCosts) return batchTabHref(only, 'xarajat');
  return `/accounting/profit?view=batch&${UNSPLIT_PARAM}=1&from=${window.from}&to=${window.to}`;
}
