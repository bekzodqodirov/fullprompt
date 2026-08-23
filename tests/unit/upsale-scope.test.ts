import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import { mayOffer, upsaleScopeFor, type UpsaleScope } from '@/modules/wms/calc/upsale-scope';
import { DEAL_WRITE_PERMISSIONS } from '@/modules/wms/deals/service';

/**
 * Law 4's four audiences, enumerated over the SEEDED ROLES.
 *
 * Not asserted against the predicate's shape, which would only restate it.
 * The exclusion that matters — «VED never sees upsale» — is a property of a
 * grant matrix the owner edits with checkboxes on /admin/roles, so the honest
 * question is «what does each of his actual roles get», and the day he ticks
 * `finance.reports` for the VED this file says so in his own vocabulary.
 */
const actorFor = (role: RoleCode) => {
  const codes = new Set<string>(ROLE_MATRIX[role]);
  return { id: 'x', permissions: { has: (c: string) => codes.has(c) } };
};

const EXPECTED: Record<RoleCode, UpsaleScope> = {
  // The owner and whoever he makes an admin.
  super_admin: 'all',
  admin: 'all',
  // «the accountant pays the upsale out to the seller» — they must see it.
  accountant: 'all',
  // Sellers: their own. The logist carries `crm.leads` + `clients.manage`
  // and works the funnel, so they are a seller here by the owner's own matrix.
  sales_manager: 'own',
  logist: 'own',
  // THE LAW. The VED computed the floor; the client price would hand them the
  // subtraction. They hold `finance.manage` and `finance.view`, which is
  // exactly why round 91's `seesAllMoney` is the wrong predicate for this.
  ved_manager: 'none',
  // Nobody else is in this conversation at all.
  warehouse_manager: 'none',
  warehouse_operator: 'none',
  // Read-only: `reports.all_warehouses` and nothing else.
  viewer: 'none',
};

describe('who sees what a customer was charged', () => {
  it('answers for every seeded role, and the VED is none', () => {
    for (const role of Object.keys(EXPECTED) as RoleCode[]) {
      expect(upsaleScopeFor(actorFor(role)), role).toBe(EXPECTED[role]);
    }
  });

  it('covers every role the catalogue has — a new one cannot arrive unanswered', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(ROLE_MATRIX).sort());
  });

  it('the VED can work a deal and still not quote a customer', () => {
    const ved = actorFor('ved_manager');
    // Both halves matter: `ved.docs` IS in the deal-write list on purpose
    // (DEALS.md #2 — the VED recalculates jobs), so the offer door cannot be
    // the card door.
    expect(DEAL_WRITE_PERMISSIONS).toContain('ved.docs');
    expect(DEAL_WRITE_PERMISSIONS.some((c) => ved.permissions.has(c))).toBe(true);
    expect(mayOffer(ved)).toBe(false);
  });

  it('everyone who may quote may also read back what they quoted', () => {
    for (const role of Object.keys(ROLE_MATRIX) as RoleCode[]) {
      const actor = actorFor(role);
      if (mayOffer(actor)) expect(upsaleScopeFor(actor)).not.toBe('none');
    }
  });

  it('round 91’s money predicate is NOT this one, and the difference is the VED', () => {
    // seesAllMoney = finance.manage || clients.manage. Pinned as a fact, so
    // that swapping this file onto it turns red rather than leaking quietly.
    const ved = actorFor('ved_manager');
    expect(ved.permissions.has('finance.manage')).toBe(true);
    expect(ved.permissions.has('finance.reports')).toBe(false);
  });
});
