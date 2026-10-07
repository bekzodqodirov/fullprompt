import { describe, expect, it } from 'vitest';
import { isWarehouseScoped, ROLE_CODES, ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import {
  counterDebtRelease,
  DEBT_GRANT_CODES,
  debtGrantScope,
  mayGrantDebt,
  mayOpenClientLedger,
  mayOverridePrice,
  type CounterDebtRelease,
  type DebtReleaser,
  type MoneyActor,
} from '@/modules/wms/finance/scope';
import { receivesDebtReleased } from '@/modules/wms/issue/debt-release';

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

/**
 * D2 (the owner, 2026-10-07): «sklad mudiri so'ramasdan beraversin» — the
 * counter's tick is `counterDebtRelease`, a superset of `mayGrantDebt` for the
 * warehouse manager at his own warehouse (D3a). Literal expectations, role by
 * role (#166), and the cells the design judge named (objection 1).
 */
const WH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const releaserOf = (
  roles: string[],
  opts: { add?: string[]; drop?: string[]; scoped?: boolean; warehouseIds?: string[] } = {},
): DebtReleaser => {
  const grants = new Set<string>(roles.flatMap((role) => (ROLE_MATRIX as Record<string, readonly string[]>)[role] ?? []));
  for (const code of opts.add ?? []) grants.add(code);
  for (const code of opts.drop ?? []) grants.delete(code);
  return {
    id: ME,
    permissions: grants,
    roles,
    warehouseScoped: opts.scoped ?? isWarehouseScoped(roles),
    warehouseIds: opts.warehouseIds ?? [WH_A],
  };
};

/** [own client @A, a colleague's @A, unowned @A, unowned @B] — always at a counter in A or B. */
type Cells = [CounterDebtRelease, CounterDebtRelease, CounterDebtRelease, CounterDebtRelease];
const cellsOf = (actor: DebtReleaser): Cells => [
  counterDebtRelease(actor, own, WH_A),
  counterDebtRelease(actor, colleagues, WH_A),
  counterDebtRelease(actor, unowned, WH_A),
  counterDebtRelease(actor, unowned, WH_B),
];

const COUNTER: Record<string, Cells> = {
  super_admin: ['ledger', 'ledger', 'ledger', 'ledger'],
  admin: ['ledger', 'ledger', 'ledger', 'ledger'],
  accountant: ['ledger', 'ledger', 'ledger', 'ledger'],
  sales_manager: ['ledger', null, null, null],
  // D2: his own warehouse, whoever the client — and nowhere else (D3a).
  warehouse_manager: ['warehouse', 'warehouse', 'warehouse', null],
  warehouse_operator: [null, null, null, null],
  logist: [null, null, null, null],
  ved_manager: [null, null, null, null],
  viewer: [null, null, null, null],
};

describe('counterDebtRelease over every shipped role (D2)', () => {
  it('names every role', () => {
    expect(Object.keys(COUNTER).sort()).toEqual([...ROLE_CODES].sort());
  });

  for (const [role, expected] of Object.entries(COUNTER)) {
    it(`${role}: ${expected.join(' / ')}`, () => {
      expect(cellsOf(releaserOf([role]))).toEqual(expected);
    });
  }

  it('an operator the owner gave the grant clears a PRICE and still releases no debt — the role is the rule, not the grant', () => {
    const operator = releaserOf(['warehouse_operator'], { add: ['finance.debt_override'] });
    expect(cellsOf(operator)).toEqual([null, null, null, null]);
    expect(mayOverridePrice(operator)).toBe(true);
  });

  it('a manager who is also a seller: his book everywhere, everybody else’s at his own warehouse only', () => {
    const both = releaserOf(['warehouse_manager', 'sales_manager']);
    expect(cellsOf(both)).toEqual(['ledger', 'warehouse', 'warehouse', null]);
    expect(counterDebtRelease(both, colleagues, WH_B)).toBe(null);
    // His own client at ANY counter he could stand at — the ledger answers first.
    expect(counterDebtRelease(both, own, WH_B)).toBe('ledger');
  });

  it('the owner’s OFF switch: a manager whose role lost `finance.debt_override` releases nothing', () => {
    expect(cellsOf(releaserOf(['warehouse_manager'], { drop: ['finance.debt_override'] }))).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it('fails CLOSED for a manager whose role scope was unticked — `inScope` would say yes to everywhere', () => {
    expect(cellsOf(releaserOf(['warehouse_manager'], { scoped: false }))).toEqual([null, null, null, null]);
  });

  it('a scoped manager with NO warehouse assigned releases nowhere', () => {
    expect(cellsOf(releaserOf(['warehouse_manager'], { warehouseIds: [] }))).toEqual([null, null, null, null]);
  });

  it('a seller who also packs at a warehouse gains nothing for a colleague’s client', () => {
    const packer = releaserOf(['sales_manager', 'warehouse_operator']);
    expect(counterDebtRelease(packer, colleagues, WH_A)).toBe(null);
    expect(counterDebtRelease(packer, own, WH_A)).toBe('ledger');
  });

  it('by construction: whoever `mayGrantDebt` admits, the counter admits as «ledger» — a superset', () => {
    for (const role of ROLE_CODES) {
      const actor = releaserOf([role]);
      for (const client of [own, colleagues, unowned]) {
        for (const wh of [WH_A, WH_B]) {
          if (mayGrantDebt(actor, client)) expect(counterDebtRelease(actor, client, wh), role).toBe('ledger');
        }
      }
    }
  });
});

describe('receivesDebtReleased — the owner and the accountant, with the company’s money sight (D6a)', () => {
  const person = (roles: string[], drop: string[] = []): MoneyActor & { roles: string[] } => {
    const permissions = new Set<string>(roles.flatMap((role) => (ROLE_MATRIX as Record<string, readonly string[]>)[role] ?? []));
    for (const code of drop) permissions.delete(code);
    return { id: ME, permissions, roles };
  };

  it('the two roles he named hear it', () => {
    expect(receivesDebtReleased(person(['super_admin']))).toBe(true);
    expect(receivesDebtReleased(person(['accountant']))).toBe(true);
  });

  it('a role holder whose grants lost the register’s door hears nothing — the bot must not read him what the screen refuses', () => {
    expect(receivesDebtReleased(person(['accountant'], ['finance.reports']))).toBe(false);
    expect(receivesDebtReleased(person(['super_admin'], ['finance.reports']))).toBe(false);
  });

  it('the admin (every grant, not named) and a seller hear nothing', () => {
    expect(receivesDebtReleased(person(['admin']))).toBe(false);
    expect(receivesDebtReleased(person(['sales_manager']))).toBe(false);
    expect(receivesDebtReleased(person(['warehouse_manager']))).toBe(false);
  });
});
