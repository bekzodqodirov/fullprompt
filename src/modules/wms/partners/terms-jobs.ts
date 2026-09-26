import type PgBoss from 'pg-boss';
import { logger } from '../../platform/logger';
import { alertPartnerTerms } from './terms-service';

export const JOB_PARTNER_TERMS = 'partners.terms';

/**
 * The counterparty reminders (0108), once a day at 09:10 Tashkent (04:10
 * UTC): a due date is a day, and a reminder at 04:00 is read at breakfast
 * anyway — the office day is when it can be acted on.
 */
export async function registerPartnerTermsWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_PARTNER_TERMS);
  await boss.schedule(JOB_PARTNER_TERMS, '10 4 * * *');
  await boss.work(JOB_PARTNER_TERMS, async () => {
    try {
      const sent = await alertPartnerTerms();
      if (sent > 0) logger.info({ sent }, 'partner term reminders sent');
    } catch (err) {
      logger.error({ err }, 'partner term sweep failed');
      throw err;
    }
  });
}
