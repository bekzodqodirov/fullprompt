import type PgBoss from 'pg-boss';
import { logger } from '../../platform/logger';
import { sweepQuietListeners } from './listener-quiet';

export const JOB_LISTENER_QUIET = 'crm.listener-quiet';

/**
 * The quiet-bridge watch (B9). Every five minutes: the threshold is ten, so
 * a finer beat buys nothing, and a coarser one lets a dead listener lose a
 * customer's quarter hour before anybody hears. The sweep reads a handful of
 * account rows and does nothing while every bridge is live.
 */
export async function registerListenerQuietWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_LISTENER_QUIET);
  await boss.schedule(JOB_LISTENER_QUIET, '*/5 * * * *');
  await boss.work(JOB_LISTENER_QUIET, async () => {
    try {
      const { quiet, back } = await sweepQuietListeners();
      if (quiet + back > 0) logger.info({ quiet, back }, 'telegram bridge quiet/back alarms sent');
    } catch (err) {
      logger.error({ err }, 'telegram bridge quiet sweep failed');
      throw err;
    }
  });
}
