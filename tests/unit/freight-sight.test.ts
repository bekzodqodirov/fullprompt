import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { freightMoneySight } from '@/modules/wms/costing/freight-offer';

/**
 * docs/YOLKIRA-TAQSIMOT.md §7.1 — who sees a split's DOLLARS (a client's
 * share, the list rate per m³). Behavioural over the seeded roles (#790): the
 * matrix is his to edit, so the answer is asked of it, not restated.
 */
const perms = (role: keyof typeof ROLE_MATRIX) => new Set<string>(ROLE_MATRIX[role]);

describe('freightMoneySight', () => {
  it('the accountant and the admins see the money', () => {
    for (const role of ['accountant', 'admin', 'super_admin'] as const) {
      expect([role, freightMoneySight(perms(role))]).toEqual([role, true]);
    }
  });

  it('the VED, the logist and the seller see the band and the % only (#791)', () => {
    for (const role of ['ved_manager', 'logist', 'sales_manager', 'warehouse_manager', 'viewer'] as const) {
      expect([role, freightMoneySight(perms(role))]).toEqual([role, false]);
    }
  });

  it('is NOT the entry page’s door: clients.manage without finance.manage sees no dollars', () => {
    expect(freightMoneySight(new Set(['clients.manage', 'costs.enter_batch']))).toBe(false);
  });
});
