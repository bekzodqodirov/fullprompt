import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV, menuItems, primaryItems, type Viewer } from '@/modules/platform/rbac/nav';
import {
  BORROWED_ADMIN_PAGES,
  REPORT_GROUPS,
  WORKSPACES,
  homeTileGroups,
  placementOf,
  tabVisible,
  visibleWorkspaces,
  type WsTab,
} from '@/modules/platform/rbac/workspaces';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { moneyHidden } from '@/modules/platform/rbac/money-sight';
import { HUB_DOORS, openDoors } from '@/app/(protected)/admin/hub-doors';
import { mayReadBatches } from '@/modules/wms/batches/read-door';
import { mayReadPickups } from '@/modules/wms/pickups/service';
import { upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';
import { calcControlScopeFor, mayReadCalcRegistry } from '@/modules/wms/calc/control-scope';
import { mayClassifyFx } from '@/modules/wms/finance/fx-door';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { mayReadUnpricedList } from '@/modules/wms/finance/unpriced-door';
import { seesAllMoney, seesCompanyMoney } from '@/modules/wms/finance/scope';
import { canReadTg } from '@/modules/wms/crm/conversations';
import { canWriteDeal } from '@/modules/wms/deals/service';
import { sellerReportScopeFor } from '@/modules/wms/crm/seller-report-scope';
import { mayBroadcast } from '@/modules/platform/broadcast/service';
import { isAnalyst } from '@/modules/platform/ai/tools';
import { mayOpenMyClients } from '@/modules/platform/clients/card-door';

/**
 * The menu by job (2026-09-26, docs/NAV-WORKSPACES.md).
 *
 * The rule that matters most is the one no rendered page can check by
 * itself: a tab is a promise that the page will OPEN. So every tab is walked,
 * for every shipped role and a few the owner could invent, through the page's
 * OWN gate — the real exported predicate wherever one exists, and where a page
 * gates inline, the page's condition restated beside the file it lives in.
 * `GATES` must name every href a workspace offers, so a new tab cannot arrive
 * without somebody writing down what its page asks.
 */

const ALL_NAV = NAV.flatMap((group) => group.items);
const NAV_HREFS = new Set(ALL_NAV.map((item) => item.href));
const MATRIX: Record<string, readonly string[]> = ROLE_MATRIX;
const ALL_TABS: WsTab[] = WORKSPACES.flatMap((ws) => [...ws.tabs, ...(ws.settings ?? [])]);

interface Actor extends Viewer {
  id: string;
  permissions: Set<string>;
  roles: string[];
  warehouseScoped: boolean;
  warehouseIds: string[];
}

function actorFor(roles: string[], extra: string[] = []): Actor {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    roles,
    permissions: new Set([...roles.flatMap((role) => MATRIX[role] ?? []), ...extra]),
    warehouseScoped: false,
    warehouseIds: [],
  };
}

const has = (a: Actor, ...codes: string[]) => codes.some((code) => a.permissions.has(code));

/** admin/layout.tsx's cosmetic gate — every /admin/* page sits under it. */
const adminLayout = (a: Actor) =>
  has(
    a,
    'admin.warehouses.manage',
    'admin.audit.browse',
    'costs.fx.manage',
    'platform.roles.manage',
    'admin.dictionaries.manage',
    'clients.manage',
    'clients.view_own',
    'crm.leads',
    'plans.manage',
    'admin.settings.manage',
  );
/** accounting/layout.tsx */
const accounting = (a: Actor) => has(a, 'finance.reports', 'finance.expenses');
/** crm/layout.tsx */
const crm = (a: Actor) => has(a, 'crm.leads');
const anyReport = (a: Actor) => has(a, 'reports.all_warehouses', 'reports.own_warehouse');

