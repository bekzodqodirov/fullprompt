import { describe, expect, it } from 'vitest';
import { missingNeeds, rowNeeds } from '@/modules/wms/calc/needs';
import { customsFor, type PricedGroup, type PricedItem } from '@/modules/wms/calc/pricing';

/**
 * The owner's «kg hamda donani birga kirgizadgan tovarlar» (2026-10-09): a row
 * whose baza unit and whose law's floor unit differ needs BOTH figures, and
 * every surface must be able to say which one is missing. The needs and the
 * engine's refusal are read off the same `itemMeasure`, so they cannot drift —
 * this file proves it on the real `customsFor`.
 */
const item = (over: Partial<PricedItem> = {}): PricedItem => ({
  seq: 1,
  label: 'Kurtka',
  quantity: null,
  weightKg: null,
  volumeM3: null,
  bazaUsd: 4,
  bazaBasis: 'kg',
  measureUnit: null,
  measureQty: null,
  ...over,
});

const law = (over: Partial<PricedGroup> = {}): PricedGroup => ({
  seq: 1,
  label: '6201',
  tnvedCode: '6201',
  dutyPct: 20,
  vatPct: 12,
  feeUsd: null,
  dutyMode: 'max',
  dutySpecific: 3,
  dutyUnit: 'dona',
  excisePct: null,
  hasCertificate: true,
  dutyFree: false,
  vatFree: false,
  ...over,
});

describe('rowNeeds — the engine asked ahead of time', () => {
  it('a jacket valued per kg under a per-piece floor needs its weight AND its count', () => {
    const needs = rowNeeds(law(), 'kg', item({ weightKg: 150 }));
    expect(needs).toEqual([
      { unit: 'kg', why: 'baza', present: true, rate: null },
      { unit: 'dona', why: 'duty', present: false, rate: 3 },
    ]);
    // …and the engine refuses for exactly that figure, naming the half.
    const r = customsFor(law(), [item({ weightKg: 150 })]);
    expect(r).toMatchObject({ ok: false, reason: 'measure_missing', unit: 'dona', half: 'duty', itemSeq: 1 });
  });

  it('a table valued per piece under a per-kg floor needs its count AND its weight', () => {
    const g = law({ dutyPct: 15, dutySpecific: 0.4, dutyUnit: 'kg' });
    const needs = missingNeeds(rowNeeds(g, 'unit', item({ bazaBasis: 'unit', quantity: 10 })));
    expect(needs).toEqual([{ unit: 'kg', why: 'duty', present: false, rate: 0.4 }]);
    const r = customsFor(g, [item({ bazaBasis: 'unit', quantity: 10 })]);
    expect(r).toMatchObject({ ok: false, reason: 'measure_missing', unit: 'kg', half: 'duty' });
  });

  it('the baza half refuses first and says so', () => {
    const r = customsFor(law(), [item({ quantity: 300 })]);
    expect(r).toMatchObject({ ok: false, reason: 'measure_missing', unit: 'kg', half: 'baza' });
  });

  it('a duty-free row asks no floor, an advalor law asks only the baza', () => {
    expect(rowNeeds(law({ dutyFree: true }), 'kg', item({ weightKg: 1 }))).toHaveLength(1);
    expect(rowNeeds(law({ dutyMode: 'advalor', dutySpecific: null, dutyUnit: null }), 'kg', item())).toHaveLength(1);
  });

  it('with both figures stated the row prices — and the need list is satisfied', () => {
    const it2 = item({ weightKg: 150, quantity: 300 });
    expect(missingNeeds(rowNeeds(law(), 'kg', it2))).toEqual([]);
    expect(customsFor(law(), [it2])).toMatchObject({ ok: true, dutyUsd: 900 });
  });

  it('1000_dona and dona read the same count — a missing count is asked once', () => {
    const cig = law({ dutyPct: 30, dutySpecific: 5, dutyUnit: '1000_dona' });
    expect(missingNeeds(rowNeeds(cig, 'unit', item({ bazaBasis: 'unit' })))).toHaveLength(1);
  });
});
