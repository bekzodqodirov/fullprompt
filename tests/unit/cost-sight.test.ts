import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import { ALL_COSTS, costSightFor, tillView } from '@/modules/wms/costing/cost-sight';
import { mayVoidLedgerRow, type LedgerRowFacts } from '@/modules/wms/finance/void-rule';
import { pricingSight } from '@/modules/wms/finance/pricing-view';

/**
 * How a cost row and a ledger row speak to each reader (Q19, 2026-09-25).
 * Behavioural over the seeded roles: the VED's answers change, and every
 * other role's answer is exactly the pair the four cost cards printed inline
 * before the rule existed — so the move changed nobody but him.
 */
const perms = (role: RoleCode) => new Set<string>(ROLE_MATRIX[role]);
// `mergedExpenseId` joined the row (Q8, the un-merge): a new FIELD, so the
// expectations below carry it; what each role reads about the kassa is the
// same as before.
const kassaRow = { accountId: 'till-1', accountName: 'Naqd USD', mergedExpenseId: null };
const plainRow = { accountId: null, accountName: null, mergedExpenseId: null };

/** The two lines each cost card carried before `tillView` (0101). */
function oldInline(p: ReadonlySet<string>, row: { accountId: string | null; accountName: string | null }) {
  const names = p.has('finance.view') || p.has('finance.manage') || p.has('finance.expenses');
  return { accountName: names ? row.accountName : null, paidFromTill: row.accountId !== null };
}

describe('tillView — the kassa as a cost row speaks it', () => {
  it('every seeded role but the VED reads exactly what it read before', () => {
    for (const role of Object.keys(ROLE_MATRIX) as RoleCode[]) {
      if (role === 'ved_manager') continue;
      for (const row of [kassaRow, plainRow]) {
        expect(tillView(perms(role), row), `${role} ${row.accountId ?? 'plain'}`).toEqual({
          ...oldInline(perms(role), row),
          voidable: true,
          mergedExpenseId: null,
        });
      }
    }
  });

  it('the VED: no drawer, no «kassadan» fact, and the kassa-paid row names who voids it', () => {
    expect(tillView(perms('ved_manager'), kassaRow)).toEqual({
      accountName: null,
      paidFromTill: false,
      voidable: false,
      mergedExpenseId: null,
    });
    expect(tillView(perms('ved_manager'), plainRow)).toEqual({
      accountName: null,
      paidFromTill: false,
      voidable: true,
      mergedExpenseId: null,
    });
  });

  it('a merged row names its expense for EVERY reader — the 🔗 and the words, whoever presses 🗑 (Q8)', () => {
    for (const role of Object.keys(ROLE_MATRIX) as RoleCode[]) {
      expect(tillView(perms(role), { ...kassaRow, mergedExpenseId: 'exp-1' }).mergedExpenseId, role).toBe('exp-1');
      expect(tillView(perms(role), { ...plainRow, mergedExpenseId: 'exp-2' }).mergedExpenseId, role).toBe('exp-2');
    }
  });
});

describe('costSightFor — whose entries a cost card lists', () => {
  it('the VED reads his own; every other seeded role reads everybody’s', () => {
    for (const role of Object.keys(ROLE_MATRIX) as RoleCode[]) {
      const sight = costSightFor({ id: `u-${role}`, permissions: perms(role) });
      expect(sight, role).toEqual(role === 'ved_manager' ? { ownOnly: 'u-ved_manager' } : ALL_COSTS);
    }
  });
});

describe('pricingSight — the «Partiya moliyasi» door', () => {
  it('price-only for the VED on an export truck, no door to an internal leg; full for law 4', () => {
    expect(pricingSight(perms('ved_manager'), false)).toBe('price');
    expect(pricingSight(perms('ved_manager'), true)).toBe('none');
    for (const role of ['accountant', 'admin', 'super_admin'] as RoleCode[]) {
      expect(pricingSight(perms(role), false), role).toBe('full');
      expect(pricingSight(perms(role), true), role).toBe('full');
    }
    for (const role of ['logist', 'sales_manager', 'viewer', 'warehouse_manager', 'warehouse_operator'] as RoleCode[]) {
      expect(pricingSight(perms(role), false), role).toBe('none');
    }
  });
});

