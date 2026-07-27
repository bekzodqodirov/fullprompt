import { getStorage } from '@/modules/platform/files/storage';
import { logger } from '@/modules/platform/logger';

/**
 * The driver app, handed out as a link instead of out of GitHub.
 *
 * Owner: "driver appni gitni ichidan emas 1 link orqali skachat qilib oladgan
 * qilib ber." Until now the APK lived in a CI artifact, which means a GitHub
 * login, a zip, and a file to move onto the driver's phone — three steps the
 * warehouse cannot do while a truck is waiting. Now the warehouse opens
 * `/driver` on any screen and the driver scans the QR.
 *
 * Storage IS the record: the APK sits under one fixed key and its details
 * beside it. No table, no migration, no settings row — there is exactly one
 * current build, replacing it is the whole operation, and a second place to
 * remember it is a second place to disagree.
 */

const APK_KEY = 'driver-app/current.apk';
const META_KEY = 'driver-app/current.json';

/** APKs are ZIP files; every one begins with these four bytes. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export interface DriverApkMeta {
  /** What the warehouse should tell people they are installing, e.g. "1.2". */
  version: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string;
}

export class DriverApkError extends Error {
  constructor(readonly reason: 'not_apk' | 'too_large' | 'empty') {
    super(reason);
  }
}

/**
 * 150 MB.
 *
 * Far above any real build (this one is under 5 MB) and far below anything
 * that would fill the VPS. The point is not the number — it is that an upload
 * form with no ceiling is a way to fill a disk that also holds the database.
 */
const MAX_BYTES = 150 * 1024 * 1024;

export async function publishDriverApk(
  file: Buffer,
  meta: { version: string; uploadedBy: string },
): Promise<DriverApkMeta> {
  if (file.length === 0) throw new DriverApkError('empty');
  if (file.length > MAX_BYTES) throw new DriverApkError('too_large');
  // Checked by CONTENT, not by the name the browser sent: `.apk` on the end of
  // a filename is a claim, and this file is downloaded by people who are told
  // to trust it enough to switch off "unknown sources".
  if (!file.subarray(0, 4).equals(ZIP_MAGIC)) throw new DriverApkError('not_apk');

  const record: DriverApkMeta = {
    version: meta.version.trim().slice(0, 40) || '—',
    sizeBytes: file.length,
    uploadedAt: new Date().toISOString(),
    uploadedBy: meta.uploadedBy,
  };
  const storage = getStorage();
  // The APK first: if this fails there is nothing to describe, and a
  // description of a build nobody can download is worse than no description.
  await storage.put(APK_KEY, file, 'application/vnd.android.package-archive');
  await storage.put(META_KEY, Buffer.from(JSON.stringify(record)), 'application/json');
  return record;
}

/** What is published right now, or null when nothing has been uploaded yet. */
export async function currentDriverApk(): Promise<DriverApkMeta | null> {
  try {
    const raw = await getStorage().get(META_KEY);
    return JSON.parse(raw.toString('utf8')) as DriverApkMeta;
  } catch {
    return null;
  }
}

/** The bytes, for the public download route. */
export async function readDriverApk(): Promise<Buffer | null> {
  try {
    return await getStorage().get(APK_KEY);
  } catch (err) {
    logger.warn({ err }, 'driver apk requested but not published');
    return null;
  }
}

/**
 * The filename the phone will show.
 *
 * Version in the name because a driver's Downloads folder ends up holding
 * three of these, and "which one did I install?" is otherwise unanswerable.
 */
export function apkFileName(meta: DriverApkMeta | null): string {
  const version = (meta?.version ?? '').replace(/[^a-zA-Z0-9._-]/g, '');
  return version ? `GSRDriver-${version}.apk` : 'GSRDriver.apk';
}
