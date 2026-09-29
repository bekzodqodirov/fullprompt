import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { sideSql } from '../db/side';
import { schemaLedger, type SchemaLedger } from '../db/ledger';
import { getStorage } from '../files/storage';
import { isBossStarted } from '../jobs/boss';

/**
 * The two failures that actually hurt — MinIO down (photos stop) and the
 * pg-boss fleet dead (backups stop) — both reported "ok" here for months,
 * because this endpoint claimed three checks and ran one `select 1`. Now
 * every word in the answer is a probe that really ran.
 *
 * B9 made it the WATCHDOG's eyes (`ops/health-probe.mjs` kills a server whose
 * pool is stuck), which changed what it must never do: hang. A starved pool
 * or a postgres the container cannot resolve (round 48's EAI_AGAIN) used to
 * hold this route for postgres.js's 30-second connect timeout, the probe
 * counted the silence as a dead server, and a database outage would have
 * become a kill loop — the one thing a restart cannot fix. So:
 *
 *  - EVERY awaited check is raced against `CHECK_MS` (a unit fence reads this
 *    file and refuses an un-raced await);
 *  - the deep result is computed at most once per `DEEP_TTL_MS` and shared by
 *    every caller in that window (single flight) — the route is public through
 *    Caddy, and a flood of requests must not become a flood of pool reads or a
 *    queue on the one side connection;
 *  - `pool` separates «the pool is stuck» (its `select 1` lost the race while
 *    the SIDE connection answered — the only state a restart heals) from «the
 *    database is down» (both lost — nothing here can fix that), and the
 *    watchdog kills on the first alone;
 *  - the 200/503 rule is unchanged: Playwright's web server waits for a 200,
 *    and schema or pool state is information, not a verdict on readiness.
 */

/** Each check's budget — well inside the probe's ten seconds. */
export const CHECK_MS = 3_000;
/** How long one deep answer is shared. */
export const DEEP_TTL_MS = 5_000;

export type PoolState = 'ok' | 'stuck' | 'down';

/** `promise`, or `fallback` once `ms` has passed or it failed — never a hang. */
export function bounded<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([promise.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

/**
 * pg-boss stamps `pgboss.version.maintained_on` every maintenance cycle
 * (120 s default); ten minutes is five missed cycles — dead, not busy. The
 * NULL right after first schema creation is vouched for by the in-process
 * latch, which is true only once every worker registered (#252).
 */
async function jobsUp(): Promise<boolean> {
  if (!isBossStarted()) return false;
  const rows = await db.execute<{ fresh: boolean }>(sql`
    SELECT (maintained_on IS NULL OR maintained_on > now() - interval '10 minutes') AS fresh
    FROM pgboss.version
  `);
  return rows.length === 1 && rows[0]!.fresh === true;
}

/** Stuck = the pool lost its race while the side door answered in time. */
export function poolState(poolAnswered: boolean, sideAnswered: boolean): PoolState {
  if (poolAnswered) return 'ok';
  return sideAnswered ? 'stuck' : 'down';
}

export interface Deep {
  ok: boolean;
  body: {
    status: 'ok' | 'degraded';
    db: 'up' | 'down';
    storage: 'up' | 'down';
    jobs: 'up' | 'down';
    pool: PoolState;
    schema: SchemaLedger | null;
  };
}

async function computeDeep(): Promise<Deep> {
  const [dbOk, sideOk, storageOk, jobsOk, schema] = await Promise.all([
    bounded(
      db.execute(sql`select 1`).then(() => true),
      CHECK_MS,
      false,
    ),
    bounded(
      sideSql()`select 1`.then(() => true),
      CHECK_MS,
      false,
    ),
    bounded(
      getStorage()
        .ping()
        .then(() => true),
      CHECK_MS,
      false,
    ),
    bounded(jobsUp(), CHECK_MS, false),
    bounded<SchemaLedger | null>(schemaLedger(), CHECK_MS, null),
  ]);
  const ok = dbOk && storageOk && jobsOk;
  return {
    ok,
    body: {
      status: ok ? 'ok' : 'degraded',
      db: dbOk ? 'up' : 'down',
      storage: storageOk ? 'up' : 'down',
      jobs: jobsOk ? 'up' : 'down',
      pool: poolState(dbOk, sideOk),
      schema,
    },
  };
}

const globalForHealth = globalThis as unknown as {
  gsrHealth?: { at: number; promise: Promise<Deep> };
};

/** Tests only: forget the shared answer. */
export function __resetHealth(): void {
  globalForHealth.gsrHealth = undefined;
}

export function healthAnswer(now = Date.now()): Promise<Deep> {
  const shared = globalForHealth.gsrHealth;
  if (shared && now - shared.at < DEEP_TTL_MS) return shared.promise;
  const promise = computeDeep();
  globalForHealth.gsrHealth = { at: now, promise };
  return promise;
}

