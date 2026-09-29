import { describe, expect, it } from 'vitest';
import {
  isMixed,
  PRICE_HISTORY_CAP,
  rankPriceHistory,
  type PriceCandidate,
} from '@/modules/wms/finance/price-history';

/**
 * «📈 Oldingi narx»'s list as the icon prints it (0119, his 16a/17a/28a) —
 * the pure half. The read that finds the candidates is integration-tested
 * (`price-history.integration.test.ts`); this pins the ORDER and the
 * arithmetic a person reads.
 */
let seq = 0;
const cand = (patch: Partial<PriceCandidate>): PriceCandidate => {
  seq += 1;
  return {
    batchId: `b${String(seq).padStart(3, '0')}`,
    batchCode: `YW-${seq}`,
    departedDay: '2026-05-01',
    clientId: 'c-other',
    clientCode: 'GS1',
    own: false,
    match: 'name',
    chargeUsd: 1000,
    kg: 2000,
    m3: 10,
    goodsKinds: 1,
    cargoMoved: null,
    pastLotId: `l${seq}`,
    ...patch,
  };
};

describe('rankPriceHistory — the order a person reads', () => {
  it('own client first (16a), then the stronger match, then the newest truck', () => {
    const rows = rankPriceHistory([
      cand({ batchCode: 'other-exact-new', match: 'exact', departedDay: '2026-09-01' }),
      cand({ batchCode: 'own-name-old', own: true, match: 'name', departedDay: '2025-11-01' }),
      cand({ batchCode: 'other-code', match: 'code', departedDay: '2026-08-01' }),
      cand({ batchCode: 'own-exact-old', own: true, match: 'exact', departedDay: '2025-10-01' }),
      cand({ batchCode: 'other-exact-old', match: 'exact', departedDay: '2026-01-01' }),
    ]);
    expect(rows.map((r) => r.batchCode)).toEqual([
      'own-exact-old',
      'own-name-old',
      'other-exact-new',
      'other-exact-old',
      'other-code',
    ]);
  });

  it('five in total (28a), and the own client fills them first', () => {
    const own = Array.from({ length: 3 }, (_, i) => cand({ own: true, departedDay: `2026-0${i + 1}-01` }));
    const others = Array.from({ length: 6 }, (_, i) =>
      cand({ match: 'exact', departedDay: `2026-0${i + 1}-15` }),
    );
    const rows = rankPriceHistory([...others, ...own]);
    expect(PRICE_HISTORY_CAP).toBe(5);
    expect(rows).toHaveLength(5);
    expect(rows.slice(0, 3).every((r) => r.own)).toBe(true);
    expect(rows.slice(3).every((r) => !r.own)).toBe(true);
    // The own rows keep their own newest-first order even as the weaker match.
    expect(rows.slice(0, 3).map((r) => r.departedDay)).toEqual(['2026-03-01', '2026-02-01', '2026-01-01']);
  });

  it('a model pick ranks below every free match of the same client', () => {
    const rows = rankPriceHistory([
      cand({ batchCode: 'ai', match: 'ai', departedDay: '2026-09-20' }),
      cand({ batchCode: 'name', match: 'name', departedDay: '2026-01-01' }),
    ]);
    expect(rows.map((r) => r.batchCode)).toEqual(['name', 'ai']);
  });

  it('the price is the charge over the client\'s own load, rounded to cents', () => {
    const [row] = rankPriceHistory([cand({ chargeUsd: 1234.5, m3: 7.3, kg: 1987 })]);
    expect(row!.usdPerM3).toBe(169.11);
    expect(row!.usdPerKg).toBe(0.62);
    expect(row!.kgPerM3).toBe(272);
  });

  it('a zero divisor is «no figure», never Infinity or $0', () => {
    const [noM3] = rankPriceHistory([cand({ m3: 0, kg: 500 })]);
    expect(noM3!.usdPerM3).toBeNull();
    expect(noM3!.kgPerM3).toBeNull();
    expect(noM3!.usdPerKg).toBe(2);
    const [noKg] = rankPriceHistory([cand({ m3: 4, kg: 0 })]);
    expect(noKg!.usdPerKg).toBeNull();
    expect(noKg!.usdPerM3).toBe(250);
    for (const row of [noM3!, noKg!]) {
      for (const v of [row.usdPerM3, row.usdPerKg, row.kgPerM3]) {
        if (v !== null) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('carries the moved-cargo warning through untouched', () => {
    const [row] = rankPriceHistory([cand({ cargoMoved: 'partial' })]);
    expect(row!.cargoMoved).toBe('partial');
  });
});

describe('«aralash» (17a)', () => {
  it('only when the client had more than one kind of goods on that truck', () => {
    expect(isMixed({ goodsKinds: 2 })).toBe(true);
    expect(isMixed({ goodsKinds: 7 })).toBe(true);
    expect(isMixed({ goodsKinds: 1 })).toBe(false);
    // «we do not know» is not a blend either.
    expect(isMixed({ goodsKinds: 0 })).toBe(false);
  });
});
