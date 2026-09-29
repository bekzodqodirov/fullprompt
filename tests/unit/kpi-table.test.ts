import { describe, expect, it } from 'vitest';
import { validateKpiGrid, versionFor, type KpiVersion } from '@/modules/wms/staff/kpi-table';
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
