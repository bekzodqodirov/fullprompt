import type PgBoss from 'pg-boss';
import { logger } from '../../platform/logger';
import { isServerBehind } from '../../platform/db/errors';
import { stampFirstContacts } from './first-contact';
import { remindUntouched } from './inbound-notify';

export const JOB_INBOUND_CONTACT = 'crm.inbound-contact';

/**
 * The advert lead's clock (0113), every MINUTE: the deadline is fifteen of
 * them, and a reminder that lands at minute nineteen has already lost the
 * customer to whoever called first. Both passes read only the clocked
 * arrivals of the last week (a partial index), so a quiet minute costs two
 * index probes.
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
