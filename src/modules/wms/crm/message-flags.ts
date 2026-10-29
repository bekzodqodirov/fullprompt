import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentTablesReady } from '../agent/config';

/**
 * Two facts about a stored message that Telegram tells only the listener
 * (0138's `tg_message_flags`, a table beside tg_messages — never a column on
 * it, review build-10). Both are written for EVERY connected account, not
 * only the agent's: the thread, the context and the corpus all skip a
 * message the customer took back.
 *
 * Each asks `agentTablesReady()` first, so a listener one migration ahead of
 * its database writes nothing and fails nothing.
 */

/**
 * The customer's OWN robot wrote this (review ban-4): a Telegram Business
 * away or greeting message carries `offline`, an answer from their business
 * bot carries `via_business_bot_id`. Neither lives in `RawMessage`, so the
 * only moment to know is the one the listener holds the gramjs message — and
 * an AI answering an auto-reply that answered the AI is the loop the fuses
 * exist for.
 *
 * `unknown` and read defensively: gramjs's Message class sets both from the
 * TL fields at runtime, and its typings declare neither.
 */
export function wasAutoSent(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as { offline?: unknown; viaBusinessBotId?: unknown };
  return m.offline === true || (m.viaBusinessBotId !== null && m.viaBusinessBotId !== undefined);
}

export async function markAutoSent(messageRowId: string): Promise<void> {
  if (!(await agentTablesReady())) return;
  await db.execute(sql`
    INSERT INTO tg_message_flags (message_id, auto_sent)
    VALUES (${messageRowId}::uuid, true)
    ON CONFLICT (message_id) DO UPDATE SET auto_sent = true`);
}

/**
 * Deleted for both sides (review leak-8). `UpdateDeleteMessages` names
 * message ids and no chat — a private chat's ids are unique inside one
 * account's message box, which is why 0138 indexes tg_messages by (manager,
 * tg message id). The FIRST delete time stands: Telegram re-delivers after a
 * reconnect, and a moved timestamp would read as a second deletion.
 *
 * Returns how many stored rows it marked — a delete in a chat this system
 * never kept marks nothing, by construction.
 */
export async function markDeleted(managerUserId: string, tgMessageIds: readonly bigint[]): Promise<number> {
  if (tgMessageIds.length === 0) return 0;
  if (!(await agentTablesReady())) return 0;
  // A JS array bound into raw sql is not a postgres array (CLAUDE.md) — joined
  // one parameter per id, each cast, so the index on (manager, tg id) is used.
  const ids = sql.join(
    tgMessageIds.map((id) => sql`${id.toString()}::bigint`),
    sql`, `,
  );
  const rows = await db.execute<{ message_id: string }>(sql`
    INSERT INTO tg_message_flags (message_id, deleted_at)
    SELECT m.id, now() FROM tg_messages m
     WHERE m.manager_user_id = ${managerUserId}::uuid
       AND m.tg_message_id IN (${ids})
    ON CONFLICT (message_id) DO UPDATE
      SET deleted_at = coalesce(tg_message_flags.deleted_at, EXCLUDED.deleted_at)
    RETURNING message_id`);
  return rows.length;
}
