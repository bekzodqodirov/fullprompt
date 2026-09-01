import { describe, expect, it } from 'vitest';
import {
  addDutyBand,
  customsFeeFor,
  customsFor,
  FEE_TIERS,
  type PricedGroup,
  type PricedItem,
} from '@/modules/wms/calc/pricing';

/**
 * VED 2.0 phase 1 — the law engine, anchored on the 2026 guide's OWN worked
 * examples (§9). The guide is the owner's file and its examples are the spec:
 * if any of these three go red, the engine disagrees with the document the
 * VED will check it against, whoever edited what.
 *
 * All three examples assume MB kursi 11 801,23 UZS/USD and BHM 412 000 so'm
 * (the guide's §9 header) — carried verbatim.
 */

const FX = 11_801.23;
const BHM = 412_000;

const group = (over: Partial<PricedGroup> = {}): PricedGroup => ({
  seq: 1,
  label: 'x',
  tnvedCode: null,
  dutyPct: 10,
  vatPct: 12,
  feeUsd: 0,
  dutyMode: 'advalor',
  dutySpecific: null,
  dutyUnit: null,
  excisePct: null,
  hasCertificate: true,
  dutyFree: false,
  vatFree: false,
  ...over,
});

const item = (over: Partial<PricedItem> = {}): PricedItem => ({
  seq: 1,
  label: 'tovar',
  quantity: 1,
  weightKg: 1,
  bazaUsd: 1,
  bazaBasis: 'unit',
  ...over,
});

describe('guide §9.1 — trikotaj kurtka (6102), certificate, MAX rate', () => {
  // BQ $13 500; 20 %, kamida $3/dona; 1 000 dona → MAX(2 700; 3 000) = 3 000.
  const g = group({
    tnvedCode: '6102',
    dutyPct: 20,
    dutyMode: 'max',
    dutySpecific: 3,
    dutyUnit: 'dona',
  });
  const items = [item({ quantity: 1000, bazaUsd: 13.5, bazaBasis: 'unit', weightKg: 4000 })];

  it('the specific floor WINS over the percentage', () => {
    const r = customsFor(g, items);
    expect(r).toMatchObject({
      ok: true,
      valueUsd: 13_500,
      dutyUsd: 3000,
      addDutyUsd: 0,
      vatUsd: 1980, // (13 500 + 3 000) × 12 %
    });
  });

  it('the fee lands in the 10–20k tier: 1,5 BHM ≈ $52.37', () => {
    const fee = customsFeeFor({ valueUsd: 13_500, bhmUzs: BHM, fxUzsPerUsd: FX, overrideUsd: null });
    expect(fee).toMatchObject({ ok: true, feeUsd: 52.37, bhmCoefficient: 1.5 });
  });
});

describe('guide §9.2 — plastmassa idish (3924), NO certificate', () => {
  // BQ $32 500; advalor 20 % → duty 6 500; qo'shimcha boj: 20 % lands in the
  // «20 dan 30 gacha» band → +15 % = 4 875; VAT (32 500+6 500+4 875)×12 % =
  // 5 265; fee 2,5 BHM ≈ $87.28.
  const g = group({ tnvedCode: '3924', dutyPct: 20, hasCertificate: false });
  const items = [item({ quantity: 1, bazaUsd: 32_500, bazaBasis: 'unit' })];

  it('the additional duty appears and feeds the VAT base', () => {
    const r = customsFor(g, items);
    expect(r).toMatchObject({
      ok: true,
      valueUsd: 32_500,
      dutyUsd: 6500,
      addDutyPct: 15,
      addDutyUsd: 4875,
      vatUsd: 5265,
    });
  });

  it('the fee lands in the 20–40k tier: 2,5 BHM ≈ $87.28', () => {
    const fee = customsFeeFor({ valueUsd: 32_500, bhmUzs: BHM, fxUzsPerUsd: FX, overrideUsd: null });
    expect(fee).toMatchObject({ ok: true, feeUsd: 87.28, bhmCoefficient: 2.5 });
  });
});

