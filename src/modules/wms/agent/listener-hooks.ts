import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentTablesReady } from './config';

/**
 * The small database questions the listener's event handlers ask for the
 * agent (spec §17.3.1). Each is one statement and each asks
 * `agentTablesReady()` first, so a listener ahead of its database does
 * exactly what it did before.
 */

/**
 * «The customer is typing» (fit-9): the worker waits while the peer types,
 * so a question in three lines is answered once. Only for a chat this
 * system already KEEPS — a friend's typing on his personal account must not
 * become a row about that friend (the tray's «counted, never named» rule),
 * which is why the insert is gated on a stored message rather than on the
 * update alone.
 */
export async function stampPeerTyping(managerUserId: string, peerId: bigint): Promise<boolean> {
  if (!(await agentTablesReady())) return false;
  const rows = await db.execute<{ peer_id: string }>(sql`
    INSERT INTO agent_conversations (manager_user_id, peer_id, peer_typing_at, updated_at)
    SELECT ${managerUserId}::uuid, ${peerId.toString()}::bigint, now(), now()
     WHERE EXISTS (
       SELECT 1 FROM tg_messages m
        WHERE m.manager_user_id = ${managerUserId}::uuid AND m.peer_id = ${peerId.toString()}::bigint)
    ON CONFLICT (manager_user_id, peer_id) DO UPDATE
      SET peer_typing_at = now(), updated_at = now()
    RETURNING peer_id`);
  return rows.length > 0;
}

/**
 * Is this message the chat's newest live inbound (regression-10)? An edit of
 * an OLDER line rewrites the record but asks nothing new of the reply to the
 * newest one; an edit of the newest is a new question in the old message's
 * place, and the draft written against its first words must be re-thought.
 */
export async function isNewestInbound(managerUserId: string, peerId: bigint, tgMessageId: bigint): Promise<boolean> {
  if (!(await agentTablesReady())) return false;
  const rows = await db.execute<{ tg_message_id: string }>(sql`
    SELECT m.tg_message_id::text AS tg_message_id FROM tg_messages m
      LEFT JOIN tg_message_flags f ON f.message_id = m.id
     WHERE m.manager_user_id = ${managerUserId}::uuid
       AND m.peer_id = ${peerId.toString()}::bigint
       AND m.direction = 'in'
       AND f.deleted_at IS NULL
     ORDER BY m.tg_message_id DESC
     LIMIT 1`);
  return rows[0]?.tg_message_id === tgMessageId.toString();
}
