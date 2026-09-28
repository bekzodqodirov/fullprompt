import type { MoneyActor } from '@/modules/wms/finance/scope';

/**
 * The person behind a fixture's handover, decision or deferral (0114): the
 * three services now take them REQUIRED (#790 — an optional one fails open),
 * because WHOSE client the debt is decides whether they may let it slide.
 *
 * `wholeLedger` is the admin's and the accountant's shape — the grant plus a
 * whole-ledger reader — so a fixture that ticked «ruxsat» before the rule
 * keeps meaning exactly what it meant. A test ABOUT the rule builds its own
 * seller or warehouse manager instead.
 */
export const wholeLedger = (id: string): MoneyActor => ({
  id,
  permissions: new Set(['finance.debt_override', 'finance.view', 'finance.manage']),
});