/** What each page asks before it renders, per href. */
const GATES: Record<string, (a: Actor) => boolean> = {
  '/': () => true,
  '/bugun': () => true,
  '/kalendar': () => true,
  '/zametkalar': () => true,
  '/ai': () => true,
  '/approvals': (a) => has(a, 'finance.debt_override'),

  '/stock': () => true,
  '/receive': (a) => has(a, 'receipts.create'),
  '/receipts': () => true,
  '/unclaimed': () => true,
  '/issue': (a) => has(a, 'scan.issue'),
  '/crates': (a) => has(a, 'crates.manage'),
  '/inventory': (a) => has(a, 'scan.load'),

  '/batches': (a) => mayReadBatches(a.permissions),
  '/plans': (a) => has(a, 'plans.manage'),
  '/trucks': (a) => mayReadBatches(a.permissions),
  '/map': (a) => mayReadBatches(a.permissions),
  '/zavod': (a) => mayReadPickups(a.permissions),
  '/arrivals': (a) => has(a, 'receipts.create', 'crm.leads', 'scan.unload'),
  '/zavod/zavodlar': (a) => mayReadPickups(a.permissions),
  '/admin/trucks': (a) => adminLayout(a) && has(a, 'plans.manage'),

  '/bitimlar': (a) => canWriteDeal(a.permissions),
  '/crm': crm,
  '/admin/clients': (a) => adminLayout(a) && has(a, 'clients.manage'),
  '/suhbatlar': (a) => canReadTg(a),
  '/my-clients': (a) => has(a, 'crm.leads', 'clients.manage'),
  '/my-clients/olib-ketilmagan': (a) => mayOpenMyClients(a),
  '/crm/dormant': crm,
  '/crm/kelganlar': (a) => crm(a) && has(a, 'crm.manage'),
  '/crm/people': (a) => crm(a) && has(a, 'crm.manage'),
  '/admin/xabarlar': (a) => adminLayout(a) && mayBroadcast(a),
  '/crm/settings': (a) => crm(a) && has(a, 'crm.manage'),
  '/bitimlar/etaplar': (a) => has(a, 'crm.manage'),
  '/suhbatlar/shablonlar': (a) => canReadTg(a),
  '/suhbatlar/ulash': (a) => has(a, 'crm.leads', 'clients.manage'),
  '/admin/taqsimot': (a) => adminLayout(a) && has(a, 'admin.settings.manage'),

  '/hisoblash': (a) => has(a, 'ved.docs'),
  '/hisoblash/tarix': (a) => mayReadCalcRegistry(a),
  '/hisoblash/narxlar': (a) => upsaleScopeFor(a) !== 'none' || has(a, 'ved.docs'),
  '/hisoblash/lugatlar': (a) => has(a, 'ved.docs'),
  '/admin/tarif': (a) => adminLayout(a) && has(a, 'admin.dictionaries.manage'),
  '/admin/bojxona-import': (a) => adminLayout(a) && has(a, 'admin.dictionaries.manage'),

  '/accounting': accounting,
  '/finance': (a) => has(a, 'finance.view', 'finance.manage'),
  '/kontragentlar': (a) => seesAllMoney(a),
  '/accounting/expenses': (a) => accounting(a) && has(a, 'finance.expenses'),
  '/accounting/accounts': (a) => accounting(a) && has(a, 'finance.expenses'),
  '/accounting/xarajat-kassa': (a) => accounting(a) && mayPickTill(a.permissions),
  '/finance/narxsiz': (a) => mayReadUnpricedList(a.permissions),
  '/finance/reestr': (a) => has(a, 'finance.view', 'finance.manage') && !moneyHidden('kassa', a.permissions),
  // finance/qarzga-berilgan/page.tsx: `companyMoneySight` (0114).
  '/finance/qarzga-berilgan': (a) => seesCompanyMoney(a),
  '/upsale': (a) => upsaleScopeFor(a) !== 'none',
  '/admin/fx': (a) => adminLayout(a) && has(a, 'costs.fx.manage'),
  '/accounting/categories': (a) => accounting(a) && has(a, 'finance.expenses'),
  '/admin/cost-types': (a) => adminLayout(a) && has(a, 'admin.dictionaries.manage'),
  '/admin/partner-types': (a) => adminLayout(a) && has(a, 'admin.dictionaries.manage'),

  '/dashboard': anyReport,
  '/accounting/pnl': (a) => accounting(a) && has(a, 'finance.reports'),
  '/accounting/cashflow': (a) => accounting(a) && has(a, 'finance.reports'),
  '/accounting/balance': (a) => accounting(a) && has(a, 'finance.reports'),
  '/accounting/receivables': (a) => accounting(a) && has(a, 'finance.reports'),
  '/accounting/profit': (a) => accounting(a) && has(a, 'finance.reports'),
  '/accounting/kurs-farqi': (a) => accounting(a) && mayClassifyFx(a.permissions),
  '/accounting/reja': (a) => accounting(a) && isAnalyst(a) && has(a, 'finance.reports'),
  '/reports/landed-cost': (a) =>
    has(a, 'reports.all_warehouses') && !moneyHidden('results', a.permissions),
  '/crm/tahlil': (a) => crm(a) && has(a, 'crm.manage'),
  '/reports/sotuvchilar': (a) => sellerReportScopeFor(a as never) !== 'none',
  '/pipeline': (a) => has(a, 'reports.own_clients'),
  '/reports/client-history': (a) => has(a, 'reports.all_warehouses'),
  '/reports': anyReport,
  '/reports/stock-aging': anyReport,
  '/reports/batches': anyReport,
  '/reports/receipts-journal': anyReport,
  '/reports/unclaimed': anyReport,
  '/reports/yuk-xavfi': (a) => anyReport(a) && mayReadBatches(a.permissions),
  '/transit': (a) => mayReadBatches(a.permissions),
  '/reports/vazifalar': (a) => has(a, 'reports.all_warehouses'),
  '/reports/staff-activity': (a) => has(a, 'reports.all_warehouses'),
  '/reports/label-prints': (a) => has(a, 'reports.all_warehouses'),
  '/hisoblash/nazorat': (a) => calcControlScopeFor(a) !== 'none',

  // The hub sends a visitor with no door home. The page's own call, roles
  // included (a door may be role-gated — B9's /admin/xatolar), so the mirror
  // cannot drift from the page it mirrors.
  '/admin': (a) =>
    adminLayout(a) && openDoors((code) => a.permissions.has(code), a.roles).length > 0,
};

