import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentTablesReady } from './config';

/**
 * «Pull this one stranger's chat» (spec §17.11, review regression-14): the
 * app writes a `tg_peer_pulls` row when he answers a stranger's card with a
 * lead or a client, and the listener — the only process holding the
 * session — fetches that chat's last day and stores it through the same
 * decide-and-store path a live message takes. One at a time per account,
 * at least ten seconds apart: a pull is a history read, and a burst of
 * history reads is not what a person's phone does.
 */

/** At least this long between two pulls on one account. */
export const PULL_GAP_MS = 10_000;
/** A pull reads this much of the chat, newest first. */
export const PULL_MESSAGES = 50;
export const PULL_WINDOW_MS = 24 * 60 * 60_000;

export interface PeerPull {
  id: string;
  peerId: bigint;
}

/** The oldest open request for this account, claimed — or none. One UPDATE, never read-then-write. */
export async function claimPeerPull(managerUserId: string): Promise<PeerPull | null> {
  if (!(await agentTablesReady())) return null;
  const rows = await db.execute<{ id: string; peer_id: string }>(sql`
    UPDATE tg_peer_pulls SET claimed_at = now()
     WHERE id = (
       SELECT id FROM tg_peer_pulls
        WHERE manager_user_id = ${managerUserId}::uuid AND claimed_at IS NULL AND done_at IS NULL
        ORDER BY requested_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED)
    RETURNING id::text AS id, peer_id::text AS peer_id`);
  const row = rows[0];
  return row ? { id: row.id, peerId: BigInt(row.peer_id) } : null;
}

export async function finishPeerPull(id: string, result: { storedCount: number; error: string | null }): Promise<void> {
  await db.execute(sql`
    UPDATE tg_peer_pulls
       SET done_at = now(), stored_count = ${result.storedCount}, error = ${result.error?.slice(0, 500) ?? null}
     WHERE id = ${id}::uuid AND done_at IS NULL`);
}

/**
 * A pull claimed by a listener that then died is owed again: storing is
 * idempotent (the unique index), so the only cost of a second walk is the
 * read — and the one-open-per-chat index would otherwise block every later
 * request for that chat for ever.
 */
export async function releaseStalePulls(managerUserId: string): Promise<number> {
  if (!(await agentTablesReady())) return 0;
  const rows = await db.execute(sql`
    UPDATE tg_peer_pulls SET claimed_at = NULL
     WHERE manager_user_id = ${managerUserId}::uuid AND claimed_at IS NOT NULL AND done_at IS NULL
    RETURNING id`);
  return rows.length;
}

/**
 * The newest stored inbound in this chat since `since`, not deleted — the
 * message a pull's completion asks the worker to answer (regression-14: the
 * sweep drafts only an inbound ≤ 30 minutes old, so a stranger answered
 * three hours later would otherwise be pulled in and never drafted).
 */
export async function newestInboundSince(
  managerUserId: string,
  peerId: bigint,
  since: Date,
): Promise<bigint | null> {
  const rows = await db.execute<{ tg_message_id: string }>(sql`
    SELECT m.tg_message_id::text AS tg_message_id FROM tg_messages m
      LEFT JOIN tg_message_flags f ON f.message_id = m.id
     WHERE m.manager_user_id = ${managerUserId}::uuid
       AND m.peer_id = ${peerId.toString()}::bigint
       AND m.direction = 'in'
       AND m.sent_at >= ${since.toISOString()}::timestamptz
       AND f.deleted_at IS NULL
     ORDER BY m.tg_message_id DESC
     LIMIT 1`);
  return rows[0] ? BigInt(rows[0].tg_message_id) : null;
}
