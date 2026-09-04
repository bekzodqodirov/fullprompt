/**
 * Who may read «hisob vs haqiqat» (VED phase E1).
 *
 * A THIRD door, and deliberately not one of the two that already exist,
 * because it answers a third question. The screen is a pure COST breakdown —
 * what we quoted the state for customs against what we actually paid — and
 * carries no client price at all, so:
 *
 *   - It is **not** `upsaleScopeFor`. That one answers `'none'` for the
 *     `ved_manager` (no `finance.reports`), which is right for a screen
 *     carrying a client price and exactly wrong here: the VED is the person
 *     being measured and the one who has to see the number to act on it. And
 *     it answers `'own'` for every `sales_manager` (they hold `crm.leads`),
 *     which would put the company's landed customs costs on a seller's
 *     screen — law 10 says sellers read prices, never the cost breakdown.
 *   - It is **not** round 91's `seesAllMoney` either: that is
 *     `finance.manage || clients.manage`, which admits the VED to everybody's
 *     row rather than their own.
 *
 * No new permission code (#170), so the audience is a property of the matrix
 * the owner edits on /admin/roles — which is why the test enumerates every
 * seeded role instead of asserting the predicate's shape.
 */
export type CalcControlScope =
  /** Owner, admins, accountant: every calculation in the company. */
  | 'all'
  /** The VED: the calculations they sealed themselves. */
  | 'own'
  /** Everybody else, sellers included. */
  | 'none';

export function calcControlScopeFor(actor: {
  permissions: { has(code: string): boolean };
}): CalcControlScope {
  if (actor.permissions.has('finance.reports')) return 'all';
  if (actor.permissions.has('ved.docs')) return 'own';
  return 'none';
}

/**
 * Who may read the registry of SEALED calculations (`/hisoblash/tarix`).
 *
 * The owner's answer 2A: himself, the accountant and the VED people — and NOT
 * the sellers, because every figure on that screen is a FLOOR (law 4).
 *
 * A BOOLEAN and not a reuse of `calcControlScopeFor`, on purpose. That one's
 * `'own'` means «the calculations you sealed yourself», which is right for a
 * screen that MEASURES the person and wrong for a history: a VED pricing a
 * Guangzhou→Tashkent podklyuch needs the company's last answer on that route,
 * not their own. And it adds no read a `ved.docs` holder does not already
 * have — `quoteHistoryFor` on /hisoblash/narxlar is company-wide by code —
 * it adds a way to FIND it.
 */
export function mayReadCalcRegistry(actor: {
  permissions: { has(code: string): boolean };
}): boolean {
  return actor.permissions.has('finance.reports') || actor.permissions.has('ved.docs');
}
