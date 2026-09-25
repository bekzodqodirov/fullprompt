import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import { moneyHidden, type MoneySight } from '@/modules/platform/rbac/money-sight';
import { mayPickTill } from '@/modules/wms/accounting/till-door';
import { seesCompanyMoney } from '@/modules/wms/finance/scope';
import { pricingSight } from '@/modules/wms/finance/pricing-view';
import { costSightFor, maySeeTillNames } from '@/modules/wms/costing/cost-sight';
import { hasMoneyTier } from '@/modules/platform/ai/tools';

/**
 * The owner's Q19 (2026-09-25): «ved hodimi kassa foyda zararni umuman
 * ko'rmasin, tannarxni ham». Enumerated over the SEEDED ROLES, every money
 * surface at once — not asserted against the predicate's shape, which would
 * only restate it (#166). The exclusion is a property of a grant matrix he
 * edits with checkboxes on /admin/roles, so the honest question is «what does
 * each of his actual roles get», and the day he ticks `finance.reports` for
 * the VED this file says so in his own vocabulary (upsale-scope.test's shape).
 */
const actorFor = (role: RoleCode) => ({
  id: `u-${role}`,
  roles: [role] as string[],
  permissions: new Set<string>(ROLE_MATRIX[role]),
});

const withGrants = (...codes: string[]) => ({
  id: 'u-invented',
  roles: ['invented'] as string[],
  permissions: new Set<string>(codes),
});

const EXPECTED: Record<RoleCode, Record<MoneySight, boolean>> = {
  super_admin: { results: false, kassa: false },
  admin: { results: false, kassa: false },
  logist: { results: false, kassa: false },
  // THE RULE: the one seeded role that holds `ved.docs` and not
  // `finance.reports`.
  ved_manager: { results: true, kassa: true },
  warehouse_manager: { results: false, kassa: false },
  warehouse_operator: { results: false, kassa: false },
  sales_manager: { results: false, kassa: false },
  accountant: { results: false, kassa: false },
  viewer: { results: false, kassa: false },
};

describe('who the Q19 rule blinds, role by role', () => {
  it('answers for every seeded role: the VED and nobody else', () => {
    for (const role of Object.keys(EXPECTED) as RoleCode[]) {
      const actor = actorFor(role);
      expect(moneyHidden('results', actor.permissions), `${role} results`).toBe(EXPECTED[role].results);
      expect(moneyHidden('kassa', actor.permissions), `${role} kassa`).toBe(EXPECTED[role].kassa);
    }
  });

  it('covers every role the catalogue has — a new one cannot arrive unanswered', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(ROLE_MATRIX).sort());
  });

  it('keys on the ved.docs GRANT, so a customs role he invents is covered the day it is ticked', () => {
    expect(moneyHidden('results', withGrants('ved.docs', 'finance.manage').permissions)).toBe(true);
    expect(moneyHidden('kassa', withGrants('ved.docs', 'finance.manage').permissions)).toBe(true);
    // Law 4's audience sees everything, the grant it keys on — NOT
    // `seesAllMoney`, which the VED passes through finance.manage (#791).
    expect(moneyHidden('results', withGrants('ved.docs', 'finance.manage', 'finance.reports').permissions)).toBe(false);
    expect(moneyHidden('kassa', withGrants('ved.docs', 'finance.reports').permissions)).toBe(false);
    // A VED who is also a kassa holder keeps the kassa, never the results.
    const holder = withGrants('ved.docs', 'finance.manage', 'finance.expenses').permissions;
    expect(moneyHidden('results', holder)).toBe(true);
    expect(moneyHidden('kassa', holder)).toBe(false);
  });

  it('both hats: the VED hat blinds whatever else is worn, unless a money grant is also held', () => {
    const union = (a: RoleCode, b: RoleCode) =>
      new Set<string>([...ROLE_MATRIX[a], ...ROLE_MATRIX[b]]);
    // logist ∪ VED: blind — stated, the union of permissions still lacks
    // finance.reports and finance.expenses.
    expect(moneyHidden('results', union('logist', 'ved_manager'))).toBe(true);
    expect(moneyHidden('kassa', union('logist', 'ved_manager'))).toBe(true);
    // accountant ∪ VED: sees everything.
    expect(moneyHidden('results', union('accountant', 'ved_manager'))).toBe(false);
    expect(moneyHidden('kassa', union('accountant', 'ved_manager'))).toBe(false);
  });

  it('over every subset of the four grants that matter: kassa ⇒ results, and nobody blinded holds finance.reports', () => {
    const codes = ['ved.docs', 'finance.reports', 'finance.expenses', 'finance.manage'];
    for (let mask = 0; mask < 1 << codes.length; mask += 1) {
      const grants = new Set(codes.filter((_, i) => mask & (1 << i)));
      const label = [...grants].join('+') || '∅';
      if (moneyHidden('kassa', grants)) expect(moneyHidden('results', grants), label).toBe(true);
      if (moneyHidden('results', grants)) expect(grants.has('finance.reports'), label).toBe(false);
    }
  });
});

