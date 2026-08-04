import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { Icon, type IconName } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page';

/**
 * The administration HUB (owner, 2026-07-28): "administrativniyga kirsa
 * to'g'ridan-to'g'ri warehouselarga o'tib ketyapti … undan ko'ra kirganda u
 * yerdan qilish mumkin bo'lgan joylarni buttonlari tursa yaxshi bo'lar edi."
 *
 * Before this, «Boshqaruv» landed on the warehouse list and the other nine
 * sections lived in a strip that scrolls off a phone screen — a person who
 * did not already know they were there never learnt it. One page of big
 * buttons, each shown only to somebody allowed through its door.
 */
export default async function AdminHubPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('nav');
  const tHome = await getTranslations('home');
  const tCosting = await getTranslations('costing');
  const tPartners = await getTranslations('partners');
  const tRoles = await getTranslations('roles');
  const tFields = await getTranslations('fields');
  const tPlans = await getTranslations('plans');
  const tSettings = await getTranslations('settings');
  const tAutomation = await getTranslations('automation');

  const has = (code: string) => actor.permissions.has(code);
  const all: { href: string; label: string; icon: IconName; show: boolean }[] = [
    { href: '/admin/warehouses', label: t('warehouses'), icon: 'crate', show: has('admin.warehouses.manage') },
    { href: '/admin/users', label: t('users'), icon: 'user', show: has('admin.warehouses.manage') },
    { href: '/admin/clients', label: t('clients'), icon: 'users', show: has('clients.manage') },
    { href: '/admin/settings', label: t('settings'), icon: 'settings', show: has('admin.settings.manage') || has('admin.warehouses.manage') },
    { href: '/admin/roles', label: tRoles('title'), icon: 'shield', show: has('platform.roles.manage') },
    { href: '/admin/fields', label: tFields('title'), icon: 'clipboard', show: has('admin.dictionaries.manage') },
    // Phase 8's «Свои списки» editor is off the hub — the owner looked at the
    // feature and said «kerak emas, olib tashla». /admin/entities and /o still
    // answer, and `custom_entities` / `custom_records` are untouched, so
    // whatever anyone put in there is still there if he changes his mind.
    { href: '/admin/cost-types', label: tCosting('typesTitle'), icon: 'wallet', show: has('admin.dictionaries.manage') },
    { href: '/admin/partner-types', label: tPartners('typesTitle'), icon: 'briefcase', show: has('admin.dictionaries.manage') },
    { href: '/admin/fx', label: tCosting('fxTitle'), icon: 'exchange', show: has('costs.fx.manage') },
    { href: '/admin/trucks', label: tPlans('trucksTitle'), icon: 'truck', show: has('plans.manage') },
    { href: '/admin/driver-app', label: tSettings('driverApp'), icon: 'truck', show: has('admin.settings.manage') },
    { href: '/admin/rules', label: tAutomation('title'), icon: 'target', show: has('admin.settings.manage') },
    { href: '/admin/audit', label: t('audit'), icon: 'clipboard', show: has('admin.audit.browse') },
    { href: '/admin/notifications', label: t('notifications'), icon: 'alert', show: has('admin.audit.browse') },
  ];
  const tiles = all.filter((tile) => tile.show);

  // Somebody with exactly one door gets walked through it instead of being
  // shown a hub of one button.
  if (tiles.length === 0) redirect('/');
  if (tiles.length === 1) redirect(tiles[0]!.href);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <PageHeader icon="settings" title={tHome('adminPanel')} />
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
        {tiles.map((tile) => (
          <Link
            key={tile.href}
            href={tile.href}
            data-testid="admin-tile"
            className="card-tap flex min-h-20 items-center gap-3 !p-4"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
              <Icon name={tile.icon} className="h-5 w-5" />
            </span>
            <span className="text-sm font-bold leading-tight [overflow-wrap:anywhere]">
              {tile.label}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
