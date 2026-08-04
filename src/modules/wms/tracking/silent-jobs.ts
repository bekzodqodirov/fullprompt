import type PgBoss from 'pg-boss';
import { logger } from '../../platform/logger';
import { alertSilentTrucks } from './silent';

export const JOB_SILENT_TRUCKS = 'tracking.silent';

/**
 * The silent-truck watch (round 55).
 *
 * Every 30 minutes, not every 5: the threshold is FRESH_MINUTES (hours), so
 * finer polling would only move the message a few minutes earlier on an
 * eight-hour silence. The sweep is one indexed select and does nothing at
 * all while every paired phone is talking.
 */
export async function registerSilentTrucksWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_SILENT_TRUCKS);
  await boss.schedule(JOB_SILENT_TRUCKS, '*/30 * * * *');
  await boss.work(JOB_SILENT_TRUCKS, async () => {
    try {
      const sent = await alertSilentTrucks();
      if (sent > 0) logger.info({ sent }, 'silent-truck alerts sent');
    } catch (err) {
      logger.error({ err }, 'silent-truck sweep failed');
      throw err;
    }
  });
}
