import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DriveError,
  accessToken,
  driveConfig,
  dumpsToPrune,
  ensureFolder,
  type DriveFile,
} from '@/modules/platform/backup/gdrive';
import { runOffsiteBackup } from '@/modules/platform/backup/offsite';

/**
 * The off-site backup, tested without a Google account.
 *
 * Every call goes through an injected `fetch`, so the branches that matter —
 * a dead refresh token, a truncated upload, retention — are exercised here
 * rather than discovered on the night the VPS is gone. What CANNOT be tested
 * here is whether Google accepts the credentials at all; that is the one step
 * the owner has to do once, and docs/BACKUP.md says how to check it.
 */

const ENV: Record<string, string | undefined> = {
  GDRIVE_CLIENT_ID: 'id',
  GDRIVE_CLIENT_SECRET: 'secret',
  GDRIVE_REFRESH_TOKEN: 'refresh',
};

function dumpFile(bytes: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gsr-backup-'));
  const file = path.join(dir, 'gsr-2026-07-27.dump');
  writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
}

/** A Drive that behaves, with hooks for the ways it can misbehave. */
function fakeDrive(opts: { storedSize?: number; existing?: DriveFile[]; tokenError?: string } = {}) {
  const deleted: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.includes('oauth2.googleapis.com/token')) {
      if (opts.tokenError) {
        return new Response(JSON.stringify({ error: opts.tokenError }), { status: 400 });
      }
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599 }), { status: 200 });
    }
    // Folder lookup — matched on the folder MIME type, not on the word
    // "folder": the retention query contains the folder id, so a looser match
    // swallowed it and returned an empty list, which is how the prune test
    // first "passed" while listing nothing at all.
    if (url.includes('/drive/v3/files?q=') && decodeURIComponent(url).includes('apps.folder')) {
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    }
    if (url.includes('/drive/v3/files?fields=id') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'folder-1' }), { status: 200 });
    }
    // Resumable initiation → session URI in the Location header.
    if (url.includes('/upload/drive/v3/files') && method === 'POST') {
      return new Response(null, { status: 200, headers: { location: 'https://upload.test/session' } });
    }
    if (url === 'https://upload.test/session' && method === 'PUT') {
      const sent = Number(init?.headers && (init.headers as Record<string, string>)['content-length']);
      return new Response(
        JSON.stringify({
          id: 'file-1',
          name: 'gsr-2026-07-27.dump',
          size: String(opts.storedSize ?? sent),
          createdTime: '2026-07-27T21:00:00Z',
        }),
        { status: 200 },
      );
    }
    // Listing the folder for retention. Matched on the DECODED query, because
    // encodeURIComponent renders the spaces as %20 and a literal-string match
    // silently never fires — which is how the first version of this fake
    // "passed" the prune test by never listing anything.
    if (url.includes('/drive/v3/files?q=') && decodeURIComponent(url).includes('in parents')) {
      return new Response(
        JSON.stringify({
          files: (opts.existing ?? []).map((f) => ({ ...f, size: String(f.size) })),
        }),
        { status: 200 },
      );
    }
    if (url.includes('/drive/v3/files/') && method === 'DELETE') {
      deleted.push(url.split('/').pop()!);
      return new Response(null, { status: 204 });
    }
    return new Response('unexpected ' + url, { status: 500 });
  }) as typeof fetch;
  return { fetcher, deleted };
}

describe('configuration', () => {
  it('is off unless all three secrets are present', () => {
    expect(driveConfig({})).toBeNull();
    expect(driveConfig({ GDRIVE_CLIENT_ID: 'a' })).toBeNull();
    expect(driveConfig({ ...ENV, GDRIVE_REFRESH_TOKEN: '  ' })).toBeNull();
    expect(driveConfig(ENV)).not.toBeNull();
  });

  it('names the folder itself, so there is no id to copy anywhere', () => {
    // drive.file cannot see a folder made by hand in the Drive web UI, so the
    // app creates and finds its own — one less thing to keep in step.
    expect(driveConfig(ENV)!.folderName).toBe('GSR LOGISTICS backup');
    expect(driveConfig({ ...ENV, GDRIVE_FOLDER_NAME: 'Arxiv' })!.folderName).toBe('Arxiv');
  });
});

describe('a dead refresh token', () => {
  it('says what actually has to be done, not "400"', async () => {
    // The token expiring is the single most likely way this stops working —
    // an app left in "Testing" issues one that dies after seven days — and
    // the fix is to re-run the consent flow, never to retry.
    const { fetcher } = fakeDrive({ tokenError: 'invalid_grant' });
    await expect(accessToken(driveConfig(ENV)!, fetcher)).rejects.toThrowError(DriveError);
    await expect(accessToken(driveConfig(ENV)!, fetcher)).rejects.toThrowError(/invalid_grant/);
    await expect(accessToken(driveConfig(ENV)!, fetcher)).rejects.toThrowError(/BACKUP\.md/);
  });
});

