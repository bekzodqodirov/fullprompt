import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

/**
 * Google Drive, just enough of it to keep a copy of the database off the VPS.
 *
 * WHY OAUTH AND NOT A SERVICE ACCOUNT — the obvious design, and it does not
 * work. Since 1 June 2023 a service account has a ZERO-byte Drive quota and
 * owns whatever it creates, so uploading into a folder a personal Gmail
 * account shared with it fails at the write with
 * `403 storageQuotaExceeded: "Service Accounts do not have storage quota"`.
 * Google's own remedies — shared drives, domain-wide delegation — are both
 * Google Workspace features and do not exist on a personal account. The
 * failure is the nastiest possible shape: auth succeeds, listing the folder
 * succeeds, and only the write fails, so the setup looks finished and there
 * is no backup at all. Every tutorial saying "just share the folder with the
 * service account" was written before mid-2023 and was true then.
 *
 * WHY `drive.file` AND NOTHING WIDER — two reasons that turn out to be one
 * decision. It is the least power that does the job (create, list and delete
 * only the app's OWN files, never the owner's photographs and contracts), and
 * it is classified non-sensitive, which is what lets the consent screen be
 * published to production instantly with no Google verification. The full
 * `drive` scope is restricted: it needs verification plus a paid annual
 * security assessment, which a twenty-person cargo company will not do — so
 * the app would stay in "Testing", and a refresh token issued in Testing
 * EXPIRES AFTER SEVEN DAYS. Scope and token lifetime are the same choice.
 *
 * The consequence for setup, and it is order-dependent: the app must be
 * published BEFORE the refresh token is minted. The seven-day clock is set at
 * the moment of consent, so publishing afterwards does not rescue a token
 * already issued. See docs/BACKUP.md.
 *
 * `drive.file` also cannot see a folder made by hand in the Drive web UI —
 * only files the app itself created — so this creates its own folder and
 * finds it again by name. That means there is no folder id to copy anywhere
 * and nothing to keep in step.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderName: string;
}

export interface DriveFile {
  id: string;
  name: string;
  size: number;
  createdTime: string;
}

/** Injected so the tests can drive every branch without a Google account. */
export type Fetcher = typeof fetch;

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DriveError';
  }
}

/**
 * Read the configuration from the environment, or say it is not set up.
 *
 * Returning null rather than throwing is the point: offsite backup is opt-in,
 * and a server without it must still take its local dump every night without
 * an error in the log that trains people to ignore errors.
 */
export type Env = Record<string, string | undefined>;

export function driveConfig(env: Env = process.env): DriveConfig | null {
  const clientId = env.GDRIVE_CLIENT_ID?.trim();
  const clientSecret = env.GDRIVE_CLIENT_SECRET?.trim();
  const refreshToken = env.GDRIVE_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) return null;
  return {
    clientId,
    clientSecret,
    refreshToken,
    folderName: env.GDRIVE_FOLDER_NAME?.trim() || 'GSR LOGISTICS backup',
  };
}

/**
 * A refresh token buys an access token good for about an hour.
 *
 * `invalid_grant` here is the one failure worth naming in the message rather
 * than passing through: it means the token is dead — expired because the app
 * was left in Testing, or revoked by a password change or a security
 * checkup — and the fix is to run the consent flow again, not to retry.
 */
export async function accessToken(config: DriveConfig, fetcher: Fetcher = fetch): Promise<string> {
  const res = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) {
    if (body.error === 'invalid_grant') {
      throw new DriveError(
        'GDRIVE_REFRESH_TOKEN ishlamayapti (invalid_grant) — token muddati tugagan yoki bekor qilingan. docs/BACKUP.md bo‘yicha qaytadan oling.',
        res.status,
      );
    }
    throw new DriveError(`token olinmadi: ${body.error ?? res.status}`, res.status);
  }
  return body.access_token;
}

async function api(
  token: string,
  url: string,
  init: RequestInit = {},
  fetcher: Fetcher = fetch,
): Promise<Response> {
  const res = await fetcher(url, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new DriveError(`drive ${init.method ?? 'GET'} ${res.status}: ${text.slice(0, 300)}`, res.status);
  }
  return res;
}

