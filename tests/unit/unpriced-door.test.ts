import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { mayReadUnpricedList } from '@/modules/wms/finance/unpriced-door';

/**
 * Every door to «Narxi yozilmagan yuk» (`/finance/narxsiz`) asks ONE
 * predicate (U03): the list page itself, the dashboard's unpriced block and
 * the Balans's notes card. A link whose page bounces is worse than no link,
 * so the predicate is tested over the seeded roles — the matrix is his to
 * edit with checkboxes (#792).
 */
const perms = (role: keyof typeof ROLE_MATRIX) => new Set<string>(ROLE_MATRIX[role]);

describe('mayReadUnpricedList', () => {
  it('is /finance’s own door: finance.view or finance.manage, over every seeded role', () => {
    for (const role of Object.keys(ROLE_MATRIX) as (keyof typeof ROLE_MATRIX)[]) {
      const p = perms(role);
      expect([role, mayReadUnpricedList(p)]).toEqual([role, p.has('finance.view') || p.has('finance.manage')]);
    }
  });

  it('opens for the accountant and the admins, never for the warehouse', () => {
    for (const role of ['accountant', 'admin', 'super_admin'] as const) {
      expect([role, mayReadUnpricedList(perms(role))]).toEqual([role, true]);
    }
    for (const role of ['warehouse_manager', 'warehouse_operator'] as const) {
      expect([role, mayReadUnpricedList(perms(role))]).toEqual([role, false]);
    }
  });

  it('is the list page’s own gate — the page redirects on exactly this answer', () => {
    const page = readFileSync('src/app/(protected)/finance/narxsiz/page.tsx', 'utf8');
    expect(page).toContain("if (!mayReadUnpricedList(actor.permissions)) redirect('/');");
  });
});
