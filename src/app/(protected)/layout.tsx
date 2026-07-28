import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { logoutAction } from '@/modules/platform/auth/actions';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { readTheme } from '@/modules/platform/theme/theme';
import { Icon } from '@/components/ui/icon';
import { UpdateBanner } from '@/components/update-banner';
import { MobileNav, Sidebar, type NavGroup, type NavItem } from '@/components/ui/nav';
import { Dock } from '@/components/dock';
import { menuItems, NAV, primaryItems } from '@/modules/platform/rbac/nav';

/**
 * The app shell.
 *
 * One bar at the top and the same navigation everywhere: a tab bar under the
 * thumb on a phone, a sidebar on a desktop. Both are generated from the one
 * navigation model, so a screen can never appear in one and be missing from
 * the other — which is how the app came to feel like a pile of pages.
 */
export default async function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('nav');
  const tHome = await getTranslations('home');
  const tSearch = await getTranslations('search');
  const theme = await readTheme();

  // Labels come from each screen's own namespace, so the nav never invents a
  // second name for a page that already has one.
  const label = async (namespace: string, key: string) =>
    (await getTranslations(namespace as 'home'))(key as 'receiving');

  const viewer = { permissions: actor.permissions, roles: actor.roles };
  const groups: NavGroup[] = [];
  for (const group of NAV) {
    const items: NavItem[] = [];
    for (const item of group.items) {
      if (!menuItems(item, viewer)) continue;
      items.push({
        href: item.href,
        label: await label(item.namespace, item.labelKey),
        icon: item.icon,
      });
    }
    if (items.length > 0) groups.push({ title: tHome(group.titleKey as 'sectionInfo'), items });
  }

  // The tab bar takes the short name where one exists — a full screen name
  // under a 60 px icon pushed the ••• button off a 360 px phone.
  const tShort = await getTranslations('navShort');
  const primary: NavItem[] = [];
  for (const item of primaryItems(viewer)) {
    primary.push({
      href: item.href,
      label: item.shortKey
        ? tShort(item.shortKey as 'home')
        : await label(item.namespace, item.labelKey),
      icon: item.icon,
    });
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-surface-raised/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-1 px-3">
          <Link href="/" className="flex items-center gap-2 font-extrabold tracking-tight">
            {/* The real mark, keyed to transparency so it works on both
                themes. A plain <img>: a 32 px logo gains nothing from the
                image optimiser and would cost an extra request through it. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-mark.png" alt="GSR GROUP" width={32} height={32} className="h-8 w-8" />
            <span className="hidden text-ink-900 sm:inline">GSR GROUP</span>
          </Link>
          <div className="min-w-0 flex-1" />
          {/* Search is a tool, not a destination (owner): it lives in the bar
              at every width instead of taking a tile and a sidebar row. */}
          <Link
            href="/search"
            aria-label={tSearch('title')}
            className="btn-ghost btn-icon text-ink-700"
          >
            <Icon name="search" />
          </Link>
          {/* Chat and tasks from ANY page (owner, items 5+7). The chat tab
              follows the conversation gate; tasks belong to everyone. */}
          <Dock
            canChat={
              actor.permissions.has('crm.leads') || actor.permissions.has('clients.manage')
            }
          />
          <ThemeToggle current={theme} />
          <LocaleSwitcher current={actor.locale} />
          <Link href="/profile" aria-label={t('profile')} className="btn-ghost btn-icon text-ink-700">
            <Icon name="user" />
          </Link>
          <form action={logoutAction}>
            <button
              type="submit"
              aria-label={t('logout')}
              className="btn-ghost btn-icon text-ink-700"
            >
              <Icon name="logout" />
            </button>
          </form>
        </div>
      </header>

      {/* The phone can be showing yesterday's app; only the app can notice. */}
      <UpdateBanner />

      <div className="mx-auto flex w-full max-w-6xl">
        <Sidebar groups={groups} />
        {/* The bottom padding clears the tab bar; without it the last row of
            every list sits under the thumb. */}
        <main className="min-w-0 flex-1 p-4 pb-28 md:pb-8">{children}</main>
      </div>

      <MobileNav primary={primary} groups={groups} />
    </div>
  );
}
