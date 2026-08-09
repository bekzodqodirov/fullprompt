import type PgBoss from 'pg-boss';
import { logger } from '../logger';
import { runStaleAutomation } from './service';

export const JOB_AUTOMATION_STALE = 'automation.stale';

/**
 * The clock behind the two time triggers (round 86).
 *
 * HOURLY, and during working hours only. The threshold is measured in DAYS,
 * so a sweep every minute would buy nothing, and the two things a rule can do
 * are open a task and send a Telegram message — a message at 04:00 is worse
 * than the same message at 09:00, and nobody reads a task before they wake up.
 * `9-19` is the Tashkent office day expressed in UTC (+5): 04:00–14:00 UTC.
 * The container runs on UTC, and stating the conversion here is cheaper than
 * discovering it from a colleague's night-time notification.
 *
 * Nothing is lost by sleeping: a card that went quiet at midnight is just as
 * quiet at nine, and `staleCandidates` orders by how long it has been sitting.
 */
export async function registerStaleAutomationWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_AUTOMATION_STALE);
  await boss.schedule(JOB_AUTOMATION_STALE, '20 4-14 * * *');
  await boss.work(JOB_AUTOMATION_STALE, async () => {
    try {
      const fired = await runStaleAutomation();
      if (fired > 0) logger.info({ fired }, 'stale automation rules fired');
    } catch (err) {
      logger.error({ err }, 'stale automation sweep failed');
      throw err;
    }
  });
}