describe('guide §9.3 — gilam (5703), certificate, MAX by weight', () => {
  // BQ $9 200; 30 %, kamida $0,7/kg; 5 000 kg → MAX(2 760; 3 500) = 3 500.
  it('the per-kilogram floor wins, priced exactly as the guide writes it', () => {
    const r = customsFor(
      group({
        tnvedCode: '5703',
        dutyPct: 30,
        dutyMode: 'max',
        dutySpecific: 0.7,
        dutyUnit: 'kg',
      }),
      [item({ quantity: 1, weightKg: 5000, bazaUsd: 9200, bazaBasis: 'unit' })],
    );
    expect(r).toMatchObject({ ok: true, valueUsd: 9200, dutyUsd: 3500, vatUsd: 1524 });
    const fee = customsFeeFor({ valueUsd: 9200, bhmUzs: BHM, fxUzsPerUsd: FX, overrideUsd: null });
    expect(fee).toMatchObject({ ok: true, feeUsd: 34.91, bhmCoefficient: 1 });
  });
});

describe('the additional-duty bands are inclusive-HIGH', () => {
  // The law's text («10 dan 20 gacha») does not decide the boundaries; the
  // guide's own example 9.2 prices a 20 % code at +15 %, so exactly-20 lands
  // in the HIGHER band and the other boundaries follow the same reading.
  it.each([
    [0, 5],
    [9.99, 5],
    [10, 10],
    [19.99, 10],
    [20, 15],
    [29.99, 15],
    [30, 20],
    [70, 20],
  ])('advalor %s %% → +%s %%', (pct, band) => {
    expect(addDutyBand(pct)).toBe(band);
  });

  it('a zero-duty code without certificate still pays +5 % — the 598 rows', () => {
    const r = customsFor(
      group({ dutyPct: 0, hasCertificate: false }),
      [item({ bazaUsd: 1000 })],
    );
    expect(r).toMatchObject({ ok: true, dutyUsd: 0, addDutyPct: 5, addDutyUsd: 50 });
  });

  it('a lgota that frees the duty frees the additional duty too', () => {
    // A lgota is proven origin; origin proven and origin unknown cannot both
    // be true of one consignment.
    const r = customsFor(
      group({ dutyPct: 20, dutyFree: true, hasCertificate: false }),
      [item({ bazaUsd: 1000 })],
    );
    expect(r).toMatchObject({ ok: true, dutyUsd: 0, addDutyUsd: 0, addDutyPct: 0 });
  });
});

describe('the four duty modes', () => {
  const items = [item({ quantity: 200, weightKg: 100, bazaUsd: 10, bazaBasis: 'unit' })];

  it("'plus' ADDS the halves — the vehicle rows", () => {
    const r = customsFor(
      group({ dutyPct: 15, dutyMode: 'plus', dutySpecific: 2, dutyUnit: 'dona' }),
      items,
    );
    // value 2 000; advalor 300; specific 200 × 2 = 400; duty = 700.
    expect(r).toMatchObject({ ok: true, dutyUsd: 700 });
  });

  it("'specific' is the quantity alone", () => {
    const r = customsFor(
      group({ dutyPct: 0, dutyMode: 'specific', dutySpecific: 2, dutyUnit: 'dona' }),
      items,
    );
    expect(r).toMatchObject({ ok: true, dutyUsd: 400 });
  });

  it("'1000_dona' divides — a 1 000-piece unit is not a piece", () => {
    const r = customsFor(
      group({ dutyPct: 0, dutyMode: 'specific', dutySpecific: 5, dutyUnit: '1000_dona' }),
      [item({ quantity: 4000, bazaUsd: 0.1, bazaBasis: 'unit' })],
    );
    // 4 000 pieces = 4 units of 1 000 → 4 × $5 = $20, NOT 4 000 × $5.
    expect(r).toMatchObject({ ok: true, dutyUsd: 20 });
  });

  it.each(['litr', 'juft', 'sm3', 'm2'] as const)(
    'refuses a %s rate — the items carry no such measure',
    (unit) => {
      const r = customsFor(
        group({ dutyPct: 10, dutyMode: 'max', dutySpecific: 1, dutyUnit: unit }),
        items,
      );
      expect(r).toMatchObject({ ok: false, reason: 'unit_unsupported' });
    },
  );

  it('a specific rate with no quantity on an item refuses and NAMES it', () => {
    const r = customsFor(
      group({ dutyPct: 10, dutyMode: 'max', dutySpecific: 1, dutyUnit: 'dona' }),
      [item({ quantity: null, bazaUsd: 10, bazaBasis: 'kg', weightKg: 50, label: 'nomsiz' })],
    );
    expect(r).toMatchObject({ ok: false, reason: 'measure_missing', itemLabel: 'nomsiz' });
  });

  it('a non-advalor group missing its specific half refuses rates_missing', () => {
    const r = customsFor(
      group({ dutyPct: 10, dutyMode: 'max', dutySpecific: null, dutyUnit: null }),
      items,
    );
    expect(r).toMatchObject({ ok: false, reason: 'rates_missing' });
  });
});

