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
  /**
   * Delivery had NO schedule of its own — it was sent only when the event
   * fan-out happened to create something. Anything that writes a `pending`
   * notification directly rather than through an event therefore waited for
   * an unrelated receipt to be confirmed before it went anywhere: the daily
   * digests, the task reminders, and — worst — the "your backups cannot be
   * restored" alarm. The one message you cannot afford to have delayed was
   * among the most likely to be.
   */
  await boss.schedule(JOB_SEND_TELEGRAM, '* * * * *', {}, {});
}
