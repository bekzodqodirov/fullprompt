import { describe, expect, it } from 'vitest';
import { receiptTotals, trimMeasure } from '@/modules/wms/receipts/card-totals';

/**
 * The prixod card's «Jami» line and its lot figures (docs/PRIXOD-KARTA.md).
 *
 * Anchored on LITERALS a person can check on paper, never on the function's
 * own output: a total that restates its helper proves nothing (#166).
 */
describe('trimMeasure — trailing zeros go, the value never moves', () => {
  it('drops only the zeros that carry nothing', () => {
    expect(trimMeasure('250.000')).toBe('250');
    expect(trimMeasure('1.2500')).toBe('1.25');
    expect(trimMeasure('2.1438')).toBe('2.1438');
    expect(trimMeasure('0.0500')).toBe('0.05');
    expect(trimMeasure('1000.000')).toBe('1000');
  });

  it('never eats a zero that is part of the number', () => {
    // «100» is one hundred, not one: only what follows the decimal mark goes.
    expect(trimMeasure('100')).toBe('100');
    expect(trimMeasure('100.000')).toBe('100');
    expect(trimMeasure('10.100')).toBe('10.1');
    expect(trimMeasure('0.000')).toBe('0');
  });

  it('prints what it cannot read as it came, and nothing as zero', () => {
    expect(trimMeasure(null)).toBe('0');
    expect(trimMeasure(undefined)).toBe('0');
    expect(trimMeasure('')).toBe('0');
    expect(trimMeasure('1,5')).toBe('1,5');
    expect(trimMeasure(12.5)).toBe('12.5');
  });
});

describe('receiptTotals — what the prixod holds', () => {
  it('adds the seeded prixod of three lots exactly', () => {
    // The demo card: 10 + 50 + 40 cartons, 250 + 1500 + 320 kg,
    // 1.25 + 2.1438 + 1.9 m³.
    const totals = receiptTotals([
      { boxCount: 10, totalWeightKg: '250.000', totalVolumeM3: '1.2500' },
      { boxCount: 50, totalWeightKg: '1500.000', totalVolumeM3: '2.1438' },
      { boxCount: 40, totalWeightKg: '320.000', totalVolumeM3: '1.9000' },
    ]);
    expect(totals).toEqual({ lots: 3, boxes: 100, kg: '2070', m3: '5.2938' });
  });

  it('does not inherit floating point from its rows', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in a double; three such lots would
    // print «0.6000000000000001 kg» on the card's one summary line.
    const totals = receiptTotals([
      { boxCount: 1, totalWeightKg: '0.100', totalVolumeM3: '0.0001' },
      { boxCount: 1, totalWeightKg: '0.200', totalVolumeM3: '0.0002' },
      { boxCount: 1, totalWeightKg: '0.300', totalVolumeM3: '0.0003' },
    ]);
    expect(totals.kg).toBe('0.6');
    expect(totals.m3).toBe('0.0006');
  });

  it('reads a lot nobody weighed as nothing, and an empty prixod as zeros', () => {
    expect(
      receiptTotals([
        { boxCount: 4, totalWeightKg: null, totalVolumeM3: null },
        { boxCount: 6, totalWeightKg: '12.500', totalVolumeM3: '0.7500' },
      ]),
    ).toEqual({ lots: 2, boxes: 10, kg: '12.5', m3: '0.75' });
    expect(receiptTotals([])).toEqual({ lots: 0, boxes: 0, kg: '0', m3: '0' });
  });
});