/** The shipped roles, and the combinations the owner is known to hold or invent. */
const PEOPLE: [string, Actor][] = [
  ...Object.keys(ROLE_MATRIX).map((role): [string, Actor] => [role, actorFor([role])]),
  ['admin + sales (his own «bir admin va sotuvchi»)', actorFor(['admin', 'sales_manager'])],
  ['ved + sales, both hats', actorFor(['ved_manager', 'sales_manager'])],
  ['accountant + warehouse manager', actorFor(['accountant', 'warehouse_manager'])],
  ['invented dispatcher: plans.manage only', actorFor(['dispachi'], ['plans.manage'])],
  ['invented kassir: finance.expenses only', actorFor(['kassir'], ['finance.expenses'])],
  ['invented VED with the kassa grant', actorFor(['bojxonachi'], ['ved.docs', 'finance.expenses', 'finance.view'])],
  ['invented seller helper: crm.leads only', actorFor(['sotuvchi_yordamchi'], ['crm.leads'])],
];

const bundles = Object.fromEntries(
  ['uz', 'ru', 'en', 'zh-CN'].map((locale) => [
    locale,
    JSON.parse(readFileSync(join(__dirname, '..', '..', 'messages', `${locale}.json`), 'utf8')) as Record<
      string,
      unknown
    >,
  ]),
);
function lookup(bundle: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], bundle);
}

