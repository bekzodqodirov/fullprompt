import type PgBoss from 'pg-boss';
import { logger } from '../../platform/logger';
import { alertLateQueues } from './queue-alert';
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

export const JOB_LATE_QUEUES = 'tracking.late-queues';

/**
 * The held-queue watch (docs/XORGOS-NAVBAT.md §3, his 3a): a truck more than
 * a day past the longest wait its Horgos or Yallama queue was given is told
 * to the logists once.
 *
 * Every 30 minutes of the Tashkent office day only — 08:00 to 19:30 is
 * 03:00-14:30 UTC. The threshold is a whole day past a wait of days, so a
 * night's delay changes nothing the logist can act on at 3 a.m., and a
 * message at 08:00 is read where one at 03:00 is buried. The sweep reads the
 * dashboard's own rows and writes nothing while no queue is late.
 */
export async function registerLateQueueWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_LATE_QUEUES);
  await boss.schedule(JOB_LATE_QUEUES, '*/30 3-14 * * *');
  await boss.work(JOB_LATE_QUEUES, async () => {
    try {
      const told = await alertLateQueues();
      if (told > 0) logger.info({ told }, 'late-queue alerts sent');
    } catch (err) {
      logger.error({ err }, 'late-queue sweep failed');
      throw err;
    }
  });
}
