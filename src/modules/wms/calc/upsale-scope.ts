/**
 * Who may see what a customer was actually charged (docs/VED.md laws 4 and 10).
 *
 * Two of the owner's laws pull in opposite directions across the same screens,
 * and this is the one place that resolves them:
 *
 *   law 4  — «VED never sees upsale.» Upsale is client price minus the sealed
 *            VED price, and the VED computed the second number themselves, so
 *            showing them the first hands them the subtraction.
 *   law 10 — «Sellers and VED can read the price history (sellers: prices
 *            only, no cost breakdown).»
 *
 * So it is NOT a hierarchy — it is two different views of one row. The VED
 * reads the cost side and never the client price; the seller reads the client
 * prices, which is law 10's whole point (per-client price drift is visible at
 * decision time), and never the floor those prices sit above.
 *
 * `finance.reports` and NOT round 91's `seesAllMoney`: that predicate is
 * `finance.manage || clients.manage`, and **`ved_manager` holds
 * `finance.manage`** (rbac/catalog.ts) — so it answers TRUE for exactly the
 * person law 4 excludes. Verified against the seeded matrix: `finance.reports`
 * is super_admin, admin and accountant, which is law 4's audience written out.
 *
 * No new permission code (#170). The exclusion is therefore a property of a
 * matrix the owner edits on /admin/roles, which is why the test enumerates
 * every seeded role rather than asserting the predicate's shape: the day he
 * ticks `finance.reports` for the VED, that test says so.
 */
export type UpsaleScope =
  /** Owner and accountant: the client price, the floor, and the difference. */
  | 'all'
  /** A seller: client prices, never the cost side. Their own is their pay. */
  | 'own'
  /** The VED: the cost side, never a client price. Law 4. */
  | 'none';

export function upsaleScopeFor(actor: { permissions: { has(code: string): boolean } }): UpsaleScope {
  if (actor.permissions.has('finance.reports')) return 'all';
  // The people who can make an offer at all — `makeOfferAction` gates on the
  // deal-write list, minus `ved.docs`, which is this whole file's subject.
  if (actor.permissions.has('crm.leads') || actor.permissions.has('clients.manage')) return 'own';
  return 'none';
}

/** May this person quote a customer at all? Law 4: the SELLER enters the price. */
export function mayOffer(actor: { permissions: { has(code: string): boolean } }): boolean {
  return upsaleScopeFor(actor) !== 'none';
}

/**
 * May this person ALLOW a below-floor promise? (law 4: «below-floor is
 * admin-only».)
 *
 * `finance.reports` and not `finance.debt_override` alone: that grant is held
 * by the logist, the warehouse manager and every sales manager, so a
 * below-floor alarm carrying a client price and a margin would go to the
 * Kashgar warehouse and to competing sellers. The composite is the owner, the
 * admins and the accountant — the same three `upsaleScopeFor` answers `all`
 * for, which is the point: the people who may allow it are the people who may
 * see what it costs.
 */
export function mayApproveBelowFloor(actor: {
  permissions: { has(code: string): boolean };
}): boolean {
  return actor.permissions.has('finance.reports');
}

/** Who to tell that one is waiting — the SAME predicate, asked of the roster. */
export async function approverIds(): Promise<string[]> {
  const { usersWithPermission } = await import('@/modules/platform/notifications/service');
  return usersWithPermission('finance.reports');
}

/**
 * The seller's PRICE as a sight of its own (the owner's 16a, «sotuvchi
 * bergan narxni ham koraversin») — which reverses law 4 for the client price
 * and for nothing else.
 *
 * Two independent facts, never one ranked value (review access-money-15): a
 * person holding `crm.leads` AND `ved.docs` without `finance.reports` is
 * `'own'` by `upsaleScopeFor`, and a ranked «own beats price» would have shown
 * them only the offers they made themselves — 16a lost on exactly the
 * both-hats accounts the owner runs.
 *   - `mayOffer` — may quote a customer (the offer form, the PDF, the own list);
 *   - `seesOfferPrices` — may READ every offer's price on a calc card, through
 *     the `offerPricesFor` projection (no payout, no below-floor reason, no
 *     PDF). The owner, the accountant and the VED.
 * `upsaleScopeFor(ved)` stays `'none'`, pinned by `upsale-scope.test.ts`, so
 * /upsale, every payout and the offer PDF stay shut to the VED.
 */
export interface OfferSight {
  mayOffer: boolean;
  seesOfferPrices: boolean;
}

export function offerSightFor(actor: { permissions: { has(code: string): boolean } }): OfferSight {
  const scope = upsaleScopeFor(actor);
  return {
    mayOffer: scope !== 'none',
    seesOfferPrices: scope === 'all' || actor.permissions.has('ved.docs'),
  };
}
