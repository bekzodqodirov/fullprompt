import { describe, expect, it } from 'vitest';
import { autoBasisFor, basisConflicts, defaultBasisFor } from '@/modules/wms/calc/basis';
import { lawPinnedBasis } from '@/modules/wms/calc/warnings';

/**
 * «avto» follows what the row states (2026-10-09). The seller's «120 m²» is
 * priced per m² without the VED retyping it; a weight-only row is per kg —
 * and nothing the auto unit picks may trip the system's own warnings.
 */
const row = (over: Partial<Parameters<typeof autoBasisFor>[1]> = {}) => ({
  quantity: null,
  weightKg: null,
  measureUnit: null,
  measureQty: null,
  ...over,
});

const LAWS = [null, 'kg', 'dona', '1000_dona', 'litr', 'juft', 'sm3', 'm2'] as const;
const ROWS = [
  row(),
  row({ quantity: 10 }),
  row({ weightKg: 5 }),
  row({ quantity: 10, weightKg: 5 }),
  row({ measureUnit: 'm2', measureQty: 120 }),
  row({ measureUnit: 'juft', measureQty: 40, weightKg: 12 }),
  row({ measureUnit: 'litr', measureQty: 50 }),
  row({ measureUnit: 'sm3', measureQty: 1500, quantity: 1 }),
];

describe('autoBasisFor', () => {
  it('the law pins first, then the row says', () => {
    expect(autoBasisFor({ dutyUnit: 'juft' }, row({ weightKg: 12 }))).toBe('juft');
    expect(autoBasisFor({ dutyUnit: 'kg' }, row({ measureUnit: 'm2', measureQty: 9 }))).toBe('kg');
    expect(autoBasisFor({ dutyUnit: 'dona' }, row({ weightKg: 150 }))).toBe('unit');
    expect(autoBasisFor(null, row({ measureUnit: 'm2', measureQty: 120 }))).toBe('m2');
    expect(autoBasisFor({ dutyUnit: null }, row({ measureUnit: 'litr', measureQty: 50 }))).toBe('litr');
    expect(autoBasisFor(null, row({ weightKg: 500 }))).toBe('kg');
    expect(autoBasisFor(null, row({ quantity: 10, weightKg: 5 }))).toBe('unit');
    expect(autoBasisFor(null, row({ measureUnit: 'sm3', measureQty: 1500 }))).toBe('unit');
  });

  it('never picks a unit the law refuses or a warning flags', () => {
    for (const law of LAWS) {
      for (const r of ROWS) {
        const basis = autoBasisFor({ dutyUnit: law }, r);
        expect(basisConflicts(law, basis), `${law} ${JSON.stringify(r)}`).toBe(false);
        const pinned = lawPinnedBasis(law);
        if (pinned) expect(basis).toBe(pinned);
      }
    }
  });

  it('agrees with the law-only default whenever the law decides', () => {
    for (const law of ['kg', 'dona', '1000_dona', 'litr', 'juft', 'sm3', 'm2'] as const) {
      for (const r of ROWS) expect(autoBasisFor({ dutyUnit: law }, r)).toBe(defaultBasisFor({ dutyUnit: law }));
    }
  });
});
