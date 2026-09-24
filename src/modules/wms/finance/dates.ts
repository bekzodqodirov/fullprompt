import { addDays, tashkentDay } from '@/modules/platform/time/tashkent';

/**
 * The latest day a ledger row may carry: Tashkent's today, plus one day of
 * grace. The grace stays although «today» is now the office's (R5): the
 * Chinese warehouses run on UTC+8, three hours ahead, so from 21:00 in
 * Tashkent it is already tomorrow where the money was spent, and a row dated
 * by the person who spent it must not be refused. A charge dated in 2308 was
 * accepted before (audit A23) and counted as debt TODAY on the home screen and
 * /finance, while the ageing page — the one the home row opens — left it out,
 * a gap the size of the typo.
 *
 * No server-only imports: the ledger form reads it too, as the date input's
 * `max`, and the day helper it uses is itself import-free.
 */
export function latestTxDate(now = new Date()): string {
  return addDays(tashkentDay(now), 1);
}
