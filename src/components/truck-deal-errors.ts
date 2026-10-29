/**
 * The price door's refusals about a truck price's DEAL (Q8 «c»), in words —
 * one map for both forms that post a truck price, so the «Narx» tab and the
 * client ledger say the same sentence for the same refusal (#513). Keys in
 * the `finance` namespace; `tests/unit/truck-deal-wire.test.ts` checks every
 * one exists in all four bundles, because a key read through a variable is
 * invisible to the literal-key tripwire and a missing one throws at render
 * (#163).
 */
export const TRUCK_DEAL_ERROR_KEYS = {
  deals_changed: 'truckDealChanged',
  deal_not_aboard: 'truckDealNotAboard',
  deal_choice_required: 'truckDealRequired',
  deal_choice_invalid: 'truckDealInvalid',
  deal_mismatch: 'truckDealMismatch',
} as const;

export function truckDealErrorKey(code: string | undefined): (typeof TRUCK_DEAL_ERROR_KEYS)[keyof typeof TRUCK_DEAL_ERROR_KEYS] | null {
  if (!code) return null;
  return (TRUCK_DEAL_ERROR_KEYS as Record<string, (typeof TRUCK_DEAL_ERROR_KEYS)[keyof typeof TRUCK_DEAL_ERROR_KEYS]>)[code] ?? null;
}
