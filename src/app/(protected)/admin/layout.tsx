import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { AdminBack } from './admin-back';

/**
 * The admin section.
 *
 * Navigation here is the HUB at /admin and a way back to it — the tab strip
 * this layout used to render duplicated the hub's buttons and scrolled off a
 * phone (owner, 2026-07-28: "tepadagi menyu turibdi, u kerak emas").
 *
 * The entry gate accepts any admin-section permission rather than
 * `admin.warehouses.manage` alone: the accountant holds `costs.fx.manage`,
 * the menu offers them the door, and a single-permission gate would bounce
 * them off their own exchange-rate page. Each page still checks its own
 * permission — this is a cosmetic gate (spec 4.2).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const tHome = await getTranslations('home');

  const canManage = actor.permissions.has('admin.warehouses.manage');
  const canAudit = actor.permissions.has('admin.audit.browse');
  const canFx = actor.permissions.has('costs.fx.manage');
  const canRoles = actor.permissions.has('platform.roles.manage');
  const canFields = actor.permissions.has('admin.dictionaries.manage');
  // A client CARD is not an admin screen — it just happens to live under
  // /admin/clients. Without this a sales manager was bounced home from their
  // own call list, the dormant list and "my clients", every one of which
  // links straight here. The card checks its own permission; this gate is
  // cosmetic (spec 4.2).
  const canClients =
    actor.permissions.has('clients.manage') ||
    actor.permissions.has('clients.view_own') ||
    actor.permissions.has('crm.leads');
  if (!canManage && !canAudit && !canFx && !canClients && !canRoles && !canFields) redirect('/');

  // The way back to the hub — only for somebody the hub would actually let
  // in. A salesperson passing through to a client card holds none of these,
  // and a door that bounces is worse than no door.
  const hasHub =
    canManage ||
    canAudit ||
    canFx ||
    canRoles ||
    canFields ||
    actor.permissions.has('plans.manage') ||
    actor.permissions.has('admin.settings.manage');

  return (
    <>
      {hasHub && <AdminBack label={tHome('adminPanel')} />}
      {children}
    </>
  );
}