describe('the eight workspaces cover the menu exactly once', () => {
  it('puts every NAV entry in exactly one workspace, and no href in two', () => {
    const seen = new Map<string, string>();
    for (const ws of WORKSPACES) {
      for (const tab of [...ws.tabs, ...(ws.settings ?? [])]) {
        expect(seen.get(tab.href), `${tab.href} is in ${seen.get(tab.href)} and ${ws.key}`).toBeUndefined();
        seen.set(tab.href, ws.key);
      }
    }
    for (const href of NAV_HREFS) expect(seen.has(href), `${href} is in no workspace`).toBe(true);
  });

  it('lets a NAV tab follow the menu alone, and hangs every other tab off a NAV entry', () => {
    for (const tab of ALL_TABS) {
      if (NAV_HREFS.has(tab.href)) {
        // A second rule on a NAV entry would be a second, drifting gate.
        expect(tab.need ?? tab.roles ?? tab.via ?? tab.sight, tab.href).toBeUndefined();
      } else {
        expect(tab.via?.length ?? 0, `${tab.href} hangs off nothing`).toBeGreaterThan(0);
        for (const parent of tab.via!) expect(NAV_HREFS.has(parent), `${tab.href} via ${parent}`).toBe(true);
      }
    }
  });

  it('writes down a gate for every page it offers', () => {
    for (const tab of ALL_TABS) expect(GATES[tab.href], `no gate recorded for ${tab.href}`).toBeDefined();
  });

  it('names every workspace, group and tab in all four languages', () => {
    for (const [locale, bundle] of Object.entries(bundles)) {
      for (const ws of WORKSPACES) {
        expect(typeof lookup(bundle, `ws.name.${ws.key}`), `${locale} ws.name.${ws.key}`).toBe('string');
      }
      for (const group of REPORT_GROUPS) {
        expect(typeof lookup(bundle, `ws.group.${group}`), `${locale} ws.group.${group}`).toBe('string');
      }
      for (const tab of ALL_TABS) {
        expect(typeof lookup(bundle, `ws.tab.${tab.key}`), `${locale} ws.tab.${tab.key}`).toBe('string');
      }
      for (const item of ALL_NAV) {
        if (item.shortKey) {
          expect(typeof lookup(bundle, `navShort.${item.shortKey}`), `${locale} navShort.${item.shortKey}`).toBe(
            'string',
          );
        }
      }
    }
  });
});

