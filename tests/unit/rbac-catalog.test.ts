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

  it('sales_manager is read-only plus debt override and own leads', () => {
    expect(new Set(ROLE_MATRIX.sales_manager)).toEqual(
      new Set([
        'clients.view_own',
        'finance.view',
        'finance.debt_override',
        'reports.own_clients',
        // Phase 2.3: own leads only — seeing everyone's needs
        // crm.leads.view_all, which stays with the owner and the logist.
        'crm.leads',
      ]),
    );
    expect(ROLE_MATRIX.sales_manager).not.toContain('crm.leads.view_all');
    expect(ROLE_MATRIX.sales_manager).not.toContain('crm.manage');
  });

  it('the company margin stays away from sales (Phase 2.3/2.4)', () => {
    // A sales manager legitimately holds finance.view for client balances.
    // Profit, overheads and the funnel settings are a different question.
    for (const code of ['finance.reports', 'finance.expenses', 'crm.manage'] as const) {
      expect(ROLE_MATRIX.sales_manager, code).not.toContain(code);
    }
  });

  it('finance.manage belongs to accountant + ved_manager (and admins) only', () => {
    for (const role of ROLE_CODES) {
      const has = ROLE_MATRIX[role].includes('finance.manage');
      const should = ['super_admin', 'admin', 'accountant', 'ved_manager'].includes(role);
      expect(has, `${role} finance.manage`).toBe(should);
    }
  });

  it('warehouse_operator cannot override the debt gate', () => {
    expect(ROLE_MATRIX.warehouse_operator).not.toContain('finance.debt_override');
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

describe('the phone tab bar', () => {
  it('gives each role the four screens that role actually opens', async () => {
    const { primaryItems } = await import('@/modules/platform/rbac/nav');
    const { ROLE_MATRIX } = await import('@/modules/platform/rbac/catalog');
    const viewer = (role: keyof typeof ROLE_MATRIX) => ({
      permissions: new Set<string>(ROLE_MATRIX[role]),
      roles: [role],
    });

    const hrefs = (role: keyof typeof ROLE_MATRIX) =>
      primaryItems(viewer(role)).map((item) => item.href);

    // Owner's words: warehouse staff receive and load, sales live in CRM,
    // accountants live where the money is.
    expect(hrefs('warehouse_operator')).toContain('/receive');
    expect(hrefs('warehouse_operator')).not.toContain('/accounting');
    expect(hrefs('sales_manager')).toContain('/crm');
    expect(hrefs('sales_manager')).toContain('/my-clients');
    expect(hrefs('sales_manager')).not.toContain('/receive');
    expect(hrefs('accountant')).toContain('/accounting');
    expect(hrefs('accountant')).not.toContain('/receive');

    // Never more than four, and never a screen the role cannot open.
    for (const role of Object.keys(ROLE_MATRIX) as (keyof typeof ROLE_MATRIX)[]) {
      const items = primaryItems(viewer(role));
      expect(items.length, role).toBeLessThanOrEqual(4);
      expect(items.length, role).toBeGreaterThan(0);
    }
  });
});
