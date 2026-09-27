import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';

/**
 * The CRM section pages that are NOT the board (round 73).
 *
 * They carried their own tab strip until the workspaces round (2026-09-26):
 * now they are tabs of «Mijozlar va savdo» and «Hisobotlar», drawn once by the
 * shell. The board's ⋯ menu still carries the same doors, because on a phone
 * the board hides the strip (round 72: the board IS the screen). What stays
 * here is the door.
 */
export default async function CrmPagesLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  return <>{children}</>;
}
