import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backupS3Client,
  backupS3Config,
  deleteStoredDump,
  listStoredDumps,
  uploadDumpToS3,
  type BackupS3Config,
} from '@/modules/platform/backup/s3';

/**
 * The off-site upload against a stand-in bucket.
 *
 * There is no S3 in this container — no MinIO, no network — and the round-9
 * Google Drive path was shipped without ever making a single real request,
 * which is why nobody found out for months that it needed a published OAuth
 * app. So this speaks the protocol at a server of our own: the SDK signs and
 * sends exactly what it would send to Contabo, and the assertions are about
 * the WIRE — path-style addressing, a declared content length, the HEAD that
 * verifies the stored size, the paged listing, the delete.
 *
 * It is the shape `scripts/dev-call-audio-probe.mjs` took for the calls APK,
 * and it catches the class of bug that only appears against a real bucket:
 * `forcePathStyle` off would ask for `bucket.127.0.0.1`, which fails as DNS.
 */

interface StoredObject {
  body: Buffer;
  modified: Date;
}

const objects = new Map<string, StoredObject>();
/** Keys the stand-in under-reports on HEAD — a truncated upload, on demand. */
const lieAboutSize = new Set<string>();
/** Every request path the SDK actually asked for, so the test can read them. */
const seenPaths: string[] = [];
/** The last PUT's headers — the wire shape is half of what this file proves. */
let putHeaders: Record<string, string | undefined> = {};
let server: Server;
let config: BackupS3Config;
let dir: string;

function xmlList(prefix: string, token: string | null): string {
  const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  // Deliberately ONE key per page: the paging loop is the part that silently
  // stops pruning when a bucket outgrows a single response.
  const start = token ? keys.indexOf(token) + 1 : 0;
  const page = keys.slice(start, start + 1);
  const next = keys[start + 1];
  const contents = page
    .map((key) => {
      const obj = objects.get(key)!;
      return `<Contents><Key>${key}</Key><Size>${obj.body.length}</Size><LastModified>${obj.modified.toISOString()}</LastModified></Contents>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>gsr</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${page[page.length - 1]}</NextContinuationToken>` : ''}${contents}</ListBucketResult>`;
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  seenPaths.push(url.pathname);
  // Path-style: /<bucket>/<key…>. Anything else means the client tried to put
  // the bucket in the hostname, which no S3 clone serves.
  const [, bucket, ...rest] = url.pathname.split('/');
  const key = rest.join('/');

  if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
    const body = xmlList(
      url.searchParams.get('prefix') ?? '',
      url.searchParams.get('continuation-token'),
    );
    res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
    return;
  }
  if (req.method === 'PUT') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      // The SDK must declare a length; several S3 clones refuse the chunked
      // fallback outright, so a missing header here is a real failure.
      if (!req.headers['content-length']) {
        res.writeHead(411).end('Length Required');
        return;
      }
      putHeaders = {
        'content-length': req.headers['content-length'],
        'content-encoding': req.headers['content-encoding'],
      };
      objects.set(key, { body: Buffer.concat(chunks), modified: new Date() });
      res.writeHead(200, { ETag: '"x"' }).end();
    });
    return;
  }
  if (req.method === 'HEAD') {
    const obj = objects.get(key);
    if (!obj) {
      res.writeHead(404).end();
      return;
    }
    const bytes = lieAboutSize.has(key) ? Math.floor(obj.body.length / 2) : obj.body.length;
    res.writeHead(200, { 'content-length': String(bytes) }).end();
    return;
  }
  if (req.method === 'DELETE') {
    objects.delete(key);
    res.writeHead(204).end();
    return;
  }
  res.writeHead(400).end(`unexpected ${req.method} ${bucket}`);
}

beforeAll(async () => {
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  config = backupS3Config({
    BACKUP_S3_ENDPOINT: `http://127.0.0.1:${port}`,
    BACKUP_S3_BUCKET: 'gsr',
    BACKUP_S3_KEY: 'k',
    BACKUP_S3_SECRET: 's',
    BACKUP_S3_PREFIX: 'nusxa',
  })!;
  dir = mkdtempSync(path.join(tmpdir(), 'gsr-backup-'));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeDump(name: string, bytes: number): string {
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

describe('the dump reaches the bucket, and we can say how big it is', () => {
  it('uploads path-style, under the prefix, and verifies the stored size', async () => {
    const client = backupS3Client(config);
    const file = makeDump('gsr-2026-08-09.dump', 4096);
    const result = await uploadDumpToS3(client, config, file);

    expect(result.bytes).toBe(4096);
    expect(result.key).toBe('nusxa/gsr-2026-08-09.dump');
    expect(objects.get('nusxa/gsr-2026-08-09.dump')?.body.length).toBe(4096);
    // The bucket name is in the PATH, never in the hostname — the whole
    // reason `forcePathStyle` is not optional against a non-AWS endpoint.
    expect(seenPaths.some((p) => p.startsWith('/gsr/nusxa/'))).toBe(true);
    // …and it arrived as a plain body with a declared length, not as
    // `aws-chunked` with a trailing checksum: 4140 bytes of chunk framing for
    // 4096 bytes of dump is what the SDK sends by default, and what several
    // S3-compatible providers refuse.
    expect(putHeaders['content-length']).toBe('4096');
    expect(putHeaders['content-encoding']).toBeUndefined();
    client.destroy();
  });

  it('refuses an empty dump before it ever reaches the network', async () => {
    const client = backupS3Client(config);
    const empty = makeDump('empty.dump', 0);
    await expect(uploadDumpToS3(client, config, empty)).rejects.toThrow(/bo‘sh/);
    client.destroy();
  });

  it('fails when the bucket stored a different number of bytes', async () => {
    // A socket closing mid-stream leaves an object with the right NAME and
    // the wrong contents, which is worse than no object at all — the name is
    // what anybody looks for, and a backup nobody has checked the size of is
    // just a file.
    const client = backupS3Client(config);
    lieAboutSize.add('nusxa/short.dump');
    try {
      await expect(uploadDumpToS3(client, config, makeDump('short.dump', 2048))).rejects.toThrow(
        /hajm mos kelmadi/,
      );
    } finally {
      lieAboutSize.delete('nusxa/short.dump');
      client.destroy();
    }
  });

  it('lists across pages and deletes what it is told to', async () => {
    const client = backupS3Client(config);
    for (const name of ['a.dump', 'b.dump', 'c.dump']) {
      await uploadDumpToS3(client, config, makeDump(name, 512));
    }
    const listed = await listStoredDumps(client, config);
    // One key per page from the stand-in, so anything less than the full set
    // means the continuation token was dropped.
    expect(listed.length).toBeGreaterThanOrEqual(4);
    expect(listed.map((d) => d.key)).toContain('nusxa/a.dump');

    await deleteStoredDump(client, config, 'nusxa/a.dump');
    expect(objects.has('nusxa/a.dump')).toBe(false);
    client.destroy();
  });
});
