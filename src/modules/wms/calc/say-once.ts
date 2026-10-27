import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { notifications, users } from '../../platform/db/schema';
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
 * said yet»; the drain is kicked after the commit, never from inside it.
 *
 * THE CLAIM IS A ROW, whoever reads it (review CONC-4/P1-R6). A muted
 * recipient has always got a `muted` row; a recipient who can no longer log
 * in got NO row at all — and with no row the next run found no claim, so
 * every re-delivery of that request's job wrote another machine note on the
 * card. Such a requester now gets a `muted` row too («cannot log in»), which
 * the drain never sends and the problem counter never counts.
 *
 * Stated, not closed: the lenta note is written AFTER this commits
 * (`writeReplyToLenta` reads a setting on the pool, which may not run inside
 * this transaction, #714), so a process killed between the two loses the
 * note — the re-delivery finds the claim and writes nothing. The message
 * itself is never lost; the card's copy of it can be.
 *
 * Returns false when an earlier attempt already spoke — the caller then
 * writes no lenta note either — and, under `whileOpen`, when the request has
 * been closed (or is gone): the VED's answer is the official one and out,
 * and the machine's reply must not follow it (review CONC-1).
 */
export async function sayOnce(
  requestId: string,
  input: StaffTelegramInput,
  opts: { whileOpen?: boolean } = {},
): Promise<boolean> {
  const ids = [...new Set(input.userIds)].filter(Boolean);
  const queued = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`calc-prefill-reply:${requestId}`}))`);
    // The request itself, read once: when it was asked — the floor of every
    // message about it (review perf-5) — and, for the reply, whether it is
    // still open, under FOR SHARE so a close in flight is waited for and
    // never raced. Absent (an id that names no request): no floor, and
    // nothing is open. Raw timestamps come back as TEXT (#923).
    const [request] = await tx.execute<{ completed_at: string | null; requested_at: string }>(
      sql`SELECT completed_at, requested_at FROM calc_requests WHERE id = ${requestId}::uuid ${
        opts.whileOpen ? sql`FOR SHARE` : sql``
      }`,
    );
    if (opts.whileOpen && (!request || request.completed_at !== null)) return null;
    if (ids.length === 0) return null;
    // `user_id` first, and a FLOOR on `created_at`: the claim reads the
    // recipient's own rows from the day the request was asked, a short range
    // on `notifications_user_idx` — unbounded, the first call (the common
    // one, which matches nothing) read every message the seller ever got,
    // holding this lock and a pool connection. A day of slack absorbs any
    // clock between the app and the database; nothing about a request is
    // written before it exists.
    const claimed = () =>
      tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            inArray(notifications.userId, ids),
            eq(notifications.type, input.type),
            sql`${notifications}.payload->>'requestId' = ${requestId}`,
            request
              ? gte(notifications.createdAt, sql`${request.requested_at}::timestamptz - interval '1 day'`)
              : undefined,
          ),
        )
        .limit(1);
    const [said] = await claimed();
    if (said) return null;
    const extra = { ...(input.extra ?? {}), requestId };
    const sent = await queueStaffTelegram(tx, { ...input, extra });
    // Nobody live to tell: the claim still needs a row, or the next run
    // speaks again. The first recipient that EXISTS carries it, muted.
    const [own] = await claimed();
    if (!own) {
      const [holder] = await tx.select({ id: users.id }).from(users).where(inArray(users.id, ids)).limit(1);
      if (!holder) return null;
      await tx.insert(notifications).values({
        userId: holder.id,
        channel: 'telegram',
        type: input.type,
        payload: { ...extra, text: input.text },
        status: 'muted',
        error: 'cannot log in',
      });
    }
    return sent;
  });
  if (queued === null) return false;
  if (queued > 0) await kickTelegramDrain();
  return true;
}
