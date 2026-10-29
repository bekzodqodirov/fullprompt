import { describe, expect, it } from 'vitest';
import { groupBySale, planWinSplit, saleIsLive, saleQuote, saleTitle, type LeadJob } from '@/modules/wms/calc/win-split';

/**
 * The win's split by sale (docs/UCH-BAND.md §7), pure. The money oracle —
 * that the moved answer stays outranked under the real fragment — is the
 * integration file's; these pin the grouping and the quotes on shapes the
 * database is slow to build.
 */
const at = (minute: number) => new Date(Date.UTC(2026, 9, 27, 9, minute));

function job(id: string, over: Partial<LeadJob> = {}): LeadJob {
  return {
    id,
    supersedes: null,
    section: 'rastamojka',
    createdAt: at(0),
    open: false,
    answerAt: null,
    answerStands: false,
    outranksAt: { answer: null, seal: null },
    seal: null,
    offer: null,
    ...over,
  };
}

const sealAt = (minute: number, stands = true, total = 1000) => ({
  at: at(minute),
  by: 'ved',
  stands,
  totalUsd: total,
  volumeM3: 30,
  weightKg: 1500,
});

const ids = (sales: LeadJob[][]) => sales.map((sale) => sale.map((j) => j.id).sort()).sort();

describe('groupBySale', () => {
  it('a correction and what it corrects are one sale', () => {
    const sales = groupBySale([job('a'), job('b', { supersedes: 'a' }), job('c')]);
    expect(ids(sales)).toEqual([['a', 'b'], ['c']]);
  });

  it('an answer that does not stand joins every job that answered or sealed after it', () => {
    const answer = job('a', { answerAt: at(10), answerStands: false, outranksAt: { answer: at(10), seal: null } });
    const laterSeal = job('b', { outranksAt: { answer: null, seal: at(20) }, seal: sealAt(20) });
    const earlierSeal = job('d', { outranksAt: { answer: null, seal: at(5) }, seal: sealAt(5) });
    const laterZeroAnswer = job('z', { outranksAt: { answer: at(30), seal: null } });
    expect(ids(groupBySale([answer, laterSeal, earlierSeal, laterZeroAnswer]))).toEqual([['a', 'b', 'z'], ['d']]);
  });

  it('a standing answer and a corrected one draw no outranked edge', () => {
    const standing = job('a', { answerAt: at(10), answerStands: true });
    const corrected = job('c', { answerAt: at(11), answerStands: false });
    const correction = job('e', { supersedes: 'c', open: true });
    const later = job('b', { outranksAt: { answer: null, seal: at(20) }, seal: sealAt(20) });
    expect(ids(groupBySale([standing, corrected, correction, later]))).toEqual([['a'], ['b'], ['c', 'e']]);
  });
});

describe('saleIsLive', () => {
  it('open, a standing seal, a standing answer — and nothing else', () => {
    expect(saleIsLive([job('a', { open: true })])).toBe(true);
    expect(saleIsLive([job('a', { seal: sealAt(1) })])).toBe(true);
    expect(saleIsLive([job('a', { answerStands: true })])).toBe(true);
    expect(saleIsLive([job('a', { seal: sealAt(1, false) }), job('b', { answerAt: at(2) })])).toBe(false);
  });
});

describe('saleQuote', () => {
  it('the later writer by the clock, and only while it stands', () => {
    const sealed = job('a', { seal: sealAt(10, true, 900) });
    expect(saleQuote([sealed])).toMatchObject({ amount: 900, volumeM3: 30, weightKg: 1500, by: 'ved' });
    const offered = job('a', {
      seal: sealAt(10, true, 900),
      offer: { at: at(20), by: 'seller', stands: true, priceUsd: 1200 },
    });
    expect(saleQuote([offered])).toMatchObject({ amount: 1200, by: 'seller', at: at(20) });
    // A writer that no longer stands opens the deal unpriced — never the floor beneath it.
    const deadOffer = job('a', { seal: sealAt(10), offer: { at: at(20), by: 's', stands: false, priceUsd: 1200 } });
    expect(saleQuote([deadOffer])).toBeNull();
    expect(saleQuote([job('a', { seal: sealAt(10, false) })])).toBeNull();
    expect(saleQuote([job('a', { open: true })])).toBeNull();
  });
});

describe('planWinSplit', () => {
  it('the writer’s sale is the main deal’s; other live sales get their own; dead history stays with the main', () => {
    const writer = job('w', { seal: sealAt(5) });
    const live = job('l', { open: true, createdAt: at(30) });
    const dead = job('x', { seal: sealAt(1, false) });
    const plan = planWinSplit([writer, live, dead], 'w');
    expect(plan.main.map((j) => j.id).sort()).toEqual(['w', 'x']);
    expect(ids(plan.own)).toEqual([['l']]);
  });

  it('with no writer the NEWEST live sale is the main deal’s', () => {
    const older = job('o', { open: true, createdAt: at(1) });
    const newer = job('n', { open: true, createdAt: at(9) });
    const plan = planWinSplit([older, newer], null);
    expect(plan.main.map((j) => j.id)).toEqual(['n']);
    expect(ids(plan.own)).toEqual([['o']]);
  });

  it('a lead with no calculation opens the main deal alone', () => {
    expect(planWinSplit([], null)).toEqual({ main: [], own: [] });
  });
});

describe('saleTitle', () => {
  it('names the sale by its oldest job’s section and the goods, or the code and the day', () => {
    const goods = new Map([['a', ['Kafel 60x60', 'Plitka']]]);
    expect(saleTitle([job('a', { createdAt: at(0) })], goods, 'GS777')).toBe('Rastamojka — Kafel 60x60 +1');
    expect(saleTitle([job('b', { createdAt: at(0) })], new Map(), 'GS777')).toBe('Rastamojka — GS777 · 27.10');
    expect(saleTitle([job('c', { section: null })], new Map(), 'GS777')).toBeNull();
  });
});
