import type { IconName } from '@/components/ui/icon';

export interface NavItemSpec {
  href: string;
  /** Key inside the given translation namespace. */
  labelKey: string;
  namespace: string;
  icon: IconName;
  /** Any one of these permissions is enough; empty = everyone. */
  permissions?: string[];
  roles?: string[];
  /** Shown in the phone's bottom bar (first four the actor can see). */
  primary?: number;
  /**
   * A short name for the tab bar. "Управленческий учёт" under a 60 px icon
   * pushed the ••• button off the screen; the sidebar and the home tiles keep
   * the full name, where there is room for it.
   */
  shortKey?: string;
}

export interface NavGroupSpec {
  titleKey: string;
  items: NavItemSpec[];
}

/**
 * One navigation model for the whole app.
 *
 * The home tiles, the desktop sidebar and the phone's tab bar all read from
 * this list, so a screen can never appear in one place and be missing from
 * another — which is how the app ended up feeling like a pile of pages.
 *
 * `primary` is the tab-bar priority: each role gets the four lowest numbers
 * it is allowed to see, so a warehouse operator's thumb lands on receiving
 * while the owner's lands on the money.
 */
export const NAV: NavGroupSpec[] = [
  {
    titleKey: 'sectionOperations',
    items: [
      { href: '/', labelKey: 'homeTile', namespace: 'nav', icon: 'home', primary: 0, shortKey: 'home' },
      {
        // Everyone's morning screen: what is late, what is due today. No
        // permission — every employee has work assigned to them.
        href: '/bugun',
        // NOT 'today': that short label is the CRM call list's ("Звонки"), and
        // reusing it put the wrong word under this tab.
        shortKey: 'myDay',
        labelKey: 'today',
        namespace: 'tasks',
        icon: 'check',
      },
      {
        href: '/kalendar',
        labelKey: 'calendar',
        namespace: 'tasks',
        icon: 'calendar',
      },
      {
        href: '/receive',
        shortKey: 'receive',
        labelKey: 'receiving',
        namespace: 'home',
        icon: 'inbox',
        permissions: ['receipts.create'],
        primary: 1,
      },
      {
        href: '/batches',
        shortKey: 'batches',
        labelKey: 'loading',
        namespace: 'home',
        icon: 'truck',
        // `ved.docs` belongs here: the customs papers live on the batch card,
        // and gating the tile on scan.load alone left the VED manager with no
        // way in but a pasted URL.
        permissions: ['scan.load', 'scan.unload', 'ved.docs', 'plans.manage'],
        primary: 2,
      },
      {
        // What is on its way HERE — a client's promised cargo in China, our
        // own trucks in Uzbekistan. Sales writes the promises, the warehouse
        // reads them, so both permissions open it.
        href: '/arrivals',
        shortKey: 'arrivals',
        labelKey: 'title',
        namespace: 'arrivals',
        icon: 'inbox',
        permissions: ['receipts.create', 'scan.unload', 'crm.leads'],
      },
      {
        href: '/plans',
        shortKey: 'plans',
        labelKey: 'title',
        namespace: 'plans',
        icon: 'clipboard',
        permissions: ['plans.manage'],
        primary: 6,
      },
      {
        href: '/issue',
        shortKey: 'issue',
        labelKey: 'handover',
        namespace: 'home',
        icon: 'handshake',
        permissions: ['scan.issue'],
        primary: 5,
      },
      {
        href: '/crates',
        labelKey: 'title',
        namespace: 'crates',
        icon: 'crate',
        permissions: ['crates.manage'],
      },
      // Stocktake is hidden until the RFID readers arrive (owner): counting a
      // warehouse by hand-scanning every box is not a job anyone will do, so
      // offering it only teaches people to ignore a menu entry. The screens
      // and the service stay — /inventory still answers, and the entry comes
      // back the day the hardware does.
    ],
  },
  {
    titleKey: 'sectionInfo',
    items: [
      { href: '/stock', labelKey: 'title', namespace: 'stock', icon: 'boxes', primary: 3, shortKey: 'stock' },
      { href: '/receipts', labelKey: 'title', namespace: 'receipts', icon: 'doc' },
      { href: '/unclaimed', labelKey: 'unclaimedTitle', namespace: 'receipts', icon: 'alert' },
      { href: '/trucks', shortKey: 'trucks', labelKey: 'title', namespace: 'trucks', icon: 'truck' },
      { href: '/map', labelKey: 'title', namespace: 'map', icon: 'map' },
      {
        href: '/dashboard',
        labelKey: 'title',
        namespace: 'dashboard',
        icon: 'chart',
        permissions: ['reports.all_warehouses', 'reports.own_warehouse'],
      },
      {
        href: '/reports',
        shortKey: 'reports',
        labelKey: 'title',
        namespace: 'reports',
        icon: 'report',
        permissions: ['reports.all_warehouses', 'reports.own_warehouse'],
      },
    ],
  },
  {
    titleKey: 'sectionSales',
    items: [
      {
        /**
         * The client book, moved out of Management (owner: "clientlarni
         * ro'yxatiga glavniy ekrandan kira olinsa yaxshi bo'lardi").
         *
         * It sat in the LAST group, below the truck presets and the field
         * editor — settings screens opened twice a year — so on the home
         * screen the list of every client the company has was the last tile
         * on the page. It belongs at the top of Sales, beside the funnel and
         * the deals that are about those same clients.
         */
        href: '/admin/clients',
        shortKey: 'clients',
        labelKey: 'title',
        namespace: 'clients',
        icon: 'users',
        permissions: ['clients.manage'],
      },
      {
        // The deal board, above the funnel on purpose: a lead is worked once,
        // a deal is an existing client's job and repeats, and "which of my
        // jobs is stuck" is the question the sales side opens the app to
        // answer (docs/DEALS.md, "The board").
        href: '/bitimlar',
        shortKey: 'deals',
        labelKey: 'title',
        namespace: 'deals',
        icon: 'handshake',
        // Both sides work a deal — sales quoted it, VED recalculated it.
        permissions: ['crm.leads', 'ved.docs', 'clients.manage'],
      },
      {
        href: '/crm',
        shortKey: 'crm',
        labelKey: 'title',
        namespace: 'crm',
        icon: 'target',
        permissions: ['crm.leads'],
        primary: 2,
      },
      {
        href: '/crm/today',
        shortKey: 'today',
        labelKey: 'today',
        namespace: 'crm',
        icon: 'phone',
        permissions: ['crm.leads'],
      },
      {
        href: '/my-clients',
        shortKey: 'myClients',
        labelKey: 'myClients',
        namespace: 'cargo',
        icon: 'users',
        permissions: ['crm.leads', 'clients.manage'],
      },
      {
        href: '/finance',
        shortKey: 'finance',
        labelKey: 'title',
        namespace: 'finance',
        icon: 'wallet',
        permissions: ['finance.view', 'finance.manage'],
        primary: 4,
      },
      {
        href: '/pipeline',
        labelKey: 'title',
        namespace: 'pipeline',
        icon: 'chart',
        roles: ['sales_manager'],
      },
    ],
  },
  {
    titleKey: 'sectionManagement',
    items: [
      {
        href: '/accounting',
        shortKey: 'accounting',
        labelKey: 'title',
        namespace: 'accounting',
        icon: 'briefcase',
        permissions: ['finance.reports', 'finance.expenses'],
        primary: 3,
      },
      {
        href: '/admin/fx',
        labelKey: 'fxTitle',
        namespace: 'costing',
        icon: 'exchange',
        permissions: ['costs.fx.manage'],
      },
      {
        // The truck PRESETS — a settings screen opened twice a year. Where
        // the trucks actually are lives at /trucks, in the info section.
        href: '/admin/trucks',
        labelKey: 'trucksTitle',
        namespace: 'plans',
        icon: 'settings',
        permissions: ['plans.manage'],
      },
      {
        href: '/admin/fields',
        labelKey: 'title',
        namespace: 'fields',
        icon: 'clipboard',
        permissions: ['admin.dictionaries.manage'],
      },
      {
        href: '/admin/roles',
        labelKey: 'title',
        namespace: 'roles',
        icon: 'shield',
        permissions: ['platform.roles.manage'],
      },
      {
        href: '/admin/warehouses',
        labelKey: 'adminPanel',
        namespace: 'home',
        icon: 'settings',
        permissions: ['admin.warehouses.manage'],
      },
    ],
  },
];

