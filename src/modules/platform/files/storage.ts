import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
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
