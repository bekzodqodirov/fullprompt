import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';

/**
 * CRM section — the gate only. A sales manager works their own leads; the
 * owner and the logist hold `crm.leads.view_all` and see everyone's; only
 * `crm.manage` reaches the settings that reshape the funnel.
 *
 * The tab strip left this layout in round 73: the funnel is the front door
 * and the owner refused a row above his board, so the section links live in
 * the board's ⋯ menu, and the strip renders only inside `(pages)` — the
 * screens it actually names.
 */
export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  return <>{children}</>;
}
