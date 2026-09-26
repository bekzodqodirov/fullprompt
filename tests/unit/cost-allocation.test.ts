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

  it('shares always sum exactly to the entry amount (the leftover unit goes somewhere)', () => {
    const pool = [box('a', 1, 0), box('b', 1, 0), box('c', 1, 0)];
    const shares = allocateEntry({ amountUsd: 100, basis: 'boxes' }, pool);
    const sum = shares.reduce((a, s) => a + s.amountUsd, 0);
    expect(sum).toBeCloseTo(100, 6);
    // 33.3334 + 33.3333 + 33.3333: ONE box carries the one leftover unit.
    expect(shares[2]!.amountUsd).not.toBe(shares[0]!.amountUsd);
  });

  /**
   * The leftover of a big equal pool (audit U42). Every box rounds the same
   * way, so the old «last box absorbs the drift» rule handed ONE box
   * N × half a unit: $3.34 over a 600-box truck left 599 boxes at 0.0056 and
   * the last at −0.0144 — a client's tannarx reading −$0.01 on «Partiya
   * moliyasi». Largest remainder keeps every share within one unit of exact.
   */
  const units = (usd: number) => Math.round(usd * 10_000);
  const assertFair = (amountUsd: number, pool: AllocBox[], basis: 'weight' | 'boxes') => {
    const shares = allocateEntry({ amountUsd, basis }, pool);
    const weights = pool.map((b) => (basis === 'weight' ? b.weightKg : 1));
    const total = weights.reduce((a, w) => a + w, 0);
    expect(
      shares.reduce((a, s) => a + units(s.amountUsd), 0),
      `Σ of $${amountUsd}`,
    ).toBe(units(amountUsd));
    const negative = shares.filter((s) => s.amountUsd < 0).length;
    const worst = Math.max(
      ...shares.map((s, i) => Math.abs(s.amountUsd - (amountUsd * weights[i]!) / total)),
    );
    expect(
      { negative, withinOneUnit: worst <= 0.0001 + 1e-12 },
      `$${amountUsd} over ${pool.length}`,
    ).toEqual({
      negative: 0,
      withinOneUnit: true,
    });
  };

  it('$3.34 over 600 equal boxes: no negative share, none off by more than one unit', () => {
    const pool = Array.from({ length: 600 }, (_, i) =>
      box(`b${i}`, 12, 0.1, i === 599 ? 'B' : 'A'),
    );
    assertFair(3.34, pool, 'boxes');
    assertFair(3.34, pool, 'weight');
  });

  it('$47.34 over 2,522 boxes and $1.94 over one 300-box lot (the receipt-fee shape)', () => {
    assertFair(
      47.34,
      Array.from({ length: 2522 }, (_, i) => box(`c${i}`, 5, 0.05)),
      'boxes',
    );
    assertFair(
      1.94,
      Array.from({ length: 300 }, (_, i) => box(`d${i}`, 8.4, 0.07)),
      'weight',
    );
  });

  it('mixed pools stay exact and within one unit (deterministic fuzz)', () => {
    let seed = 20260925;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 2000; run += 1) {
      const n = 1 + Math.floor(rnd() * (run % 10 === 0 ? 900 : 40));
      const pool = Array.from({ length: n }, (_, k) =>
        box(`f${k}`, Math.round(rnd() * 5000) / 1000 + 0.001, 0.01),
      );
      const amount = Math.max(0.01, Math.round(rnd() * (run % 2 ? 50 : 50_000) * 100) / 100);
      assertFair(amount, pool, run % 3 === 0 ? 'boxes' : 'weight');
    }
  });

  it('the same pool always splits the same way (ties go to the earlier box)', () => {
    const pool = [box('a', 1, 0), box('b', 1, 0), box('c', 1, 0)];
    const shares = allocateEntry({ amountUsd: 100, basis: 'boxes' }, pool);
    expect(shares.map((s) => s.amountUsd)).toEqual([33.3334, 33.3333, 33.3333]);
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
