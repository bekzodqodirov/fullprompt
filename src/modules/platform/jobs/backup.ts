import type PgBoss from 'pg-boss';
import { logger } from '../logger';

export const JOB_NIGHTLY_BACKUP = 'db.backup';

/**
 * Nightly pg_dump at 02:00 Tashkent (21:00 UTC), then a copy somewhere the
 * loss of this machine cannot reach: an S3-compatible bucket, or the older
 * Google Drive path when that is what is configured.
 *
 * The offsite half is what makes this a backup rather than a second file on
 * the same disk: until it existed, the dump lived in a docker volume on the
 * very machine whose loss it was supposed to survive. It is opt-in — a server
 * with no off-site credentials takes its local dump and says so — but when it
 * IS configured, an upload that fails fails the JOB, because a backup believed
 * to be off-site and silently not there is worse than one nobody claimed.
 */
export async function registerBackupWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_NIGHTLY_BACKUP);
  await boss.schedule(JOB_NIGHTLY_BACKUP, '0 21 * * *');
  await boss.work(JOB_NIGHTLY_BACKUP, async () => {
    const { runBackup } = await import('../backup/run');
    const result = await runBackup();
    if (!result.ok) {
      logger.error({ error: result.error }, 'db backup FAILED');
      await alertAdmins('BackupFailed', { error: result.error });
      throw new Error(result.error);
    }
    logger.info({ file: result.file, bytes: result.bytes, pruned: result.pruned }, 'db backup ok');

    const { runOffsiteBackup } = await import('../backup/offsite');
    const offsite = await runOffsiteBackup(result.file);
    if (!offsite.ok) {
      logger.error({ error: offsite.error }, 'offsite backup FAILED');
      await alertAdmins('BackupFailed', { error: `Off-site: ${offsite.error}` });
      throw new Error(offsite.error);
    }
    if (offsite.skipped) {
      logger.warn('offsite backup not configured — the only copy is on this machine');
    } else {
      logger.info(
        { where: offsite.where, name: offsite.name, bytes: offsite.bytes, pruned: offsite.pruned },
        'offsite ok',
      );
    }
  });
}

/**
 * Tell somebody. The dump failing is the one thing nobody finds out about by
 * using the app — every screen keeps working exactly as before.
 */
async function alertAdmins(type: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const { db } = await import('../db/client');
    const { notifications, roles, userRoles } = await import('../db/schema');
    const { eq, inArray } = await import('drizzle-orm');
    const admins = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(inArray(roles.code, ['admin', 'super_admin']));
    for (const adminId of [...new Set(admins.map((a) => a.userId))]) {
      await db.insert(notifications).values({
        userId: adminId,
        channel: 'telegram',
        type,
        payload,
        status: 'pending',
      });
    }
    // Pending rows sit until something drains them — see notifications.ts.
    const { enqueue, JOB_SEND_TELEGRAM } = await import('./boss');
    await enqueue(JOB_SEND_TELEGRAM, {});
  } catch (err) {
    logger.error({ err }, 'could not raise the backup alarm');
  }
}
