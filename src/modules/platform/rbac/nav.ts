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
        permissions: ['scan.load'],
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
        href: '/admin/clients',
        labelKey: 'title',
        namespace: 'clients',
        icon: 'users',
        permissions: ['clients.manage'],
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
  warehouse_operator: ['/', '/receive', '/arrivals', '/batches', '/issue'],
  warehouse_manager: ['/', '/receive', '/arrivals', '/batches', '/stock'],
  logist: ['/', '/plans', '/batches', '/trucks', '/stock'],
  sales_manager: ['/', '/crm', '/crm/today', '/my-clients', '/finance'],
  accountant: ['/', '/accounting', '/finance', '/reports', '/stock'],
  ved_manager: ['/', '/batches', '/finance', '/stock', '/reports'],
  // The owner watches the money and the funnel; the operational screens are
  // one tap away behind •••.
  super_admin: ['/', '/accounting', '/crm', '/stock', '/batches'],
  admin: ['/', '/accounting', '/crm', '/stock', '/batches'],
};

export function canSee(item: NavItemSpec, viewer: Viewer): boolean {
  if (item.roles && !item.roles.some((role) => viewer.roles.includes(role))) return false;
  if (!item.permissions) return true;
  return item.permissions.some((code) => viewer.permissions.has(code));
}

/** The tab-bar destinations this viewer gets, in the order they want them. */
export function primaryItems(viewer: Viewer, limit = 4): NavItemSpec[] {
  const all = NAV.flatMap((group) => group.items);
  const visible = (href: string) => {
    const item = all.find((candidate) => candidate.href === href);
    return item && canSee(item, viewer) ? item : null;
  };

  // The most specific role the viewer holds wins; PRIMARY_BY_ROLE is ordered
  // from the narrowest job to the broadest.
  for (const role of Object.keys(PRIMARY_BY_ROLE)) {
    if (!viewer.roles.includes(role)) continue;
    const picked = PRIMARY_BY_ROLE[role]!.map(visible).filter(Boolean) as NavItemSpec[];
    if (picked.length > 0) return picked.slice(0, limit);
  }

  return all
    .filter((item) => item.primary !== undefined && canSee(item, viewer))
    .sort((a, b) => a.primary! - b.primary!)
    .slice(0, limit);
}