export interface Viewer {
  permissions: Set<string> | { has(code: string): boolean };
  roles: string[];
}

/**
 * The four tabs each kind of person actually wants under their thumb
 * (owner: "skladchilar prixod/yuklash/qabul, sotuvchilar CRM, buxgalterlar
 * pul bilan bog'liq joyni ishlatadi").
 *
 * A generic priority order cannot serve all three: the same list that puts
 * receiving first for a warehouse operator would put it first for the
 * accountant too, who never opens it. Anything a role may not see is skipped
 * and the next entry moves up, so a short list still fills the bar.
 */
const PRIMARY_BY_ROLE: Record<string, string[]> = {
  // The warehouse bars are unchanged: receiving IS the job there, and tasks
  // are occasional — /bugun stays one tap away on the home tiles.
  warehouse_operator: ['/', '/receive', '/arrivals', '/batches', '/issue'],
  warehouse_manager: ['/', '/receive', '/arrivals', '/batches', '/stock'],
  logist: ['/', '/bugun', '/plans', '/batches', '/trucks'],
  // /crm/today is gone from the bar, not from the app: /bugun shows those same
  // follow-ups alongside the tasks, so keeping both would be two doors to one
  // list.
  sales_manager: ['/', '/bugun', '/crm', '/my-clients', '/finance'],
  accountant: ['/', '/bugun', '/accounting', '/finance', '/reports'],
  ved_manager: ['/', '/bugun', '/batches', '/finance', '/stock'],
  // A read-only viewer had a TWO-icon bar: only `/` and `/stock` carry a
  // `primary` number among the ten screens they may open, and the generic
  // fallback can only pick from those. Naming their four makes half the phone
  // screen useful again.
  viewer: ['/', '/stock', '/receipts', '/dashboard', '/reports'],
  // The owner watches the money and the funnel; the operational screens are
  // one tap away behind •••.
  super_admin: ['/', '/bugun', '/accounting', '/crm', '/stock'],
  admin: ['/', '/bugun', '/accounting', '/crm', '/stock'],
};

