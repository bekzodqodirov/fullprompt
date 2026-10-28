import { describe, expect, it } from 'vitest';
import type { BatchLot } from '@/modules/wms/batches/lots';
import { pricingView, tripPriced, tripPricedCount } from '@/modules/wms/finance/pricing-view';
import { dealCandidatesOf, shownDealChoice, truckDealDecision, unpricedDealsOf } from '@/modules/wms/finance/truck-deal';

/**
 * «Partiya moliyasi» by goods (owner, 2026-09-24, answer 1c: the price stays
 * one per client, the screen opens the client into its goods). What the
 * header prints is arithmetic over three inputs, so it is tested as that.
 */

const lot = (over: Partial<BatchLot>): BatchLot => ({
  lotId: 'L',
  letter: 'A',
  productNameZh: '货',
  productNameRu: null,
  receiptId: 'R',
  receiptNumber: 'YW-1',
  clientId: 'C1',
  clientCode: 'GS1',
  clientName: 'Bir',
  marking: null,
  dealId: null,
  dealCode: null,
  dealTitle: null,
  // A deal is the lot's own client's unless a case says otherwise.
  dealClientId: over.dealId ? (over.clientId ?? 'C1') : null,
  calcRequestId: null,
  calcLinkConfirmed: false,
  onBatch: 1,
  lotBoxCount: 1,
  kg: 10,
  m3: 0.1,
  lostCount: 0,
  missingCount: 0,
  leftBehindCount: 0,
  arrivedKg: 10,
  arrivedM3: 0.1,
  goodsPhotoId: null,
  boxPhotoId: null,
  ...over,
});

const LOTS = [
  // Client 1: two goods on the truck.
  lot({ lotId: 'a1', clientId: 'C1', onBatch: 6, lotBoxCount: 10, kg: 60, m3: 0.6 }),
  lot({ lotId: 'a2', clientId: 'C1', letter: 'B', onBatch: 2, lotBoxCount: 2, kg: 20, m3: 0.2 }),
  // Client 2: nothing priced yet.
  lot({ lotId: 'b1', clientId: 'C2', clientCode: 'GS2', clientName: 'Ikki', kg: 5, m3: 0.05 }),
  // Cargo nobody has claimed.
  lot({ lotId: 'u1', clientId: null, clientCode: null, clientName: null, marking: 'MK1' }),
];
const COST = new Map([
  // a1: 80 on this truck, 15 brought with it, 5 the Uzbek leg after it
  // added («keyingi yo'l», 2026-09-30) — the three parts of one tannarx.
  ['a1', { lotId: 'a1', totalUsd: 100, batchUsd: 80, laterUsd: 5 }],
  ['a2', { lotId: 'a2', totalUsd: 50, batchUsd: 50, laterUsd: 0 }],
  ['b1', { lotId: 'b1', totalUsd: 30, batchUsd: 30, laterUsd: 0 }],
  ['u1', { lotId: 'u1', totalUsd: 7, batchUsd: 7, laterUsd: 0 }],
]);
const CHARGES = [
  { clientId: 'C1', clientCode: 'GS1', clientName: 'Bir', type: 'charge', amountUsd: 200 },
  // A payment tagged with the truck is money RECEIVED — not a price.
  { clientId: 'C1', clientCode: 'GS1', clientName: 'Bir', type: 'payment', amountUsd: 999 },
  // A client whose cargo has left this truck, still charged on it.
  { clientId: 'C9', clientCode: 'GS9', clientName: 'Toqqiz', type: 'charge', amountUsd: 40 },
];

