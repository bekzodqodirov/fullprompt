import { describe, expect, it } from 'vitest';
import { ROLE_CODES, ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import {
  DEBT_GRANT_CODES,
  debtGrantScope,
  mayGrantDebt,
  mayOpenClientLedger,
  type MoneyActor,
} from '@/modules/wms/finance/scope';

/**
 * Who may let a client's cargo go on debt (0114, the owner's 2a: «sotuvchi
 * faqat o'z mijoziga, admin va buxgalter hammaga»), walked over every shipped
 * role — the answer is a property of a matrix he edits with checkboxes, so it
 * is asserted role by role, and against LITERAL expectations rather than a
 * second reading of the rule (#166).
 */

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const actorOf = (role: string, extra: string[] = []): MoneyActor => ({
  id: ME,
  permissions: new Set<string>([...(ROLE_MATRIX as Record<string, readonly string[]>)[role]!, ...extra]),
});

const own = { salesManagerId: ME };
const colleagues = { salesManagerId: OTHER };
const unowned = { salesManagerId: null };

/** role → [own client, another seller's, unowned]. */
const EXPECTED: Record<string, [boolean, boolean, boolean]> = {
  super_admin: [true, true, true],
  admin: [true, true, true],
  accountant: [true, true, true],
  sales_manager: [true, false, false],
  // Not named by the owner: no grant by default (the judge's #10).
  logist: [false, false, false],
  warehouse_manager: [false, false, false],
  warehouse_operator: [false, false, false],
  ved_manager: [false, false, false],
  viewer: [false, false, false],
};

describe('mayGrantDebt over every shipped role', () => {
  it('names every role', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ROLE_CODES].sort());
  });

  for (const [role, [mine, theirs, nobodys]] of Object.entries(EXPECTED)) {
    it(`${role}: own ${mine}, a colleague's ${theirs}, unowned ${nobodys}`, () => {
      const actor = actorOf(role);
      expect(mayGrantDebt(actor, own)).toBe(mine);
      expect(mayGrantDebt(actor, colleagues)).toBe(theirs);
      expect(mayGrantDebt(actor, unowned)).toBe(nobodys);
    });
  }

  it('the warehouse manager holds the grant and still decides nothing — he reads no ledger', () => {
    expect(ROLE_MATRIX.warehouse_manager).toContain('finance.debt_override');
    expect(debtGrantScope(actorOf('warehouse_manager'))).toBe('none');
  });

  it('a logist the owner re-ticks on /admin/roles releases for everybody (he reads every ledger)', () => {
    const logist = actorOf('logist', ['finance.debt_override']);
    expect(debtGrantScope(logist)).toBe('all');
  });

  it('a seller is scoped to his own id — never «all», never «none»', () => {
    expect(debtGrantScope(actorOf('sales_manager'))).toEqual({ ownerId: ME });
  });

  it('by construction: the grant AND the client’s ledger, for every role and client', () => {
    for (const role of ROLE_CODES) {
      for (const client of [own, colleagues, unowned]) {
        const actor = actorOf(role);
        expect(mayGrantDebt(actor, client), `${role}`).toBe(
          actor.permissions.has('finance.debt_override') && mayOpenClientLedger(actor, client),
        );
      }
    }
  });

  it('DEBT_GRANT_CODES is everything the predicate reads — the ping rebuilds holders from exactly these', () => {
    // A holder rebuilt from only these codes answers as the whole grant set
    // does, for every role: a code the predicate reads and this list lacks
    // would make the ping disagree with the decision.
    for (const role of ROLE_CODES) {
      const full = actorOf(role);
      const narrowed: MoneyActor = {
        id: ME,
        permissions: new Set([...full.permissions].filter((code) => DEBT_GRANT_CODES.includes(code))),
      };
      for (const client of [own, colleagues, unowned]) {
        expect(mayGrantDebt(narrowed, client), role).toBe(mayGrantDebt(full, client));
      }
    }
  });
});
