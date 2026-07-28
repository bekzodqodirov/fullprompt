import { describe, expect, it } from 'vitest';
import { computeLotTotals, densityBand } from '@/modules/wms/receipts/math';

// The owner's bands (2026-07-28): green to 150, yellow to 250, light red to
// 450, dark red above — light cargo is the GOOD case in this business, so it
// must never wear the danger colour.
const THRESHOLDS = { light: 150, medium: 250, heavy: 450 };

describe('computeLotTotals (spec acceptance test 5)', () => {
  it('uniform: 10 boxes 50×50×50 @25 kg ⇒ 1.25 m³, 250 kg, density 200 → yellow', () => {
    const totals = computeLotTotals(
      {
        dimsMode: 'uniform',
        boxCount: 10,
        boxLengthCm: 50,
        boxWidthCm: 50,
        boxHeightCm: 50,
        boxWeightKg: 25,
      },
      167,
    );
    expect(totals.totalVolumeM3).toBe(1.25);
    expect(totals.totalWeightKg).toBe(250);
    expect(totals.densityKgM3).toBe(200);
    expect(densityBand(totals.densityKgM3, THRESHOLDS)).toBe('yellow');
  });

  it('chargeable weight = max(actual, volume × factor)', () => {
    const light = computeLotTotals(
      {
        dimsMode: 'uniform',
        boxCount: 1,
        boxLengthCm: 100,
        boxWidthCm: 100,
        boxHeightCm: 100,
        boxWeightKg: 50,
      },
      167,
    );
    expect(light.totalVolumeM3).toBe(1);
    expect(light.chargeableKg).toBe(167);

    const heavy = computeLotTotals(
      {
        dimsMode: 'uniform',
        boxCount: 1,
        boxLengthCm: 50,
        boxWidthCm: 50,
        boxHeightCm: 50,
        boxWeightKg: 100,
      },
      167,
    );
    expect(heavy.chargeableKg).toBe(100);
  });

  it('mixed mode passes totals through', () => {
    const totals = computeLotTotals(
      { dimsMode: 'mixed', boxCount: 40, totalWeightKg: 480, totalVolumeM3: 1.2 },
      167,
    );
    expect(totals.totalWeightKg).toBe(480);
    expect(totals.totalVolumeM3).toBe(1.2);
    expect(totals.densityKgM3).toBe(400);
    expect(densityBand(totals.densityKgM3, THRESHOLDS)).toBe('red');
  });

  it('density bands are lower-bound inclusive', () => {
    expect(densityBand(149.9, THRESHOLDS)).toBe('green');
    expect(densityBand(150, THRESHOLDS)).toBe('yellow');
    expect(densityBand(250, THRESHOLDS)).toBe('red');
    expect(densityBand(450, THRESHOLDS)).toBe('darkred');
  });
});
