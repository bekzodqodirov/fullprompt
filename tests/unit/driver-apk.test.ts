import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The driver app is handed out as a PUBLIC download and people are told to
 * switch off "unknown sources" to install it. That makes what gets published
 * here the most trusted file this system serves, so the checks on the way in
 * are the whole point of the module.
 */

// Parameters spelled out so `put.mock.calls` keeps its tuple type and the
// assertions below can index it.
const put = vi.fn(async (_key: string, _body: Buffer, _contentType?: string) => {});
const get = vi.fn(async (_key: string) => Buffer.from(''));
vi.mock('@/modules/platform/files/storage', () => ({
  getStorage: () => ({ put, get, delete: vi.fn(), url: vi.fn() }),
}));

const { publishDriverApk, currentDriverApk, readDriverApk, apkFileName, DriverApkError } =
  await import('@/modules/wms/tracking/driver-apk');

/** A minimal file that begins like every real APK: a ZIP. */
const apkLike = (size = 64) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(size)]);

beforeEach(() => {
  put.mockClear();
  get.mockReset();
});

describe('what may be published', () => {
  it('accepts a real APK and records what was published', async () => {
    const meta = await publishDriverApk(apkLike(), { version: ' 1.2 ', uploadedBy: 'u1' });
    expect(meta.version).toBe('1.2');
    expect(meta.sizeBytes).toBe(68);
    expect(meta.uploadedBy).toBe('u1');

    // The binary first, then its description: a description of a build nobody
    // can download is worse than no description.
    expect(put.mock.calls[0]![0]).toBe('driver-app/current.apk');
    expect(put.mock.calls[0]![2]).toBe('application/vnd.android.package-archive');
    expect(put.mock.calls[1]![0]).toBe('driver-app/current.json');
  });

  it('refuses a file that is not an APK, whatever it is called', async () => {
    // The name is a claim by whoever uploaded it; the first four bytes are not.
    // A PDF renamed to .apk would otherwise become the file every driver in the
    // company is told to trust.
    await expect(publishDriverApk(Buffer.from('%PDF-1.7 hello'), { version: '1', uploadedBy: 'u' }))
      .rejects.toMatchObject({ reason: 'not_apk' });
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses an empty upload', async () => {
    await expect(publishDriverApk(Buffer.alloc(0), { version: '1', uploadedBy: 'u' }))
      .rejects.toBeInstanceOf(DriverApkError);
    expect(put).not.toHaveBeenCalled();
  });

  it('refuses something big enough to fill the disk the database is on', async () => {
    const huge = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(151 * 1024 * 1024)]);
    await expect(publishDriverApk(huge, { version: '1', uploadedBy: 'u' }))
      .rejects.toMatchObject({ reason: 'too_large' });
    expect(put).not.toHaveBeenCalled();
  });

  it('never leaves the version blank on the download page', async () => {
    const meta = await publishDriverApk(apkLike(), { version: '   ', uploadedBy: 'u' });
    expect(meta.version).toBe('—');
  });
});

describe('what is served', () => {
  it('reports nothing published rather than throwing at the page', async () => {
    // Storage says the object is not there — on a fresh server it never has
    // been. The download page has to render that as "not uploaded yet", not
    // as a 500 in a driver's face.
    get.mockRejectedValue(new Error('NoSuchKey'));
    expect(await currentDriverApk()).toBeNull();
    expect(await readDriverApk()).toBeNull();
  });

  it('gives the file a name carrying the version', async () => {
    expect(apkFileName({ version: '1.2', sizeBytes: 1, uploadedAt: '', uploadedBy: '' }))
      .toBe('GSRDriver-1.2.apk');
  });

  it('cannot be talked into a filename with a path or a quote in it', async () => {
    // The version is typed by a person and lands inside a `filename="…"`
    // header; anything but the safe set is dropped rather than escaped.
    const name = apkFileName({
      version: '../../etc/pa"sswd',
      sizeBytes: 1,
      uploadedAt: '',
      uploadedBy: '',
    });
    expect(name).not.toContain('/');
    expect(name).not.toContain('"');
    expect(name).toMatch(/^GSRDriver-[\w.-]*\.apk$/);
  });

  it('still has a name when nothing is published', () => {
    expect(apkFileName(null)).toBe('GSRDriver.apk');
  });
});
