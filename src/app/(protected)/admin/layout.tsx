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

  const canManage = actor.permissions.has('admin.warehouses.manage');
  const canAudit = actor.permissions.has('admin.audit.browse');
  const canFx = actor.permissions.has('costs.fx.manage');
  if (!canManage && !canAudit && !canFx) redirect('/');

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
  ];

  return (
    <>
      <SubNav items={links} />
      {children}
    </>
  );
}
