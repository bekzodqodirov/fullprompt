import { getStorage } from '@/modules/platform/files/storage';
import { logger } from '@/modules/platform/logger';

/**
 * The calls app's build, handed out from inside the system — the driver
 * app's distribution restated for STAFF: the download needs a login (it sits
 * on /profile next to the pairing code), so there is no public page and no
 * QR. Storage is the record: one fixed key, its details beside it, replacing
 * the file is the whole operation.
 */

/** One fixed uuid — a single published build has no id of its own to point
 * at, and `audit_log.entity_id` is a uuid column (the driver app's lesson). */
export const CALLS_APP_AUDIT_ID = 'a7c1b9d0-3e52-5f76-8a91-b2c3d4e5f607';

const APK_KEY = 'calls-app/current.apk';
const META_KEY = 'calls-app/current.json';

/** APKs are ZIP files; every one begins with these four bytes. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export interface CallsApkMeta {
  version: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string;
}

export class CallsApkError extends Error {
  constructor(readonly reason: 'not_apk' | 'too_large' | 'empty') {
    super(reason);
  }
}

/** Far above any real build, far below anything that would fill the VPS. */
const MAX_BYTES = 150 * 1024 * 1024;

export async function publishCallsApk(
  file: Buffer,
  meta: { version: string; uploadedBy: string },
): Promise<CallsApkMeta> {
  if (file.length === 0) throw new CallsApkError('empty');
  if (file.length > MAX_BYTES) throw new CallsApkError('too_large');
  // By CONTENT, not by filename: people are told to trust this file enough
  // to switch off "unknown sources".
  if (!file.subarray(0, 4).equals(ZIP_MAGIC)) throw new CallsApkError('not_apk');

  const record: CallsApkMeta = {
    version: meta.version.trim().slice(0, 40) || '—',
    sizeBytes: file.length,
    uploadedAt: new Date().toISOString(),
    uploadedBy: meta.uploadedBy,
  };
  const storage = getStorage();
  // The APK first: a description of a build nobody can download is worse
  // than no description.
  await storage.put(APK_KEY, file, 'application/vnd.android.package-archive');
  await storage.put(META_KEY, Buffer.from(JSON.stringify(record)), 'application/json');
  return record;
}

export async function currentCallsApk(): Promise<CallsApkMeta | null> {
  try {
    const raw = await getStorage().get(META_KEY);
    return JSON.parse(raw.toString('utf8')) as CallsApkMeta;
  } catch {
    return null;
  }
}

export async function readCallsApk(): Promise<Buffer | null> {
  try {
    return await getStorage().get(APK_KEY);
  } catch (err) {
    logger.warn({ err }, 'calls apk requested but not published');
    return null;
  }
}

/** Version in the name: a Downloads folder ends up holding three of these. */
export function callsApkFileName(meta: CallsApkMeta | null): string {
  const version = (meta?.version ?? '').replace(/[^a-zA-Z0-9._-]/g, '');
  return version ? `GSRCalls-${version}.apk` : 'GSRCalls.apk';
}