describe('pricingView', () => {
  const view = pricingView(LOTS, COST, CHARGES);

  it('keeps the price on the client and opens the client into its goods', () => {
    const c1 = view.clients.find((group) => group.clientId === 'C1')!;
    expect(c1.lots.map((row) => row.lotId)).toEqual(['a1', 'a2']);
    expect(c1).toMatchObject({ costUsd: 150, prevUsd: 15, laterUsd: 5, chargedUsd: 200, marginUsd: 50, boxes: 8, kg: 80 });
  });

  it('prints no margin for a client without a price', () => {
    expect(view.clients.find((group) => group.clientId === 'C2')!.marginUsd).toBeNull();
  });

  it('keeps unclaimed cargo out of every client and inside the truck’s cost', () => {
    expect(view.unclaimed).toMatchObject({ costUsd: 7 });
    expect(view.unclaimed.lots.map((row) => row.lotId)).toEqual(['u1']);
    expect(view.totals.costUsd).toBe(187);
  });

  it('counts every charge on the truck and names the ones with no cargo under them', () => {
    expect(view.orphans).toEqual([{ clientId: 'C9', code: 'GS9', name: 'Toqqiz', chargedUsd: 40 }]);
    expect(view.totals).toMatchObject({ chargedUsd: 240, marginUsd: 53, prevUsd: 15, laterUsd: 5 });
    // 0104 under his (a): the orphan's $40 is named as a PART of «Narx» —
    // still inside the 240 and the margin, printed beside them.
    expect(view.totals.noCargoUsd).toBe(40);
  });
});

/**
 * «Narx qo'yilgan N / M» (owner's 1a, 2026-09-28): a client counts as priced
 * when a price sits on this truck, OR when the unpriced rule finds their
 * cargo aboard covered elsewhere — the China truck, the deal. The coverage
 * sets are what `tripCoverageOn` returns; the integration file asks the real
 * rule for them.
 */
describe('tripPriced — the header and the page count one way', () => {
  const view = pricingView(LOTS, COST, CHARGES);
  const none = { unpriced: new Set<string>(), covered: new Set<string>() };

  it('counts a price on this truck, and nothing else, when the rule knows nothing more', () => {
    expect(tripPricedCount(view.clients, none)).toBe(1);
  });

  it('counts a client whose cargo aboard the rule calls covered — priced on another truck or the deal', () => {
    expect(tripPricedCount(view.clients, { unpriced: new Set(), covered: new Set(['C2']) })).toBe(2);
  });

  it('does not count a client covered only in part', () => {
    expect(tripPricedCount(view.clients, { unpriced: new Set(['C2']), covered: new Set(['C2']) })).toBe(1);
  });

  it('keeps a price typed on this truck counted even where the rule does not let it cover (a local leg, before departure)', () => {
    expect(tripPriced({ clientId: 'C1', chargedUsd: 200 }, { unpriced: new Set(['C1']), covered: new Set() })).toBe(true);
  });

  it('leaves the charge-only count behind — no header can read the old way', () => {
    expect('priced' in view.totals).toBe(false);
  });
});

/**
 * R3a (owner, 2026-09-24: «mashinada qo'yilgan narx bitimga ham yozilsin»)
 * and his Q8 «c» (2026-10-27: «logist o'zi tanlaydi»): a truck price is the
 * deal's money by itself when the client's cargo aboard is ONE deal's and
 * nothing else, and the person's CHOICE when two or more of his deals ride
 * the truck. The page, the ledger and the price door fold the same rows
 * through the same function, so the question drawn and the answer written
 * cannot disagree.
 */
