import type PgBoss from 'pg-boss';
import {
  processPendingEvents,
  sendPendingTelegram,
} from '../notifications/service';
import { JOB_PROCESS_EVENTS, JOB_SEND_TELEGRAM } from './boss';

/**
 * Event fan-out + Telegram delivery workers. Mutations enqueue
 * JOB_PROCESS_EVENTS right after commit for instant delivery; a per-minute
 * schedule sweeps anything missed (e.g. process restart).
 */
export async function registerNotificationWorkers(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_PROCESS_EVENTS);
  await boss.createQueue(JOB_SEND_TELEGRAM);

  await boss.work(JOB_PROCESS_EVENTS, async () => {
    const created = await processPendingEvents();
    if (created > 0) {
      await boss.send(JOB_SEND_TELEGRAM, {}, { retryLimit: 8, retryBackoff: true });
    }
  });

  await boss.work(JOB_SEND_TELEGRAM, async () => {
    await sendPendingTelegram();
  });

  await boss.schedule(JOB_PROCESS_EVENTS, '* * * * *', {}, {});
}
