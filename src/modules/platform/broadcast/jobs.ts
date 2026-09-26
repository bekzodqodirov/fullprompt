import type PgBoss from 'pg-boss';
import { logger } from '../logger';
import { runBroadcast } from './send';
import { alertBirthdays } from './birthdays';

export const JOB_BROADCAST = 'broadcast.send';
export const JOB_BIRTHDAYS = 'broadcast.birthdays';

/**
 * One job per broadcast (0109). Sending three hundred chats takes minutes and
 * must survive the office closing the tab, so the page only writes the rows
 * and queues this; a job killed mid-send leaves its claimed chats to the
 * ten-minute reclaim and the next attempt finishes them.
 */
export async function registerBroadcastWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_BROADCAST);
  await boss.work<{ broadcastId: string }>(JOB_BROADCAST, async (jobs) => {
    for (const job of jobs) {
      try {
        const sent = await runBroadcast(job.data.broadcastId);
        logger.info({ broadcastId: job.data.broadcastId, sent }, 'broadcast sent');
      } catch (err) {
        logger.error({ err, broadcastId: job.data.broadcastId }, 'broadcast failed');
        throw err;
      }
    }
  });
}

/**
 * The birthday reminder (0109), at 09:05 Tashkent (04:05 UTC): the morning,
 * when a congratulation still reads as remembered and not as caught up on.
 */
export async function registerBirthdayWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_BIRTHDAYS);
  await boss.schedule(JOB_BIRTHDAYS, '5 4 * * *');
  await boss.work(JOB_BIRTHDAYS, async () => {
    try {
      const sent = await alertBirthdays();
      if (sent > 0) logger.info({ sent }, 'birthday reminders sent');
    } catch (err) {
      logger.error({ err }, 'birthday sweep failed');
      throw err;
    }
  });
}
