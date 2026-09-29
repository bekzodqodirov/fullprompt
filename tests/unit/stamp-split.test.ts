import { describe, expect, it } from 'vitest';
import {
  apportionCents,
  attributeRow,
  centsOf,
  foldParts,
  namedCargo,
  needsFallback,
  roundPreservingTotal,
  unitsOf,
  type CargoLookup,
  type CargoShare,
  type LedgerRow,
  type SellerKey,
} from '@/modules/wms/staff/stamp-split';

/**
 * WHOSE revenue a price is (4a, his «a) yuk kelgan kundagi sotuvchiga»): the
 * branching and the arithmetic of `staff/stamp-split.ts`, with literals. The
 * SQL that feeds it is pinned by stamp-profit.integration; this file pins the
 * rules — the most specific cargo a row names, batch beats deal, the fallback
 * to the client's newest prixod before the book, and a split in which no cent
 * is invented, lost, or credited to a carton worth $0.
 */

const s = (sellerId: SellerKey, m3u: number, kgu: number, n = 1, noM3 = 0, noKg = 0): CargoShare => ({
  sellerId,
  m3u,
  kgu,
  n,
  noM3,
  noKg,
});

const sum = (parts: readonly { cents: number }[]) => parts.reduce((t, p) => t + p.cents, 0);
const bySeller = (parts: readonly { sellerId: SellerKey; cents: number }[]) =>
  Object.fromEntries(parts.map((p) => [p.sellerId ?? '—', p.cents]));

describe('apportionCents', () => {
  it('splits by m³, to the cent', () => {
    const out = apportionCents(10000, [s('a', 2e6, 20e6), s('b', 1e6, 10e6)]);
    expect(bySeller(out)).toEqual({ a: 6667, b: 3333 });
    expect(sum(out)).toBe(10000);
  });

  it('three equal shares: the extra cent goes by seller id', () => {
    const out = apportionCents(100, [s('b', 1e6, 1e6), s('a', 1e6, 1e6), s('c', 1e6, 1e6)]);
    expect(bySeller(out)).toEqual({ a: 34, b: 33, c: 33 });
  });

  it('«—» is last on a tie', () => {
    const out = apportionCents(100, [s(null, 1e6, 1e6), s('a', 1e6, 1e6), s('b', 1e6, 1e6)]);
    expect(bySeller(out)).toEqual({ a: 34, b: 33, '—': 33 });
  });

  it('a rider with no m³ is never $0: kg is the basis every carton carries', () => {
    const out = apportionCents(400, [s('a', 1e6, 10e6), s('b', 0, 30e6, 1, 1, 0)]);
    expect(bySeller(out)).toEqual({ a: 100, b: 300 });
  });

  it('m³ and kg both missing somewhere → the carton count', () => {
    const out = apportionCents(400, [s('a', 0, 0, 1, 1, 1), s('b', 3e6, 3e6, 3)]);
    expect(bySeller(out)).toEqual({ a: 100, b: 300 });
  });

  it('the same seller twice is merged; a single seller takes everything', () => {
    expect(apportionCents(999, [s('a', 1e6, 1e6), s('a', 2e6, 2e6, 2)])).toEqual([{ sellerId: 'a', cents: 999 }]);
    const out = apportionCents(300, [s('a', 1e6, 1e6), s('b', 1e6, 1e6), s('a', 1e6, 1e6)]);
    expect(out).toHaveLength(2);
    expect(bySeller(out)).toEqual({ a: 200, b: 100 });
  });

  it('a negative row splits with its sign, and zero gives zeros (never -0)', () => {
    const out = apportionCents(-100, [s('a', 1e6, 1e6), s('b', 1e6, 1e6), s('c', 1e6, 1e6)]);
    expect(bySeller(out)).toEqual({ a: -34, b: -33, c: -33 });
    const zero = apportionCents(0, [s('a', 1e6, 1e6), s('b', 2e6, 2e6)]);
    expect(zero).toEqual([
      { sellerId: 'a', cents: 0 },
      { sellerId: 'b', cents: 0 },
    ]);
    for (const p of zero) expect(Object.is(p.cents, -0)).toBe(false);
  });

  it('property: no cent is invented or lost over 200 generated rows', () => {
    // A seeded LCG so a failure is reproducible.
    let seed = 20260929;
    const rnd = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    const perCarton = [333_333, 666_667, 1_000_000, 250_000, 1];
    for (let c = 0; c < 200; c += 1) {
      const cents = Math.floor(rnd() * 1e10) * (rnd() < 0.2 ? -1 : 1);
      const k = 1 + Math.floor(rnd() * 8);
      const shares: CargoShare[] = [];
      for (let i = 0; i < k; i += 1) {
        const n = 1 + Math.floor(rnd() * 5);
        const unmeasured = rnd() < 0.2;
        const m3u = unmeasured ? 0 : n * perCarton[Math.floor(rnd() * perCarton.length)]!;
        const kgu = n * (1 + Math.floor(rnd() * 50_000_000));
        shares.push(s(rnd() < 0.15 ? null : `s${Math.floor(rnd() * 6)}`, m3u, kgu, n, unmeasured ? n : 0, 0));
      }
      const out = apportionCents(cents, shares);
      expect(sum(out)).toBe(cents);
      for (const p of out) expect(Math.abs(p.cents)).toBeLessThanOrEqual(Math.abs(cents));
    }
  });

  it('no shares is a throw, never a silent $0', () => {
    expect(() => apportionCents(100, [])).toThrow('stamp_split_empty');
  });
});

