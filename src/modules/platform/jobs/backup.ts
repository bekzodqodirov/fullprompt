import type PgBoss from 'pg-boss';
import { logger } from '../logger';

export const JOB_NIGHTLY_BACKUP = 'db.backup';

/**
 * Nightly pg_dump at 02:00 Tashkent (21:00 UTC) to a local folder (owner's
 * answer: same machine for now, revisit off-site later). Same code path as
 * `pnpm backup`; failures are logged loudly but never crash the app.
 */
export async function registerBackupWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_NIGHTLY_BACKUP);
  await boss.schedule(JOB_NIGHTLY_BACKUP, '0 21 * * *');
  await boss.work(JOB_NIGHTLY_BACKUP, async () => {
    const { runBackup } = await import('../backup/run');
    const result = await runBackup();
    if (result.ok) {
      logger.info({ file: result.file, bytes: result.bytes, pruned: result.pruned }, 'db backup ok');
    } else {
      logger.error({ error: result.error }, 'db backup FAILED');
      throw new Error(result.error);
    }
  });
}