describe('excise', () => {
  it('sits in the VAT base between the duties and the VAT', () => {
    const r = customsFor(
      group({ dutyPct: 10, excisePct: 5 }),
      [item({ bazaUsd: 1000 })],
    );
    // value 1 000; duty 100; excise 50; VAT (1 000+100+50) × 12 % = 138.
    expect(r).toMatchObject({ ok: true, exciseUsd: 50, vatUsd: 138 });
  });
});

describe('the customs fee scale (VMQ-55)', () => {
  const fee = (valueUsd: number) =>
    customsFeeFor({ valueUsd, bhmUzs: BHM, fxUzsPerUsd: FX, overrideUsd: null });

  it('pins every boundary of the law’s own table', () => {
    // «gacha» is inclusive below; «1 000 000 va undan ortiq» starts AT the
    // million, so exactly a million pays 25.
    expect(fee(10_000)).toMatchObject({ ok: true, bhmCoefficient: 1 });
    expect(fee(10_000.01)).toMatchObject({ ok: true, bhmCoefficient: 1.5 });
    expect(fee(20_000)).toMatchObject({ ok: true, bhmCoefficient: 1.5 });
    expect(fee(40_000)).toMatchObject({ ok: true, bhmCoefficient: 2.5 });
    expect(fee(60_000)).toMatchObject({ ok: true, bhmCoefficient: 4 });
    expect(fee(100_000)).toMatchObject({ ok: true, bhmCoefficient: 7 });
    expect(fee(200_000)).toMatchObject({ ok: true, bhmCoefficient: 10 });
    expect(fee(500_000)).toMatchObject({ ok: true, bhmCoefficient: 15 });
    expect(fee(999_999.99)).toMatchObject({ ok: true, bhmCoefficient: 20 });
    expect(fee(1_000_000)).toMatchObject({ ok: true, bhmCoefficient: 25 });
    expect(FEE_TIERS).toHaveLength(8);
  });

  it('refuses with fee_fx_missing rather than inventing a conversion', () => {
    expect(
      customsFeeFor({ valueUsd: 1000, bhmUzs: BHM, fxUzsPerUsd: null, overrideUsd: null }),
    ).toMatchObject({ ok: false, reason: 'fee_fx_missing' });
  });

  it('a typed override wins over the computed tier', () => {
    expect(
      customsFeeFor({ valueUsd: 1000, bhmUzs: BHM, fxUzsPerUsd: null, overrideUsd: 41.9 }),
    ).toMatchObject({ ok: true, feeUsd: 41.9, overridden: true });
  });

  it('NaN anywhere is a refusal, never a number', () => {
    expect(
      customsFeeFor({ valueUsd: NaN, bhmUzs: BHM, fxUzsPerUsd: FX, overrideUsd: null }),
    ).toMatchObject({ ok: false, reason: 'not_a_number' });
    expect(
      customsFeeFor({ valueUsd: 1000, bhmUzs: BHM, fxUzsPerUsd: FX, overrideUsd: NaN }),
    ).toMatchObject({ ok: false, reason: 'not_a_number' });
  });
});