describe('roundPreservingTotal', () => {
  it('the cents left go by the largest remainder, so the client sums to its own row', () => {
    const out = roundPreservingTotal(
      [
        { sellerId: 'A', units: 100045 },
        { sellerId: 'B', units: 100035 },
      ],
      centsOf('20.0080'),
    );
    expect(centsOf('20.0080')).toBe(2001);
    expect(out).toEqual([
      { sellerId: 'A', cents: 1001 },
      { sellerId: 'B', cents: 1000 },
    ]);
  });

  it('a target that cannot be the parts’ own rounding is a throw', () => {
    const parts = [
      { sellerId: 'A', units: 100045 },
      { sellerId: 'B', units: 100035 },
    ];
    expect(() => roundPreservingTotal(parts, 1999)).toThrow('stamp_cost_reconcile');
    expect(() => roundPreservingTotal(parts, 2003)).toThrow('stamp_cost_reconcile');
  });
});

describe('unitsOf', () => {
  it('reads exact decimal text into integer units, never rounding', () => {
    expect(unitsOf('123.4567', 4)).toBe(1234567);
    expect(unitsOf('5', 4)).toBe(50000);
    expect(unitsOf('-0.0012', 4)).toBe(-12);
    expect(unitsOf('756.67', 2)).toBe(75667);
    expect(unitsOf('-25.00', 2)).toBe(-2500);
  });

  it('a digit past the scale, or not a number, is a throw', () => {
    expect(() => unitsOf('1.00001', 4)).toThrow();
    expect(() => unitsOf('1.005', 2)).toThrow();
    expect(() => unitsOf('abc', 2)).toThrow();
  });
});

