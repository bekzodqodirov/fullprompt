import { describe, expect, it } from 'vitest';
import { ROLE_CODES, ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import {
  mayEditKpiTable,
  mayPayCommission,
  maySeeStaffMoney,
  maySeeStaffUpsale,
} from '@/modules/wms/staff/door';

/**
 * Who may read and pay a colleague's money (0117). BEHAVIOURAL over every
 * seeded role and over roles he could invent tomorrow with checkboxes on
 * /admin/roles — the exclusion is a property of a matrix he edits, not of
 * today's seed (#790's test shape).
 */
const actorOf = (codes: readonly string[]) => {
  const set = new Set(codes);
  return { permissions: set };
};
const role = (code: RoleCode, ...extra: string[]) => actorOf([...ROLE_MATRIX[code], ...extra]);

describe('the seeded roles', () => {
  const expected: Record<RoleCode, { read: boolean; pay: boolean; upsale: boolean; table: boolean }> = {
    super_admin: { read: true, pay: true, upsale: true, table: true },
    admin: { read: true, pay: true, upsale: true, table: true },
    logist: { read: false, pay: false, upsale: false, table: false },
    ved_manager: { read: false, pay: false, upsale: false, table: false },
    warehouse_manager: { read: false, pay: false, upsale: false, table: false },
    warehouse_operator: { read: false, pay: false, upsale: false, table: false },
    sales_manager: { read: false, pay: false, upsale: false, table: false },
    accountant: { read: true, pay: true, upsale: true, table: false },
    viewer: { read: false, pay: false, upsale: false, table: false },
  };

  for (const code of ROLE_CODES) {
    it(code, () => {
      const actor = role(code);
      expect({
        read: maySeeStaffMoney(actor.permissions),
        pay: mayPayCommission(actor),
        upsale: maySeeStaffUpsale(actor),
        table: mayEditKpiTable(actor),
      }).toEqual(expected[code]);
    });
  }
});

describe('invented roles — the owner’s checkboxes', () => {
  it('a VED given the kassa may spend but never sees or pays a seller’s earnings (law 4)', () => {
    const ved = role('ved_manager', 'finance.expenses');
    expect(maySeeStaffMoney(ved.permissions)).toBe(true);
    expect(maySeeStaffUpsale(ved)).toBe(false);
    expect(mayPayCommission(ved)).toBe(false);
  });

  it('a logist given the kassa gets no upsale column and no KPI press', () => {
    // He holds clients.manage, which makes his upsale scope 'own' — a
    // colleague's commission is not his.
    const logist = role('logist', 'finance.expenses');
    expect(maySeeStaffMoney(logist.permissions)).toBe(true);
    expect(maySeeStaffUpsale(logist)).toBe(false);
    expect(mayPayCommission(logist)).toBe(false);
  });

  it('the read-only analyst (finance.reports alone) does not open /hodimlar and cannot pay', () => {
    const analyst = actorOf(['finance.reports']);
    expect(maySeeStaffMoney(analyst.permissions)).toBe(false);
    expect(mayPayCommission(analyst)).toBe(false);
    expect(maySeeStaffUpsale(analyst)).toBe(true);
  });

  it('the kassa alone opens the page and nothing more', () => {
    const cashier = actorOf(['finance.expenses']);
    expect(maySeeStaffMoney(cashier.permissions)).toBe(true);
    expect(mayPayCommission(cashier)).toBe(false);
    expect(mayEditKpiTable(cashier)).toBe(false);
  });
});
