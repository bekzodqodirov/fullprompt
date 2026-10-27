import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { notifications } from '../../platform/db/schema';
import {
  kickTelegramDrain,
  queueStaffTelegram,
  type StaffTelegramInput,
} from '../../platform/notifications/staff';

/**
 * ONE machine message per calculation request (docs/SAKKIZ-R2.md §6.8,
 * concurrency-1).
 *
 * pg-boss re-delivers a job whose process died, and a job that outlives its
 * expiry runs a second time beside the first. Each run used to speak: a
 * second reply, a second lenta note, and — worst — a «🤖 AI hisoblay olmadi»
 * after a real answer had already gone out, which a seller reads as «ignore
 * the figure you were sent». The reply, every stand-down sentence and every
 * failure for a request now go through here, and only the first is queued.
 *
 * Every request is queued exactly once, right after its own INSERT (the
 * three landing doors), so «one message per request» is «one per job» — with
 * no migration. `telegram_once` cannot carry this key: 0130's CHECK admits
 * only Telegram message identities (`m:`/`q:`).
 *
 * The claim and the rows go in ONE transaction, serialised on the request
 * by an advisory lock so two overlapping runs cannot both find «nothing
 * said yet»; the drain is kicked after the commit, never from inside it. A
 * muted recipient still gets a `muted` row, so the claim holds; a recipient
 * who can no longer log in gets no row and no message, which is right.
 *
 * Returns false when an earlier attempt already spoke — the caller then
 * writes no lenta note either.
 */
export async function sayOnce(requestId: string, input: StaffTelegramInput): Promise<boolean> {
  const ids = [...new Set(input.userIds)].filter(Boolean);
  const queued = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calc-prefill-reply:${requestId}`}))`);
    // `user_id` first: it rides `notifications_user_idx`, so the claim reads
    // the recipient's own rows and never the whole table.
    const [said] =
      ids.length === 0
        ? []
        : await tx
            .select({ id: notifications.id })
            .from(notifications)
            .where(
              and(
                inArray(notifications.userId, ids),
                eq(notifications.type, input.type),
                sql`${notifications}.payload->>'requestId' = ${requestId}`,
              ),
            )
            .limit(1);
    if (said) return null;
    return queueStaffTelegram(tx, { ...input, extra: { ...(input.extra ?? {}), requestId } });
  });
  if (queued === null) return false;
  if (queued > 0) await kickTelegramDrain();
  return true;
}