/** The app's own folder, made on first use. */
export async function ensureFolder(
  token: string,
  name: string,
  fetcher: Fetcher = fetch,
): Promise<string> {
  const q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const found = (await (
    await api(token, `${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`, {}, fetcher)
  ).json()) as { files?: { id: string }[] };
  if (found.files?.[0]) return found.files[0].id;

  const created = (await (
    await api(
      token,
      `${API}/files?fields=id`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
      },
      fetcher,
    )
  ).json()) as { id: string };
  return created.id;
}

/**
 * Upload one dump, resumably.
 *
 * Resumable rather than multipart because the dump is a few megabytes today
 * and will be hundreds later, and a VPS in Europe uploading to Google over a
 * link that drops halfway should not have to start again. The initiation
 * response carries the session URI in the `Location` header; the bytes go in
 * the PUT that follows.
 *
 * The returned size is what GOOGLE says it stored, not what was sent — the
 * caller compares it against the file on disk. A backup nobody has checked
 * the size of is a file, not a backup.
 */
export async function uploadDump(
  token: string,
  folderId: string,
  filePath: string,
  fetcher: Fetcher = fetch,
): Promise<DriveFile> {
  const bytes = statSync(filePath).size;
  const name = path.basename(filePath);

  const init = await api(
    token,
    `${UPLOAD}?uploadType=resumable&fields=id,name,size,createdTime`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-upload-content-type': 'application/octet-stream',
        'x-upload-content-length': String(bytes),
      },
      body: JSON.stringify({ name, parents: [folderId] }),
    },
    fetcher,
  );
  const session = init.headers.get('location');
  if (!session) throw new DriveError('resumable sessiya URI qaytmadi');

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  const put = await fetcher(session, {
    method: 'PUT',
    headers: { 'content-length': String(bytes), 'content-type': 'application/octet-stream' },
    body: stream,
    // Node requires this when the body is a stream.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  if (!put.ok) {
    const text = await put.text().catch(() => '');
    throw new DriveError(`yuklash ${put.status}: ${text.slice(0, 300)}`, put.status);
  }
  const file = (await put.json()) as { id: string; name: string; size?: string; createdTime: string };
  return {
    id: file.id,
    name: file.name,
    size: Number(file.size ?? 0),
    createdTime: file.createdTime,
  };
}

/** Every dump this app has put in its folder, newest first. */
export async function listDumps(
  token: string,
  folderId: string,
  fetcher: Fetcher = fetch,
): Promise<DriveFile[]> {
  const q = `'${folderId}' in parents and trashed = false`;
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const url =
      `${API}/files?q=${encodeURIComponent(q)}` +
      `&fields=nextPageToken,files(id,name,size,createdTime)&pageSize=100&orderBy=createdTime desc` +
      (pageToken ? `&pageToken=${pageToken}` : '');
    const page = (await (await api(token, url, {}, fetcher)).json()) as {
      files?: { id: string; name: string; size?: string; createdTime: string }[];
      nextPageToken?: string;
    };
    for (const f of page.files ?? []) {
      out.push({ id: f.id, name: f.name, size: Number(f.size ?? 0), createdTime: f.createdTime });
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Delete for real, not into the trash.
 *
 * A trashed file goes on consuming the account's 15 GB, so pruning that way
 * frees nothing: the quota fills on schedule while the log says retention is
 * working. `files.delete` is permanent — which is correct here and is also
 * why this only ever runs against files the app created itself.
 */
export async function deleteFile(
  token: string,
  fileId: string,
  fetcher: Fetcher = fetch,
): Promise<void> {
  await api(token, `${API}/files/${fileId}`, { method: 'DELETE' }, fetcher);
}

/**
 * Which of these should be dropped to keep `keep` of them.
 *
 * A pure function so the retention rule can be tested without a Google
 * account, and so the thing that DELETES BACKUPS is something a person can
 * read in one sitting. Newest are kept; anything that is not a dump this app
 * recognises is left strictly alone.
 */
export function dumpsToPrune(files: DriveFile[], keep: number): DriveFile[] {
  const dumps = files
    .filter((f) => /^gsr-[\w-]+\.dump$/.test(f.name))
    .sort((a, b) => b.createdTime.localeCompare(a.createdTime));
  return keep <= 0 ? [] : dumps.slice(keep);
}
