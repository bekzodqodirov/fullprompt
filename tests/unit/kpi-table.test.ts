import { describe, expect, it } from 'vitest';
import { parseKpiGridPost, validateKpiGrid, versionFor, type KpiVersion } from '@/modules/wms/staff/kpi-table';
import type { KpiCell } from '@/modules/wms/staff/kpi-engine';

/** A small full grid: two tiers × two bands, each with its open top. */
const FULL: KpiCell[] = [
  { maxM3: 30, maxDensity: 100, rateUsd: 1 },
  { maxM3: 30, maxDensity: null, rateUsd: 2 },
  { maxM3: null, maxDensity: 100, rateUsd: 3 },
  { maxM3: null, maxDensity: null, rateUsd: 4 },
];

describe('validateKpiGrid — a save writes ONE full grid', () => {
  it('a full grid passes', () => {
    expect(validateKpiGrid(FULL)).toEqual({ ok: true });
  });

  it('refuses an empty grid, a hole and a duplicate', () => {
    expect(validateKpiGrid([])).toEqual({ ok: false, reason: 'grid_empty' });
    expect(validateKpiGrid(FULL.slice(0, 3))).toEqual({ ok: false, reason: 'grid_hole' });
    expect(validateKpiGrid([...FULL, { maxM3: 30, maxDensity: 100, rateUsd: 7 }])).toEqual({
      ok: false,
      reason: 'grid_duplicate',
    });
  });

  it('demands an open tier and an open band', () => {
    const closedTier = FULL.map((c) => ({ ...c, maxM3: c.maxM3 ?? 50 }));
    expect(validateKpiGrid(closedTier)).toEqual({ ok: false, reason: 'grid_no_open_tier' });
    const closedBand = FULL.map((c) => ({ ...c, maxDensity: c.maxDensity ?? 200 }));
    expect(validateKpiGrid(closedBand)).toEqual({ ok: false, reason: 'grid_no_open_band' });
  });

  it('refuses NaN, a negative rate and a bound that is not a positive (whole, for density) number', () => {
    const at = (patch: Partial<KpiCell>) => FULL.map((c, i) => (i === 0 ? { ...c, ...patch } : c));
    expect(validateKpiGrid(at({ rateUsd: Number.NaN }))).toEqual({ ok: false, reason: 'bad_rate' });
    expect(validateKpiGrid(at({ rateUsd: -1 }))).toEqual({ ok: false, reason: 'bad_rate' });
    expect(validateKpiGrid(at({ maxM3: Number.NaN }))).toEqual({ ok: false, reason: 'bad_bound' });
    expect(validateKpiGrid(at({ maxM3: 0 }))).toEqual({ ok: false, reason: 'bad_bound' });
    expect(validateKpiGrid(at({ maxDensity: 100.5 }))).toEqual({ ok: false, reason: 'bad_bound' });
  });
});

describe('versionFor — the newest on or before, never an earlier-row fallback', () => {
  const versions: KpiVersion[] = [
    { month: '2026-09', cells: FULL },
    { month: '2027-01', cells: FULL.map((c) => ({ ...c, rateUsd: c.rateUsd * 2 })) },
  ];

  it('picks the version in force', () => {
    expect(versionFor(versions, '2026-09')?.month).toBe('2026-09');
    expect(versionFor(versions, '2026-12')?.month).toBe('2026-09');
    expect(versionFor(versions, '2027-01')?.month).toBe('2027-01');
    expect(versionFor(versions, '2027-06')?.month).toBe('2027-01');
  });

  it('a month before the first version is outside KPI', () => {
    expect(versionFor(versions, '2026-08')).toBeNull();
  });
});

describe('parseKpiGridPost — what the editor posts', () => {
  const post = (patch: Record<string, unknown>) => [
    { maxM3: '30', maxDensity: '100', rateUsd: '1', ...patch },
    { maxM3: '30', maxDensity: null, rateUsd: '2' },
    { maxM3: null, maxDensity: '100', rateUsd: '3' },
    { maxM3: null, maxDensity: null, rateUsd: '4' },
  ];

  it('reads the typed strings, a comma decimal included, and null as the open top', () => {
    expect(parseKpiGridPost(post({ rateUsd: '1,5' }))).toEqual([
      { maxM3: 30, maxDensity: 100, rateUsd: 1.5 },
      { maxM3: 30, maxDensity: null, rateUsd: 2 },
      { maxM3: null, maxDensity: 100, rateUsd: 3 },
      { maxM3: null, maxDensity: null, rateUsd: 4 },
    ]);
  });

  it('a BLANK rate is refused, never saved as $0 (Number("") is 0)', () => {
    const cells = parseKpiGridPost(post({ rateUsd: '' }))!;
    expect(validateKpiGrid(cells)).toEqual({ ok: false, reason: 'bad_rate' });
  });

  it('a blank top is not «open» — it is refused by name', () => {
    expect(validateKpiGrid(parseKpiGridPost(post({ maxM3: ' ' }))!)).toEqual({ ok: false, reason: 'bad_bound' });
    expect(validateKpiGrid(parseKpiGridPost(post({ maxDensity: '' }))!)).toEqual({ ok: false, reason: 'bad_bound' });
  });

  it('something that is not a list is nothing', () => {
    expect(parseKpiGridPost({ grid: 1 })).toBeNull();
  });
});

describe('validateKpiGrid — nothing the columns cannot store', () => {
  // rate_usd numeric(8,2), max_m3 numeric(10,3), max_density integer (0117).
  // Past them postgres answers 22003 and the editor showed the error page.
  const with1 = (patch: Partial<KpiCell>) => [{ ...FULL[0]!, ...patch }, ...FULL.slice(1)];

  it('a rate of a million is a typo, refused by name; 999 999.99 is storable', () => {
    expect(validateKpiGrid(with1({ rateUsd: 1_000_000 }))).toEqual({ ok: false, reason: 'bad_rate' });
    expect(validateKpiGrid(with1({ rateUsd: 999_999.99 }))).toEqual({ ok: true });
  });

  it('a kub top of ten million, and a density past the integer, are refused', () => {
    // The whole row / column moves, or the grid has a hole before it has a bound.
    const tier = (top: number) => FULL.map((c) => ({ ...c, maxM3: c.maxM3 === null ? null : top }));
    const band = (top: number) => FULL.map((c) => ({ ...c, maxDensity: c.maxDensity === null ? null : top }));
    expect(validateKpiGrid(tier(10_000_000))).toEqual({ ok: false, reason: 'bad_bound' });
    expect(validateKpiGrid(tier(9_999_999.999))).toEqual({ ok: true });
    expect(validateKpiGrid(band(2_147_483_648))).toEqual({ ok: false, reason: 'bad_bound' });
    expect(validateKpiGrid(band(2_147_483_647))).toEqual({ ok: true });
  });
});
