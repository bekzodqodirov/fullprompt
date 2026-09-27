/**
 * The three refusals a count-only lot gives a phone scan (0112), as the
 * server's ack `detail` of a `rejected` result. No new ack verdict: `rejected`
 * already means «not recorded — take the green mark back, no confirm», and a
 * refusal must not widen the wire type every screen narrows (#591).
 *
 * Browser-safe on purpose: the screens import it to turn a detail into a
 * sentence with a literal switch (`t('scanRefusal.<detail>', {lot})`), so the
 * i18n key is always one the bundles can see (#163).
 */
export const SCAN_REFUSALS = ['lot_counted', 'qr_less_count_only', 'reserved_reason'] as const;
export type ScanRefusal = (typeof SCAN_REFUSALS)[number];

export function isScanRefusal(detail: unknown): detail is ScanRefusal {
  return typeof detail === 'string' && (SCAN_REFUSALS as readonly string[]).includes(detail);
}
