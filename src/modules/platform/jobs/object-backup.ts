import type PgBoss from 'pg-boss';
import { logger } from '../logger';
import { alertAdmins } from './backup';

export const JOB_OBJECT_BACKUP = 'files.backup';

/**
 * The photographs, nightly, half an hour behind the database dump.
 *
 * A JOB OF ITS OWN and not a second half of the backup job, deliberately: the
 * dump is the thing that carries the money and the cargo, and a photograph
 * that would not upload must never fail — and so retry, and so re-take — the
 * job that ships it. Half an hour is enough for the dump to be safely away
 * before tens of thousands of small uploads start competing for the same
 * uplink.
 *
 * The run is bounded by a wall clock rather than a count (see objects.ts), so
 * the first night after this deploys does not run until morning; the ledger
 * means the next night continues exactly where it stopped, and the backlog
 * drains over however many nights it takes. `remaining` is in every log line
 * for that reason — it is the only number that says whether this is working.
 */
export async function registerObjectBackupWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_OBJECT_BACKUP);
  await boss.schedule(JOB_OBJECT_BACKUP, '30 21 * * *');
  await boss.work(JOB_OBJECT_BACKUP, async () => {
    const { runObjectBackup } = await import('../backup/objects');
    const result = await runObjectBackup();

    if (!result.ok) {
      logger.error({ error: result.error }, 'object backup FAILED');
      await alertAdmins('BackupFailed', { error: `Fayllar: ${result.error}` });
      throw new Error(result.error);
    }
    if (result.skipped) {
      logger.warn('object backup not configured — the photographs exist on this disk only');
      return;
    }

    logger.info(
      {
        where: result.where,
        copied: result.copied,
        bytes: result.bytes,
        failed: result.failed,
        remaining: result.remaining,
        stoppedBecause: result.stoppedBecause,
      },
      'object backup ok',
    );

    // Running out of room is the one stop worth waking somebody for: the
    // backlog stops draining and stays stopped until a person buys space or
    // changes destination, and every night after this one is silent progress
    // that is not happening.
    if (result.stoppedBecause === 'quota') {
      await alertAdmins('BackupFailed', {
        error: `Fayllar zaxirasi to‘xtadi: joy tugadi. ${result.remaining} ta fayl hali ko‘chirilmagan.`,
      });
    }
  });
}
