import PgBoss from 'pg-boss';
import { logger } from '../logger';

export const JOB_THUMBNAILS = 'files.thumbnails';
export const JOB_PROCESS_EVENTS = 'events.process';
export const JOB_SEND_TELEGRAM = 'notify.telegram';

const globalForBoss = globalThis as unknown as { boss?: PgBoss; bossStarted?: boolean };

export function getBoss(): PgBoss {
  if (!globalForBoss.boss) {
    globalForBoss.boss = new PgBoss({
      connectionString: process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev',
    });
    globalForBoss.boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  }
  return globalForBoss.boss;
}

export async function startBoss(): Promise<PgBoss> {
  const boss = getBoss();
  if (!globalForBoss.bossStarted) {
    await boss.start();
    globalForBoss.bossStarted = true;
    // Worker registration lives next to each job's implementation.
    const { registerThumbnailWorker } = await import('./thumbnails');
    await registerThumbnailWorker(boss);
    const { registerNotificationWorkers } = await import('./notifications');
    await registerNotificationWorkers(boss);
    logger.info('pg-boss started');
  }
  return boss;
}

export async function enqueue<T extends object>(name: string, data: T): Promise<void> {
  const boss = await startBoss();
  await boss.send(name, data, { retryLimit: 5, retryBackoff: true });
}
