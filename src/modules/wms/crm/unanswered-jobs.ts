import type PgBoss from 'pg-boss';
import { logger } from '../../platform/logger';
import { remindUnanswered } from './unanswered';

export const JOB_UNANSWERED = 'crm.unanswered';

/**
 * The waiting-customer watch (staff bot, round 36).
 *
 * Every five minutes, like the calc lateness sweep and for the same reason:
 * the threshold is measured in MINUTES, and a reminder that arrives the next
 * morning is an anecdote. The sweep itself is cheap — a partial index over
 * unanswered incoming messages — and does nothing at all when the owner sets
 * the threshold to 0.
 */
export async function registerUnansweredWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_UNANSWERED);
  await boss.schedule(JOB_UNANSWERED, '*/5 * * * *');
  await boss.work(JOB_UNANSWERED, async () => {
    try {
      const sent = await remindUnanswered();
      if (sent > 0) logger.info({ sent }, 'unanswered client reminders sent');
    } catch (err) {
      logger.error({ err }, 'unanswered sweep failed');
      throw err;
    }
  });
}
