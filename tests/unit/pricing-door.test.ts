import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { mayOpenPricing } from '@/modules/wms/finance/pricing-door';
import { pricingSight } from '@/modules/wms/finance/pricing-view';

/**
 * Every link to «Partiya moliyasi» asks ONE predicate (0104): the unpriced
 * list's truck cells, /approvals' «narx qo'yish →». A link that bounces is
 * worse than no link, so the predicate must say yes exactly for the people
 * the page admits — over the seeded roles, because the matrix is his to edit.
 */
const perms = (role: keyof typeof ROLE_MATRIX) => new Set<string>(ROLE_MATRIX[role]);

describe('mayOpenPricing', () => {
  it('opens for the accountant, the admins and the VED (who prices trucks, Q19)', () => {
    for (const role of ['accountant', 'admin', 'super_admin', 'ved_manager'] as const) {
      expect([role, mayOpenPricing(perms(role))]).toEqual([role, true]);
    }
  });

  it('never for the seller, the logist, the warehouse or the viewer', () => {
    for (const role of ['sales_manager', 'logist', 'warehouse_manager', 'warehouse_operator', 'viewer'] as const) {
      expect([role, mayOpenPricing(perms(role))]).toEqual([role, false]);
    }
  });

  it('is the page’s own answer for an arrival truck, over every seeded role', () => {
    for (const role of Object.keys(ROLE_MATRIX) as (keyof typeof ROLE_MATRIX)[]) {
      expect([role, mayOpenPricing(perms(role))]).toEqual([role, pricingSight(perms(role), false) !== 'none']);
    }
  });
});
