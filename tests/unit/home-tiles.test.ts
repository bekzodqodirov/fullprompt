import { describe, expect, it } from 'vitest';
import { NAV, menuItems } from '@/modules/platform/rbac/nav';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';

/**
 * Round 75, the owner's item 1: "sotuv main ekranda bitim bn crmni ketma ket
 * qoy".
 *
 * Bitimlar and CRM were ALREADY consecutive in `NAV` and still rendered
 * diagonally on his phone — the home tiles are `grid-cols-2 sm:grid-cols-3`,
 * so a pair that starts in the second column of a two-column row wraps
 * between its halves. Source order is not screen order.
 *
 * The fix is to anchor the pair at index 0, which is the only position the
 * per-viewer filter cannot move. This file is the reason that keeps holding:
 * index 0 survives filtering but NOT insertion, and nothing else in the
 * suite can see tile order (nav-relevance's own comparison derives both
 * sides from `ALL_ITEMS` in the same order, so it is reorder-proof).
 */

/** Exactly the filter `src/app/(protected)/page.tsx` applies to a group. */
function salesTiles(viewer: { permissions: Set<string>; roles: string[] }, flowHrefs: string[] = []) {
  const group = NAV.find((candidate) => candidate.titleKey === 'sectionSales')!;
  return group.items
    .filter((item) => item.href !== '/')
    .filter((item) => menuItems(item, viewer))
    .filter((item) => !flowHrefs.includes(item.href))
    .map((item) => item.href);
}

function viewerFor(...roles: string[]) {
  const matrix: Record<string, readonly string[]> = ROLE_MATRIX;
  return { roles, permissions: new Set(roles.flatMap((role) => matrix[role] ?? [])) };
}

/** Do these two land side by side in a `cols`-wide wrapping grid? */
function sameRow(hrefs: string[], a: string, b: string, cols: number) {
  const i = hrefs.indexOf(a);
  const j = hrefs.indexOf(b);
  if (i === -1 || j === -1) return null; // this viewer sees neither pair member
  return Math.floor(i / cols) === Math.floor(j / cols);
}

describe('the home tiles put Bitimlar and CRM side by side', () => {
  // The two column counts the grid actually has: `grid-cols-2 sm:grid-cols-3`.
  const COLS = [2, 3];

  it('keeps the pair on one row for every shipped role that can see both', () => {
    for (const role of Object.keys(ROLE_MATRIX)) {
      const tiles = salesTiles(viewerFor(role));
      for (const cols of COLS) {
        const together = sameRow(tiles, '/bitimlar', '/crm', cols);
        if (together === null) continue;
        // The red-proof target: restore the old order (client book first)
        // and this fails at cols=2 for super_admin — the owner's own phone.
        expect(together, `${role} at ${cols} columns: ${tiles.join(' ')}`).toBe(true);
      }
    }
  });

  it('keeps it for a role the owner invents that cannot see the client book', () => {
    // `/admin/clients` needs `clients.manage`. A role with only `crm.leads`
    // loses it, and every index after it shifts — which is the whole reason
    // the pair is anchored at 0 rather than at some counted position.
    const viewer = { roles: ['sotuvchi_yordamchi'], permissions: new Set(['crm.leads']) };
    const tiles = salesTiles(viewer);
    expect(tiles).not.toContain('/admin/clients');
    for (const cols of COLS) expect(sameRow(tiles, '/bitimlar', '/crm', cols)).toBe(true);
  });

  it('keeps it when the workflow home has already drawn some of the group', () => {
    // A sales manager's tiles are what is LEFT after their flow rows; the
    // suppression list is the other thing that shifts every index.
    const viewer = viewerFor('sales_manager');
    const flow = ['/crm/today', '/bitimlar', '/crm', '/suhbatlar', '/my-clients'];
    const tiles = salesTiles(viewer, flow);
    // Both are drawn as flow rows here, so there is no pair left to break —
    // asserting that is the point: the case exists and is accounted for.
    expect(sameRow(tiles, '/bitimlar', '/crm', 2)).toBeNull();
  });
});

describe('«Bugun qo‘ng‘iroq» is off the menu, not out of the app', () => {
  it('offers no /crm/today entry anywhere in NAV', () => {
    // Owner, round 75: "bugun qongiroq kerak emas". One deletion in NAV
    // takes the home tile, the sidebar row and the ••• sheet row together.
    expect(NAV.flatMap((group) => group.items).map((item) => item.href)).not.toContain(
      '/crm/today',
    );
  });
});
