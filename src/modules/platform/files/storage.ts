import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * Did the object store ANSWER, or did nothing come back at all?
 *
 * The AWS SDK carries the service's HTTP status on every error it was given
 * one for; a refused connection, a DNS failure or a timeout carries none.
 * That is the difference between «the store is up and said no» and «the store
 * is not there», and `ensureBucket` is the one place it decides something.
 */
function answeredStatus(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

/**
 * Storage abstraction (spec 4.8): S3/MinIO in production, local disk in dev
 * environments without object storage. All reads go through signed URLs.
 */
export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Remove the object; missing keys are not an error. */
  delete(key: string): Promise<void>;
  /** URL the browser can fetch for a limited time. */
  signedUrl(key: string, expiresSeconds?: number): Promise<string>;
  /** Is the store actually reachable RIGHT NOW — for /api/health. */
  ping(): Promise<void>;
}

class S3Driver implements StorageDriver {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION ?? 'auto',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY ?? '',
        secretAccessKey: process.env.S3_SECRET_KEY ?? '',
      },
    });
    this.bucket = process.env.S3_BUCKET ?? 'gsr-files';
  }

  private ensured = false;

  /**
   * Fresh MinIO ships without our bucket — create it on first write.
   *
   * The latch is set only when this process has actually SEEN the bucket.
   * It used to be set unconditionally, so a storage blip during the first
   * upload after a deploy — MinIO still starting, a network hiccup — latched
   * «ensured» on a failure and every upload for the life of the container
   * then went straight to a `put` against a bucket nobody had confirmed.
   * The cure was restarting the app, which is not a thing a warehouse knows
   * to do at seven in the morning (round 97).
   */
  private async ensureBucket(): Promise<void> {
    if (this.ensured) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.ensured = true;
      return;
    } catch (err) {
      // The store ANSWERED — 403 from restricted AWS creds, 404 for a bucket
      // that is genuinely missing. Either way it is up, so the latch may close
      // and the `put` that follows says whether the bucket works. A network
      // error carries no status: nothing answered, and latching on that is
      // what wedged the container.
      const answered = typeof answeredStatus(err) === 'number';
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket })).catch((e) => {
        if (!answered && typeof answeredStatus(e) !== 'number') throw e;
      });
      this.ensured = true;
    }
  }

  /**
   * Deliberately NOT via ensureBucket(): its once-only latch would make
   * every ping after the first a no-op, and the health endpoint would go
   * straight back to lying — the very thing it is being fixed for.
   */
  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
      abortSignal: AbortSignal.timeout(1500),
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await res.Body!.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async signedUrl(key: string, expiresSeconds = 600): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresSeconds,
    });
  }
}

/**
 * Local-disk driver for dev. "Signed URL" = app route + HMAC token so access
 * control still applies (no directly-served public directory).
 */
class LocalDriver implements StorageDriver {
  private dir = process.env.STORAGE_LOCAL_DIR ?? '.data/files';
  private secret = process.env.SESSION_SECRET ?? 'dev-secret';

  private filePath(key: string): string {
    const safe = createHash('sha256').update(key).digest('hex');
    return path.join(this.dir, safe.slice(0, 2), safe);
  }

  sign(key: string, expiresAt: number): string {
    return createHmac('sha256', this.secret).update(`${key}:${expiresAt}`).digest('base64url');
  }

  async ping(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async put(key: string, body: Buffer): Promise<void> {
    const target = this.filePath(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.filePath(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.filePath(key), { force: true });
  }

  async signedUrl(key: string, expiresSeconds = 600): Promise<string> {
    const expiresAt = Date.now() + expiresSeconds * 1000;
    const sig = this.sign(key, expiresAt);
    return `/api/files/serve?key=${encodeURIComponent(key)}&exp=${expiresAt}&sig=${sig}`;
  }

  verify(key: string, expiresAt: number, sig: string): boolean {
    if (Date.now() > expiresAt) return false;
    return this.sign(key, expiresAt) === sig;
  }
}

const globalForStorage = globalThis as unknown as { storageDriver?: StorageDriver };

export function getStorage(): StorageDriver {
  if (!globalForStorage.storageDriver) {
    globalForStorage.storageDriver =
      (process.env.STORAGE_DRIVER ?? 'local') === 's3' ? new S3Driver() : new LocalDriver();
  }
  return globalForStorage.storageDriver;
}

export function getLocalDriver(): LocalDriver | null {
  const driver = getStorage();
  return driver instanceof LocalDriver ? driver : null;
}
