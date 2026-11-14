import { sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { JOB_SEND_TELEGRAM } from '@/modules/platform/jobs/boss';

/**
 * The drain's kicks a file's notifications queued (`kickTelegramDrain` → a pg-boss `notify.telegram` job each): no
 * worker runs in the suite, so every one stays `created` — 361 after one run of the agent files (fix pass 5, the check
 * of pass 3's leftovers) — for the next process with a worker to run against rows that are gone. Dropped by name and
 * by the file's own start, never another file's; a database pg-boss never started has none to drop.
 */
export async function dropDrainKicksSince(since: string): Promise<void> {
  const present = await db.execute<{ job: boolean }>(sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS job`);
  if (!present[0]?.job) return;
  await db.execute(sql`
    DELETE FROM pgboss.job
     WHERE name = ${JOB_SEND_TELEGRAM} AND state = 'created' AND created_on >= ${since}::timestamptz`);
}
