import { describe, expect, it, vi } from 'vitest';

/**
 * A push's photograph is read from storage by the ONE sweep that sends every
 * customer's message (round C review, PA-2). The S3 client carries no deadline
 * of its own, so a MinIO that stops answering held every customer behind one
 * picture; the read now has one, and a late read means «the text goes alone».
 */
const hang = vi.fn(() => new Promise<Buffer>(() => {}));
vi.mock('@/modules/platform/files/storage', () => ({
  getStorage: () => ({ get: hang }),
}));

const { loadPhoto } = await import('@/modules/wms/notices/client-push');

describe('loadPhoto', () => {
  it('gives up on a read that never answers', async () => {
    const started = Date.now();
    const photo = await loadPhoto({ storageKey: 'orig', thumb800Key: null, contentType: 'image/jpeg', sizeBytes: 1_000 }, 50);
    expect(photo).toBeNull();
    expect(hang).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('one stalled read and the rest of the sweep goes as text (the verifier on PA-2)', () => {
  it('the breaker trips on the THUMBNAIL and neither the original nor a later push waits again', async () => {
    hang.mockClear();
    const { loadPhoto: load } = await import('@/modules/wms/notices/client-push');
    const breaker = { stalled: false };
    const ref = { storageKey: 'orig', thumb800Key: 'thumb', contentType: 'image/jpeg', sizeBytes: 1_000 };
    expect(await load(ref, 30, breaker)).toBeNull();
    expect(breaker.stalled).toBe(true);
    // Only the thumbnail was waited on: a store that did not answer for it
    // will not answer for the original.
    expect(hang).toHaveBeenCalledTimes(1);
    const started = Date.now();
    expect(await load(ref, 5_000, breaker)).toBeNull();
    expect(hang).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
