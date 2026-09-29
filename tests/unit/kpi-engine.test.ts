import { describe, expect, it } from 'vitest';
import { earnedOnPaid, kpiFor, type KpiCell } from '@/modules/wms/staff/kpi-engine';
import { OWNER_KPI_FROM, ownerKpiCells } from '@/modules/wms/staff/kpi-seed';

/**
 * The owner's KPI table, anchored on HIS literals (2026-09-28 message, answers
 * 3a/4a) — never on the seed the code wrote, so a wrong seed and a wrong
 * engine cannot agree with each other and pass together (#1116's lesson):
 *
 *            ≤100   ≤200   ≤350   >350  kg/m³
 *   ≤30 m³     1      2      3      4
 *   ≤50        1.5    3      4      5
 *   ≤70        2      4      5      6
 *   ≤100       2.5    5      6      7
 *   ≤150       3      6      7      8
 *   >150       3      7      8      9
 */
const TIERS = [30, 50, 70, 100, 150, null];
const BANDS = [100, 200, 350, null];
const GRID = [
  [1, 2, 3, 4],
  [1.5, 3, 4, 5],
  [2, 4, 5, 6],
  [2.5, 5, 6, 7],
  [3, 6, 7, 8],
  [3, 7, 8, 9],
];
const HIS: KpiCell[] = TIERS.flatMap((maxM3, t) =>
  BANDS.map((maxDensity, b) => ({ maxM3, maxDensity, rateUsd: GRID[t]![b]! })),
);

const cargo = (m3: number, kg: number, unmeasured: string[] = []) => ({ m3, kg, unmeasured });

describe('the seed is his table', () => {
  it('ownerKpiCells() is the literal grid, cell for cell', () => {
    const key = (c: KpiCell) => `${c.maxM3}|${c.maxDensity}`;
    const seeded = new Map(ownerKpiCells().map((c) => [key(c), c.rateUsd]));
    expect(seeded.size).toBe(24);
    for (const cell of HIS) expect(seeded.get(key(cell)), key(cell)).toBe(cell.rateUsd);
  });

  it('KPI starts in September 2026 (open point 1, default a)', () => {
    expect(OWNER_KPI_FROM).toBe('2026-09-01');
  });
});

describe('kpiFor — his own examples', () => {
  it('40 m³ at 150 kg/m³ is the ≤50 row, «до 200» column: $3 × 40 = $120', () => {
    const r = kpiFor(HIS, cargo(40, 6000));
    expect(r).toMatchObject({ ok: true, m3: 40, density: 150, tierMaxM3: 50, bandMaxDensity: 200, rate: 3, earnedUsd: 120 });
  });

  it('exactly 30 m³ is the ≤30 row; 30.0001 is past it; 151 is the open row', () => {
    // A tier top is INCLUSIVE («gacha»), and the m³ is not rounded to a whole.
    expect(kpiFor(HIS, cargo(30, 4500))).toMatchObject({ ok: true, tierMaxM3: 30, rate: 2 });
    expect(kpiFor(HIS, cargo(30.0001, 4500))).toMatchObject({ ok: true, tierMaxM3: 50, rate: 3 });
    expect(kpiFor(HIS, cargo(151, 22650))).toMatchObject({ ok: true, tierMaxM3: null, rate: 7 });
  });

  it('the density is looked up as a WHOLE kg/m³, band tops inclusive', () => {
    // exactly 100 → «до 100»; 100.4 rounds to 100 → «до 100»;
    // 100.5 rounds to 101 → «до 200»; exactly 350 → «до 350»; 351 → open.
    expect(kpiFor(HIS, cargo(10, 1000))).toMatchObject({ ok: true, density: 100, bandMaxDensity: 100, rate: 1 });
    expect(kpiFor(HIS, cargo(10, 1004))).toMatchObject({ ok: true, density: 100, bandMaxDensity: 100, rate: 1 });
    expect(kpiFor(HIS, cargo(10, 1005))).toMatchObject({ ok: true, density: 101, bandMaxDensity: 200, rate: 2 });
    expect(kpiFor(HIS, cargo(10, 3500))).toMatchObject({ ok: true, density: 350, bandMaxDensity: 350, rate: 3 });
    expect(kpiFor(HIS, cargo(10, 3510))).toMatchObject({ ok: true, density: 351, bandMaxDensity: null, rate: 4 });
  });

  it('pays per cube to the cent', () => {
    expect(kpiFor(HIS, cargo(12.3456, 1851.84))).toMatchObject({ ok: true, rate: 2, earnedUsd: 24.69 });
  });
});

describe('kpiFor — it never invents a number', () => {
  it('no cargo is a true zero, named', () => {
    expect(kpiFor(HIS, cargo(0, 0))).toEqual({ ok: false, reason: 'no_cargo' });
  });

  it('an unmeasured lot blocks the month and names the receipts', () => {
    expect(kpiFor(HIS, cargo(10, 1500, ['YW-00042']))).toEqual({
      ok: false,
      reason: 'lot_unmeasured',
      receipts: ['YW-00042'],
    });
  });

  it('no table, an empty table, or a table with no open top past its last bound: rate_missing', () => {
    expect(kpiFor(null, cargo(10, 1500))).toEqual({ ok: false, reason: 'rate_missing' });
    expect(kpiFor([], cargo(10, 1500))).toEqual({ ok: false, reason: 'rate_missing' });
    const closed = HIS.filter((c) => c.maxM3 !== null);
    expect(kpiFor(closed, cargo(200, 30000))).toEqual({ ok: false, reason: 'rate_missing' });
  });

  it('two rates in one cell: rate_ambiguous', () => {
    const doubled = [...HIS, { maxM3: 50, maxDensity: 200, rateUsd: 99 }];
    expect(kpiFor(doubled, cargo(40, 6000))).toEqual({ ok: false, reason: 'rate_ambiguous' });
  });

  it('NaN anywhere is refused by name (#777)', () => {
    expect(kpiFor(HIS, cargo(Number.NaN, 100))).toEqual({ ok: false, reason: 'not_a_number' });
    expect(kpiFor(HIS, cargo(10, Number.NaN))).toEqual({ ok: false, reason: 'not_a_number' });
    const poisoned = HIS.map((c) => (c.maxM3 === 50 && c.maxDensity === 200 ? { ...c, rateUsd: Number.NaN } : c));
    expect(kpiFor(poisoned, cargo(40, 6000))).toEqual({ ok: false, reason: 'not_a_number' });
  });
});

describe('earnedOnPaid', () => {
  it('the paid cubes at the month’s rate, to the cent', () => {
    expect(earnedOnPaid(12.34567, 3)).toBe(37.04);
    expect(earnedOnPaid(0, 9)).toBe(0);
  });
});
