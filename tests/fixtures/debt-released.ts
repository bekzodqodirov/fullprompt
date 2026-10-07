import { sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';

/**
 * Removes the «🔓 Qarzga yuk berildi» rows (0126, D6a) a test file's own
 * handovers produced. The audience is the owner and the accountant BY ROLE,
 * so these rows land on the DEMO super_admin and accountant — people no
 * file's `inArray(notifications.userId, people)` ever reaches — and would
 * ride into the Playwright database, where /admin/notifications and the
 * problem count read them (#183). Keyed on the handover the send names
 * (`extra: { handoverId }`), never on a guess at the text.
 */
export async function deleteDebtReleasedFor(clientIds: readonly string[]): Promise<void> {
  if (clientIds.length === 0) return;
  const ids = sql.join(
    clientIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await db.execute(sql`
    DELETE FROM notifications
     WHERE type = 'DebtReleased'
       AND payload->>'handoverId' IN (SELECT h.id::text FROM handovers h WHERE h.client_id IN (${ids}))`);
}
