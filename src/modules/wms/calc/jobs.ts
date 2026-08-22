import type PgBoss from 'pg-boss';
import { logger } from '@/modules/platform/logger';
import { notifyOverdueCalcs } from './service';

export const JOB_CALC_OVERDUE = 'calc.overdue';

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
