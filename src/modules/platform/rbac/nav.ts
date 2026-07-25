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
      { href: '/', labelKey: 'homeTile', namespace: 'nav', icon: 'home', primary: 0 },
      {
        href: '/receive',
        labelKey: 'receiving',
        namespace: 'home',
        icon: 'inbox',
        permissions: ['receipts.create'],
        primary: 1,
      },
      {
        href: '/batches',
        labelKey: 'loading',
        namespace: 'home',
        icon: 'truck',
        permissions: ['scan.load'],
        primary: 2,
      },
      {
        href: '/plans',
        labelKey: 'title',
        namespace: 'plans',
        icon: 'clipboard',
        permissions: ['plans.manage'],
        primary: 6,
      },
      {
        href: '/issue',
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
      {
        href: '/inventory',
        labelKey: 'title',
        namespace: 'inventory',
        icon: 'scan',
        permissions: ['scan.load'],
      },
    ],
  },
  {
    titleKey: 'sectionInfo',
    items: [
      { href: '/stock', labelKey: 'title', namespace: 'stock', icon: 'boxes', primary: 3 },
      { href: '/search', labelKey: 'title', namespace: 'search', icon: 'search', primary: 8 },
      { href: '/receipts', labelKey: 'title', namespace: 'receipts', icon: 'doc' },
      { href: '/unclaimed', labelKey: 'unclaimedTitle', namespace: 'receipts', icon: 'alert' },
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
        labelKey: 'title',
        namespace: 'crm',
        icon: 'phone',
        permissions: ['crm.leads'],
        primary: 2,
      },
      {
        href: '/crm/leads',
        labelKey: 'funnel',
        namespace: 'crm',
        icon: 'target',
        permissions: ['crm.leads'],
      },
      {
        href: '/finance',
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
        href: '/trucks',
        labelKey: 'trucksTitle',
        namespace: 'plans',
        icon: 'truck',
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

export function canSee(item: NavItemSpec, viewer: Viewer): boolean {
  if (item.roles && !item.roles.some((role) => viewer.roles.includes(role))) return false;
  if (!item.permissions) return true;
  return item.permissions.some((code) => viewer.permissions.has(code));
}

/** The four tab-bar destinations this viewer gets, in priority order. */
export function primaryItems(viewer: Viewer, limit = 4): NavItemSpec[] {
  return NAV.flatMap((group) => group.items)
    .filter((item) => item.primary !== undefined && canSee(item, viewer))
    .sort((a, b) => a.primary! - b.primary!)
    .slice(0, limit);
}
