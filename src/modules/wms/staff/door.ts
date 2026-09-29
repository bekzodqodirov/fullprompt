import { upsaleScopeFor } from '../calc/upsale-scope';
import { maySeeStaffMoney } from '../partners/staff';

/**
 * Who may do what with a colleague's pay (0117) — the one table the pages AND
 * the actions ask, so a button can never be drawn for somebody its action
 * refuses, or the reverse (#531):
 *
 *  - READ /hodimlar (salaries, KPI, the unstamped cargo): `maySeeStaffMoney`
 *    = `finance.expenses`, the staff account's own door (partners/staff.ts —
 *    the owner's M2a/M3a «faqat buxgalter va admin»). NOT `finance.reports`
 *    alone: a salary is payroll, and the analyst who reads the P&L is not
 *    the person who pays people.
 *  - PAY a commission — the upsale's or the KPI's: `mayPayCommission`, the
 *    pair the /upsale payout has always asked (writing an expense is the
 *    kassa holder's power, seeing whose commission it is is law 4's), now ONE
 *    predicate both actions call. Neither alone: the VED with a kassa grant
 *    may spend money and must never see a seller's earnings (law 4), and the
 *    owner's read-only analyst may see them and must not press pay.
 *  - The upsale COLUMN on /hodimlar: `upsaleScopeFor === 'all'` exactly — the
 *    logist holds `clients.manage`, which makes the scope 'own', and a
 *    colleague's upsale is not his (#1047's audience).
 *  - EDIT the KPI table and pick the two categories: `admin.settings.manage`,
 *    the upsale category picker's precedent — a company setting, not the
 *    accountant's press.
 */

type Actor = { permissions: { has(code: string): boolean } };

export { maySeeStaffMoney };

export function mayPayCommission(actor: Actor): boolean {
  return actor.permissions.has('finance.expenses') && upsaleScopeFor(actor) === 'all';
}

export function maySeeStaffUpsale(actor: Actor): boolean {
  return upsaleScopeFor(actor) === 'all';
}

export function mayEditKpiTable(actor: Actor): boolean {
  return actor.permissions.has('admin.settings.manage');
}
