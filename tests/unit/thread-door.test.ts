import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import { lentaReaderOf, threadDoorOf, type ThreadCard } from '@/modules/wms/crm/thread-door';

/**
 * The staff thread's ONE door (0127), over EVERY seeded role — because who
 * reads a thread is a property of a matrix the owner edits with checkboxes
 * (#170), so it is measured on that matrix, not on a hand-made actor.
 *
 * Six cards: the reader's own lead, a colleague's lead, a colleague's lead
 * that carries a calculation, a plain deal, a deal with a calculation, and a
 * client. The expectation is the spec's sentence for each role.
 */

const ME = '00000000-0000-4000-8000-000000000001';
const COLLEAGUE = '00000000-0000-4000-8000-000000000002';

const CARDS: Record<string, ThreadCard> = {
  ownLead: { kind: 'lead', ownerId: ME, calcCard: false },
  colleagueLead: { kind: 'lead', ownerId: COLLEAGUE, calcCard: false },
  calcLead: { kind: 'lead', ownerId: COLLEAGUE, calcCard: true },
  deal: { kind: 'deal', calcCard: false },
  calcDeal: { kind: 'deal', calcCard: true },
  client: { kind: 'client' },
};

const actor = (role: RoleCode) => ({ id: ME, permissions: new Set<string>(ROLE_MATRIX[role]) });
const row = (role: RoleCode) =>
  Object.fromEntries(Object.entries(CARDS).map(([name, card]) => [name, threadDoorOf(actor(role), card)]));

const none = { ownLead: false, colleagueLead: false, calcLead: false, deal: false, calcDeal: false, client: false };
const all = { ownLead: true, colleagueLead: true, calcLead: true, deal: true, calcDeal: true, client: true };

describe('the thread door over every seeded role', () => {
  it('the seller reads his own lead, every deal and every client — never a colleague’s lead (E9 a)', () => {
    expect(row('sales_manager')).toEqual({ ...all, colleagueLead: false, calcLead: false });
  });

  it('the logist (the whole funnel + the client book) and the admins read every thread', () => {
    expect(row('logist')).toEqual(all);
    expect(row('admin')).toEqual(all);
    expect(row('super_admin')).toEqual(all);
  });

  it('the VED reads only a lead or deal that carries a calculation — never a plain card, never a client', () => {
    expect(row('ved_manager')).toEqual({ ...none, calcLead: true, calcDeal: true });
  });

  it('the warehouse roles, the accountant and the viewer read none', () => {
    for (const role of ['warehouse_manager', 'warehouse_operator', 'accountant', 'viewer'] as RoleCode[]) {
      expect(row(role), role).toEqual(none);
    }
  });

  it('a both-hats seller who also calculates reads a colleague’s CALC lead (the karta draws him its box)', () => {
    const both = { id: ME, permissions: new Set<string>(['crm.leads', 'ved.docs']) };
    expect(threadDoorOf(both, CARDS.calcLead!)).toBe(true);
    expect(threadDoorOf(both, CARDS.colleagueLead!)).toBe(false);
  });
});

describe('the lenta gate lives in the door (#513)', () => {
  it('the deal arm IS the lenta’s gate — for every role, on both kinds of deal', () => {
    for (const role of Object.keys(ROLE_MATRIX) as RoleCode[]) {
      for (const calcCard of [false, true]) {
        expect(threadDoorOf(actor(role), { kind: 'deal', calcCard }), `${role} ${calcCard}`).toBe(
          lentaReaderOf(actor(role), { calcCard }) !== null,
        );
      }
    }
  });

  it('the VED reads the lenta through the calc arm only, and the CRM grant is never «viaCalc»', () => {
    expect(lentaReaderOf(actor('ved_manager'), { calcCard: true })).toEqual({ crm: false, viaCalc: true });
    expect(lentaReaderOf(actor('ved_manager'), { calcCard: false })).toBeNull();
    expect(lentaReaderOf(actor('sales_manager'), { calcCard: true })).toEqual({ crm: true, viaCalc: false });
    expect(lentaReaderOf(actor('accountant'), { calcCard: true })).toBeNull();
  });
});