/**
 * What each job actually needs in its MENU (owner: "skladchiga mening kunim
 * kalendarlar korinishi shart emas — ularga faqat sklad boyicha ishlar").
 *
 * This is a different question from what a person may DO. `canSee` answers
 * "are they allowed"; this answers "is it any use to them". Eight of the
 * entries above require no permission at all — `canSee` returns true when
 * `permissions` is absent — so the menu's default was "show everyone", and a
 * packer in Yiwu was offered the map, the truck board and the calendar.
 *
 * Three rules, and the third is the one that matters:
 *  - a role listed here sees only what it lists (intersected with what it is
 *    ALLOWED to open, so this can never widen access);
 *  - several roles union, because permissions union (DECISIONS #166) and
 *    somebody who is both accountant and warehouse manager does both jobs;
 *  - a role that is NOT listed here sees everything it may open. That is the
 *    safe default for the roles an admin invents on /admin/roles: a new role
 *    gets a full menu rather than an empty one, and the owner narrows it here
 *    only if it is worth narrowing.
 *
 * Hiding a screen from the menu does NOT close the route. A task assigned to
 * a warehouse operator still reaches them — it surfaces on the home screen and
 * `/bugun` still answers — because a menu decision must never be able to make
 * assigned work disappear.
 */
const MENU_BY_ROLE: Record<string, string[]> = {
  // Receive, load, unload, hand over. Nothing else is their job.
  warehouse_operator: [
    '/', '/receive', '/arrivals', '/batches', '/issue', '/crates', '/stock', '/receipts',
  ],
  // The same, plus the two screens a manager answers questions from.
  warehouse_manager: [
    '/', '/receive', '/arrivals', '/batches', '/issue', '/crates', '/stock', '/receipts',
    '/unclaimed', '/dashboard', '/reports',
  ],
  // Plans and trucks. A logist does not receive cargo, but does chase it —
  // and does hold `clients.manage`: he creates client cards and mints their
  // cabinet links, so the client book belongs in his menu. Leaving it out was
  // a curation mistake, caught by the e2e that opens the page as him.
  logist: [
    '/', '/bugun', '/kalendar', '/bitimlar', '/plans', '/batches', '/arrivals', '/trucks',
    '/map', '/stock', '/receipts', '/admin/clients', '/admin/trucks', '/dashboard', '/reports',
  ],
  // Customs papers hang off the batch; the rest is reference. The deal board
  // is here because recalculating a job the client was mis-quoted for is a VED
  // manager's work as much as a salesperson's (DEALS.md answer 2).
  ved_manager: [
    '/', '/bugun', '/kalendar', '/bitimlar', '/batches', '/stock', '/receipts', '/reports',
    '/finance',
  ],
  // Clients, their jobs, the funnel, and what they owe — never the company's
  // margin.
  sales_manager: [
    '/', '/bugun', '/kalendar', '/bitimlar', '/crm', '/crm/today', '/my-clients', '/finance',
    '/pipeline', '/arrivals',
  ],
  accountant: [
    '/', '/bugun', '/kalendar', '/accounting', '/finance', '/reports', '/dashboard',
    '/admin/fx', '/receipts', '/stock',
  ],
  viewer: ['/', '/stock', '/receipts', '/dashboard', '/reports'],
  // super_admin and admin are deliberately absent: the owner looks at
  // everything, and a curated list for him would be a list to maintain.
};

