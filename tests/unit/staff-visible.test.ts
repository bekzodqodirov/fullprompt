import { describe, expect, it } from 'vitest';
import { droppedLeavers, visibleStaff } from '@/modules/wms/staff/visible';

/**
 * Who /hodimlar lists (0120, the owner's 2b). A person who never signs in is
 * let go with «Ishdan ketdi» — and must stay on the page until the due list
 * has nothing open for them, or the last month's «To'landi» has no card to
 * sit beside. Pure, so every clause is its own case.
 */

type P = { id: string; active: boolean };
const person = (id: string, active: boolean): P => ({ id, active });

const empty = {
  hodim: null,
  owed: new Set<string>() as ReadonlySet<string> | null,
  kpiLineIds: new Set<string>(),
  payables: new Map<string, { payableUsd: number; overpaidUsd: number }>(),
  kpiFailed: false,
  kpiSellers: new Set<string>(),
};

describe('visibleStaff', () => {
  it('lists an active person and drops a leaver nobody owes', () => {
    const out = visibleStaff([person('a', true), person('b', false)], empty);
    expect(out.map((p) => p.id)).toEqual(['a']);
  });

  it('KEEPS a leaver the due list still names — a stopped template with a re-opened month included', () => {
    const out = visibleStaff([person('b', false)], { ...empty, owed: new Set(['b']) });
    expect(out.map((p) => p.id)).toEqual(['b']);
  });

  it('drops nobody when the owed read failed (null = unknown, not «nobody»)', () => {
    const out = visibleStaff([person('a', true), person('b', false), person('c', false)], { ...empty, owed: null });
    expect(out.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps a leaver with a KPI line, a payable or an overpayment', () => {
    expect(visibleStaff([person('b', false)], { ...empty, kpiLineIds: new Set(['b']) })).toHaveLength(1);
    expect(
      visibleStaff([person('b', false)], { ...empty, payables: new Map([['b', { payableUsd: 5, overpaidUsd: 0 }]]) }),
    ).toHaveLength(1);
    expect(
      visibleStaff([person('b', false)], { ...empty, payables: new Map([['b', { payableUsd: 0, overpaidUsd: 3 }]]) }),
    ).toHaveLength(1);
    expect(
      visibleStaff([person('b', false)], { ...empty, payables: new Map([['b', { payableUsd: 0, overpaidUsd: 0 }]]) }),
    ).toHaveLength(0);
  });

  it('keeps a stamped seller whose figures ran out of budget', () => {
    expect(visibleStaff([person('b', false)], { ...empty, kpiFailed: true, kpiSellers: new Set(['b']) })).toHaveLength(1);
    expect(visibleStaff([person('b', false)], { ...empty, kpiFailed: false, kpiSellers: new Set(['b']) })).toHaveLength(0);
  });

  it('?hodim= answers that ONE person whatever their state — «Qayta faollashtirish» lives there', () => {
    const people = [person('a', true), person('b', false)];
    expect(visibleStaff(people, { ...empty, hodim: 'b' }).map((p) => p.id)).toEqual(['b']);
    expect(visibleStaff(people, { ...empty, hodim: 'a' }).map((p) => p.id)).toEqual(['a']);
  });

  it('?hodim= with an unknown id answers nobody', () => {
    expect(visibleStaff([person('a', true)], { ...empty, hodim: 'zzz' })).toEqual([]);
  });
});

/**
 * «Ketganlar (N)» (0120's review, UI-2): the way back to a person who never
 * signs in and has dropped off the list. Its whole rule is three clauses —
 * each one a case.
 */
describe('droppedLeavers', () => {
  type L = { id: string; active: boolean; loginEnabled: boolean };
  const who = (id: string, active: boolean, loginEnabled: boolean): L => ({ id, active, loginEnabled });
  const people = [who('worker', true, false), who('gone', false, false), who('login-gone', false, true), who('login', true, true)];

  it('lists the no-login leaver the page no longer draws', () => {
    expect(droppedLeavers(people, new Set(['worker', 'login'])).map((p) => p.id)).toEqual(['gone']);
  });

  it('never lists a person still at work, nor a login leaver (the admin’s, on /admin/users)', () => {
    const out = droppedLeavers(people, new Set()).map((p) => p.id);
    expect(out).not.toContain('worker');
    expect(out).not.toContain('login');
    expect(out).not.toContain('login-gone');
  });

  it('never repeats a leaver the list still shows (still owed, or `?hodim=`)', () => {
    expect(droppedLeavers(people, new Set(['gone']))).toEqual([]);
  });
});
