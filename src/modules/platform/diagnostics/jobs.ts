import type PgBoss from 'pg-boss';
import { logger } from '../logger';
import { pruneSystemErrors } from './errors';
import { checkDisks } from '../backup/disk';

export const JOB_ERRORS_PRUNE = 'system.errors-prune';
export const JOB_DISK = 'system.disk';

/**
 * The error list keeps a month (B9). Once a day, at a quiet hour in Tashkent
 * (03:40 there = 22:40 UTC): the table is a few thousand rows at most, so the
 * clock matters more than the cost.
 */
export async function registerErrorsPruneWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_ERRORS_PRUNE);
  await boss.schedule(JOB_ERRORS_PRUNE, '40 22 * * *');
  await boss.work(JOB_ERRORS_PRUNE, async () => {
    try {
      const removed = await pruneSystemErrors();
      if (removed > 0) logger.info({ removed }, 'old system errors pruned');
    } catch (err) {
      logger.error({ err }, 'system errors prune failed');
      throw err;
    }
  });
}

/**
 * The disk watch (B9). Hourly: a disk fills over days, and a statfs costs
 * nothing — what matters is that the 80 % word arrives while there is still
 * room to act on it.
 */
export async function registerDiskWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_DISK);
  await boss.schedule(JOB_DISK, '17 * * * *');
  await boss.work(JOB_DISK, async () => {
    try {
      const alerted = await checkDisks();
      if (alerted > 0) logger.warn({ alerted }, 'disk filling alarm sent');
    } catch (err) {
      logger.error({ err }, 'disk check failed');
      throw err;
    }
  });
}