/** Is this screen worth showing to this viewer at all? */
export function isRelevant(href: string, roles: string[]): boolean {
  const curated = roles.filter((role) => MENU_BY_ROLE[role]);
  // An uncurated role — super_admin, or one the owner invented — carries the
  // whole menu, so nobody is ever left with an empty app.
  if (curated.length === 0 || curated.length < roles.length) return true;
  return curated.some((role) => MENU_BY_ROLE[role]!.includes(href));
}

export function canSee(item: NavItemSpec, viewer: Viewer): boolean {
  if (item.roles && !item.roles.some((role) => viewer.roles.includes(role))) return false;
  if (!item.permissions) return true;
  return item.permissions.some((code) => viewer.permissions.has(code));
}

/**
 * The menu this viewer gets: allowed AND useful.
 *
 * Both conditions, in that order — the relevance list can only ever remove,
 * never add, so it cannot become a way of granting anything.
 */
export function menuItems(item: NavItemSpec, viewer: Viewer): boolean {
  return canSee(item, viewer) && isRelevant(item.href, viewer.roles);
}

/** The tab-bar destinations this viewer gets, in the order they want them. */
export function primaryItems(viewer: Viewer, limit = 4): NavItemSpec[] {
  const all = NAV.flatMap((group) => group.items);
  const visible = (href: string) => {
    const item = all.find((candidate) => candidate.href === href);
    // menuItems, not canSee: a screen hidden from the menu must not come back
    // as a thumb tab.
    return item && menuItems(item, viewer) ? item : null;
  };

  // The most specific role the viewer holds wins; PRIMARY_BY_ROLE is ordered
  // from the narrowest job to the broadest.
  for (const role of Object.keys(PRIMARY_BY_ROLE)) {
    if (!viewer.roles.includes(role)) continue;
    const picked = PRIMARY_BY_ROLE[role]!.map(visible).filter(Boolean) as NavItemSpec[];
    if (picked.length > 0) return picked.slice(0, limit);
  }

  return all
    .filter((item) => item.primary !== undefined && menuItems(item, viewer))
    .sort((a, b) => a.primary! - b.primary!)
    .slice(0, limit);
}
