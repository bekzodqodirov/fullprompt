import { describe, expect, it } from 'vitest';
import { mixedTotalsFor, type LotFigures } from '@/modules/wms/receipts/grow-lot';

/**
 * A mixed lot's count walk is exact (docs/PRIXOD-JAVOBLAR.md §1.10).
 *
 * The lot below is a real case of the old arithmetic: 7 cartons, 40.714 kg,
 * grown to 13 in one press and taken back one carton a press. Scaling the
 * CURRENT totals at every step kept every rounding and landed on 40.716 kg —
 * a figure a list prints as 40.72, where the client had confirmed 40.71. The
 * old rule is restated here only as the oracle of that defect: the walk from
 * the BASE must never reproduce it.
 */
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

/** The arithmetic `growLotInTx` / `shrinkGrownInTx` used before 0147 — scale what is stored now. */
function oldWalk(start: LotFigures, path: number[]): LotFigures {
  let { boxCount, totalWeightKg, totalVolumeM3 } = start;
  for (const n of path) {
    totalWeightKg = r3((totalWeightKg * n) / boxCount);
    totalVolumeM3 = r4((totalVolumeM3 * n) / boxCount);
    boxCount = n;
  }
  return { boxCount, totalWeightKg, totalVolumeM3 };
}

const BASE: LotFigures = { boxCount: 7, totalWeightKg: 40.714, totalVolumeM3: 0.314 };
const TAKE_BACK = [13, 12, 11, 10, 9, 8, 7];

describe('a mixed lot walked from its base', () => {
  it('the old arithmetic drifted on this very lot (the defect the walk exists for)', () => {
    expect(oldWalk(BASE, TAKE_BACK).totalWeightKg).toBe(40.716);
  });

  it('an intermediate count is the base scaled once — never a chain of roundings', () => {
    // 7 → 13 → 12 → 11 → 10 by the old rule is a chain of four roundings and
    // ends at 58.164 kg; 7 → 8 → 9 → 10 ends at 58.162 — two routes, two
    // weights. From the base it is one rounding, whatever the route.
    expect(mixedTotalsFor(BASE, 10)).toEqual({ totalWeightKg: r3((40.714 * 10) / 7), totalVolumeM3: r4((0.314 * 10) / 7) });
    expect(oldWalk(BASE, [13, 12, 11, 10]).totalWeightKg).toBe(58.164);
    expect(oldWalk(BASE, [8, 9, 10]).totalWeightKg).toBe(58.162);
    expect(mixedTotalsFor(BASE, 10).totalWeightKg).toBe(58.163);
  });

  it('the base’s own count is the base — the one rounding gives back what was stored', () => {
    const odd: LotFigures = { boxCount: 3, totalWeightKg: 12.963, totalVolumeM3: 0.1235 };
    expect(mixedTotalsFor(odd, 3)).toEqual({ totalWeightKg: 12.963, totalVolumeM3: 0.1235 });
  });
});
