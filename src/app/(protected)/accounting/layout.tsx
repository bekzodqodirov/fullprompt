import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';

/**
 * Management accounting section.
 *
 * Gated hard: profit and overheads are the owner's and the accountant's
 * business (owner's answer 7). A sales manager holds `finance.view` and sees
 * client balances — they must never reach the company's margin from here.
 *
 * The section's own tab strip is gone (2026-09-26): its pages are now tabs of
 * two workspaces — the books in «Pul», the reports in «Hisobotlar» — drawn by
 * the shell from `rbac/workspaces.ts`, where each tab asks the page's own
 * gate. What stays here is the section's DOOR, which the strip never was.
 */
export default async function AccountingLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const canReport = actor.permissions.has('finance.reports');
  const canEnter = actor.permissions.has('finance.expenses');
  if (!canReport && !canEnter) redirect('/');
  return <>{children}</>;
}