describe('dealCandidatesOf', () => {
  const own = (dealId: string | null) => ({ dealId, dealClientId: dealId ? 'C1' : null });

  it('names the deal when every lot aboard is that one deal — derived, nobody is asked', () => {
    expect(dealCandidatesOf([own('D1'), own('D1')], 'C1')).toEqual({
      deals: ['D1'],
      none: false,
      sole: 'D1',
      ambiguous: false,
      key: 'D1',
    });
  });

  it('asks for two deals — the person chooses (his «c»); nothing is derived', () => {
    const got = dealCandidatesOf([own('D2'), own('D1')], 'C1');
    expect(got).toMatchObject({ deals: ['D1', 'D2'], none: false, sole: null, ambiguous: true });
    // Sorted, so the page and the door spell the question alike.
    expect(got.key).toBe('D1,D2');
  });

  it('names nothing for deal cargo beside deal-less cargo, and does not ask — that price would ride onto the deal', () => {
    for (const rows of [[own('D1'), own(null)], [own(null), own('D1')]]) {
      expect(dealCandidatesOf(rows, 'C1')).toMatchObject({ sole: null, ambiguous: false, none: true, key: 'D1|none' });
    }
  });

  it('offers «bitimsiz» beside two deals when part of the cargo has none', () => {
    expect(dealCandidatesOf([own('D1'), own('D2'), own(null)], 'C1')).toMatchObject({
      ambiguous: true,
      none: true,
      key: 'D1,D2|none',
    });
  });

  it('reads another client’s deal as no deal — no price may reach somebody else’s job', () => {
    const foreign = { dealId: 'F', dealClientId: 'C9' };
    expect(dealCandidatesOf([foreign], 'C1')).toMatchObject({ deals: [], sole: null, none: true, ambiguous: false });
    expect(dealCandidatesOf([own('D1'), foreign], 'C1')).toMatchObject({ deals: ['D1'], sole: null, ambiguous: false });
    expect(dealCandidatesOf([own('D1'), own('D2'), foreign], 'C1').key).toBe('D1,D2|none');
  });

  it('names nothing with no cargo, or no deal at all — and the key is never empty for cargo aboard', () => {
    expect(dealCandidatesOf([], 'C1')).toMatchObject({ sole: null, ambiguous: false });
    // The action reads `dealsSeen || undefined`: an empty key for cargo
    // aboard would read as «not posted» and switch the stale check off.
    expect(dealCandidatesOf([own(null)], 'C1').key).toBe('|none');
  });

  it('puts the deal on the client group, so the screen says where the price goes', () => {
    const view = pricingView(
      [
        lot({ lotId: 'd1', clientId: 'C1', dealId: 'D1', dealCode: 'B-00001' }),
        lot({ lotId: 'd2', clientId: 'C1', letter: 'B', dealId: 'D1', dealCode: 'B-00001' }),
        lot({ lotId: 'e1', clientId: 'C2', clientCode: 'GS2', dealId: 'D2', dealCode: 'B-00002' }),
        lot({ lotId: 'e2', clientId: 'C2', clientCode: 'GS2', letter: 'B', dealId: null }),
      ],
      new Map(),
      [],
    );
    expect(view.clients.find((group) => group.clientId === 'C1')).toMatchObject({
      dealId: 'D1',
      dealCode: 'B-00001',
    });
    expect(view.clients.find((group) => group.clientId === 'C2')).toMatchObject({
      dealId: null,
      dealCode: null,
    });
  });
});

describe('truckDealDecision — the one rule every door writes a truck price through', () => {
  const two = dealCandidatesOf(
    [
      { dealId: 'D1', dealClientId: 'C1' },
      { dealId: 'D2', dealClientId: 'C1' },
    ],
    'C1',
  );
  const twoAndNone = dealCandidatesOf(
    [
      { dealId: 'D1', dealClientId: 'C1' },
      { dealId: 'D2', dealClientId: 'C1' },
      { dealId: null, dealClientId: null },
    ],
    'C1',
  );
  const sole = dealCandidatesOf([{ dealId: 'D1', dealClientId: 'C1' }], 'C1');
  const mixed = dealCandidatesOf(
    [
      { dealId: 'D1', dealClientId: 'C1' },
      { dealId: null, dealClientId: null },
    ],
    'C1',
  );
  const derive = { kind: 'derive' } as const;
  const none = { kind: 'none' } as const;
  const deal = (dealId: string) => ({ kind: 'deal', dealId }) as const;

  it('writes the chosen deal on a two-deal truck', () => {
    expect(truckDealDecision(two, deal('D2'), two.key)).toEqual({ ok: true, dealId: 'D2', via: 'chosen' });
  });

  it('refuses a two-deal price with no choice — at every door, with or without the form’s key', () => {
    expect(truckDealDecision(two, derive, two.key)).toEqual({ ok: false, code: 'deal_choice_required' });
    expect(truckDealDecision(two, derive, undefined)).toEqual({ ok: false, code: 'deal_choice_required' });
  });

  it('refuses a page drawn before the cargo moved — never answers the old question', () => {
    expect(truckDealDecision(two, deal('D1'), 'D1')).toEqual({ ok: false, code: 'deals_changed' });
    expect(truckDealDecision(sole, derive, 'D1,D2')).toEqual({ ok: false, code: 'deals_changed' });
  });

  it('refuses a deal whose cargo is not aboard', () => {
    expect(truckDealDecision(two, deal('D9'), undefined)).toEqual({ ok: false, code: 'deal_not_aboard' });
  });

  it('«bitimsiz» only for the deal-less part of a two-deal client — never as option (a) on a deals-only truck', () => {
    expect(truckDealDecision(twoAndNone, none, twoAndNone.key)).toEqual({ ok: true, dealId: null, via: 'none' });
    expect(truckDealDecision(two, none, two.key)).toEqual({ ok: false, code: 'deal_choice_invalid' });
    expect(truckDealDecision(sole, none, sole.key)).toEqual({ ok: false, code: 'deal_choice_invalid' });
  });

  it('derives R3a exactly as before when nobody has to choose', () => {
    expect(truckDealDecision(sole, derive, sole.key)).toEqual({ ok: true, dealId: 'D1', via: 'derived' });
    expect(truckDealDecision(mixed, derive, undefined)).toEqual({ ok: true, dealId: null, via: 'derived' });
    // The one deal named by hand on that same truck: its own deal is fine…
    expect(truckDealDecision(sole, deal('D1'), undefined)).toEqual({ ok: true, dealId: 'D1', via: 'chosen' });
    // …but deal cargo beside deal-less cargo names no deal, typed or not.
    expect(truckDealDecision(mixed, deal('D1'), undefined)).toEqual({ ok: false, code: 'deal_choice_invalid' });
  });
});

