import type PgBoss from 'pg-boss';
import { logger } from '@/modules/platform/logger';
import { resolveExpiredDeferrals } from './service';

export const JOB_DEAL_DEFERRALS = 'deals.deferrals';

/**
 * Close the payment deferrals that have run out.
 *
 * A deferral that expires in silence is how a debtor disappears from the
 * debtor list for good — which is exactly the failure the deferral was built
 * to avoid in the first place (docs/DEALS.md answer 4). Most of them
 * self-resolve when the last box lands, and the reads that ask "is this client
 * deferred" already ignore an expired one, so this sweep is what makes the
 * fact PERMANENT and tells the person who granted it.
 *
 * Hourly rather than daily: "when the last box arrives" is an event that
 * happens during the working day, and a nudge that lands the following morning
 * is a day of chasing lost.
 */
export async function registerDealWorkers(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_DEAL_DEFERRALS);
  await boss.schedule(JOB_DEAL_DEFERRALS, '15 * * * *');
  await boss.work(JOB_DEAL_DEFERRALS, async () => {
    try {
      const closed = await resolveExpiredDeferrals();
      if (closed > 0) logger.info({ closed }, 'deal deferrals resolved');
    } catch (err) {
      logger.error({ err }, 'deal deferral sweep failed');
      throw err;
    }
  });
}
