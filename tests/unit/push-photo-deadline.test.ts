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
  it('gives up on a read that never answers — both the thumbnail and the original', async () => {
    const started = Date.now();
    const photo = await loadPhoto(
      { storageKey: 'orig', thumb800Key: 'thumb', contentType: 'image/jpeg', sizeBytes: 1_000 },
      50,
    );
    expect(photo).toBeNull();
    expect(hang).toHaveBeenCalledTimes(2);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
