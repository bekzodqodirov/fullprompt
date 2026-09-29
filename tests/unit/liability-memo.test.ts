import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetUpsaleLiability, LIABILITY_TTL_MS, rememberedLiability } from '@/modules/wms/calc/liability-memo';

/**
 * The Balans's sellers' commissions are one company-wide walk a minute
 * (review defect 2): behavioural over the memo itself, with a loader that
 * counts how often the walk would have run. The clock is passed in, never
 * waited for.
 */
const T0 = 1_790_000_000_000;

beforeEach(() => {
  forgetUpsaleLiability();
});

function loader<T>(value: T) {
  const load = vi.fn(async () => value);
  return load;
}

describe('rememberedLiability', () => {
  it('two readers inside the minute walk once and read the same answer', async () => {
    const load = loader({ payableUsd: 600 });
    const first = await rememberedLiability(load, T0);
    const second = await rememberedLiability(load, T0 + LIABILITY_TTL_MS - 1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('readers that arrive while the walk runs share the ONE in-flight walk', async () => {
    let finish!: (value: number) => void;
    const load = vi.fn(() => new Promise<number>((resolve) => (finish = resolve)));
    const a = rememberedLiability(load, T0);
    const b = rememberedLiability(load, T0 + 5);
    const c = rememberedLiability(load, T0 + 10);
    expect(load).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
    finish(42);
    expect(await Promise.all([a, b, c])).toEqual([42, 42, 42]);
  });

  it('after the minute the next reader walks again', async () => {
    const load = loader(1);
    await rememberedLiability(load, T0);
    await rememberedLiability(load, T0 + LIABILITY_TTL_MS);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a door that changes the answer forgets it, and the next reader walks again', async () => {
    const before = loader('before');
    const after = loader('after');
    expect(await rememberedLiability(before, T0)).toBe('before');
    forgetUpsaleLiability();
    expect(await rememberedLiability(after, T0 + 1)).toBe('after');
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('a failed walk is the caller’s to see and nobody’s to be served again', async () => {
    const failing = vi.fn(async () => {
      throw new Error('pool exhausted');
    });
    await expect(rememberedLiability(failing, T0)).rejects.toThrow('pool exhausted');
    const good = loader('ok');
    expect(await rememberedLiability(good, T0 + 1)).toBe('ok');
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('an old walk failing after a forget does not drop the newer answer', async () => {
    let fail!: (err: Error) => void;
    const old = rememberedLiability(() => new Promise<string>((_, reject) => (fail = reject)), T0);
    forgetUpsaleLiability();
    const fresh = loader('fresh');
    expect(await rememberedLiability(fresh, T0 + 1)).toBe('fresh');
    fail(new Error('late'));
    await expect(old).rejects.toThrow('late');
    // The newer entry survives: still inside its minute, no second walk.
    const again = loader('again');
    expect(await rememberedLiability(again, T0 + 2)).toBe('fresh');
    expect(again).not.toHaveBeenCalled();
  });
});
