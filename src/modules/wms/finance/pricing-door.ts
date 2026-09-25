/**
 * May this person open a truck's «Partiya moliyasi» (`/batches/[id]/pricing`)?
 *
 * ONE predicate for every link that points there — the unpriced list's truck
 * cells, /approvals' «narx qo'yish →», the batch card's door — because a row
 * whose link bounces is worse than a row with no link (#1023's rule).
 *
 * Today that is the page's own gate, `finance.manage`. The VED round
 * (`design-ved-0925.md` §5.3) gives the page a price-only view and one
 * answer for it, `pricingSight(perms, internal)` in `pricing-view.ts`; when
 * it lands this becomes `pricingSight(perms, false) !== 'none'`, which is the
 * same set of people — the VED keeps pricing trucks, he only stops seeing the
 * tannarx — so no caller changes.
 *
 * Zero imports on purpose: client components ask it too.
 */
export function mayOpenPricing(permissions: ReadonlySet<string>): boolean {
  return permissions.has('finance.manage');
}
