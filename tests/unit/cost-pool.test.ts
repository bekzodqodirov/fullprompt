import { describe, expect, it } from 'vitest';
import { allocateEntry, type AllocBox, type AllocationBasis } from '@/modules/wms/costing/engine';
import { costPool, homed, type PoolFreight } from '@/modules/wms/costing/pool';
import type { BoxMeasure, FreightCopy } from '@/modules/wms/costing/freight-types';

/**
 * docs/YOLKIRA-TAQSIMOT.md §9.6 — ONE pool for the recompute and the void
 * guard, and the order inside it is a rule: an EMPTY base is «nothing» for
 * every basis before anything freight-shaped is read (M3/E1).
 */

const copy: FreightCopy = {
  warehouseId: 'W',
  zone: 'cn',
  tariffFrom: '2026-01-01',
  lightBelow: 10,
  bands: [
    { min: 1, max: 999, price: 100, perKg: false },
    { min: 1000, max: null, price: 0.5, perKg: true },
  ],
};

function measure(boxId: string, client: string | null, kg: number, m3: number): BoxMeasure {
  return {
    boxId,
    clientId: client,
    clientCode: client,
    receiptId: `R-${client}`,
    receiptNumber: null,
    unclaimedMarking: null,
    lotId: `L-${boxId}`,
    lotLetter: 'A',
    lotSeq: 1,
    dimsMode: 'mixed',
    boxLengthCm: null,
    boxWidthCm: null,
    boxHeightCm: null,
    boxWeightKg: null,
    boxCount: 1,
    totalWeightKg: kg.toFixed(3),
    totalVolumeM3: m3.toFixed(4),
    weightKg: kg,
    volumeM3: m3,
  };
}

const entry = (basis: AllocationBasis, clientId: string | null = null) => ({
  allocationBasis: basis,
  clientId,
  amountUsd: 100,
});

describe('costPool — the order', () => {
  const freights: (PoolFreight | null)[] = [
    null,
    { copy: 'missing', customs: false },
    { copy: 'invalid', customs: false },
    { copy, customs: true },
    { copy, customs: false },
  ];

  it('an EMPTY base is «nothing» for EVERY freight argument — before the copy or the customs flag is read', () => {
    for (const f of freights) {
      expect(costPool(entry('freight'), [], 167, f), JSON.stringify(f)).toEqual({ kind: 'nothing' });
    }
  });

  it('over one carton the copy and the customs flag DO decide (so the test above pins the order)', () => {
    const one = [measure('a', 'A', 200, 1)];
    expect(costPool(entry('freight'), one, 167, null)).toEqual({ kind: 'held', held: { reason: 'copy_missing' } });
    expect(costPool(entry('freight'), one, 167, { copy: 'missing', customs: false })).toEqual({
      kind: 'held',
      held: { reason: 'copy_missing' },
    });
    expect(costPool(entry('freight'), one, 167, { copy: 'invalid', customs: false })).toEqual({
      kind: 'held',
      held: { reason: 'copy_invalid' },
    });
    expect(costPool(entry('freight'), one, 167, { copy, customs: true })).toEqual({
      kind: 'held',
      held: { reason: 'on_customs' },
    });
  });

  it('a held bill writes no shares, and is HOMED (the void guard lets the void through)', () => {
    const light = costPool(entry('freight'), [measure('a', 'A', 1, 3)], 167, { copy, customs: false });
    expect(light.kind).toBe('held');
    expect(homed(light)).toBe(true);
    expect(homed({ kind: 'nothing' })).toBe(false);
  });

  it('a freight split carries its groups and adds up to the bill', () => {
    const v = costPool(entry('freight'), [measure('a', 'A', 1200, 2), measure('b', 'B', 1500, 1)], 167, {
      copy,
      customs: false,
    });
    expect(v.kind).toBe('split');
    if (v.kind !== 'split') return;
    // A: 600 kg/m³ → $100 × 2 = 200; B: 1500 kg/m³ → $0.5 × 1500 = 750.
    expect(v.groups!.map((g) => Math.round(g.value))).toEqual([200, 750]);
    expect(v.shares.reduce((a, s) => a + s.amountUsd, 0)).toBeCloseTo(100, 9);
    expect(v.shares.map((s) => s.amountUsd)).toEqual([21.0526, 78.9474]);
  });
});

describe('costPool — the old bases did not move', () => {
  /** A FROZEN copy of the pool builder this round replaced (boxDims + allocateEntry). */
  function before(basis: AllocationBasis, clientId: string | null, measures: BoxMeasure[], factor: number) {
    const pool: AllocBox[] = measures.map((d) => ({
      boxId: d.boxId,
      clientId: d.clientId,
      weightKg: d.weightKg,
      volumeM3: d.volumeM3,
      chargeableKg: Math.max(d.weightKg, d.volumeM3 * factor),
      freightWeight: 0,
    }));
    return allocateEntry({ amountUsd: 333.33, basis, clientId }, pool);
  }

  it('weight, volume, chargeable, boxes and direct_to_client give exactly the old shares', () => {
    const measures = [
      measure('a', 'A', 120.5, 0.4),
      measure('b', 'A', 10, 2.1),
      measure('c', 'B', 0, 0),
      measure('d', null, 77.7, 0.33),
      measure('e', 'B', 400, 1.25),
    ];
    for (const basis of ['weight', 'volume', 'chargeable', 'boxes', 'direct_to_client'] as const) {
      const clientId = basis === 'direct_to_client' ? 'B' : null;
      const v = costPool({ allocationBasis: basis, clientId, amountUsd: 333.33 }, measures, 167, null);
      const old = before(basis, clientId, measures, 167);
      expect(v.kind === 'split' ? v.shares : [], basis).toEqual(old);
    }
  });

  it('a zero-weight base is «nothing», as allocateEntry’s [] always was', () => {
    expect(costPool(entry('weight'), [measure('a', 'A', 0, 0)], 167, null)).toEqual({ kind: 'nothing' });
  });
});