describe('the folder', () => {
  it('is created when it is not there yet', async () => {
    const { fetcher } = fakeDrive();
    expect(await ensureFolder('at', 'GSR LOGISTICS backup', fetcher)).toBe('folder-1');
  });
});

describe('retention', () => {
  const file = (name: string, day: string): DriveFile => ({
    id: name,
    name,
    size: 10,
    createdTime: `2026-07-${day}T21:00:00Z`,
  });

  it('keeps the newest N and drops the rest', () => {
    const files = [
      file('gsr-2026-07-27.dump', '27'),
      file('gsr-2026-07-26.dump', '26'),
      file('gsr-2026-07-25.dump', '25'),
    ];
    expect(dumpsToPrune(files, 2).map((f) => f.name)).toEqual(['gsr-2026-07-25.dump']);
    expect(dumpsToPrune(files, 5)).toEqual([]);
  });

  it('never touches a file it does not recognise as its own dump', () => {
    // This function DELETES BACKUPS. Anything that is not a dump this app
    // wrote is left strictly alone, whatever the retention number says.
    const files = [
      file('gsr-2026-07-27.dump', '27'),
      { id: 'x', name: 'muhim-hujjat.pdf', size: 1, createdTime: '2020-01-01T00:00:00Z' },
    ];
    expect(dumpsToPrune(files, 0)).toEqual([]);
    expect(dumpsToPrune(files, 1)).toEqual([]);
  });

  it('accepts both naming schemes, because two writers produce both', () => {
    const files = [
      file('gsr-2026-07-27.dump', '27'),
      { id: 'sh', name: 'gsr-20260726-210000.dump', size: 5, createdTime: '2026-07-26T21:00:00Z' },
    ];
    expect(dumpsToPrune(files, 1).map((f) => f.name)).toEqual(['gsr-20260726-210000.dump']);
  });
});

describe('the nightly upload', () => {
  it('does nothing, loudly enough, when it is not configured', async () => {
    const result = await runOffsiteBackup(dumpFile(10), fakeDrive().fetcher, {});
    expect(result).toEqual({ ok: true, skipped: true, reason: 'not_configured' });
  });

  it('uploads, and reports the size Google says it stored', async () => {
    const { fetcher } = fakeDrive();
    const result = await runOffsiteBackup(dumpFile(2048), fetcher, ENV);
    expect(result).toMatchObject({ ok: true, skipped: false, bytes: 2048 });
  });

  it('FAILS when Drive stored fewer bytes than the disk holds', async () => {
    // A truncated upload is the failure that looks like success: a file with
    // the right name, in the right folder, that cannot be restored. The size
    // is checked against Google's own answer, and a mismatch fails the job.
    const { fetcher } = fakeDrive({ storedSize: 999 });
    const result = await runOffsiteBackup(dumpFile(2048), fetcher, ENV);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/hajm mos kelmadi/);
  });

  it('refuses to upload an empty dump', async () => {
    const result = await runOffsiteBackup(dumpFile(0), fakeDrive().fetcher, ENV);
    expect(result.ok).toBe(false);
  });

  it('prunes only after the new copy has landed and been checked', async () => {
    const { fetcher, deleted } = fakeDrive({
      existing: [
        { id: 'old-1', name: 'gsr-2026-06-01.dump', size: 9, createdTime: '2026-06-01T21:00:00Z' },
        { id: 'new-1', name: 'gsr-2026-07-27.dump', size: 9, createdTime: '2026-07-27T21:00:00Z' },
      ],
    });
    const result = await runOffsiteBackup(dumpFile(64), fetcher, { ...ENV, GDRIVE_RETENTION: '1' });
    expect(result.ok).toBe(true);
    expect(deleted).toEqual(['old-1']);
  });

  it('deletes nothing on a night the upload failed', async () => {
    // The rule that matters most: never drop yesterday's copy because today's
    // did not arrive.
    const { fetcher, deleted } = fakeDrive({
      storedSize: 1,
      existing: [{ id: 'old-1', name: 'gsr-2026-06-01.dump', size: 9, createdTime: '2026-06-01T21:00:00Z' }],
    });
    const result = await runOffsiteBackup(dumpFile(64), fetcher, { ...ENV, GDRIVE_RETENTION: '1' });
    expect(result.ok).toBe(false);
    expect(deleted).toEqual([]);
  });
});
