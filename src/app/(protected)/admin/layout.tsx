import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';

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

  const links = [
    ...(canManage
      ? [
          { href: '/admin/warehouses', label: t('warehouses') },
          { href: '/admin/clients', label: t('clients') },
          { href: '/admin/users', label: t('users') },
          { href: '/admin/settings', label: t('settings') },
        ]
      : []),
    ...(canAudit
      ? [
          { href: '/admin/audit', label: t('audit') },
          { href: '/admin/notifications', label: t('notifications') },
        ]
      : []),
    ...(canFx ? [{ href: '/admin/fx', label: `💱 ${tCosting('fxTitle')}` }] : []),
  ];

  return (
    <>
      {/* Negative margins pull the bar to the edges of <main>'s padding. */}
      <nav className="-mx-4 -mt-4 mb-4 flex gap-1 overflow-x-auto border-b border-gray-200 bg-white px-4 py-2 text-sm font-semibold">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className="whitespace-nowrap rounded-md px-3 py-2 hover:bg-gray-100"
          >
            {link.label}
          </Link>
        ))}
      </nav>
      {children}
    </>
  );
}
