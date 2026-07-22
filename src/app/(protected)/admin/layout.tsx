import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  // UI-level gate only (cosmetic, spec 4.2) — every server action re-checks.
  if (!actor.permissions.has('admin.warehouses.manage')) redirect('/');
  return <>{children}</>;
}
