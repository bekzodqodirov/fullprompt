import type { IconName } from '@/components/ui/icon';
import { NAV, menuItems, type NavItemSpec, type Viewer } from './nav';
import { moneyHidden, type MoneySight } from './money-sight';

/**
 * The menu by JOB — «ish joylari» (owner, 2026-09-26, answer 1a; the design
 * is docs/NAV-WORKSPACES.md).
 *
 * The flat NAV had grown to 36 entries in four groups ordered by when each
 * screen was built: money work lived in 17 places, «where is the cargo» in 16,
 * and 40-odd screens could only be reached from inside another one. Here the
 * same screens are gathered into eight workspaces, and a workspace's pages sit
 * in ONE strip at the top of each of them.
 *
 * Three rules this file does not bend:
 *
 *  - **No route moves.** A tab is a link to a URL that already exists —
 *    Telegram messages, notifications and `links.ts` carry those URLs.
 *  - **A menu decision is never an access decision.** Every page keeps its own
 *    gate. A tab is shown only to somebody that gate admits, because a door
 *    that bounces is worse than no door, and a tab can never be the way
 *    somebody reaches a page they could not reach before.
 *  - **Curation only removes.** A tab that is itself a NAV entry is visible
 *    exactly when `menuItems` says so; a sub-page hangs off one or more NAV
 *    entries (`via`) and is visible only when one of those is in the viewer's
 *    menu AND the page's own permission test passes. So the curated role menus
 *    (`MENU_BY_ROLE`) narrow the workspaces exactly as they narrowed the old
 *    menu, and nothing here can widen it.
 *
 * `need` restates a page gate that lives in `wms` (platform must not import
 * wms); `tests/unit/workspaces.test.ts` walks every seeded role through every
 * tab and asks the page's own predicate, so the two cannot drift silently.
 */

export type WorkspaceKey =
  | 'home'
  | 'day'
  | 'sklad'
  | 'yol'
  | 'savdo'
  | 'calc'
  | 'pul'
  | 'reports'
  | 'admin';

/** The report workspace's own grouping (answer 7a: every report in one place). */
export type ReportGroup = 'biz' | 'money' | 'sales' | 'cargo' | 'staff' | 'ved';

export const REPORT_GROUPS: ReportGroup[] = ['biz', 'money', 'sales', 'cargo', 'staff', 'ved'];

export interface WsTab {
  href: string;
  /** Key under `ws.tab` — a strip wants a short word, not the page's title. */
  key: string;
  /**
   * For a sub-page only: EVERY inner list must be satisfied, each by any one
   * of its codes. `[['finance.manage'], ['finance.reports']]` is «both»;
   * `[['crm.leads', 'clients.manage']]` is «either».
   */
  need?: string[][];
  /** For a sub-page only: the viewer must hold one of these ROLES. */
  roles?: string[];
  /**
   * For a sub-page only: the NAV entries it hangs from. It is shown only when
   * one of them is in the viewer's menu — which is how a curated role keeps
   * the narrowing it had.
   */
  via?: string[];
  /** Hidden when the Q19 money sight hides this kind from the viewer. */
  sight?: MoneySight;
  /** Hisobotlar only. */
  group?: ReportGroup;
  /**
   * Other path prefixes that belong to this tab — a detail page whose URL is
   * not under its list's (a box card lives at /boxes/<id>, its list is /stock).
   */
  claims?: string[];
}

export interface WorkspaceSpec {
  key: WorkspaceKey;
  icon: IconName;
  tabs: WsTab[];
  /** The workspace's own settings (answer 8b), behind the ⚙ at the strip's end. */
  settings?: WsTab[];
  /**
   * Where the workspace's menu row goes, in order of preference; the first of
   * these the viewer is offered wins, else the first visible tab. Hisobotlar
   * needs it: the VED's first visible report is an empty client-history
   * search, and the cargo hub is the useful door.
   */
  entry?: string[];
  /**
   * Pages that belong to the workspace without being one of its tabs — the
   * strip is drawn there with NO tab lit, no star and no visit counted
   * (/crm/today is off every menu by the owner's word, round 75, and must not
   * light «Voronka» or count as a funnel visit).
   */
  pages?: string[];
  /** «Bosh sahifa» and «Boshqaruv» draw no strip: the home IS the overview,
      and the administration hub is its own navigation. */
  strip: boolean;
}

