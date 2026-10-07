import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import {
  DEAL_TERMS_PERMISSIONS,
  DEAL_WRITE_PERMISSIONS,
  canWriteDeal,
  dealBoardShape,
  dealBoardWhose,
  mayEditDealTerms,
  type DealBoardShape,
  type DealBoardWhose,
} from '@/modules/wms/deals/door';
import { mayOffer } from '@/modules/wms/calc/upsale-scope';
import { entitySpec } from '@/modules/platform/fields/registry';
import { canWriteEntity } from '@/modules/platform/entities/service';

/**
 * The deal card's two halves (the owner's 17a, 2026-10-07), enumerated over
 * the SEEDED ROLES and a handful of invented grant sets.
 *
 * Behavioural, not a restatement of the predicates: who may open the card,
 * who may work its terms, which board they get and whether its custom fields
 * write — the exclusion that matters («the VED reads the card and works its
 * positions, never its terms») is a property of a matrix the owner edits with
 * checkboxes, so the honest question is «what does each of his roles get».
 */
type Grants = { id: string; permissions: { has(code: string): boolean } };
const grants = (codes: Iterable<string>): Grants => {
  const set = new Set<string>(codes);
  return { id: 'x', permissions: { has: (c: string) => set.has(c) } };
};
const actorFor = (role: RoleCode) => grants(ROLE_MATRIX[role]);

const deal = entitySpec('deal')!;
const readsFieldFiles = (a: Grants) =>
  (deal.readPermissions ?? deal.writePermissions).some((c) => a.permissions.has(c));

interface Row {
  openCard: boolean;
  terms: boolean;
  board: DealBoardShape;
  fieldsWrite: boolean;
  fieldFilesRead: boolean;
}
const NONE: Row = { openCard: false, terms: false, board: 'none', fieldsWrite: false, fieldFilesRead: false };
const SELLER: Row = { openCard: true, terms: true, board: 'full', fieldsWrite: true, fieldFilesRead: true };

const EXPECTED: Record<RoleCode, Row> = {
  // 17a: the card and its positions/prixods are his, the terms are not.
  ved_manager: { openCard: true, terms: false, board: 'ved', fieldsWrite: false, fieldFilesRead: true },
  sales_manager: SELLER,
  // The logist carries crm.leads + clients.manage — a seller by his matrix.
  logist: SELLER,
  admin: SELLER,
  super_admin: SELLER,
  // Nobody else opens a deal card at all.
  accountant: NONE,
  warehouse_manager: NONE,
  warehouse_operator: NONE,
  viewer: NONE,
};

const rowFor = (a: Grants): Row => ({
  openCard: canWriteDeal(a.permissions),
  terms: mayEditDealTerms(a.permissions),
  board: dealBoardShape(a.permissions),
  fieldsWrite: canWriteEntity(deal, a.permissions),
  fieldFilesRead: readsFieldFiles(a),
});

const INVENTED: { name: string; codes: string[]; expected: Row }[] = [
  // The VED alone, as a role built from scratch.
  { name: '{ved.docs}', codes: ['ved.docs'], expected: EXPECTED.ved_manager },
  // Both hats keep everything by construction.
  { name: '{ved.docs, crm.leads}', codes: ['ved.docs', 'crm.leads'], expected: SELLER },
  { name: '{ved.docs, clients.manage}', codes: ['ved.docs', 'clients.manage'], expected: SELLER },
  // A client-book reader with the VED hat is still the VED on a deal.
  {
    name: '{clients.view_own, ved.docs}',
    codes: ['clients.view_own', 'ved.docs'],
    expected: EXPECTED.ved_manager,
  },
  // Seeing every seller's work is not a grant to work a deal.
  { name: '{crm.leads.view_all}', codes: ['crm.leads.view_all'], expected: NONE },
];

describe('the deal card, by seeded role (17a)', () => {
  it('answers for every seeded role — the VED reads and works positions, never terms', () => {
    for (const role of Object.keys(EXPECTED) as RoleCode[]) {
      expect(rowFor(actorFor(role)), role).toEqual(EXPECTED[role]);
    }
  });

  it('covers every role the catalogue has — a new one cannot arrive unanswered', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(ROLE_MATRIX).sort());
  });

  it('answers for invented grant sets the owner could build with checkboxes', () => {
    for (const set of INVENTED) {
      expect(rowFor(grants(set.codes)), set.name).toEqual(set.expected);
    }
  });
});

