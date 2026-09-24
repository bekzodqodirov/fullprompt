/**
 * The latest day a ledger row may carry: today, plus one day of grace so a
 * row typed just after midnight in Tashkent (still yesterday in UTC) is never
 * refused. A charge dated in 2308 was accepted before (audit A23) and counted
 * as debt TODAY on the home screen and /finance, while the ageing page — the
 * one the home row opens — left it out, a gap the size of the typo.
 *
 * Zero imports: the ledger form reads it too, as the date input's `max`.
 */
export function latestTxDate(now = new Date()): string {
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  return tomorrow.toISOString().slice(0, 10);
}
