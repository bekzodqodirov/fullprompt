import { sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { getStorage } from '@/modules/platform/files/storage';
import { isBossStarted } from '@/modules/platform/jobs/boss';

/**
 * The two failures that actually hurt — MinIO down (photos stop) and the
 * pg-boss fleet dead (backups stop) — both reported "ok" here for months,
 * because this endpoint claimed three checks and ran one `select 1`. Now
 * every word in the answer is a probe that really ran.
 */

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

export async function GET() {
  const [dbOk, storageOk, jobsOk] = await Promise.all([
    db.execute(sql`select 1`).then(
      () => true,
      () => false,
    ),
    getStorage()
      .ping()
      .then(
        () => true,
        () => false,
      ),
    jobsUp().catch(() => false),
  ]);
  const ok = dbOk && storageOk && jobsOk;
  return Response.json(
    {
      status: ok ? 'ok' : 'degraded',
      db: dbOk ? 'up' : 'down',
      storage: storageOk ? 'up' : 'down',
      jobs: jobsOk ? 'up' : 'down',
    },
    { status: ok ? 200 : 503 },
  );
}
