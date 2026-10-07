import type PgBoss from 'pg-boss';
import { logger } from '@/modules/platform/logger';
import { JOB_PRICE_CHANNEL } from './channel-queue';
import { drainPriceChannel, reconcilePriceChannelMarks } from './channel-send';

export { JOB_PRICE_CHANNEL };

/**
 * The price channel's worker (the owner's F): every minute, plus the kicks the
 * seal, Готово, every ending and a recalc send. Drain, then reconcile, each in
 * its own try. NOT rethrown: the ledger rows ARE the retry (their status,
 * `not_before` and attempts), and a pg-boss retry of a run that half-sent
 * would only race the next minute's run.
 */
export async function registerPriceChannelWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_PRICE_CHANNEL);
  await boss.schedule(JOB_PRICE_CHANNEL, '* * * * *');
  await boss.work(JOB_PRICE_CHANNEL, async () => {
    try {
      const run = await drainPriceChannel();
      if (run.sent > 0 || run.paused) logger.info(run, '[price-channel] drain');
    } catch (err) {
      logger.error({ err }, '[price-channel] drain failed');
    }
    try {
      await reconcilePriceChannelMarks();
    } catch (err) {
      logger.error({ err }, '[price-channel] reconcile failed');
    }
  });
}