describe('shownDealChoice — a stale choice is shown blank, never as the first deal', () => {
  it('shows the choice only under the question it was made for, and only while it is an option', () => {
    const options = ['D1', 'D2', 'none'];
    expect(shownDealChoice({ deal: 'D2', seen: 'D1,D2|none' }, 'D1,D2|none', options)).toBe('D2');
    // The page redrew a different question: asked again.
    expect(shownDealChoice({ deal: 'D2', seen: 'D1,D2' }, 'D1,D2|none', options)).toBe('');
    // The option is gone.
    expect(shownDealChoice({ deal: 'D3', seen: 'D1,D2|none' }, 'D1,D2|none', options)).toBe('');
    expect(shownDealChoice(null, 'D1,D2', options)).toBe('');
  });
});

describe('unpricedDealsOf — what «Bu mashinadagi narxlar» says about a deal with no price here', () => {
  const ab = dealCandidatesOf(
    [
      { dealId: 'A', dealClientId: 'C1' },
      { dealId: 'B', dealClientId: 'C1' },
    ],
    'C1',
  );
  const abLoose = dealCandidatesOf(
    [
      { dealId: 'A', dealClientId: 'C1' },
      { dealId: 'B', dealClientId: 'C1' },
      { dealId: null, dealClientId: null },
    ],
    'C1',
  );
  const noCard = () => false;

  it('quiet before any price, loud once the client has one here and this deal does not', () => {
    expect(unpricedDealsOf(ab, [], noCard)).toEqual([
      { dealId: 'A', why: 'missing', loud: false },
      { dealId: 'B', why: 'missing', loud: false },
    ]);
    expect(unpricedDealsOf(ab, [{ dealId: 'B' }], noCard)).toEqual([{ dealId: 'A', why: 'missing', loud: true }]);
  });

  it('a no-deal price on a deals-only truck is a WHOLE-cargo price: both deals are covered, said muted (review)', () => {
    expect(unpricedDealsOf(ab, [{ dealId: null }], noCard)).toEqual([
      { dealId: 'A', why: 'whole', loud: false },
      { dealId: 'B', why: 'whole', loud: false },
    ]);
  });

  it('a chosen «bitimsiz» part beside deal-less cargo covers no deal’s part', () => {
    expect(unpricedDealsOf(abLoose, [{ dealId: null }], noCard)).toEqual([
      { dealId: 'A', why: 'missing', loud: true },
      { dealId: 'B', why: 'missing', loud: true },
    ]);
  });

  it('a deal with its own price off any truck is covered by it — never «narx yo’q»', () => {
    expect(unpricedDealsOf(ab, [{ dealId: 'B' }], (dealId) => dealId === 'A')).toEqual([
      { dealId: 'A', why: 'card', loud: false },
    ]);
  });

  it('asks nothing of a client nobody asks', () => {
    expect(unpricedDealsOf(dealCandidatesOf([{ dealId: 'A', dealClientId: 'C1' }], 'C1'), [], noCard)).toEqual([]);
  });
});
