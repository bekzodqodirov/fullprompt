import type PgBoss from 'pg-boss';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { notifications, roles, userRoles } from '../db/schema';
import { logger } from '../logger';

export const JOB_RESTORE_TEST = 'db.restore_test';

/**
 * Weekly backup fire drill: Sunday 04:00 Tashkent (Sat 23:00 UTC), a few
 * hours after the Saturday-night backup. Restores the latest dump into a
 * scratch DB and sanity-checks the core tables. Failure pings the admins'
 * Telegram — a backup that cannot be restored must never fail silently.
 */
export async function registerRestoreTestWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_RESTORE_TEST);
  await boss.schedule(JOB_RESTORE_TEST, '0 23 * * 6');
  await boss.work(JOB_RESTORE_TEST, async () => {
    const { runRestoreTest } = await import('../backup/restore-test');
    const result = await runRestoreTest();
    if (result.ok) {
      logger.info({ file: result.file, counts: result.counts }, 'restore test ok');
      return;
    }
    logger.error({ error: result.error }, 'restore test FAILED');
    const admins = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(inArray(roles.code, ['admin', 'super_admin']));
    for (const adminId of [...new Set(admins.map((a) => a.userId))]) {
      await db.insert(notifications).values({
        userId: adminId,
        channel: 'telegram',
        type: 'RestoreTestFailed',
        payload: { error: result.error },
        status: 'pending',
      });
    }
    throw new Error(result.error);
  });
}
