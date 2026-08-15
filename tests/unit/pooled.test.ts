import { describe, expect, it } from 'vitest';
import { PHOTO_UPLOAD_CONCURRENCY, runPooled } from '@/components/pooled';

/**
 * The receive wizard's photographs used to upload one at a time, so a
 * receipt's ten to twenty pictures cost the SUM of that many
 * compress-then-upload round trips — with the operators in China and the
 * server in Europe, which is where latency dominates (owner, go-live day:
 * «rasimlarni yuklaganda juda sekin yuklayabti»).
 *
 * What has to hold: everything is attempted, never more than `limit` are in
 * flight, and one failure does not take the rest with it.
 */
describe('runPooled', () => {
  it('runs every item and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    const items = Array.from({ length: 20 }, (_unused, i) => i);

    await runPooled(items, 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      done.push(item);
      inFlight -= 1;
    });

    expect(done.sort((a, b) => a - b)).toEqual(items);
    expect(peak, 'never more than the limit at once').toBeLessThanOrEqual(4);
    expect(peak, 'and it really does overlap them').toBeGreaterThan(1);
  });

  it('one failure does not drop the items behind it', async () => {
    // A photo that fails is one photo lost; taking the other nineteen with it
    // would be the operator re-taking the whole receipt.
    const done: number[] = [];
    await runPooled([1, 2, 3, 4, 5], 2, async (item) => {
      if (item === 2) throw new Error('upload failed');
      done.push(item);
    });
    expect(done.sort()).toEqual([1, 3, 4, 5]);
  });

  it('handles fewer items than the limit, and none at all', async () => {
    const done: number[] = [];
    await runPooled([7], 4, async (item) => {
      done.push(item);
    });
    expect(done).toEqual([7]);
    await expect(runPooled([], 4, async () => {})).resolves.toBeUndefined();
  });

  it('the photo concurrency is a small number, deliberately', () => {
    // Bounded for two reasons at once: a warehouse Android compressing twenty
    // 12-megapixel photographs in parallel runs out of memory, and twenty
    // simultaneous uploads on a thin link finish later than four.
    expect(PHOTO_UPLOAD_CONCURRENCY).toBeGreaterThan(1);
    expect(PHOTO_UPLOAD_CONCURRENCY).toBeLessThanOrEqual(6);
  });
});
