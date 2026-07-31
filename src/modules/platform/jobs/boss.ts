import PgBoss from 'pg-boss';
import { logger } from '../logger';

export const JOB_THUMBNAILS = 'files.thumbnails';
export const JOB_PROCESS_EVENTS = 'events.process';
export const JOB_SEND_TELEGRAM = 'notify.telegram';
export const JOB_RECOMPUTE_COSTS = 'costs.recompute';

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

/**
 * Observe the latch without touching it — the health probe's view. True only
 * after boss.start() AND every worker registration succeeded in THIS process
 * (#252 made the latch honest). A probe must never call startBoss(): a
 * health check that boots the worker fleet is a health check that lies the
 * other way.
 */
export function isBossStarted(): boolean {
  return globalForBoss.bossStarted === true;
}

export async function startBoss(): Promise<PgBoss> {
  const boss = getBoss();
  if (!globalForBoss.bossStarted) {
    await boss.start();
    // Worker registration lives next to each job's implementation.
    const { registerThumbnailWorker } = await import('./thumbnails');
    await registerThumbnailWorker(boss);
    const { registerNotificationWorkers } = await import('./notifications');
    await registerNotificationWorkers(boss);
    const { registerDigestWorker } = await import('./digest');
    await registerDigestWorker(boss);
    const { registerCostRecomputeWorker } = await import('./cost-recompute');
    await registerCostRecomputeWorker(boss);
    const { registerBackupWorker } = await import('./backup');
    await registerBackupWorker(boss);
    const { registerRestoreTestWorker } = await import('./restore-test');
    await registerRestoreTestWorker(boss);
    const { registerCrmWorkers } = await import('../../wms/crm/digest');
    await registerCrmWorkers(boss);
    const { registerTaskWorkers } = await import('../tasks/digest');
    await registerTaskWorkers(boss);
    const { registerDealWorkers } = await import('../../wms/deals/jobs');
    await registerDealWorkers(boss);
    const { registerCalcWorker } = await import('../../wms/calc/jobs');
    await registerCalcWorker(boss);
    const { registerUnansweredWorker } = await import('../../wms/crm/unanswered-jobs');
    await registerUnansweredWorker(boss);
    /**
     * LAST, not first.
     *
     * This latch used to be set immediately after `boss.start()`, before the
     * nine registrations below it. One of them throwing left the latch set:
     * the boot retry called `startBoss()` again, took the early return, and
     * registered NOTHING — while `enqueue()` (which also calls `startBoss()`)
     * went on filling queues nobody was working. Worse, the retry then
     * RESOLVED, so the error stopped being logged and the boot looked healed
     * while the nightly backup, the restore test, cost recompute and every
     * digest were quietly dead.
     *
     * Setting it after the registrations means a failure is retried properly
     * and stays loud. Registration is idempotent, so a retry that re-runs
     * some of them is safe.
     */
    globalForBoss.bossStarted = true;
    logger.info('pg-boss started');
  }
  return boss;
}

export async function enqueue<T extends object>(name: string, data: T): Promise<void> {
  const boss = await startBoss();
  await boss.send(name, data, { retryLimit: 5, retryBackoff: true });
}
