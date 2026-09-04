import PgBoss from 'pg-boss';
import { logger } from '../logger';

export const JOB_THUMBNAILS = 'files.thumbnails';
export const JOB_PROCESS_EVENTS = 'events.process';
export const JOB_SEND_TELEGRAM = 'notify.telegram';
export const JOB_RECOMPUTE_COSTS = 'costs.recompute';

const globalForBoss = globalThis as unknown as {
  boss?: PgBoss;
  /** boss.start() has run — enough to SEND jobs. */
  bossListening?: boolean;
  /** Every worker registration succeeded — this process WORKS jobs. */
  bossStarted?: boolean;
  /** Which registrations have succeeded, so a boot retry never re-runs one. */
  bossRegistered?: Set<string>;
  /** Queues this process has ensured exist, so enqueue pays the upsert once. */
  bossQueues?: Set<string>;
};

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

/** boss.start() alone — the half that both senders and workers need. */
async function ensureListening(): Promise<PgBoss> {
  const boss = getBoss();
  if (!globalForBoss.bossListening) {
    await boss.start();
    globalForBoss.bossListening = true;
  }
  return boss;
}

/**
 * Every worker this application runs, BY NAME.
 *
 * Named so a partially-failed boot can retry without doubling anybody: the
 * old code re-ran the whole list from the top when one registration threw,
 * and `boss.work` is NOT idempotent — each call adds a fresh worker, so the
 * queues registered before the failure got a second worker on the retry and
 * every staff notification went out twice. The completed set survives the
 * retry; only the failed-and-after entries run again, each at most once.
 *
 * Exported for the test that proves exactly that with a boss that fails on
 * purpose — the real one cannot be made to fail on demand.
 */
export const WORKER_REGISTRATIONS: [string, (boss: PgBoss) => Promise<void>][] = [
  ['thumbnails', async (b) => (await import('./thumbnails')).registerThumbnailWorker(b)],
  ['notifications', async (b) => (await import('./notifications')).registerNotificationWorkers(b)],
  ['digest', async (b) => (await import('./digest')).registerDigestWorker(b)],
  ['cost-recompute', async (b) => (await import('./cost-recompute')).registerCostRecomputeWorker(b)],
  ['backup', async (b) => (await import('./backup')).registerBackupWorker(b)],
  ['object-backup', async (b) => (await import('./object-backup')).registerObjectBackupWorker(b)],
  ['restore-test', async (b) => (await import('./restore-test')).registerRestoreTestWorker(b)],
  ['crm', async (b) => (await import('../../wms/crm/digest')).registerCrmWorkers(b)],
  ['tasks', async (b) => (await import('../tasks/digest')).registerTaskWorkers(b)],
  ['deals', async (b) => (await import('../../wms/deals/jobs')).registerDealWorkers(b)],
  ['unanswered', async (b) => (await import('../../wms/crm/unanswered-jobs')).registerUnansweredWorker(b)],
  ['silent-trucks', async (b) => (await import('../../wms/tracking/silent-jobs')).registerSilentTrucksWorker(b)],
  ['meta-leads', async (b) => (await import('../../wms/crm/meta-jobs')).registerMetaLeadWorker(b)],
  ['stale-automation', async (b) => (await import('../automation/stale-jobs')).registerStaleAutomationWorker(b)],
  ['client-notices', async (b) => (await import('../../wms/notices/arrival-jobs')).registerClientNoticeWorker(b)],
  ['calc-overdue', async (b) => (await import('../../wms/calc/jobs')).registerCalcWorker(b)],
  ['calc-review', async (b) => (await import('../../wms/calc/jobs')).registerCalcReviewWorker(b)],
  [
    'calc-prefill',
    async (b) => (await import('../../wms/calc/jobs')).registerCalcPrefillWorker(b),
  ],
  [
    'customs-import',
    async (b) => (await import('../../wms/customs/jobs')).registerCustomsImportWorker(b),
  ],
];

/** Run each registration at most once per process, whatever failed before. */
export async function registerAllWorkers(
  boss: PgBoss,
  registrations: [string, (boss: PgBoss) => Promise<void>][],
  registered: Set<string>,
): Promise<void> {
  for (const [name, register] of registrations) {
    if (registered.has(name)) continue;
    await register(boss);
    registered.add(name);
  }
}

export async function startBoss(): Promise<PgBoss> {
  const boss = await ensureListening();
  if (!globalForBoss.bossStarted) {
    globalForBoss.bossRegistered ??= new Set();
    await registerAllWorkers(boss, WORKER_REGISTRATIONS, globalForBoss.bossRegistered);
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
     * and stays loud. The per-name set above is what makes the retry safe —
     * `boss.work` mints a fresh worker on every call, so «idempotent» has to
     * be built, not assumed (the audit measured the assumption: a partial
     * boot left two workers on notify.telegram and every message went twice).
     */
    globalForBoss.bossStarted = true;
    logger.info('pg-boss started');
  }
  return boss;
}

/**
 * Put a job on a queue — WITHOUT becoming a worker.
 *
 * This used to call `startBoss()`, which registers every worker in the
 * process that happens to enqueue. The place that mattered is the tg-listen
 * container: a session-dead alarm there called notifyStaffTelegram →
 * enqueue → the whole fleet, and from then on TWO processes worked
 * notify.telegram (every staff message twice) and the nightly backup ran in
 * a container with no backups volume — #253's «dump into a container thrown
 * away on every deploy», resurrected by an alarm. Sending needs only
 * `boss.start()` plus the queue existing; working jobs stays the app's.
 */
export async function enqueue<T extends object>(name: string, data: T): Promise<void> {
  const boss = await ensureListening();
  globalForBoss.bossQueues ??= new Set();
  if (!globalForBoss.bossQueues.has(name)) {
    // pg-boss v10 refuses a send onto a queue nobody has created. The worker
    // side creates its queues at registration; a pure sender (tg-listen) has
    // to ensure them itself. createQueue is an upsert, paid once per process.
    await boss.createQueue(name);
    globalForBoss.bossQueues.add(name);
  }
  await boss.send(name, data, { retryLimit: 5, retryBackoff: true });
}
