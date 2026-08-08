import { describe, expect, it } from 'vitest';
import {
  MENU_BY_ROLE,
  NAV,
  canSee,
  isRelevant,
  menuItems,
  primaryItems,
} from '@/modules/platform/rbac/nav';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';

const ALL_ITEMS = NAV.flatMap((group) => group.items);
const MATRIX: Record<string, readonly string[]> = ROLE_MATRIX;

/** The viewer a role would actually be, straight from the shipped matrix. */
function viewerFor(...roles: string[]) {
  const permissions = new Set(roles.flatMap((role) => MATRIX[role] ?? []));
  return { roles, permissions };
}

function menuFor(...roles: string[]) {
  const viewer = viewerFor(...roles);
  return ALL_ITEMS.filter((item) => menuItems(item, viewer)).map((item) => item.href);
}

describe('menu relevance', () => {
  it('never widens: an item hidden by permission stays hidden', () => {
    // The whole safety argument for MENU_BY_ROLE rests on this. If relevance
    // could ever turn a `false` from canSee into a `true`, the curated lists
    // would be a second, sloppier permission system.
    for (const role of Object.keys(MATRIX)) {
      const viewer = viewerFor(role);
      for (const item of ALL_ITEMS) {
        if (menuItems(item, viewer)) expect(canSee(item, viewer)).toBe(true);
      }
    }
  });

  it('hides the personal planner from warehouse staff', () => {
    // The owner's instruction, verbatim: "mening kunim / kalendarlar
    // skladchiga korinishi shart emas".
    for (const role of ['warehouse_operator', 'warehouse_manager']) {
      const menu = menuFor(role);
      expect(menu).not.toContain('/bugun');
      expect(menu).not.toContain('/kalendar');
      expect(menu).toContain('/receive');
    }
  });

  it('leaves warehouse staff a short, warehouse-shaped menu', () => {
    // A regression fence, not a spec: these numbers went 15 → 8 / 11, and a
    // future nav entry that quietly lands back in the warehouse menu should
    // have to say so here. Round 47 took TWO screens back off them, both on
    // the owner's instruction: /o («Свои списки» — «kerak emas, olib tashla»,
    // gone from every menu) and /arrivals («sklad ekranidan yo'qolsin» — a
    // promise is a sales fact and a packer can only act on a truck). 9 → 7,
    // 12 → 10.
    expect(menuFor('warehouse_operator')).toHaveLength(7);
    expect(menuFor('warehouse_manager')).toHaveLength(10);
    // And they are gone rather than merely reordered.
    expect(menuFor('warehouse_operator')).not.toContain('/arrivals');
    expect(menuFor('warehouse_manager')).not.toContain('/o');
    for (const href of menuFor('warehouse_operator')) {
      expect(href).not.toMatch(/^\/(crm|pipeline|accounting|admin|map)/);
    }
  });

  it('gives an uncurated role — including one the owner invents — everything it may open', () => {
    const owner = viewerFor('super_admin');
    expect(menuFor('super_admin')).toEqual(
      ALL_ITEMS.filter((item) => canSee(item, owner)).map((item) => item.href),
    );
    // A role invented on /admin/roles has no curated list; it must get a full
    // menu rather than an empty app.
    expect(isRelevant('/kalendar', ['brigadir'])).toBe(true);
  });

  it('unions across roles — two jobs means both menus', () => {
    const both = menuFor('warehouse_operator', 'accountant');
    expect(both).toContain('/receive');
    expect(both).toContain('/accounting');
  });

  it('falls back to the full menu when any held role is uncurated', () => {
    // Warehouse operator + super_admin is the owner logging in to test the
    // scanner. He keeps his own menu.
    expect(isRelevant('/accounting', ['warehouse_operator', 'super_admin'])).toBe(true);
  });

  it('keeps every tab-bar destination inside its own menu', () => {
    // A primary href that relevance hides is a tab that silently disappears,
    // leaving a three-icon bar nobody asked for.
    for (const role of Object.keys(MATRIX)) {
      const bar = primaryItems(viewerFor(role));
      expect(bar.length).toBeGreaterThanOrEqual(3);
      for (const item of bar) expect(isRelevant(item.href, [role])).toBe(true);
    }
  });

  it('curates only hrefs that exist in NAV', () => {
    // A typo in a curated list is invisible: `isRelevant` only ever filters,
    // so a curated href NAV does not have simply never matches anything.
    //
    // This test carried that name for twelve rounds while asserting only
    // that every role can reach its home tile — so when round 75 deleted the
    // /crm/today entry, the stale '/crm/today' left in the sales list would
    // have gone unnoticed. It now does what it says: every curated href must
    // be a real destination.
    const known = new Set(ALL_ITEMS.map((item) => item.href));
    for (const role of Object.keys(MATRIX)) {
      expect(menuFor(role)).toContain('/');
      for (const href of MENU_BY_ROLE[role] ?? []) {
        expect(known, `${role} curates ${href}`).toContain(href);
      }
    }
  });

  it('leaves each job a route to its own work', () => {
    expect(menuFor('ved_manager')).toContain('/batches');
    expect(menuFor('logist')).toContain('/plans');
    expect(menuFor('sales_manager')).toContain('/crm');
    expect(menuFor('accountant')).toContain('/accounting');
  });
});
