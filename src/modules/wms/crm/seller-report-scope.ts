import type { Actor } from '@/modules/platform/rbac/authorize';

/**
 * Who reads the seller performance report, and how much of it
 * (owner, 2026-08-25: «2 ha qur · 3 tannarx korinmasin sotuvchiga»).
 *
 * Its own door file, like `upsale-scope.ts` and `control-scope.ts` before it,
 * because the wrong existing predicate is wrong in a recorded way each time:
 *
 * - `finance.reports` → **all**: the owner and the accountant. Profit is
 *   revenue minus COST, and the cost side is law 4's fence — so the full
 *   table follows the same grant every other cost-bearing screen follows.
 * - `reports.own_clients` → **own**: the seller reads their own volume and
 *   revenue and NOTHING cost-derived. Deliberately NOT `crm.leads`: the
 *   logist holds `crm.leads` (and `clients.manage`) but is nobody's
 *   `sales_manager_id`, so that grant would offer them a permanently empty
 *   row — a dead screen, not a leak, but round 47's rule stands: a door is
 *   only offered to people it answers.
 * - everyone else → **none**. The VED reads costs all day and client money
 *   never (law 4's other half), and this screen is client money.
 *
 * #170: both codes exist in the catalog; no new permission.
 */
export type SellerReportScope = 'all' | 'own' | 'none';

export function sellerReportScopeFor(actor: Actor): SellerReportScope {
  if (actor.permissions.has('finance.reports')) return 'all';
  if (actor.permissions.has('reports.own_clients')) return 'own';
  return 'none';
}
