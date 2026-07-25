import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { logoutAction } from '@/modules/platform/auth/actions';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { Icon } from '@/components/ui/icon';
import { MobileNav, Sidebar, type NavGroup, type NavItem } from '@/components/ui/nav';
import { canSee, NAV, primaryItems } from '@/modules/platform/rbac/nav';

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

  // Labels come from each screen's own namespace, so the nav never invents a
  // second name for a page that already has one.
  const label = async (namespace: string, key: string) =>
    (await getTranslations(namespace as 'home'))(key as 'receiving');

  const viewer = { permissions: actor.permissions, roles: actor.roles };
  const groups: NavGroup[] = [];
  for (const group of NAV) {
    const items: NavItem[] = [];
    for (const item of group.items) {
      if (!canSee(item, viewer)) continue;
      items.push({
        href: item.href,
        label: await label(item.namespace, item.labelKey),
        icon: item.icon,
      });
    }
    if (items.length > 0) groups.push({ title: tHome(group.titleKey as 'sectionInfo'), items });
  }

  const primary: NavItem[] = [];
  for (const item of primaryItems(viewer)) {
    primary.push({
      href: item.href,
      label: await label(item.namespace, item.labelKey),
      icon: item.icon,
    });
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-surface-raised/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-1 px-3">
          <Link href="/" className="flex items-center gap-2 font-extrabold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-600 text-sm text-white">
              GS
            </span>
            <span className="hidden text-ink-900 sm:inline">GSR LOGISTICS</span>
          </Link>
          <div className="min-w-0 flex-1" />
          <Link
            href="/search"
            aria-label={t('home')}
            className="btn-ghost btn-icon text-ink-700 md:hidden"
          >
            <Icon name="search" />
          </Link>
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