/**
 * The ✖ on the client ledger — the truth table the void's SQL claim is held
 * to as well (ledger-void.integration.test.ts runs the same kinds of row
 * through `voidTransaction` and asserts it agrees with this function).
 */
const LEDGER_CASES: { name: string; row: (me: string, other: string) => LedgerRowFacts; nonHolder: boolean }[] = [
  { name: 'charge (a price)', row: (me) => ({ type: 'charge', accountId: null, partnerId: null, partnerStaff: false, createdBy: me }), nonHolder: true },
  {
    name: "a colleague's charge",
    row: (_me, other) => ({ type: 'charge', accountId: null, partnerId: null, partnerStaff: false, createdBy: other }),
    nonHolder: true,
  },
  { name: 'placed payment', row: (me) => ({ type: 'payment', accountId: 'till-1', partnerId: null, partnerStaff: false, createdBy: me }), nonHolder: false },
  { name: 'own unplaced payment', row: (me) => ({ type: 'payment', accountId: null, partnerId: null, partnerStaff: false, createdBy: me }), nonHolder: true },
  {
    name: "a colleague's unplaced payment",
    row: (_me, other) => ({ type: 'payment', accountId: null, partnerId: null, partnerStaff: false, createdBy: other }),
    nonHolder: false,
  },
  {
    name: 'settlement half',
    row: (_me, other) => ({ type: 'payment', accountId: null, partnerId: 'firm-1', partnerStaff: false, createdBy: other }),
    nonHolder: true,
  },
  // Through a colleague's account it is staff money — the accountant's and
  // the admin's alone (M3a), whoever typed it (review of the VED unit).
  {
    name: 'settlement half through a staff account',
    row: (me) => ({ type: 'payment', accountId: null, partnerId: 'staff-1', partnerStaff: true, createdBy: me }),
    nonHolder: false,
  },
  { name: 'refund', row: (me) => ({ type: 'refund', accountId: 'till-1', partnerId: null, partnerStaff: false, createdBy: me }), nonHolder: false },
  // 0105 DECIDED the compensation (Q15): the other half of the refund it
  // funds, so its ✖ is the kassa holders' — the row this table's «unknown
  // kind» used to stand in for, pinned now under its own name.
  { name: 'compensation', row: (me) => ({ type: 'compensation', accountId: null, partnerId: null, partnerStaff: false, createdBy: me }), nonHolder: false },
  // A kind a later round adds is the kassa holders' until somebody decides.
  { name: 'an unknown kind', row: (me) => ({ type: 'x_later_kind', accountId: null, partnerId: null, partnerStaff: false, createdBy: me }), nonHolder: false },
];

describe('mayVoidLedgerRow — who may ✖ which ledger row', () => {
  it('a kassa holder voids every row; a non-holder exactly the allow-list', () => {
    for (const c of LEDGER_CASES) {
      const row = c.row('me', 'other');
      expect(mayVoidLedgerRow(row, { mayMoveTill: true, actorId: 'me' }), `${c.name} holder`).toBe(true);
      expect(mayVoidLedgerRow(row, { mayMoveTill: false, actorId: 'me' }), `${c.name} non-holder`).toBe(c.nonHolder);
    }
  });

  it('a kurs farqi row is nobody’s ✖ — the kassa holder’s neither (0103: its cycle writes and voids it)', () => {
    for (const createdBy of ['me', 'other']) {
      for (const till of [{ accountId: null }, { accountId: 'till-1' }]) {
        const row = { type: 'fx_diff', partnerId: null, partnerStaff: false, createdBy, ...till };
        expect(mayVoidLedgerRow(row, { mayMoveTill: true, actorId: 'me' }), `${createdBy} holder`).toBe(false);
        expect(mayVoidLedgerRow(row, { mayMoveTill: false, actorId: 'me' }), `${createdBy} non-holder`).toBe(false);
      }
    }
  });
});
