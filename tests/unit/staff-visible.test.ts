import { describe, expect, it } from 'vitest';
import { visibleStaff } from '@/modules/wms/staff/visible';

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
