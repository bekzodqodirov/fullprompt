import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/**
 * Off-site backup to an S3-compatible bucket — the owner's choice of Contabo
 * Object Storage (round 84: «google drive emas boshqa joy yo'qmi»).
 *
 * Why this rather than the Drive path built in round 9: a Drive refresh token
 * dies after seven days unless the OAuth app is published, has to be minted by
 * hand through a browser, and the whole exchange is bespoke. An S3 key does
 * not expire, is created in one screen, and this system already speaks the
 * protocol — MinIO is what every photograph in it is stored on, and
 * `@aws-sdk/client-s3` was already a dependency. The bucket can be Contabo's,
 * Backblaze's, Yandex's or anybody's: nothing here names a provider.
 *
 * `forcePathStyle` is not optional. Every S3 clone except AWS itself serves
 * `endpoint/bucket/key`, and the default virtual-host style would ask for
 * `bucket.endpoint` — a hostname that does not resolve, failing as DNS rather
 * than as configuration, which is the hardest kind of failure to read.
 */

export interface BackupS3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Everything this server writes lives under one prefix. */
  prefix: string;
}

export type Env = Record<string, string | undefined>;

/**
 * The four things that cannot be guessed. Null unless ALL of them are present:
 * a half-configured destination must read as «not configured» and take the
 * local dump, never as a silent failure to upload.
 */
export function backupS3Config(env: Env = process.env): BackupS3Config | null {
  const endpoint = env.BACKUP_S3_ENDPOINT?.trim();
  const bucket = env.BACKUP_S3_BUCKET?.trim();
  const accessKeyId = env.BACKUP_S3_KEY?.trim();
  const secretAccessKey = env.BACKUP_S3_SECRET?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    // Most S3 clones ignore the region but the SDK refuses to sign without
    // one, so it has a default rather than being a fifth thing to get right.
    region: env.BACKUP_S3_REGION?.trim() || 'auto',
    prefix: (env.BACKUP_S3_PREFIX?.trim() || 'gsr-backups').replace(/^\/+|\/+$/g, ''),
  };
}

export function backupS3Client(config: BackupS3Config): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    // NOT a tuning knob — without it this does not work against Contabo, and
    // measured rather than assumed. Since ~3.729 the SDK computes a CRC32 on
    // every upload by default, and for a STREAM body it delivers that as a
    // trailer: `content-encoding: aws-chunked`,
    // `x-amz-content-sha256: STREAMING-UNSIGNED-PAYLOAD-TRAILER`, no
    // `Content-Length`, and 4140 bytes on the wire for 4096 bytes of dump.
    // Plenty of S3-compatible providers reject that shape outright, and the
    // ones that accept it store the chunk framing. `WHEN_REQUIRED` puts a
    // plain body and a real `Content-Length` back — verified against a
    // stand-in server, which is the only bucket this container has.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * Upload, then ask the bucket how big the object it stored is.
 *
 * The verification is the point, and it is the rule round 9 set for the Drive
 * path: a backup nobody has checked the size of is a file. A truncated upload
 * — a socket closing mid-stream, a quota hit — otherwise leaves an object with
 * the right name and the wrong contents, which is worse than no object at all,
 * because the name is what anybody looks for.
 */
export async function uploadDumpToS3(
  client: S3Client,
  config: BackupS3Config,
  dumpPath: string,
): Promise<{ key: string; bytes: number }> {
  const bytes = statSync(dumpPath).size;
  if (bytes === 0) throw new Error(`dump bo‘sh: ${dumpPath}`);
  const key = `${config.prefix}/${path.basename(dumpPath)}`;

  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: createReadStream(dumpPath),
      // The SDK cannot learn the length of a stream by itself, and without it
      // it would fall back to chunked upload, which several S3 clones refuse.
      ContentLength: bytes,
      ContentType: 'application/octet-stream',
    }),
  );

  const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
  if (head.ContentLength !== bytes) {
    throw new Error(`hajm mos kelmadi: diskda ${bytes} bayt, omborda ${head.ContentLength} bayt`);
  }
  return { key, bytes };
}

/**
 * The same upload for something already in memory — one photograph, one call
 * recording, one attached document.
 *
 * A Buffer rather than a path because objects come back from MinIO as bytes,
 * and writing them to a temporary file first would put a disk that can run
 * out between the object store and its backup. The size check is the dump's
 * rule, unchanged: what the bucket says it stored, never what was sent.
 */
export async function uploadBufferToS3(
  client: S3Client,
  config: BackupS3Config,
  key: string,
  body: Buffer,
): Promise<number> {
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentLength: body.length,
      ContentType: 'application/octet-stream',
    }),
  );
  const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
  if (head.ContentLength !== body.length) {
    throw new Error(`hajm mos kelmadi: ${body.length} bayt yuborildi, ${head.ContentLength} saqlandi`);
  }
  return head.ContentLength ?? 0;
}

export interface StoredDump {
  key: string;
  bytes: number;
  modified: Date;
}

export async function listStoredDumps(
  client: S3Client,
  config: BackupS3Config,
): Promise<StoredDump[]> {
  const out: StoredDump[] = [];
  let token: string | undefined;
  // Paged, because the bucket outlives the retention window if anybody ever
  // raises it, and a silent first-thousand would make pruning stop working
  // exactly when there is most to prune.
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: config.bucket,
        Prefix: `${config.prefix}/`,
        ContinuationToken: token,
      }),
    );
    for (const item of page.Contents ?? []) {
      if (!item.Key || !item.Key.endsWith('.dump')) continue;
      out.push({
        key: item.Key,
        bytes: item.Size ?? 0,
        modified: item.LastModified ?? new Date(0),
      });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/**
 * Which stored dumps are past the retention window.
 *
 * Newest-first, keep N, delete the rest — and sorted by the bucket's own
 * `LastModified` rather than by the filename, because a filename is a claim
 * and a timestamp is a fact. Pure, so the arithmetic is testable without a
 * bucket.
 */
export function dumpsToPrune(dumps: StoredDump[], keep: number): StoredDump[] {
  if (keep <= 0) return [];
  return [...dumps].sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(keep);
}

export async function deleteStoredDump(
  client: S3Client,
  config: BackupS3Config,
  key: string,
): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}
