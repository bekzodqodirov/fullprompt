import { describe, expect, it } from 'vitest';
import { allocateEntry, toUsd, type AllocBox } from '@/modules/wms/costing/engine';

const box = (boxId: string, kg: number, m3: number, clientId: string | null = 'C1'): AllocBox => ({
  boxId,
  clientId,
  weightKg: kg,
  volumeM3: m3,
  chargeableKg: Math.max(kg, m3 * 167),
});

describe('allocation engine (spec 6.9)', () => {
  it('worked example: box P = 30 + 60 = 90 CNY-equivalent across two batches', () => {
    // YW-001: freight 10,000 CNY over 10,000 kg total → 1 CNY/kg.
    // Model the batch as box P (30 kg) + "rest of the truck" (9,970 kg).
    const rate1 = 0.14; // CNY→USD on the YW-001 entry date
    const yw = allocateEntry(
      { amountUsd: toUsd(10_000, rate1), basis: 'weight' },
      [box('P', 30, 0.1), box('rest', 9_970, 40)],
    );
    const pShare1 = yw.find((s) => s.boxId === 'P')!.amountUsd;
    expect(pShare1).toBeCloseTo(toUsd(30, rate1), 2); // 30 CNY equiv

    // KA-001: freight 40,000 CNY over 20,000 kg → 2 CNY/kg, different date/rate.
    const rate2 = 0.135;
    const ka = allocateEntry(
      { amountUsd: toUsd(40_000, rate2), basis: 'weight' },
      [box('P', 30, 0.1), box('rest2', 19_970, 80)],
    );
    const pShare2 = ka.find((s) => s.boxId === 'P')!.amountUsd;
    expect(pShare2).toBeCloseTo(toUsd(60, rate2), 2); // 60 CNY equiv

    // Landed cost of P = Σ shares — 90 CNY equivalent, each leg at ITS rate.
    expect(pShare1 + pShare2).toBeCloseTo(30 * rate1 + 60 * rate2, 2);

    // Box Q that came via a different first leg gets a different landed cost.
    const gz = allocateEntry(
      { amountUsd: toUsd(5_000, rate1), basis: 'weight' },
      [box('Q', 30, 0.1), box('rest3', 970, 4)],
    );
    const qShare1 = gz.find((s) => s.boxId === 'Q')!.amountUsd;
    expect(qShare1).not.toBeCloseTo(pShare1, 2);
  });

  it('covers all five bases', () => {
    const pool = [box('a', 10, 1), box('b', 30, 1), box('c', 10, 2, 'C2')];

    const byWeight = allocateEntry({ amountUsd: 100, basis: 'weight' }, pool);
    expect(byWeight.find((s) => s.boxId === 'b')!.amountUsd).toBeCloseTo(60, 3);

    const byVolume = allocateEntry({ amountUsd: 100, basis: 'volume' }, pool);
    expect(byVolume.find((s) => s.boxId === 'c')!.amountUsd).toBeCloseTo(50, 3);

    // chargeable: a=max(10,167)=167, b=max(30,167)=167, c=max(10,334)=334 → c gets half
    const byChargeable = allocateEntry({ amountUsd: 100, basis: 'chargeable' }, pool);
    expect(byChargeable.find((s) => s.boxId === 'c')!.amountUsd).toBeCloseTo(50, 3);

    const byBoxes = allocateEntry({ amountUsd: 99, basis: 'boxes' }, pool);
    expect(byBoxes.map((s) => s.amountUsd)).toEqual([33, 33, 33]);

    const direct = allocateEntry(
      { amountUsd: 100, basis: 'direct_to_client', clientId: 'C2' },
      pool,
    );
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({ boxId: 'c', amountUsd: 100 });
  });

  it('shares always sum exactly to the entry amount (rounding drift absorbed)', () => {
    const pool = [box('a', 1, 0), box('b', 1, 0), box('c', 1, 0)];
    const shares = allocateEntry({ amountUsd: 100, basis: 'boxes' }, pool);
    const sum = shares.reduce((a, s) => a + s.amountUsd, 0);
    expect(sum).toBeCloseTo(100, 6);
    expect(shares[2]!.amountUsd).not.toBe(shares[0]!.amountUsd); // absorbed drift
  });

  it('degenerate cases return no shares', () => {
    expect(allocateEntry({ amountUsd: 100, basis: 'weight' }, [])).toEqual([]);
    expect(
      allocateEntry({ amountUsd: 100, basis: 'weight' }, [box('a', 0, 0)]),
    ).toEqual([]);
    expect(
      allocateEntry({ amountUsd: 100, basis: 'direct_to_client', clientId: 'NOPE' }, [
        box('a', 1, 1),
      ]),
    ).toEqual([]);
  });
});
