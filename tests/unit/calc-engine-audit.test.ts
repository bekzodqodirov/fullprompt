import { describe, expect, it } from 'vitest';
import {
  customsFor,
  requestCustomsFor,
  totalsFor,
  type CustomsResult,
  type PricedGroup,
  type PricedItem,
} from '@/modules/wms/calc/pricing';

/**
 * The engine-level findings of the 2026-10-09 customs audit, each pinned on
 * the real functions. Every assertion here was red before its fix.
 */
const item = (over: Partial<PricedItem> = {}): PricedItem => ({
  seq: 1,
  label: 'Tovar',
  quantity: 100,
  weightKg: null,
  volumeM3: null,
  bazaUsd: 10,
  bazaBasis: 'unit',
  measureUnit: null,
  measureQty: null,
  ...over,
});

const group = (over: Partial<PricedGroup> = {}): PricedGroup => ({
  seq: 1,
  label: '9999',
  tnvedCode: '9999',
  dutyPct: 10,
  vatPct: 12,
  feeUsd: null,
  dutyMode: 'advalor',
  dutySpecific: null,
  dutyUnit: null,
  excisePct: null,
  exciseSpecific: null,
  exciseUnit: null,
  hasCertificate: true,
  dutyFree: false,
  vatFree: false,
  ...over,
});

const fee = { bhmUzs: 412_000, fxUzsPerUsd: 12_650, feeOverrideUsd: null };

describe('2026-10-09 customs audit — engine', () => {
  it('a legacy per-group fee is never charged beside the declaration fee', () => {
    const withLegacy = customsFor(group({ feeUsd: 30 }), [item()]);
    const without = customsFor(group(), [item()]);
    expect(withLegacy).toMatchObject({ ok: true, feeUsd: 0 });
    expect(withLegacy.ok && without.ok && withLegacy.customsUsd).toBe(without.ok && without.customsUsd);
  });

  it('a declaration worth exactly $10,000.00 pays the 1-BHM tier, whatever the float sum says', () => {
    // Three real cent values whose raw float sum is 10000.000000000002 — the
    // auditor's measured case; the 1-BHM tier answers «up to and including».
    const values = [228.62, 8503.27, 1268.11];
    const customs: CustomsResult[] = values.map((v) => ({
      ok: true,
      valueUsd: v,
      dutyUsd: 0,
      addDutyUsd: 0,
      addDutyPct: 0,
      exciseUsd: 0,
      vatUsd: 0,
      feeUsd: 0,
      customsUsd: 0,
    }));
    expect(values.reduce((a, b) => a + b, 0)).not.toBe(10000);
    const r = requestCustomsFor({ customs, ungroupedCount: 0, ...fee });
    expect(r.valueUsd).toBe(10000);
    expect(r.fee).toMatchObject({ ok: true, bhmCoefficient: 1 });
  });

  it('a row with no code means NO total — never the coded rows as if complete', () => {
    const coded = customsFor(group(), [item()]);
    const r = requestCustomsFor({ customs: [coded], ungroupedCount: 1, ...fee });
    expect(r).toEqual({ valueUsd: null, fee: null, customsUsd: null });
    expect(requestCustomsFor({ customs: [coded], ungroupedCount: 0, ...fee }).customsUsd).not.toBeNull();
  });

  it('a request total is a sum to the cent, not a float', () => {
    const groups = [0.1, 0.2].map((v) => customsFor(group({ dutyPct: 0, vatPct: 0 }), [item({ bazaUsd: v, quantity: 1 })]));
    const r = requestCustomsFor({ customs: groups, ungroupedCount: 0, ...fee, feeOverrideUsd: 0 });
    expect(r.customsUsd).toBe(0);
    expect(r.valueUsd).toBe(0.3);
  });

  it('money rounds half-up on the decimal, not on the binary float', () => {
    // 1.005 is stored as 1.00499999…; a broker's half cent goes UP.
    const r = totalsFor({
      section: 'rastamojka',
      customsUsd: 1.005,
      freightUsd: 0,
      extrasUsd: 0,
      discountUsd: 0,
      weightKg: null,
      volumeM3: null,
    });
    expect(r).toMatchObject({ ok: true, totalUsd: 1.01 });
    // A group's duty at 5 % on a value whose exact product is x.xx5.
    const g = customsFor(group({ dutyPct: 5, vatPct: 0 }), [item({ bazaUsd: 0.21, quantity: 1 })]);
    expect(g).toMatchObject({ ok: true, valueUsd: 0.21, dutyUsd: 0.01 });
    const tie = customsFor(group({ dutyPct: 5, vatPct: 0 }), [item({ bazaUsd: 20.1, quantity: 1 })]);
    // 20.1 × 5 % = 1.005 exactly in decimal → 1.01.
    expect(tie).toMatchObject({ ok: true, dutyUsd: 1.01 });
  });

  it('a zero baza is not a price; a rate outside 0-100 is not a rate', () => {
    expect(customsFor(group(), [item({ bazaUsd: 0 })])).toMatchObject({ ok: false, reason: 'not_a_number', itemSeq: 1 });
    expect(customsFor(group({ dutyPct: 120 }), [item()])).toMatchObject({ ok: false, reason: 'not_a_number' });
    expect(customsFor(group({ excisePct: -1 }), [item()])).toMatchObject({ ok: false, reason: 'not_a_number' });
  });
});
