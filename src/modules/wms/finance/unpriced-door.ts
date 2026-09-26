/**
 * May this person open the accountant's list «Narxi yozilmagan yuk»
 * (`/finance/narxsiz`)? /finance's own door — the list is that screen's
 * sibling and shares its money scope (a seller reads their own clients).
 *
 * ONE predicate for every place that draws a door to it — the list page
 * itself, the dashboard's «yetib kelgan, narx yozilmagan» block and the
 * Balans's notes card under «narxi hali yozilmagan yukka sarflangan» (U03) —
 * because three inline copies of one door drift apart, and a link whose
 * page bounces is worse than no link (#1023's rule). Zero imports on
 * purpose: the rule is the two codes and nothing else.
 */
export function mayReadUnpricedList(permissions: ReadonlySet<string>): boolean {
  return permissions.has('finance.view') || permissions.has('finance.manage');
}
