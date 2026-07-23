import { eq } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { db } from '../db/client';
import { attachments } from '../db/schema';
import { getStorage } from '../files/storage';
import { logger } from '../logger';
import { JOB_THUMBNAILS } from './boss';

interface ThumbnailJob {
  attachmentId: string;
}

/**
 * Generate 200px and 800px thumbnails for a photo attachment (spec §3
 * Images). EXIF is dropped by re-encoding through sharp.
 */
export async function generateThumbnails(attachmentId: string): Promise<void> {
  const attachment = await db.query.attachments.findFirst({
    where: eq(attachments.id, attachmentId),
  });
  if (!attachment || attachment.kind !== 'photo') return;

  // Lazy import: sharp is a native module and must never be traced into the
  // instrumentation bundle (dev webpack chokes on its child_process usage).
  const sharp = (await import('sharp')).default;

  const storage = getStorage();
  const original = await storage.get(attachment.storageKey);

  const thumb200Key = `${attachment.storageKey}.thumb200.webp`;
  const thumb800Key = `${attachment.storageKey}.thumb800.webp`;

  const [thumb200, thumb800] = await Promise.all([
    sharp(original).rotate().resize(200, 200, { fit: 'inside' }).webp({ quality: 75 }).toBuffer(),
    sharp(original).rotate().resize(800, 800, { fit: 'inside' }).webp({ quality: 80 }).toBuffer(),
  ]);

  await Promise.all([
    storage.put(thumb200Key, thumb200, 'image/webp'),
    storage.put(thumb800Key, thumb800, 'image/webp'),
  ]);

  await db
    .update(attachments)
    .set({ thumb200Key, thumb800Key })
    .where(eq(attachments.id, attachmentId));
}

export async function registerThumbnailWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_THUMBNAILS);
  await boss.work<ThumbnailJob>(JOB_THUMBNAILS, async (jobs) => {
    for (const job of jobs) {
      try {
        await generateThumbnails(job.data.attachmentId);
      } catch (err) {
        logger.error({ err, attachmentId: job.data.attachmentId }, 'thumbnail job failed');
        throw err;
      }
    }
  });
}
