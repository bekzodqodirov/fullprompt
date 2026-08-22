/**
 * Bring the photographs back: `pnpm restore-objects`.
 *
 * The half of a backup that is usually written on the day it is needed. Run
 * it AFTER the database dump has been restored, because the file names in the
 * backup carry the storage KEY and the content type lives on `attachments`.
 *
 * Thumbnails are deliberately not in the backup — they are derived, and
 * copying them would have roughly doubled the bytes to buy back something
 * that can be rebuilt. `--thumbs` regenerates them here once the originals
 * are home.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { db } from '../src/modules/platform/db/client';
import { attachments } from '../src/modules/platform/db/schema';
import { getStorage } from '../src/modules/platform/files/storage';
import {
  accessToken,
  downloadFile,
  driveConfig,
  ensureFolder,
  listDumps,
} from '../src/modules/platform/backup/gdrive';
import {
  backupS3Client,
  backupS3Config,
} from '../src/modules/platform/backup/s3';
import { storageKeyFromFileName } from '../src/modules/platform/backup/objects';
import { generateThumbnails } from '../src/modules/platform/jobs/thumbnails';
import { runPooled } from '../src/components/pooled';

const withThumbs = process.argv.includes('--thumbs');

async function contentTypeFor(key: string): Promise<string> {
  const row = await db.query.attachments.findFirst({
    columns: { contentType: true },
    where: eq(attachments.storageKey, key),
  });
  return row?.contentType ?? 'application/octet-stream';
}

async function restoreFromDrive(): Promise<number> {
  const config = driveConfig();
  if (!config) return -1;
  const token = await accessToken(config);
  const folder = await ensureFolder(token, `${config.folderName} fayllar`);
  const files = await listDumps(token, folder);
  const storage = getStorage();
  let done = 0;
  await runPooled(files, 3, async (file) => {
    const key = storageKeyFromFileName(file.name);
    const body = await downloadFile(token, file.id);
    await storage.put(key, body, await contentTypeFor(key));
    done += 1;
    if (done % 100 === 0) console.log(`   ${done}/${files.length}`);
  });
  return done;
}

async function restoreFromS3(): Promise<number> {
  const config = backupS3Config();
  if (!config) return -1;
  const client = backupS3Client(config);
  const storage = getStorage();
  const prefix = `${config.prefix}/objects/`;
  let token: string | undefined;
  let done = 0;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: token }),
    );
    const keys = (page.Contents ?? []).map((o) => o.Key!).filter(Boolean);
    await runPooled(keys, 3, async (objectKey) => {
      const key = objectKey.slice(prefix.length);
      const got = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: objectKey }),
      );
      const body = Buffer.from(await got.Body!.transformToByteArray());
      await storage.put(key, body, await contentTypeFor(key));
      done += 1;
      if (done % 100 === 0) console.log(`   ${done}`);
    });
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  client.destroy();
  return done;
}

async function main() {
  // Same precedence the backup itself uses, so a restore reads from wherever
  // the copies were written (see offsite.ts).
  let restored = await restoreFromS3();
  if (restored < 0) restored = await restoreFromDrive();
  if (restored < 0) {
    console.error('❌ zaxira manzili sozlanmagan (.env) — qayerdan tiklashni bilmayman');
    process.exit(1);
  }
  console.log(`✅ ${restored} ta fayl tiklandi`);

  if (withThumbs) {
    const photos = await db.query.attachments.findMany({
      columns: { id: true },
      where: eq(attachments.kind, 'photo'),
    });
    console.log(`kichik nusxalar qayta yaratilmoqda: ${photos.length} ta rasm`);
    let n = 0;
    await runPooled(photos, 3, async (photo) => {
      await generateThumbnails(photo.id);
      n += 1;
      if (n % 100 === 0) console.log(`   ${n}/${photos.length}`);
    });
    console.log(`✅ ${n} ta kichik nusxa tayyor`);
  }
  process.exit(0);
}

void main();
