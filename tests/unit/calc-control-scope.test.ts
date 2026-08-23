import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import {
  calcControlScopeFor,
  type CalcControlScope,
} from '@/modules/wms/calc/control-scope';
import { upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';

/**
 * Phase E1's audience, enumerated over the SEEDED ROLES.
 *
 * The shape `upsale-scope.test.ts` uses, and for the same reason: the door is
 * a composite of grants the owner edits with checkboxes, so the honest
 * question is «what does each of his actual roles get» — and the day he ticks
 * something for somebody, this file says so in his own vocabulary.
 */
const actorFor = (role: RoleCode) => {
  const codes = new Set<string>(ROLE_MATRIX[role]);
  return { id: 'x', permissions: { has: (c: string) => codes.has(c) } };
};

const EXPECTED: Record<RoleCode, CalcControlScope> = {
  // The owner, whoever he makes an admin, and the person who types the
  // rastamojka into the cost grid — the other half of every comparison.
  super_admin: 'all',
  admin: 'all',
  accountant: 'all',
  // The person being measured, on their own work. They have to see the number
  // to act on it, and a VED who cannot open this screen cannot be helped by it.
  ved_manager: 'own',
  // A pure cost breakdown is not a seller's screen (law 10: sellers read
  // PRICES, never the cost side). The logist is in the funnel, not in customs.
  sales_manager: 'none',
  logist: 'none',
  warehouse_manager: 'none',
  warehouse_operator: 'none',
  viewer: 'none',
};

describe('who may read hisob vs haqiqat', () => {
  it('answers for every seeded role', () => {
    for (const role of Object.keys(EXPECTED) as RoleCode[]) {
      expect(calcControlScopeFor(actorFor(role)), role).toBe(EXPECTED[role]);
    }
  });

  it('covers every role the catalogue has — a new one cannot arrive unanswered', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(ROLE_MATRIX).sort());
  });

  /**
   * The two doors disagree about exactly two roles, and both disagreements
   * are the point — which is why this is a THIRD predicate and not a reuse.
   */
  it('is not upsaleScopeFor, and the difference is deliberate', () => {
    // The VED: shut out of the client price, admitted to their own costs.
    expect(upsaleScopeFor(actorFor('ved_manager'))).toBe('none');
    expect(calcControlScopeFor(actorFor('ved_manager'))).toBe('own');
    // The seller: admitted to the client price, shut out of the cost side.
    expect(upsaleScopeFor(actorFor('sales_manager'))).toBe('own');
    expect(calcControlScopeFor(actorFor('sales_manager'))).toBe('none');
  });

  it('lets the accountant in, which is the door #792 got wrong', () => {
    expect(calcControlScopeFor(actorFor('accountant'))).toBe('all');
  });
});