/** The batch-reading door (`wms/batches/read-door.ts`), spelled out once here. */
const BATCH_READERS = ['scan.load', 'scan.unload', 'ved.docs', 'plans.manage', 'batches.depart_close'];
const ANY_REPORT = ['reports.all_warehouses', 'reports.own_warehouse'];

export const WORKSPACES: WorkspaceSpec[] = [
  { key: 'home', icon: 'home', strip: false, tabs: [{ href: '/', key: 'home' }] },
  {
    key: 'day',
    icon: 'check',
    strip: true,
    tabs: [
      { href: '/bugun', key: 'bugun' },
      { href: '/kalendar', key: 'kalendar' },
      // The debt-override queue is somebody's decision to make today, and it
      // is decided by people from three jobs — it is «my day», not «money».
      { href: '/approvals', key: 'approvals' },
      { href: '/zametkalar', key: 'zametkalar' },
      { href: '/ai', key: 'ai' },
    ],
  },
  {
    key: 'sklad',
    icon: 'boxes',
    strip: true,
    tabs: [
      { href: '/stock', key: 'stock', claims: ['/boxes'] },
      { href: '/receive', key: 'receive' },
      { href: '/receipts', key: 'receipts' },
      { href: '/unclaimed', key: 'unclaimed' },
      { href: '/issue', key: 'issue' },
      { href: '/crates', key: 'crates' },
      { href: '/inventory', key: 'inventory' },
    ],
  },
  {
    key: 'yol',
    icon: 'truck',
    strip: true,
    tabs: [
      { href: '/batches', key: 'batches' },
      { href: '/plans', key: 'plans' },
      { href: '/trucks', key: 'trucks' },
      { href: '/map', key: 'map' },
      { href: '/zavod', key: 'zavod' },
      { href: '/arrivals', key: 'arrivals' },
    ],
    settings: [
      // `mayReadPickups` — the same door as /zavod itself.
      {
        href: '/zavod/zavodlar',
        key: 'factories',
        need: [['plans.manage', 'costs.enter_batch', 'finance.reports']],
        via: ['/zavod'],
      },
      { href: '/admin/trucks', key: 'truckPresets', need: [['plans.manage']], via: ['/plans', '/batches'] },
    ],
  },
  {
    key: 'savdo',
    icon: 'users',
    strip: true,
    pages: ['/crm/today'],
    tabs: [
      // The deal board and the funnel lead, as a PAIR, for the same reason
      // they lead NAV's sales group (round 75): the home tiles are grouped by
      // workspace in this order, and index 0 is the only place the per-viewer
      // filter cannot move.
      { href: '/bitimlar', key: 'bitimlar' },
      { href: '/crm', key: 'crm' },
      { href: '/admin/clients', key: 'clients' },
      { href: '/suhbatlar', key: 'suhbatlar' },
      { href: '/my-clients', key: 'myClients' },
      // «Olib ketilmagan yuk» (0116) — `mayOpenMyClients`'s grants. Hung off
      // the client book too: the logist's menu carries /admin/clients and not
      // /my-clients, and the page's door admits him.
      {
        href: '/my-clients/olib-ketilmagan',
        key: 'uncollected',
        need: [['crm.leads', 'clients.manage']],
        via: ['/my-clients', '/admin/clients'],
      },
      { href: '/crm/dormant', key: 'dormant', need: [['crm.leads']], via: ['/crm'] },
      { href: '/crm/kelganlar', key: 'kelganlar', need: [['crm.leads'], ['crm.manage']], via: ['/crm'] },
      { href: '/crm/people', key: 'people', need: [['crm.leads'], ['crm.manage']], via: ['/crm'] },
      // `mayBroadcast` is the super_admin ROLE (his 6a), not a permission.
      {
        href: '/admin/xabarlar',
        key: 'broadcast',
        roles: ['super_admin'],
        via: ['/admin/clients', '/crm', '/bitimlar'],
      },
    ],
    settings: [
      { href: '/crm/settings', key: 'crmSettings', need: [['crm.leads'], ['crm.manage']], via: ['/crm'] },
      { href: '/bitimlar/etaplar', key: 'dealStages', need: [['crm.manage']], via: ['/bitimlar'] },
      // `canReadTg`'s grants; its two admin ROLES hold every permission.
      {
        href: '/suhbatlar/shablonlar',
        key: 'templates',
        need: [['crm.leads', 'clients.manage', 'ved.docs']],
        via: ['/suhbatlar'],
      },
      {
        href: '/suhbatlar/ulash',
        key: 'tgConnect',
        need: [['crm.leads', 'clients.manage']],
        via: ['/suhbatlar'],
      },
      { href: '/admin/taqsimot', key: 'routing', need: [['admin.settings.manage']], via: ['/crm'] },
    ],
  },
  {
    key: 'calc',
    icon: 'report',
    strip: true,
    tabs: [
      { href: '/hisoblash', key: 'calcQueue' },
      { href: '/hisoblash/tarix', key: 'calcHistory' },
      // `upsaleScopeFor !== 'none' || ved.docs`, hung off the two calc doors
      // so a seller — who reaches it from a card panel — gains no workspace.
      {
        href: '/hisoblash/narxlar',
        key: 'calcPrices',
        need: [['finance.reports', 'crm.leads', 'clients.manage', 'ved.docs']],
        via: ['/hisoblash', '/hisoblash/tarix'],
      },
    ],
    settings: [
      { href: '/hisoblash/lugatlar', key: 'calcDictionaries', need: [['ved.docs']], via: ['/hisoblash'] },
      // The list price the VED's discount is measured against: the dictionary
      // door and NEVER `ved.docs` (tarif/page.tsx).
      {
        href: '/admin/tarif',
        key: 'tariff',
        need: [['admin.dictionaries.manage']],
        via: ['/hisoblash', '/hisoblash/tarix'],
      },
      {
        href: '/admin/bojxona-import',
        key: 'customsImport',
        need: [['admin.dictionaries.manage']],
        via: ['/hisoblash', '/hisoblash/tarix'],
      },
    ],
  },
  {
    key: 'pul',
    icon: 'wallet',
    strip: true,
    tabs: [
      { href: '/accounting', key: 'moneyOverview' },
      // The accountant's most frequent job, second and not ninth — on a phone
      // the ninth tab of a strip is off the screen.
      { href: '/accounting/expenses', key: 'expenses' },
      { href: '/finance', key: 'clientMoney' },
      { href: '/kontragentlar', key: 'partners' },
      {
        href: '/accounting/accounts',
        key: 'tills',
        need: [['finance.expenses']],
        via: ['/accounting', '/accounting/expenses'],
      },
      // `mayPickTill` = finance.expenses.
      {
        href: '/accounting/xarajat-kassa',
        key: 'costKassa',
        need: [['finance.expenses']],
        via: ['/accounting', '/accounting/expenses'],
      },
      // The day's rates are typed daily, so a TAB and not a setting.
      { href: '/admin/fx', key: 'fx', need: [['costs.fx.manage']], via: ['/accounting', '/finance'] },
      // `mayReadUnpricedList`.
      { href: '/finance/narxsiz', key: 'unpriced', need: [['finance.view', 'finance.manage']], via: ['/finance'] },
      {
        href: '/finance/reestr',
        key: 'payments',
        need: [['finance.view', 'finance.manage']],
        sight: 'kassa',
        via: ['/finance'],
      },
      // `seesCompanyMoney` (0114): the whole receivable — the owner and the
      // accountant, never a seller, the VED or the logist.
      {
        href: '/finance/qarzga-berilgan',
        key: 'debtReleases',
        need: [['finance.manage', 'clients.manage'], ['finance.reports']],
        via: ['/finance'],
      },
      { href: '/upsale', key: 'upsale' },
    ],
    settings: [
      {
        href: '/accounting/categories',
        key: 'expenseCategories',
        need: [['finance.expenses']],
        via: ['/accounting', '/accounting/expenses'],
      },
      {
        href: '/admin/cost-types',
        key: 'costTypes',
        need: [['admin.dictionaries.manage']],
        via: ['/accounting', '/finance'],
      },
      {
        href: '/admin/partner-types',
        key: 'partnerTypes',
        need: [['admin.dictionaries.manage']],
        via: ['/kontragentlar'],
      },
    ],
  },
  {
    key: 'reports',
    icon: 'chart',
    strip: true,
    entry: ['/dashboard', '/reports'],
    tabs: [
      { href: '/dashboard', key: 'dashboard', group: 'biz' },

      { href: '/accounting/pnl', key: 'pnl', group: 'money', need: [['finance.reports']], via: ['/accounting'] },
      {
        href: '/accounting/cashflow',
        key: 'cashflow',
        group: 'money',
        need: [['finance.reports']],
        via: ['/accounting'],
      },
      {
        href: '/accounting/balance',
        key: 'balance',
        group: 'money',
        need: [['finance.reports']],
        via: ['/accounting'],
      },
      {
        href: '/accounting/receivables',
        key: 'receivables',
        group: 'money',
        need: [['finance.reports']],
        via: ['/accounting'],
      },
      {
        href: '/accounting/profit',
        key: 'batchProfit',
        group: 'money',
        need: [['finance.reports']],
        via: ['/accounting'],
      },
      // `mayClassifyFx` — a close writes the P&L, so BOTH grants.
      {
        href: '/accounting/kurs-farqi',
        key: 'fxResidue',
        group: 'money',
        need: [['finance.manage'], ['finance.reports']],
        via: ['/accounting'],
      },
      // The owner's monthly plan: `isAnalyst` (a ROLE) and finance.reports.
      {
        href: '/accounting/reja',
        key: 'plan',
        group: 'money',
        roles: ['super_admin', 'admin'],
        need: [['finance.reports']],
        via: ['/accounting'],
      },
      {
        href: '/reports/landed-cost',
        key: 'landedCost',
        group: 'money',
        need: [['reports.all_warehouses']],
        sight: 'results',
        via: ['/reports'],
      },

      {
        href: '/crm/tahlil',
        key: 'salesAnalytics',
        group: 'sales',
        need: [['crm.leads'], ['crm.manage']],
        via: ['/crm'],
      },
      { href: '/reports/sotuvchilar', key: 'sellers', group: 'sales' },
      { href: '/pipeline', key: 'pipeline', group: 'sales' },
      {
        href: '/reports/client-history',
        key: 'clientHistory',
        group: 'sales',
        need: [['reports.all_warehouses']],
        via: ['/reports'],
      },

      { href: '/reports', key: 'cargoReports', group: 'cargo' },
      { href: '/reports/stock-aging', key: 'stockAging', group: 'cargo', need: [ANY_REPORT], via: ['/reports'] },
      { href: '/reports/batches', key: 'batchRegister', group: 'cargo', need: [ANY_REPORT], via: ['/reports'] },
      {
        href: '/reports/receipts-journal',
        key: 'receiptsJournal',
        group: 'cargo',
        need: [ANY_REPORT],
        via: ['/reports'],
      },
      {
        href: '/reports/unclaimed',
        key: 'unclaimedReport',
        group: 'cargo',
        need: [ANY_REPORT],
        via: ['/reports'],
      },
      {
        href: '/reports/yuk-xavfi',
        key: 'cargoRisk',
        group: 'cargo',
        need: [ANY_REPORT, BATCH_READERS],
        via: ['/reports'],
      },
      // `mayReadBatches` — the viewer role reads /reports and NOT the trucks,
      // so the old hub's transit tile bounced them; this tab does not. Hung
      // off /trucks and /reports, not /batches: a packer loads trucks and was
      // never offered the report (the warehouse menu stays warehouse-shaped).
      { href: '/transit', key: 'transit', group: 'cargo', need: [BATCH_READERS], via: ['/trucks', '/reports'] },

      {
        href: '/reports/vazifalar',
        key: 'taskReport',
        group: 'staff',
        need: [['reports.all_warehouses']],
        via: ['/reports'],
      },
      {
        href: '/reports/staff-activity',
        key: 'staffActivity',
        group: 'staff',
        need: [['reports.all_warehouses']],
        via: ['/reports'],
      },
      {
        href: '/reports/label-prints',
        key: 'labelPrints',
        group: 'staff',
        need: [['reports.all_warehouses']],
        via: ['/reports'],
      },

      // `calcControlScopeFor !== 'none'`.
      {
        href: '/hisoblash/nazorat',
        key: 'calcControl',
        group: 'ved',
        need: [['finance.reports', 'ved.docs']],
        via: ['/hisoblash', '/hisoblash/tarix'],
      },
    ],
  },
  // The administration hub: the system pages that belong to no job. Its own
  // tiles are its navigation, so no strip.
  { key: 'admin', icon: 'settings', strip: false, tabs: [{ href: '/admin', key: 'admin' }] },
];

