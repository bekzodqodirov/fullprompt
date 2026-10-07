import type { DebtReleaser } from '@/modules/wms/finance/scope';

/**
 * The person behind a fixture's handover, decision or deferral (0114): the
 * three services now take them REQUIRED (#790 — an optional one fails open),
 * because WHOSE client the debt is decides whether they may let it slide.
 *
 * `wholeLedger` is the admin's and the accountant's shape — the grant plus a
 * whole-ledger reader — so a fixture that ticked «ruxsat» before the rule
 * keeps meaning exactly what it meant. A test ABOUT the rule builds its own
 * seller or warehouse manager instead.
 *
 * Since D2 (2026-10-07) the counter also asks WHERE the releaser stands and
 * which role he holds, and what that role was given (`counterDebtRelease`):
 * an unscoped reader with no role the rule keys on — so no role's own grants
 * either — and the whole-ledger answer is still the only one he gets. A
 * `DebtReleaser` is a `MoneyActor`, so the deferral and decision doors take
 * the same value.
 */
export const wholeLedger = (id: string): DebtReleaser => ({
  id,
  permissions: new Set(['finance.debt_override', 'finance.view', 'finance.manage']),
  roles: [],
  roleGrants: new Map(),
  warehouseScoped: false,
  warehouseIds: [],
});