describe('the invariants', () => {
  it('the terms grant can never open a card the work grant cannot', () => {
    for (const code of DEAL_TERMS_PERMISSIONS) {
      expect(DEAL_WRITE_PERMISSIONS as readonly string[]).toContain(code);
    }
  });

  it('quoting a customer IS a deal’s terms — the seller’s pair has one meaning', () => {
    // Below `finance.reports` (law 4's «all» — the owner, the admins and the
    // accountant, who READ every price without being sellers) the two answers
    // are one: whoever may quote may work a deal's terms and nobody else. The
    // accountant is the one seeded role where they part, and only upward.
    const everyone = [
      ...(Object.keys(ROLE_MATRIX) as RoleCode[]).map((role) => ({ name: role, a: actorFor(role) })),
      ...INVENTED.map((set) => ({ name: set.name, a: grants(set.codes) })),
    ];
    for (const { name, a } of everyone) {
      if (mayEditDealTerms(a.permissions)) expect(mayOffer(a), name).toBe(true);
      if (!a.permissions.has('finance.reports')) {
        expect(mayOffer(a), name).toBe(mayEditDealTerms(a.permissions));
      }
    }
    // The part the clause above skips, said out loud rather than hidden.
    expect(mayOffer(actorFor('accountant'))).toBe(true);
    expect(mayEditDealTerms(actorFor('accountant').permissions)).toBe(false);
  });

  it('platform spells the deal spec’s two lists; they are the door’s two lists', () => {
    // platform must not import wms, so the registry writes the codes out;
    // this pins them as SETS to the one home in deals/door.ts.
    expect(new Set(deal.writePermissions)).toEqual(new Set(DEAL_TERMS_PERMISSIONS));
    expect(new Set(deal.readPermissions)).toEqual(new Set(DEAL_WRITE_PERMISSIONS));
  });
});

describe('whose work the board draws (the review’s DEAL17-2)', () => {
  // A URL asking for everything at once: «Hammasi» AND a colleague.
  const COLLEAGUE = '0f6b1d2e-3c4a-4b5c-8d6e-7f8091a2b3c4';
  const asked = { scope: 'all', hodim: COLLEAGUE };
  const OFF: DealBoardWhose = { seesAll: false, all: false, hodim: '' };
  const ON: DealBoardWhose = { seesAll: true, all: true, hodim: COLLEAGUE };

  const WHOSE: Record<RoleCode, DealBoardWhose> = {
    // His slice is the work set: no «whose» to pick, nothing honoured.
    ved_manager: OFF,
    // A seller sees his own; a pasted «Hammasi» is ignored like `hodim`.
    sales_manager: OFF,
    logist: ON,
    admin: ON,
    super_admin: ON,
    accountant: OFF,
    warehouse_manager: OFF,
    warehouse_operator: OFF,
    viewer: OFF,
  };

  it('answers for every seeded role', () => {
    for (const role of Object.keys(WHOSE) as RoleCode[]) {
      expect(dealBoardWhose(actorFor(role).permissions, asked), role).toEqual(WHOSE[role]);
    }
    expect(Object.keys(WHOSE).sort()).toEqual(Object.keys(ROLE_MATRIX).sort());
  });

  it('the VED hat with view_all and no seller grant still gets his slice, not a picker', () => {
    // Two roles, or one checkbox on /admin/roles: the board is the VED's
    // (`dealBoardShape` says so) and view_all widens the FUNNEL only.
    const both = grants(['ved.docs', 'crm.leads.view_all']);
    expect(dealBoardShape(both.permissions)).toBe('ved');
    expect(dealBoardWhose(both.permissions, asked)).toEqual(OFF);
    const withBook = grants(['ved.docs', 'clients.view_own', 'crm.leads.view_all']);
    expect(dealBoardWhose(withBook.permissions, asked)).toEqual(OFF);
    // The moment he is a seller too, the funnel and its «whose» are his.
    const seller = grants(['ved.docs', 'crm.leads', 'crm.leads.view_all']);
    expect(dealBoardWhose(seller.permissions, asked)).toEqual(ON);
  });

  it('a view_all holder starts on his own, and a malformed colleague is dropped', () => {
    const admin = actorFor('admin').permissions;
    expect(dealBoardWhose(admin, {})).toEqual({ seesAll: true, all: false, hodim: '' });
    expect(dealBoardWhose(admin, { scope: 'mine', hodim: 'not-a-uuid' })).toEqual({
      seesAll: true,
      all: false,
      hodim: '',
    });
    // uuid-SHAPED is not a uuid: 36 characters of hex and dashes that postgres
    // refuses with 22P02 — the board's 500, not a dropped filter.
    expect(dealBoardWhose(admin, { hodim: 'aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaa' }).hodim).toBe('');
    // A real one, in either case, is honoured.
    expect(dealBoardWhose(admin, { hodim: COLLEAGUE.toUpperCase() }).hodim).toBe(COLLEAGUE.toUpperCase());
  });
});