const NAV_BY_HREF = new Map<string, NavItemSpec>(
  NAV.flatMap((group) => group.items).map((item) => [item.href, item]),
);

/** Is this NAV href in the viewer's menu? */
function inMenu(href: string, viewer: Viewer): boolean {
  const item = NAV_BY_HREF.get(href);
  return item !== undefined && menuItems(item, viewer);
}

/**
 * May this viewer be OFFERED this tab?
 *
 * `hidden` carries the hrefs the server has switched off for everybody right
 * now (the AI door while no key is configured) — the layout knows that, this
 * pure module does not.
 */
export function tabVisible(tab: WsTab, viewer: Viewer, hidden: ReadonlySet<string> = new Set()): boolean {
  if (hidden.has(tab.href)) return false;
  if (NAV_BY_HREF.has(tab.href)) return inMenu(tab.href, viewer);
  if (tab.roles && !tab.roles.some((role) => viewer.roles.includes(role))) return false;
  if (tab.need && !tab.need.every((any) => any.some((code) => viewer.permissions.has(code)))) return false;
  if (tab.sight && moneyHidden(tab.sight, viewer.permissions)) return false;
  return (tab.via ?? []).some((href) => inMenu(href, viewer));
}

export interface VisibleWorkspace {
  key: WorkspaceKey;
  icon: IconName;
  strip: boolean;
  /** Where the workspace's own menu row goes: its preferred entry, else its FIRST visible tab. */
  href: string;
  tabs: WsTab[];
  settings: WsTab[];
  /** Non-tab pages that still belong here (the strip shows, nothing is lit). */
  pages: string[];
}

