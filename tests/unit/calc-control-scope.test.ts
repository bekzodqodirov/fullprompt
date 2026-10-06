import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import {
  calcControlReadScopeFor,
  calcControlScopeFor,
  internalNoteSight,
  mayReadCalcInternalNote,
  mayReadCalcRegistry,
  type CalcControlScope,
} from '@/modules/wms/calc/control-scope';
import { offerSightFor, upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';

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

/**
 * The REGISTRY's door (`/hisoblash/tarix`), enumerated the same way.
 *
 * The owner's answer 2A: himself, the accountant and the VED — and NOT the
 * sellers, because every figure on that screen is a floor (law 4). A
 * boolean and not a reuse of the control scope: `'own'` there means «the
 * calculations you sealed», and a history must answer about the company's.
 */
const REGISTRY: Record<RoleCode, boolean> = {
  super_admin: true,
  admin: true,
  accountant: true,
  ved_manager: true,
  sales_manager: false,
  logist: false,
  warehouse_manager: false,
  warehouse_operator: false,
  viewer: false,
};

describe('who may read the registry of sealed calculations', () => {
  it('answers for every seeded role', () => {
    for (const role of Object.keys(REGISTRY) as RoleCode[]) {
      expect(mayReadCalcRegistry(actorFor(role)), role).toBe(REGISTRY[role]);
    }
  });

  it('covers every role the catalogue has', () => {
    expect(Object.keys(REGISTRY).sort()).toEqual(Object.keys(ROLE_MATRIX).sort());
  });

  it('is exactly the control screen with «own» widened to «yes» — no third audience', () => {
    for (const role of Object.keys(ROLE_MATRIX) as RoleCode[]) {
      expect(mayReadCalcRegistry(actorFor(role)), role).toBe(
        calcControlScopeFor(actorFor(role)) !== 'none',
      );
    }
  });
});

/*
 * DELIBERATE EDIT (docs/VED-TARIX.md §7, review access-money-6,
 * ved-correctness-3, tests-completeness-5): the owner's 12a widens the
 * nazorat page's READS to every VED. `calcControlScopeFor` above keeps its
 * name and its value — it is the WRITE scope for all six of its callers (the
 * link ✅/❌, `assertMine`, the home count, the bot's link ask, the prixod
 * card picker, the pricing page) — so its `'own'` assertions stand, now read
 * as «the VED confirms only what scores himself». The reads are a second
 * predicate, enumerated the same way.
 */
const READ: Record<RoleCode, 'all' | 'none'> = {
  super_admin: 'all',
  admin: 'all',
  accountant: 'all',
  // 12a: «ved hodimlari bir birini … ishini korish imkoniyati bolishi kerak».
  ved_manager: 'all',
  sales_manager: 'none',
  logist: 'none',
  warehouse_manager: 'none',
  warehouse_operator: 'none',
  viewer: 'none',
};

describe('who may READ the nazorat lists (12a)', () => {
  it('answers for every seeded role', () => {
    for (const role of Object.keys(READ) as RoleCode[]) {
      expect(calcControlReadScopeFor(actorFor(role)), role).toBe(READ[role]);
    }
  });

  it('covers every role the catalogue has', () => {
    expect(Object.keys(READ).sort()).toEqual(Object.keys(ROLE_MATRIX).sort());
  });

  it('reads wider than it writes only for the VED — the person a link scores', () => {
    for (const role of Object.keys(ROLE_MATRIX) as RoleCode[]) {
      const write = calcControlScopeFor(actorFor(role));
      const read = calcControlReadScopeFor(actorFor(role));
      if (role === 'ved_manager') {
        expect([read, write]).toEqual(['all', 'own']);
      } else {
        expect(read === 'all', role).toBe(write === 'all');
      }
    }
  });
});

/*
 * The internal note's audience (9a, review access-money-10): NARROWER than
 * the registry's — the accountant reads the history and must NOT see the
 * note. Over every seeded role, so the day the owner ticks `ved.docs` for
 * somebody this file says so in his vocabulary.
 */
const NOTE: Record<RoleCode, boolean> = {
  super_admin: true,
  admin: true,
  ved_manager: true,
  accountant: false,
  sales_manager: false,
  logist: false,
  warehouse_manager: false,
  warehouse_operator: false,
  viewer: false,
};

describe('who may read the VED internal note', () => {
  it('answers for every seeded role — the accountant reads the history and not the note', () => {
    for (const role of Object.keys(NOTE) as RoleCode[]) {
      expect(mayReadCalcInternalNote(actorFor(role)), role).toBe(NOTE[role]);
      expect(internalNoteSight(actorFor(role)) !== null, role).toBe(NOTE[role]);
    }
    expect(mayReadCalcRegistry(actorFor('accountant'))).toBe(true);
    expect(mayReadCalcInternalNote(actorFor('accountant'))).toBe(false);
  });

  it('covers every role the catalogue has', () => {
    expect(Object.keys(NOTE).sort()).toEqual(Object.keys(ROLE_MATRIX).sort());
  });
});

/*
 * 16a's two facts (review access-money-15), over the seeded roles AND an
 * invented both-hats role — `crm.leads` + `ved.docs`, no view_all, no
 * finance.reports — which a ranked «own beats price» would have left reading
 * only their own offers.
 */
describe('the seller price as a sight of its own (16a)', () => {
  const SIGHT: Record<RoleCode, { mayOffer: boolean; seesOfferPrices: boolean }> = {
    super_admin: { mayOffer: true, seesOfferPrices: true },
    admin: { mayOffer: true, seesOfferPrices: true },
    accountant: { mayOffer: true, seesOfferPrices: true },
    ved_manager: { mayOffer: false, seesOfferPrices: true },
    sales_manager: { mayOffer: true, seesOfferPrices: false },
    logist: { mayOffer: true, seesOfferPrices: false },
    warehouse_manager: { mayOffer: false, seesOfferPrices: false },
    warehouse_operator: { mayOffer: false, seesOfferPrices: false },
    viewer: { mayOffer: false, seesOfferPrices: false },
  };

  it('answers for every seeded role, and the VED still sees no upsale', () => {
    for (const role of Object.keys(SIGHT) as RoleCode[]) {
      expect(offerSightFor(actorFor(role)), role).toEqual(SIGHT[role]);
    }
    expect(upsaleScopeFor(actorFor('ved_manager'))).toBe('none');
  });

  it('a both-hats person keeps BOTH facts', () => {
    const codes = new Set(['crm.leads', 'ved.docs']);
    const bothHats = { id: 'x', permissions: { has: (c: string) => codes.has(c) } };
    expect(upsaleScopeFor(bothHats)).toBe('own');
    expect(offerSightFor(bothHats)).toEqual({ mayOffer: true, seesOfferPrices: true });
  });
});
