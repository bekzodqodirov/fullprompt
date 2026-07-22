import { describe, expect, it } from 'vitest';
import {
  PERMISSION_CODES,
  ROLE_CODES,
  ROLE_MATRIX,
  WAREHOUSE_SCOPED_ROLES,
} from '@/modules/platform/rbac/catalog';

describe('RBAC catalog (spec §16 matrix)', () => {
  it('every role in the matrix maps to known permissions only', () => {
    for (const [role, perms] of Object.entries(ROLE_MATRIX)) {
      expect(ROLE_CODES).toContain(role);
      for (const perm of perms) {
        expect(PERMISSION_CODES).toContain(perm);
      }
    }
  });

  it('super_admin and admin hold every permission', () => {
    expect(new Set(ROLE_MATRIX.super_admin)).toEqual(new Set(PERMISSION_CODES));
    expect(new Set(ROLE_MATRIX.admin)).toEqual(new Set(PERMISSION_CODES));
  });

  it('warehouse_operator cannot void receipts or resolve unclaimed (spec §16)', () => {
    expect(ROLE_MATRIX.warehouse_operator).not.toContain('receipts.void');
    expect(ROLE_MATRIX.warehouse_operator).not.toContain('receipts.unclaimed.resolve');
  });

  it('sales_manager is read-only: own clients + own reports', () => {
    expect(new Set(ROLE_MATRIX.sales_manager)).toEqual(
      new Set(['clients.view_own', 'reports.own_clients']),
    );
  });

  it('only logist/admin manage load plans', () => {
    for (const role of ROLE_CODES) {
      const hasPlans = ROLE_MATRIX[role].includes('plans.manage');
      const shouldHave = role === 'super_admin' || role === 'admin' || role === 'logist';
      expect(hasPlans, `${role} plans.manage`).toBe(shouldHave);
    }
  });

  it('only ved_manager (and admins) hold ved.docs', () => {
    for (const role of ROLE_CODES) {
      const has = ROLE_MATRIX[role].includes('ved.docs');
      const should = role === 'super_admin' || role === 'admin' || role === 'ved_manager';
      expect(has, `${role} ved.docs`).toBe(should);
    }
  });

  it('warehouse-scoped roles are exactly manager and operator', () => {
    expect(new Set(WAREHOUSE_SCOPED_ROLES)).toEqual(
      new Set(['warehouse_manager', 'warehouse_operator']),
    );
  });
});
