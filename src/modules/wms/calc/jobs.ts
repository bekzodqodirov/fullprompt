import type PgBoss from 'pg-boss';
import { logger } from '@/modules/platform/logger';
import { notifyOverdueCalcs } from './service';
import { notifyDictionaryReview } from './review';

export const JOB_CALC_OVERDUE = 'calc.overdue';
export const JOB_CALC_REVIEW = 'calc.dict-review';

/**
 * The lateness watch for calculations (round 28, reopened in VED phase A).
 *
 * Every five minutes rather than the digests' once-a-morning: the deadlines
 * here are 30–120 MINUTES, and a red flag that arrives the next day is an
 * anecdote, not an alert. Five minutes is also the most the flag can lag its
 * deadline, which on a half-hour SLA is noise.
 *
 * The sweep itself claims its rows in the UPDATE before anything leaves
 * (0082's rule), so two overlapping sweeps split the work instead of both
 * announcing it.
 */
export async function registerCalcWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CALC_OVERDUE);
  await boss.schedule(JOB_CALC_OVERDUE, '*/5 * * * *');
  await boss.work(JOB_CALC_OVERDUE, async () => {
    try {
      const sent = await notifyOverdueCalcs();
      if (sent > 0) logger.info({ sent }, 'calc overdue flags sent');
    } catch (err) {
      logger.error({ err }, 'calc overdue sweep failed');
      throw err;
    }
  });
}

/**
 * «Har oyda bir marta ko'rib chiqish» — the dictionary review reminder.
 *
 * Scheduled DAILY and claimed monthly, rather than scheduled monthly. A
 * `0 6 1 * *` cron fires once, and if the container is down that minute — a
 * deploy, a restart, the one morning the VPS is being resized — the month is
 * simply skipped with nothing to notice it. A daily attempt that claims the
 * month cannot miss: whichever day the process is first alive, it speaks.
 *
 * 06:00 UTC is 11:00 in Tashkent — inside the office day, like the stale-lead
 * sweep, because this message can reach Telegram.
 */
export async function registerCalcReviewWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CALC_REVIEW);
  await boss.schedule(JOB_CALC_REVIEW, '0 6 * * *');
  await boss.work(JOB_CALC_REVIEW, async () => {
    try {
      const sent = await notifyDictionaryReview();
      if (sent > 0) logger.info({ sent }, 'calc dictionary review reminder sent');
    } catch (err) {
      logger.error({ err }, 'calc dictionary review sweep failed');
      throw err;
    }
  });
}