describe('attributeRow', () => {
  const row = (over: Partial<LedgerRow>): LedgerRow => ({
    id: 't1',
    clientId: 'c1',
    txDate: '2018-08-15',
    cents: 10000,
    receiptId: null,
    receiptSellerId: null,
    batchId: null,
    dealId: null,
    bookSellerId: 'BOOK',
    ...over,
  });
  const lookup = (over: {
    truck?: Record<string, CargoShare[]>;
    deal?: Record<string, CargoShare[]>;
    last?: SellerKey | undefined;
  }): CargoLookup => ({
    truck: (batchId, clientId) => over.truck?.[`${batchId}|${clientId}`],
    deal: (dealId, clientId) => over.deal?.[`${dealId}|${clientId}`],
    // Answers only for the row's own client and day — a lookup that ignored its
    // arguments would pass a caller that asks about the wrong client.
    lastPrixod: (clientId, txDate) =>
      clientId === 'c1' && txDate === '2018-08-15' && 'last' in over && over.last !== undefined
        ? { sellerId: over.last }
        : undefined,
  });

  it('a row that names a prixod is that prixod’s, whatever its deal says', () => {
    const r = row({ receiptId: 'r7', receiptSellerId: 'B', dealId: 'd1', cents: -2500 });
    const cargo = lookup({ deal: { 'd1|c1': [s('A', 1e6, 1e6), s('B', 1e6, 1e6)] } });
    expect(attributeRow(r, cargo)).toEqual([
      { txId: 't1', clientId: 'c1', sellerId: 'B', cents: -2500, via: 'receipt', split: false },
    ]);
    expect(needsFallback(r, cargo)).toBe(false);
  });

  it('a truck price names the riders — one stamp, no split', () => {
    const r = row({ batchId: 'T1' });
    const cargo = lookup({ truck: { 'T1|c1': [s('A', 1e6, 1e6)] } });
    expect(attributeRow(r, cargo)).toEqual([
      { txId: 't1', clientId: 'c1', sellerId: 'A', cents: 10000, via: 'truck', split: false },
    ]);
  });

  it('a truck price over two stamps is split, and folded as one split charge', () => {
    const r = row({ batchId: 'T2' });
    const cargo = lookup({ truck: { 'T2|c1': [s('A', 2e6, 1e6), s('B', 1e6, 1e6)] } });
    const parts = attributeRow(r, cargo);
    expect(parts.map((p) => [p.sellerId, p.cents, p.via, p.split])).toEqual([
      ['A', 6667, 'truck', true],
      ['B', 3333, 'truck', true],
    ]);
    expect(foldParts(parts).split).toEqual({ charges: 1, cents: 10000 });
  });

  it('a truck whose riders are not this client’s names nothing → the latest prixod', () => {
    const r = row({ batchId: 'T1' });
    const cargo = lookup({ truck: { 'T1|other': [s('A', 1e6, 1e6)] }, last: 'L' });
    expect(namedCargo(r, cargo)).toBeNull();
    expect(needsFallback(r, cargo)).toBe(true);
    expect(attributeRow(r, cargo)[0]).toMatchObject({ sellerId: 'L', via: 'lastPrixod' });
  });

  it('an empty rider list names nothing either', () => {
    const r = row({ batchId: 'T1' });
    const cargo = lookup({ truck: { 'T1|c1': [] }, last: 'L' });
    expect(needsFallback(r, cargo)).toBe(true);
  });

  it('batch beats deal: a truck with no cargo of this client never falls through to its deal', () => {
    const r = row({ batchId: 'T4', dealId: 'dA' });
    const withLast = lookup({ deal: { 'dA|c1': [s('A', 1e6, 1e6)] }, last: 'B' });
    expect(attributeRow(r, withLast)[0]).toMatchObject({ sellerId: 'B', via: 'lastPrixod' });
    const noLast = lookup({ deal: { 'dA|c1': [s('A', 1e6, 1e6)] }, last: undefined });
    expect(attributeRow(r, noLast)[0]).toMatchObject({ sellerId: 'BOOK', via: 'book' });
  });

  it('a job’s price names the job’s prixods; a job with none falls back', () => {
    const r = row({ dealId: 'dA' });
    expect(attributeRow(r, lookup({ deal: { 'dA|c1': [s('A', 1e6, 1e6)] } }))[0]).toMatchObject({
      sellerId: 'A',
      via: 'deal',
    });
    const empty = lookup({ last: 'L' });
    expect(needsFallback(r, empty)).toBe(true);
    expect(attributeRow(r, empty)[0]).toMatchObject({ sellerId: 'L', via: 'lastPrixod' });
  });

  it('a card price goes to the client’s newest prixod by that day (4a), not the book', () => {
    const r = row({ bookSellerId: 'B' });
    expect(attributeRow(r, lookup({ last: 'A' }))[0]).toMatchObject({ sellerId: 'A', via: 'lastPrixod' });
  });

  it('only a client with no prixod by then follows the book — and a bookless one is «—»', () => {
    expect(attributeRow(row({ bookSellerId: 'B' }), lookup({}))[0]).toMatchObject({ sellerId: 'B', via: 'book' });
    expect(attributeRow(row({ bookSellerId: null }), lookup({}))[0]).toMatchObject({ sellerId: null, via: 'book' });
  });

  it('a prixod stamped by nobody lends «—», never the book', () => {
    expect(attributeRow(row({ bookSellerId: 'B' }), lookup({ last: null }))[0]).toMatchObject({
      sellerId: null,
      via: 'lastPrixod',
    });
  });
});

describe('foldParts', () => {
  it('counts distinct charges and sums the unlinked and split cents per row', () => {
    const folded = foldParts([
      { txId: 'x', clientId: 'c1', sellerId: 'A', cents: 600, via: 'truck', split: true },
      { txId: 'x', clientId: 'c1', sellerId: 'B', cents: 400, via: 'truck', split: true },
      { txId: 'y', clientId: 'c1', sellerId: 'A', cents: 50, via: 'lastPrixod', split: false },
      { txId: 'z', clientId: 'c0', sellerId: null, cents: 70, via: 'book', split: false },
      { txId: 'w', clientId: 'c1', sellerId: 'A', cents: -25, via: 'receipt', split: false },
    ]);
    expect(folded.rows).toEqual([
      { clientId: 'c0', sellerId: null, cents: 70, unlinkedCents: 70, splitCents: 0 },
      { clientId: 'c1', sellerId: 'A', cents: 625, unlinkedCents: 50, splitCents: 600 },
      { clientId: 'c1', sellerId: 'B', cents: 400, unlinkedCents: 0, splitCents: 400 },
    ]);
    expect(folded.unlinked).toEqual({ charges: 2, cents: 120 });
    expect(folded.split).toEqual({ charges: 1, cents: 1000 });
  });
});
