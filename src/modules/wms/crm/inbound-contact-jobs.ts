import type PgBoss from 'pg-boss';
import { logger } from '../../platform/logger';
import { isServerBehind } from '../../platform/db/errors';
import { stampFirstContacts } from './first-contact';
import { remindUntouched } from './inbound-notify';

export const JOB_INBOUND_CONTACT = 'crm.inbound-contact';

/**
 * The advert lead's clock (0113), every MINUTE: the deadline is fifteen of
 * them, and a reminder that lands at minute nineteen has already lost the
 * customer to whoever called first. Both passes read the clocked arrivals of
 * the last week (a partial index) — and the STAMP also reads every UNSTAMPED
 * agent arrival of the last ninety days (`EXEMPT_CONTACT_LOOKBACK_DAYS`, the
 * source index), running the five-way evidence lateral (calls, Telegram,
 * notes, two audit reads) for each one, every minute. That is linear in how
 * many agent leads nobody has touched: measured ~50-80 ms a run at ~4,500 of
 * them, and past ~5,000 the plan's estimate crosses `jit_above_cost`, so a
 * postgres still running JIT (compose's `-c jit=off` applies once the
 * container is recreated, #1039) adds tens of milliseconds a minute on top
 * (review, 2026-10-24). At the owner's ~25 agent pushes a day the set stays
 * well under that; a seller who works his leads empties it.
 *
 * The STAMP always runs — it is the measurement /crm/tahlil reads — and the
 * reminder decides for itself whether it is office time and switched on.
 * A database one migration behind is logged and skipped rather than retried
 * five times a minute into the error log.
 */
export async function registerInboundContactWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_INBOUND_CONTACT);
  await boss.schedule(JOB_INBOUND_CONTACT, '* * * * *');
  await boss.work(JOB_INBOUND_CONTACT, async () => {
    const now = new Date();
    try {
      const stamped = await stampFirstContacts(now);
      const reminded = await remindUntouched(now);
      if (stamped > 0 || reminded > 0) logger.info({ stamped, reminded }, 'advert lead contact sweep');
    } catch (err) {
      if (isServerBehind(err)) {
        logger.warn('advert lead contact sweep: migration 0113 not applied yet');
        return;
      }
      logger.error({ err }, 'advert lead contact sweep failed');
      throw err;
    }
  });
}
