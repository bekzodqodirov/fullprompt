/**
 * The price door's refusals about a truck price's DEAL (Q8 «c»), in words —
 * one map for every form that posts a truck price (the «Narx» tab's single
 * form and its table, the client ledger), so they say the same sentence for
 * the same refusal (#513). Keys in
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
  // The price table (2026-11-08, his 1a): a press with no filled row, a deal
  // posted twice (a forged or doubled post — the table draws each once), and
  // a page drawn before somebody else priced the truck.
  deal_parts_empty: 'truckPartsEmpty',
  deal_part_duplicate: 'truckPartDuplicate',
  prices_changed: 'truckPricesChanged',
} as const;

export function truckDealErrorKey(code: string | undefined): (typeof TRUCK_DEAL_ERROR_KEYS)[keyof typeof TRUCK_DEAL_ERROR_KEYS] | null {
  if (!code) return null;
  return (TRUCK_DEAL_ERROR_KEYS as Record<string, (typeof TRUCK_DEAL_ERROR_KEYS)[keyof typeof TRUCK_DEAL_ERROR_KEYS]>)[code] ?? null;
}