/**
 * The workspaces this viewer gets, each with only the tabs they may open.
 * A workspace with no visible tab is absent.
 */
export function visibleWorkspaces(
  viewer: Viewer,
  hidden: ReadonlySet<string> = new Set(),
): VisibleWorkspace[] {
  const out: VisibleWorkspace[] = [];
  for (const ws of WORKSPACES) {
    const tabs = ws.tabs.filter((tab) => tabVisible(tab, viewer, hidden));
    if (tabs.length === 0) continue;
    const preferred = (ws.entry ?? []).find((href) => tabs.some((tab) => tab.href === href));
    out.push({
      key: ws.key,
      icon: ws.icon,
      strip: ws.strip,
      href: preferred ?? tabs[0]!.href,
      tabs,
      settings: (ws.settings ?? []).filter((tab) => tabVisible(tab, viewer, hidden)),
      pages: ws.pages ?? [],
    });
  }
  return out;
}

/** Does `pathname` sit at or under `prefix`, on a segment boundary? */
export function underPrefix(pathname: string, prefix: string): boolean {
  if (prefix === '/') return pathname === '/';
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Anything a page can be placed under: a tab, a settings page, or the shell's copy of one. */
export interface Placeable {
  href: string;
  claims?: readonly string[];
}

function matchLength(tab: Placeable, pathname: string): number {
  let best = -1;
  for (const prefix of [tab.href, ...(tab.claims ?? [])]) {
    if (underPrefix(pathname, prefix) && prefix.length > best) best = prefix.length;
  }
  return best;
}

export interface Placement<K extends string = WorkspaceKey> {
  workspace: K;
  /** The tab (or settings page, or non-tab page) the page belongs to. */
  href: string;
  settings: boolean;
  /** False on a workspace's non-tab page: nothing is lit, starred or counted. */
  tab: boolean;
}

/**
 * Which workspace and tab a page belongs to: the LONGEST matching prefix
 * across every workspace, tabs and settings alike, so /accounting/pnl lands in
 * Hisobotlar while /accounting lands in Pul, and /admin/clients/<id> in Savdo
 * while /admin/warehouses stays in Boshqaruv.
 *
 * It answers over what it is GIVEN — the full spec for the chrome rules, the
 * viewer's visible set for the strip — so a page nobody offered this viewer
 * lights nothing.
 */
export function placementOf<K extends string>(
  pathname: string,
  workspaces: readonly {
    key: K;
    tabs: readonly Placeable[];
    settings?: readonly Placeable[];
    pages?: readonly string[];
  }[],
): Placement<K> | null {
  let best: (Placement<K> & { length: number }) | null = null;
  for (const ws of workspaces) {
    const pages = (ws.pages ?? []).map((href) => ({ href }));
    for (const [list, settings, tab] of [
      [ws.tabs, false, true],
      [ws.settings ?? [], true, true],
      [pages, false, false],
    ] as const) {
      for (const one of list) {
        const length = matchLength(one, pathname);
        if (length < 0) continue;
        if (!best || length > best.length) {
          best = { workspace: ws.key, href: one.href, settings, tab, length };
        }
      }
    }
  }
  return best ? { workspace: best.workspace, href: best.href, settings: best.settings, tab: best.tab } : null;
}

/**
 * The `/admin/*` pages that belong to a JOB and not to the administration
 * section — derived, so moving a settings page into a workspace is one edit
 * here and the «← Boshqaruv» link and the lit menu row follow it.
 */
export const BORROWED_ADMIN_PAGES: string[] = WORKSPACES.filter((ws) => ws.key !== 'admin')
  .flatMap((ws) => [...ws.tabs, ...(ws.settings ?? [])])
  .map((tab) => tab.href)
  .filter((href) => href.startsWith('/admin/'));

export interface HomeTile {
  href: string;
  workspace: WorkspaceKey;
  item: NavItemSpec;
}

/**
 * The home screen's tiles: the NAV entries this viewer's menu carries, grouped
 * by workspace and in the workspace's tab order. The home itself and anything
 * the role's workflow rows already draw (`drawn`) are left out.
 */
export function homeTileGroups(
  viewer: Viewer,
  drawn: readonly string[] = [],
  hidden: ReadonlySet<string> = new Set(),
): { workspace: WorkspaceKey; tiles: HomeTile[] }[] {
  const groups: { workspace: WorkspaceKey; tiles: HomeTile[] }[] = [];
  for (const ws of WORKSPACES) {
    const tiles: HomeTile[] = [];
    for (const tab of ws.tabs) {
      const item = NAV_BY_HREF.get(tab.href);
      if (!item || item.href === '/' || drawn.includes(item.href)) continue;
      if (!tabVisible(tab, viewer, hidden)) continue;
      tiles.push({ href: item.href, workspace: ws.key, item });
    }
    if (tiles.length > 0) groups.push({ workspace: ws.key, tiles });
  }
  return groups;
}