describe('a tab is a promise that the page opens', () => {
  it('offers nobody a page its own gate refuses', () => {
    // The red-proof target: drop `need: [['finance.reports']]` off the P&L tab
    // and the invented kassir (finance.expenses alone) is offered a page that
    // sends them straight back to /accounting.
    for (const [who, actor] of PEOPLE) {
      for (const ws of visibleWorkspaces(actor)) {
        for (const tab of [...ws.tabs, ...ws.settings]) {
          expect(GATES[tab.href]!(actor), `${who} is offered ${tab.href}, which bounces them`).toBe(true);
        }
      }
    }
  });

  it('never widens the menu: every tab is either in the menu or hangs off something that is', () => {
    for (const [who, actor] of PEOPLE) {
      for (const tab of ALL_TABS) {
        if (!tabVisible(tab, actor)) continue;
        const item = ALL_NAV.find((one) => one.href === tab.href);
        if (item) expect(menuItems(item, actor), `${who}: ${tab.href}`).toBe(true);
        else {
          const hung = tab.via!.some((href) => menuItems(ALL_NAV.find((one) => one.href === href)!, actor));
          expect(hung, `${who}: ${tab.href}`).toBe(true);
        }
      }
    }
  });

  it('keeps the warehouse on warehouse work', () => {
    // The owner took the planner and the calendar off warehouse menus
    // («skladchiga mening kunim kalendarlar korinishi shart emas»); a
    // workspace must not bring them back.
    const keys = visibleWorkspaces(actorFor(['warehouse_operator'])).map((ws) => ws.key);
    expect(keys).toEqual(['home', 'sklad', 'yol']);
  });

  it('keeps the money the VED must not see out of every workspace (Q19)', () => {
    const ved = actorFor(['ved_manager']);
    const offered = visibleWorkspaces(ved).flatMap((ws) => [...ws.tabs, ...ws.settings].map((tab) => tab.href));
    for (const href of ['/reports/landed-cost', '/finance/reestr', '/accounting/pnl', '/upsale', '/admin/tarif']) {
      expect(offered, href).not.toContain(href);
    }
    // …and the kassa grant gives back the kassa, and nothing else.
    const kassir = actorFor(['bojxonachi'], ['ved.docs', 'finance.expenses', 'finance.view']);
    const theirs = visibleWorkspaces(kassir).flatMap((ws) => ws.tabs.map((tab) => tab.href));
    expect(theirs).toContain('/finance/reestr');
    expect(theirs).not.toContain('/accounting/pnl');
  });

  it('gives the accountant her FX rates back as a Pul tab, and the logist his truck presets as Yo’l’s ⚙', () => {
    // Their only hub doors left the hub; the workspaces must carry them.
    const accountant = visibleWorkspaces(actorFor(['accountant']));
    expect(accountant.find((ws) => ws.key === 'pul')!.tabs.map((tab) => tab.href)).toContain('/admin/fx');
    const logist = visibleWorkspaces(actorFor(['logist']));
    expect(logist.find((ws) => ws.key === 'yol')!.settings.map((tab) => tab.href)).toContain('/admin/trucks');
  });

  it('opens the broadcast to the super admin ROLE only — not to an admin who holds every grant', () => {
    const tabs = (roles: string[]) =>
      visibleWorkspaces(actorFor(roles)).flatMap((ws) => ws.tabs.map((tab) => tab.href));
    expect(tabs(['super_admin'])).toContain('/admin/xabarlar');
    expect(tabs(['admin'])).not.toContain('/admin/xabarlar');
  });
});

describe('where a workspace’s own row goes', () => {
  it('opens Hisobotlar on the cargo hub for the VED, not on an empty client search', () => {
    const ved = visibleWorkspaces(actorFor(['ved_manager'])).find((ws) => ws.key === 'reports')!;
    expect(ved.href).toBe('/reports');
    const owner = visibleWorkspaces(actorFor(['super_admin'])).find((ws) => ws.key === 'reports')!;
    expect(owner.href).toBe('/dashboard');
  });

  it('opens Hisoblash on the queue for the VED and on the registry for the accountant', () => {
    const entry = (role: string) =>
      visibleWorkspaces(actorFor([role])).find((ws) => ws.key === 'calc')?.href;
    expect(entry('ved_manager')).toBe('/hisoblash');
    expect(entry('accountant')).toBe('/hisoblash/tarix');
  });
});

describe('the administration hub after the job settings left it', () => {
  it('stops offering /admin to the two people whose only doors moved', () => {
    const entry = ALL_NAV.find((item) => item.href === '/admin')!;
    expect(menuItems(entry, actorFor(['logist']))).toBe(false);
    expect(menuItems(entry, actorFor(['accountant']))).toBe(false);
    expect(menuItems(entry, actorFor(['admin']))).toBe(true);
  });

  it('offers the /admin entry to exactly the grants that open a door on it', () => {
    const entry = ALL_NAV.find((item) => item.href === '/admin')!;
    const union = new Set(HUB_DOORS.flatMap((door) => door.allow));
    expect(new Set(entry.permissions)).toEqual(union);
  });

  it('keeps no hub door on a page a workspace calls its own', () => {
    for (const door of HUB_DOORS) expect(BORROWED_ADMIN_PAGES, door.href).not.toContain(door.href);
  });
});

