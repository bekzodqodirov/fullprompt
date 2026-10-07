import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { SearchPalette } from '@/components/search-palette';
import { QuickCreate, type QuickAction, type QuickKind } from '@/components/quick-create';
import { canMintClient } from '@/modules/platform/clients/service';
import { readTheme } from '@/modules/platform/theme/theme';
import { Icon } from '@/components/ui/icon';
import { UpdateBanner } from '@/components/update-banner';
import { SchemaBanner } from '@/components/schema-banner';
import { isAnalyst } from '@/modules/platform/ai/tools';
import { NavProgress } from '@/components/nav-progress';
import {
  MobileNav,
  Sidebar,
  type FrequentNav,
  type NavItem,
  type NavLabels,
  type WsNav,
} from '@/components/ui/nav';
import { WorkspaceTabs } from '@/components/ui/ws-tabs';
import { Dock } from '@/components/dock';
import { canReadTg } from '@/modules/wms/crm/conversations';
import { mayEditDealTerms } from '@/modules/wms/deals/door';
import { primaryItems } from '@/modules/platform/rbac/nav';
import { REPORT_GROUPS } from '@/modules/platform/rbac/workspaces';
import { frequentFor, workspacesFor, type FrequentRow } from '@/modules/platform/nav/usage';
import { logger } from '@/modules/platform/logger';
import { db } from '@/modules/platform/db/client';
import { warehouses } from '@/modules/platform/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

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
  const tSearch = await getTranslations('search');
  const theme = await readTheme();
  const quickKinds: QuickKind[] = [
    ...(actor.permissions.has('crm.leads') ? (['lead'] as const) : []),
    // One predicate, asked here and again inside the action — a screen that
    // offers what the action refuses is worse than neither (round 111).
    ...(canMintClient(actor.permissions) ? (['client'] as const) : []),
  ];
  // Which kinds have a FULL form this person can actually open. `/admin/clients/new`
  // is `clients.manage` at the page AND at its action, so the seller the quick
  // door was just opened to would be bounced to the home screen by «Batafsil»,
  // losing what they had typed. Hiding the link is the honest v1: widening that
  // page also hands over the typed-code field, the manager picker and the
  // internal notes, which is a separate decision and the owner's to make.
  const quickFullForms: QuickKind[] = quickKinds.filter(
    (kind) => kind !== 'client' || actor.permissions.has('clients.manage'),
  );

  // Labels come from each screen's own namespace, so the tab bar never
  // invents a second name for a page that already has one.
  const label = async (namespace: string, key: string) =>
    (await getTranslations(namespace as 'home'))(key as 'receiving');

  const viewer = { permissions: actor.permissions, roles: actor.roles };

  // The menu by job (2026-09-26, docs/NAV-WORKSPACES.md): ONE model for the
  // sidebar, the ••• sheet and the tab strip, so none of them can offer a
  // page another hides.
  const tWs = await getTranslations('ws');
  const visible = workspacesFor(viewer);
  const wsLabel = (key: string) => tWs(`name.${key}` as 'name.home');
  const tabLabel = (key: string) => tWs(`tab.${key}` as 'tab.home');
  const workspaces: WsNav[] = visible.map((ws) => ({
    key: ws.key,
    label: wsLabel(ws.key),
    icon: ws.icon,
    href: ws.href,
    strip: ws.strip,
    tabs: ws.tabs.map((tab) => ({
      href: tab.href,
      label: tabLabel(tab.key),
      ...(tab.group ? { group: tab.group } : {}),
      ...(tab.claims ? { claims: tab.claims } : {}),
    })),
    settings: ws.settings.map((tab) => ({ href: tab.href, label: tabLabel(tab.key) })),
    ...(ws.key === 'reports'
      ? {
          groups: REPORT_GROUPS.flatMap((group) => {
            const first = ws.tabs.find((tab) => tab.group === group);
            return first ? [{ key: group, label: tWs(`group.${group}` as 'group.biz'), href: first.href }] : [];
          }),
        }
      : {}),
  }));

  // «Tez-tez» reads a table this release adds. The layout is every page, so
  // on deploy morning — the app a release ahead of its database — an uncaught
  // read here would take the whole app down (#472): the block is simply empty
  // until the migration has run.
  let frequentRows: FrequentRow[] = [];
  try {
    frequentRows = await frequentFor(actor.id, visible);
  } catch (err) {
    logger.warn({ err }, '[nav] frequent pages unavailable');
  }
  const frequent: FrequentNav[] = frequentRows.flatMap((row) => {
    for (const ws of workspaces) {
      const tab = [...ws.tabs, ...ws.settings].find((one) => one.href === row.href);
      if (tab) return [{ href: row.href, label: tab.label, icon: ws.icon, where: ws.label, starred: row.starred }];
    }
    return [];
  });
  // «+ Yangi»'s doors (answer 5), each offered only where its destination is
  // in this person's menu AND its screen would let them write — the same
  // «a door that bounces is worse than none» the tabs follow.
  const offered = new Set(visible.flatMap((ws) => [...ws.tabs, ...ws.settings].map((tab) => tab.href)));
  const has = (code: string) => actor.permissions.has(code);
  const quickActions: QuickAction[] = [
    ...(offered.has('/receive') ? [{ key: 'receive' as const }] : []),
    // Opening a deal is the seller's (G4 a) — the VED's /bitimlar is a read-only slice.
    ...(offered.has('/bitimlar') && mayEditDealTerms(actor.permissions) ? [{ key: 'deal' as const }] : []),
    // The ledger's payment form is `finance.manage`'s (finance/[clientId]).
    ...(offered.has('/finance') && has('finance.manage') ? [{ key: 'payment' as const }] : []),
    ...(offered.has('/accounting/expenses') ? [{ key: 'expense' as const }] : []),
    // Asking for a calculation is the SELLER's move; the VED is the one who
    // answers it, so the door is not offered to `ved.docs` alone — the same
    // pair as a deal's terms, asked through its one home (17a).
    ...((offered.has('/crm') || offered.has('/bitimlar')) && mayEditDealTerms(actor.permissions)
      ? [{ key: 'calc' as const }]
      : []),
    ...(offered.has('/bugun') ? [{ key: 'task' as const }] : []),
  ];

  const navLabels: NavLabels = {
    frequent: tWs('frequent'),
    more: tWs('more'),
    workspaces: tWs('workspaces'),
    settings: tWs('settings'),
    tabs: tWs('tabsLabel'),
    star: tWs('star'),
    unstar: tWs('unstar'),
    starFull: tWs('starFull'),
  };

  // The tab bar takes the short name where one exists — a full screen name
  // under a 60 px icon pushed the ••• button off a 360 px phone.
  const tShort = await getTranslations('navShort');
  const primary: NavItem[] = [];
  // A warehouse that hands cargo to clients gets «Topshirish» on its bar
  // (answer 6's «o'zing tavsiya qil», per warehouse). One indexed read, and
  // only for the warehouse-scoped — nobody else's bar depends on it.
  const issuesToClients =
    actor.warehouseScoped && actor.warehouseIds.length > 0
      ? (
          await db
            .select({ id: warehouses.id })
            .from(warehouses)
            .where(and(inArray(warehouses.id, actor.warehouseIds), eq(warehouses.issuesToClients, true)))
            .limit(1)
        ).length > 0
      : false;
  for (const item of primaryItems(viewer, 4, { issuesToClients })) {
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
      {/* A tap from Uzbekistan to Germany and back has half a second where
          App Router shows the old screen and nothing moves. This is the only
          thing on it (round 45). NOT wrapped in Suspense, and it reads no
          navigation hook: a boundary here hydrates late, and a listener that
          attaches late misses the taps it exists for. */}
      <NavProgress />
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
          {/* Which objects this person may mint, decided HERE: the client
              component holds no permission knowledge, the same way the nav
              receives a ready list rather than the rules behind it. */}
          <QuickCreate kinds={quickKinds} fullForms={quickFullForms} actions={quickActions} />
          {/* Search is a tool, not a destination (owner): it lives in the bar
              at every width instead of taking a tile and a sidebar row. */}
          {/* The palette wraps the link rather than replacing it: with no
              JavaScript, or before hydration, the icon still opens a page
              that works. Ctrl/⌘+K reaches the same panel from anywhere. */}
          <SearchPalette>
            <Link
              href="/search"
              aria-label={tSearch('title')}
              className="btn-ghost btn-icon text-ink-700"
            >
              <Icon name="search" />
            </Link>
          </SearchPalette>
          {/* Chat and tasks from ANY page (owner, items 5+7). The chat tab
              follows the conversation gate; tasks belong to everyone. */}
          <Dock canChat={canReadTg(actor)} />
          <ThemeToggle current={theme} />
          {/* Hidden on a phone — it lives on /profile there. Seven controls
              at 44 px do not fit in 360 px, and flex silently squeezed every
              one of them to 33 px when the «+» was added. */}
          <span className="hidden sm:inline-flex">
            <LocaleSwitcher current={actor.locale} />
          </span>
          {/* Signing out lives on /profile now (owner: «logoutni profil ichiga
              kirgaz»). It sat here as the rightmost 44 px target on every
              screen — a thumb's width from the theme toggle, and the one
              control in the bar that ends the session. */}
          <Link href="/profile" aria-label={t('profile')} className="btn-ghost btn-icon text-ink-700">
            <Icon name="user" />
          </Link>
        </div>
      </header>

      {/* The phone can be showing yesterday's app; only the app can notice. */}
      <UpdateBanner />
      {/* …and the server can be running on yesterday's database (B9) — said to
          the two roles who can act on it, and never able to throw. */}
      {isAnalyst(actor) && <SchemaBanner />}

      <div className="mx-auto flex w-full max-w-6xl">
        <Sidebar workspaces={workspaces} frequent={frequent} labels={navLabels} />
        {/* The bottom padding clears the tab bar; without it the last row of
            every list sits under the thumb. */}
        <main className="min-w-0 flex-1 p-4 pb-28 md:pb-8">
          <WorkspaceTabs
            workspaces={workspaces}
            starred={frequent.filter((item) => item.starred).map((item) => item.href)}
            labels={navLabels}
          />
          {children}
        </main>
      </div>

      <MobileNav primary={primary} workspaces={workspaces} frequent={frequent} labels={navLabels} />
    </div>
  );
}
