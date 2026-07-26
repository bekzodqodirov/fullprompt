import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { SubNav, type SubNavItem } from '@/components/ui/sub-nav';

/**
 * The admin section, with its own nav.
 *
 * That nav used to live in the protected layout, so "warehouses / clients /
 * employees" greeted an admin on the home screen and on every operational
 * page (owner: it should appear only after opening the admin panel).
 *
 * The entry gate accepts any admin-section permission rather than
 * `admin.warehouses.manage` alone: the accountant holds `costs.fx.manage`,
 * the home screen offers them the FX tile, and the old single-permission
 * gate bounced them straight back off their own exchange-rate page. Each
 * page still checks its own permission — this is a cosmetic gate (spec 4.2).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('nav');
  const tCosting = await getTranslations('costing');
  const tRoles = await getTranslations('roles');
  const tFields = await getTranslations('fields');

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
    actor.permissions.has('clients.view_own') || actor.permissions.has('crm.leads');
  if (!canManage && !canAudit && !canFx && !canClients && !canRoles && !canFields) redirect('/');

  const links: SubNavItem[] = [
    ...(canManage
      ? ([
          { href: '/admin/warehouses', label: t('warehouses'), icon: 'crate' },
          { href: '/admin/clients', label: t('clients'), icon: 'users' },
          { href: '/admin/users', label: t('users'), icon: 'user' },
          { href: '/admin/settings', label: t('settings'), icon: 'settings' },
        ] as SubNavItem[])
      : []),
    ...(canAudit
      ? ([
          { href: '/admin/audit', label: t('audit'), icon: 'clipboard' },
          { href: '/admin/notifications', label: t('notifications'), icon: 'alert' },
        ] as SubNavItem[])
      : []),
    ...(canFx
      ? ([{ href: '/admin/fx', label: tCosting('fxTitle'), icon: 'exchange' }] as SubNavItem[])
      : []),
    ...(canFields
      ? ([{ href: '/admin/fields', label: tFields('title'), icon: 'clipboard' }] as SubNavItem[])
      : []),
    ...(canRoles
      ? ([{ href: '/admin/roles', label: tRoles('title'), icon: 'shield' }] as SubNavItem[])
      : []),
  ];

  return (
    <>
      {/* Someone who is only here for a client card gets no admin tabs — an
          empty strip is a bar of nothing at the top of every card. */}
      {links.length > 0 && <SubNav items={links} />}
      {children}
    </>
  );
}
