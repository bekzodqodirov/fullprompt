import { describe, expect, it } from 'vitest';
import {
  dealCandidatesOf,
  partKeyOf,
  pricedHereReading,
  truckDealParts,
  type TruckDealPart,
} from '@/modules/wms/finance/truck-deal';

/**
 * The price table's one press (the owner, 2026-11-08, his 1a: one row per
 * deal, one «Saqlash») — decided by a pure rule built from Q8's own
 * (`truckDealDecision`), asked by the door on the pool and again inside its
 * transaction. Every refusal and the shapes it admits.
 */
const C = 'C1';
const ab = dealCandidatesOf(
  [
    { dealId: 'A', dealClientId: C },
    { dealId: 'B', dealClientId: C },
  ],
  C,
);
const abLoose = dealCandidatesOf(
  [
    { dealId: 'A', dealClientId: C },
    { dealId: 'B', dealClientId: C },
    { dealId: null, dealClientId: null },
  ],
  C,
);
const deal = (dealId: string, amount = 100): TruckDealPart => ({ choice: { kind: 'deal', dealId }, amount });
const none = (amount = 50): TruckDealPart => ({ choice: { kind: 'none' }, amount });

describe('truckDealParts — the table’s press, decided', () => {
  it('writes one part per filled row, each on its own deal, in the order posted', () => {
    expect(truckDealParts(abLoose, [deal('B', 300), deal('A', 200), none(40)], abLoose.key)).toEqual({
      ok: true,
      parts: [
        { dealId: 'B', via: 'chosen', amount: 300 },
        { dealId: 'A', via: 'chosen', amount: 200 },
        { dealId: null, via: 'none', amount: 40 },
      ],
    });
  });

  it('a partial press is a press (his 3a): one deal of two', () => {
    expect(truckDealParts(ab, [deal('A')], ab.key)).toMatchObject({ ok: true, parts: [{ dealId: 'A' }] });
  });

  it('a page drawn under another question is refused FIRST — nothing else it says is trusted', () => {
    // Even a press that would otherwise be malformed: the redraw is the answer.
    expect(truckDealParts(ab, [], 'A,B,C')).toEqual({ ok: false, code: 'deals_changed' });
    expect(truckDealParts(ab, [deal('A')], abLoose.key)).toEqual({ ok: false, code: 'deals_changed' });
  });

  it('refuses a table for a client nobody has to ask — a stale or forged post', () => {
    const sole = dealCandidatesOf([{ dealId: 'A', dealClientId: C }], C);
    expect(truckDealParts(sole, [deal('A')], sole.key)).toEqual({ ok: false, code: 'deal_choice_invalid' });
    const mixed = dealCandidatesOf(
      [
        { dealId: 'A', dealClientId: C },
        { dealId: null, dealClientId: null },
      ],
      C,
    );
    expect(truckDealParts(mixed, [deal('A'), none()], mixed.key)).toEqual({ ok: false, code: 'deal_choice_invalid' });
  });

  it('refuses an empty press in its own words', () => {
    expect(truckDealParts(ab, [], ab.key)).toEqual({ ok: false, code: 'deal_parts_empty' });
  });

  it('refuses a deal — or «bitimsiz» — posted twice, naming it', () => {
    expect(truckDealParts(ab, [deal('A'), deal('B'), deal('A', 1)], ab.key)).toEqual({
      ok: false,
      code: 'deal_part_duplicate',
      at: 'A',
    });
    expect(truckDealParts(abLoose, [none(), none(2)], abLoose.key)).toEqual({
      ok: false,
      code: 'deal_part_duplicate',
      at: 'none',
    });
  });

  it('refuses a deal whose cargo is not aboard — another client’s deal included — naming it', () => {
    expect(truckDealParts(ab, [deal('A'), deal('ELSEWHERE')], ab.key)).toEqual({
      ok: false,
      code: 'deal_not_aboard',
      at: 'ELSEWHERE',
    });
  });

  it('«bitimsiz» only for the deal-less part — never as option (a) on a deals-only truck', () => {
    expect(truckDealParts(ab, [deal('A'), none()], ab.key)).toEqual({ ok: false, code: 'deal_choice_invalid', at: 'none' });
  });

  it('`derive` is no part: a row always names its deal', () => {
    expect(truckDealParts(ab, [{ choice: { kind: 'derive' }, amount: 5 }], ab.key)).toEqual({
      ok: false,
      code: 'deal_choice_invalid',
      at: 'derive',
    });
  });

  it('names a part the way the table posts it', () => {
    expect(partKeyOf({ kind: 'deal', dealId: 'A' })).toBe('A');
    expect(partKeyOf({ kind: 'none' })).toBe('none');
  });
});

describe('pricedHereReading — the ONE «already priced here» reading', () => {
  const p = (id: string, dealId: string | null, chosenNone = false) => ({ id, dealId, usd: 10, chosenNone });

  it('sorts each live price into its deal, the chosen «bitimsiz» part, or the whole cargo', () => {
    const reading = pricedHereReading(abLoose, [
      p('1', 'A'),
      p('2', 'A'),
      p('3', null, true),
      p('4', null),
      p('5', 'GONE'),
      p('6', 'B'),
    ]);
    expect([...reading.byDeal.entries()].map(([deal, rows]) => [deal, rows.map((row) => row.id)])).toEqual([
      ['A', ['1', '2']],
      ['B', ['6']],
    ]);
    expect(reading.none.map((row) => row.id)).toEqual(['3']);
    expect(reading.whole.map((row) => row.id)).toEqual(['4', '5']);
  });

  it('a deal-less price is the «bitimsiz» part only when its audit says somebody CHOSE it — on any truck', () => {
    expect(pricedHereReading(ab, [p('1', null)])).toMatchObject({ none: [], whole: [{ id: '1' }] });
    // A chosen part whose deal-less cargo has since left the truck is still a
    // part and not the whole cargo's price (§3.1.6) — the deals keep reading
    // «narx yo'q» rather than «covered».
    expect(pricedHereReading(ab, [p('2', null, true)])).toMatchObject({ none: [{ id: '2' }], whole: [] });
  });
});