describe('where a page belongs', () => {
  const place = (path: string) => placementOf(path, WORKSPACES);

  it('answers by the longest prefix across every workspace', () => {
    expect(place('/')).toEqual({ workspace: 'home', href: '/', settings: false, tab: true });
    expect(place('/accounting')?.workspace).toBe('pul');
    expect(place('/accounting/pnl')?.workspace).toBe('reports');
    expect(place('/accounting/expenses/abc')).toEqual({
      workspace: 'pul',
      href: '/accounting/expenses',
      settings: false,
      tab: true,
    });
    expect(place('/admin/clients/2f1a')?.workspace).toBe('savdo');
    expect(place('/admin/warehouses')?.workspace).toBe('admin');
    expect(place('/admin/fx')).toEqual({ workspace: 'pul', href: '/admin/fx', settings: false, tab: true });
    expect(place('/admin/cost-types')).toEqual({
      workspace: 'pul',
      href: '/admin/cost-types',
      settings: true,
      tab: true,
    });
    expect(place('/boxes/77')).toEqual({ workspace: 'sklad', href: '/stock', settings: false, tab: true });
    // Off every menu by his word (round 75): the strip shows, nothing is lit,
    // and a visit to it is not a visit to the funnel.
    expect(place('/crm/today')).toEqual({ workspace: 'savdo', href: '/crm/today', settings: false, tab: false });
    expect(place('/crm/leads/abc')?.href).toBe('/crm');
    expect(place('/hisoblash/nazorat')?.workspace).toBe('reports');
    expect(place('/hisoblash/abc')?.href).toBe('/hisoblash');
  });

  it('places nothing it was not given, and never a mere shared prefix', () => {
    expect(place('/profile')).toBeNull();
    expect(place('/stockroom')).toBeNull();
    // A viewer's own set: a page they are not offered lights nothing.
    const seller = visibleWorkspaces(actorFor(['sales_manager']));
    expect(placementOf('/accounting/pnl', seller)).toBeNull();
  });
});

describe('the phone bars the owner asked for (answer 6)', () => {
  const bar = (role: string) => primaryItems(actorFor([role])).map((item) => item.href);

  it('gives each job its own four', () => {
    expect(bar('warehouse_operator')).toEqual(['/', '/receive', '/stock', '/batches']);
    expect(bar('warehouse_manager')).toEqual(['/', '/receive', '/stock', '/batches']);
    expect(bar('logist')).toEqual(['/', '/stock', '/trucks', '/plans']);
    expect(bar('ved_manager')).toEqual(['/', '/hisoblash', '/batches', '/bitimlar']);
  });

  it('puts «Topshirish» fourth at a warehouse that hands cargo to clients', () => {
    const issuing = (role: string) =>
      primaryItems(actorFor([role]), 4, { issuesToClients: true }).map((item) => item.href);
    expect(issuing('warehouse_operator')).toEqual(['/', '/receive', '/stock', '/issue']);
    expect(issuing('warehouse_manager')).toEqual(['/', '/receive', '/stock', '/issue']);
    // Nobody else's bar hangs on the flag.
    expect(primaryItems(actorFor(['logist']), 4, { issuesToClients: true }).map((i) => i.href)).toEqual(
      bar('logist'),
    );
  });
});

describe('the home tiles follow the workspaces', () => {
  it('draws no tile for the home itself, nor for what the workflow rows already draw', () => {
    const owner = actorFor(['super_admin']);
    const hrefs = homeTileGroups(owner, ['/bitimlar']).flatMap((group) => group.tiles.map((tile) => tile.href));
    expect(hrefs).not.toContain('/');
    expect(hrefs).not.toContain('/bitimlar');
    expect(hrefs).toContain('/crm');
  });

  it('hides a switched-off door', () => {
    const owner = actorFor(['super_admin']);
    const hrefs = homeTileGroups(owner, [], new Set(['/ai'])).flatMap((group) => group.tiles.map((t) => t.href));
    expect(hrefs).not.toContain('/ai');
  });
});
