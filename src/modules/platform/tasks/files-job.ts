import { createHash } from 'node:crypto';
import type PgBoss from 'pg-boss';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { attachments } from '../db/schema';
import { logger } from '../logger';
import { botCall } from '../telegram/send';
import type { DraftFile } from '../telegram/task-draft';

/**
 * A task's files, fetched from Telegram onto the web (his 3a: «travels with
 * the task and shows on the site»).
 *
 * A pg-boss job and not a `void` in the bot (review telegram-mechanics-26):
 * the bot lives in the container the owner restarts on every deploy, and a
 * download cut there left a task on the web without its voice note while the
 * Telegram side still had the forwards — with no row saying a download was
 * owed. A job survives the restart, and a `file_id` stays valid on Telegram
 * for the retry.
 *
 * The bytes are stored as `attachments` of `entity_type = 'task'`. That type
 * is NOT in the upload route's `ATTACHABLE` — that would open the bare-login
 * upload route to any task id — so it has its own read case and its own
 * delete rule (wms/attachments/access.ts, files/service.ts), fenced together.
 */
export const JOB_TASK_FILES = 'tasks.files';

/** The entity type the bot writes a task's files under — one spelling for every reader. */
export const TASK_ENTITY_TYPE = 'task';

export interface TaskFilesJob {
  taskId: string;
  uploadedBy: string;
  files: DraftFile[];
}

/** How long one Telegram file download may take — finite, which is the point. */
const DOWNLOAD_MS = 60_000;

/** The default MIME per kind when Telegram did not say (a photo never says). */
const KIND_MIME: Record<DraftFile['kind'], string> = {
  photo: 'image/jpeg',
  voice: 'audio/ogg',
  audio: 'audio/mpeg',
  video: 'video/mp4',
  video_note: 'video/mp4',
  document: 'application/octet-stream',
};

const KIND_EXT: Record<DraftFile['kind'], string> = {
  photo: 'jpg',
  voice: 'ogg',
  audio: 'mp3',
  video: 'mp4',
  video_note: 'mp4',
  document: 'bin',
};

/**
 * The name a file is SHOWN under on the web — the document's own name, or one
 * made from the kind and the file id's tail. Only a label: two suppliers'
 * «Invoice.pdf» are two files with one name, so the retry fence is
 * `taskFileKey`, never this.
 */
export function taskFileName(file: DraftFile): string {
  if (file.name && file.name.trim()) return file.name.trim().slice(0, 200);
  const tail = file.fileId.replace(/[^A-Za-z0-9_-]/g, '').slice(-16) || 'fayl';
  return `${file.kind}_${tail}.${KIND_EXT[file.kind]}`;
}

/**
 * Where one Telegram file is stored for one task — and the retry fence:
 * pg-boss re-delivers a job whose last file failed, and the files that
 * already landed must not land twice. Keyed on the FILE and not its name: the
 * name fence stored the first of two «Invoice.pdf» and skipped the second as
 * «already here», with nothing in the log (review tasks-6 / bot-6). A hash of
 * the whole file_id, because the id is ~80 characters and the tails of one
 * chat's photos look alike.
 */
export function taskFileKey(file: Pick<DraftFile, 'fileId'>): string {
  return `tg-${createHash('sha256').update(file.fileId).digest('hex').slice(0, 32)}`;
}

/**
 * Download every file of one job. A file Telegram or storage refuses for good
 * (too big, a type the store does not keep) is LOGGED and skipped; a file that
 * failed for a moment throws at the end so pg-boss tries the job again, and
 * the ones already stored are skipped by their FILE (`taskFileKey`).
 */
export async function downloadTaskFiles(job: TaskFilesJob): Promise<{ stored: number; skipped: number }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { stored: 0, skipped: job.files.length };
  const { saveAttachment, FileValidationError } = await import('../files/service');
  let stored = 0;
  let skipped = 0;
  let transient = 0;
  for (const file of job.files) {
    const fileName = taskFileName(file);
    const keyName = taskFileKey(file);
    const [already] = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.storageKey, `${TASK_ENTITY_TYPE}/${job.taskId}/${keyName}`))
      .limit(1);
    if (already) {
      logger.info({ taskId: job.taskId, fileName }, '[task-files] already stored — skipped');
      skipped += 1;
      continue;
    }
    try {
      const meta = await botCall('getFile', { file_id: file.fileId }, 20_000);
      const path = (meta.result as { file_path?: string } | null)?.file_path;
      if (!meta.ok || !path) {
        // 400 = Telegram will not hand this file over (over 20 MB, gone).
        if (meta.status === 400) {
          logger.warn({ taskId: job.taskId, fileName, description: meta.description }, '[task-files] Telegram refused the file');
          skipped += 1;
        } else {
          transient += 1;
        }
        continue;
      }
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
        signal: AbortSignal.timeout(DOWNLOAD_MS),
      });
      if (!res.ok) {
        transient += 1;
        continue;
      }
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length === 0) {
        skipped += 1;
        continue;
      }
      await saveAttachment(
        {
          entityType: TASK_ENTITY_TYPE,
          entityId: job.taskId,
          fileName,
          contentType: file.mime || KIND_MIME[file.kind],
          body,
          uploadedBy: job.uploadedBy,
        },
        { thumbnails: 'enqueue', keyName },
      );
      stored += 1;
    } catch (err) {
      if (err instanceof FileValidationError) {
        logger.warn({ taskId: job.taskId, fileName, code: err.code }, '[task-files] not kept on the web');
        skipped += 1;
      } else {
        logger.warn({ err, taskId: job.taskId, fileName }, '[task-files] download failed — retrying');
        transient += 1;
      }
    }
  }
  if (transient > 0) throw new Error(`${transient} task file(s) not downloaded yet`);
  return { stored, skipped };
}

export async function registerTaskFilesWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_TASK_FILES);
  await boss.work<TaskFilesJob>(JOB_TASK_FILES, async (jobs) => {
    for (const job of jobs) {
      const out = await downloadTaskFiles(job.data);
      logger.info({ taskId: job.data.taskId, ...out }, '[task-files] done');
    }
  });
}
