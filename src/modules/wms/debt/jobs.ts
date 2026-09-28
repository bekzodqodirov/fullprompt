import type PgBoss from 'pg-boss';
import { logger } from '../../platform/logger';
import { sweepPromises } from './promises';

export const JOB_DEBT_PROMISES = 'debt.promises';

/**
 * The payment-promise sweep (0114), hourly through the Tashkent office day
 * (`10 4-14 * * *` UTC = 09:10-19:10 there — the automation sweep's clock,
 * #610): a promise is judged when the ledger can have moved, and its alarm
 * lands when somebody can pick up a phone. «Buzildi» waits for noon the day
 * after the due date (`promiseBrokenAt`), which the 07:10 UTC run catches.
 */
export async function registerDebtPromiseWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_DEBT_PROMISES);
  await boss.schedule(JOB_DEBT_PROMISES, '10 4-14 * * *');
  await boss.work(JOB_DEBT_PROMISES, async () => {
    try {
      const done = await sweepPromises();
      if (done.kept + done.settled + done.broken > 0) logger.info(done, 'payment promises judged');
    } catch (err) {
      logger.error({ err }, 'payment promise sweep failed');
      throw err;
    }
  });
}