describe('the sight rule and the door rule agree (Q19 + U33)', () => {
  it('whoever the kassa is hidden from may not move a till, for every seeded role', () => {
    for (const role of Object.keys(ROLE_MATRIX) as RoleCode[]) {
      const { permissions } = actorFor(role);
      if (moneyHidden('kassa', permissions)) expect(mayPickTill(permissions), role).toBe(false);
    }
  });

  it('the roles whose kassa doors change are ENUMERATED: finance.manage without the till grant is the VED alone', () => {
    const changed = (Object.keys(ROLE_MATRIX) as RoleCode[]).filter((role) => {
      const { permissions } = actorFor(role);
      return permissions.has('finance.manage') && !mayPickTill(permissions);
    });
    expect(changed).toEqual(['ved_manager']);
  });
});

/**
 * Every money SURFACE, per seeded role — each asked through the predicate
 * its screen asks. `company` is the dashboard's money blocks, the admin
 * home's «Pul» card and the cargo-risk dollars (`seesCompanyMoney`); `ai` is
 * the assistant's money tier; `pricing` the «Partiya moliyasi» door on an
 * export truck and on an internal one; `ownCosts` whether the cost cards list
 * only the reader's own entries; `tillName` whether a cost row may name its
 * drawer.
 */
type Surface = {
  company: boolean;
  ai: boolean;
  pricing: 'full' | 'price' | 'none';
  pricingInternal: 'full' | 'price' | 'none';
  ownCosts: boolean;
  tillName: boolean;
};

const SURFACES: Record<RoleCode, Surface> = {
  super_admin: { company: true, ai: true, pricing: 'full', pricingInternal: 'full', ownCosts: false, tillName: true },
  admin: { company: true, ai: true, pricing: 'full', pricingInternal: 'full', ownCosts: false, tillName: true },
  accountant: { company: true, ai: false, pricing: 'full', pricingInternal: 'full', ownCosts: false, tillName: true },
  // THE ROW THE OWNER DECIDED: no company money, no AI money tier, a
  // price-only «Partiya moliyasi» (he keeps pricing, #108) and no door at all
  // to an internal leg's cost page, his own cost entries only, no drawer names.
  ved_manager: { company: false, ai: false, pricing: 'price', pricingInternal: 'none', ownCosts: true, tillName: false },
  // Untouched by construction — every row below is what it was before Q19.
  logist: { company: false, ai: false, pricing: 'none', pricingInternal: 'none', ownCosts: false, tillName: true },
  sales_manager: { company: false, ai: false, pricing: 'none', pricingInternal: 'none', ownCosts: false, tillName: true },
  warehouse_manager: { company: false, ai: false, pricing: 'none', pricingInternal: 'none', ownCosts: false, tillName: false },
  warehouse_operator: { company: false, ai: false, pricing: 'none', pricingInternal: 'none', ownCosts: false, tillName: false },
  viewer: { company: false, ai: false, pricing: 'none', pricingInternal: 'none', ownCosts: false, tillName: false },
};

describe('every seeded role × every money surface', () => {
  it('answers as the owner decided', () => {
    for (const role of Object.keys(SURFACES) as RoleCode[]) {
      const actor = actorFor(role);
      const got: Surface = {
        company: seesCompanyMoney(actor),
        ai: hasMoneyTier(actor),
        pricing: pricingSight(actor.permissions, false),
        pricingInternal: pricingSight(actor.permissions, true),
        ownCosts: costSightFor(actor).ownOnly !== null,
        tillName: maySeeTillNames(actor.permissions),
      };
      expect(got, role).toEqual(SURFACES[role]);
    }
  });

  it('covers every role the catalogue has', () => {
    expect(Object.keys(SURFACES).sort()).toEqual(Object.keys(ROLE_MATRIX).sort());
  });

  it('the company money and the results rule can never disagree, whatever the grants', () => {
    const codes = ['ved.docs', 'finance.reports', 'finance.manage', 'clients.manage', 'finance.expenses'];
    for (let mask = 0; mask < 1 << codes.length; mask += 1) {
      const actor = withGrants(...codes.filter((_, i) => mask & (1 << i)));
      if (seesCompanyMoney(actor)) {
        expect(moneyHidden('results', actor.permissions), [...actor.permissions].join('+')).toBe(false);
      }
    }
  });

  it('the AI money tier is closed to an admin role customised with ved.docs and without finance.reports', () => {
    const customised = { roles: ['admin'], permissions: new Set(['ved.docs', 'finance.manage']) };
    expect(hasMoneyTier(customised)).toBe(false);
    expect(hasMoneyTier({ roles: ['admin'], permissions: new Set(['ved.docs', 'finance.reports']) })).toBe(true);
  });
});
