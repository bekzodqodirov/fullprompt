import { sql } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import { AGENT_LIMITS, dailySendCeiling } from './limits';

/**
 * The day's counts the agent's caps are made of — ONE home (house rule #513),
 * read by the caps themselves and by the page that shows them.
 *
 * `/suhbatlar/ai` printed «today» by restating the reservation's predicate
 * (run.ts) and the ✅'s send budget (decide.ts) in SQL of its own; a fourth
 * outcome added to the reservation, or a status to the budget, would have
 * left the page counting a different day from the one the caps refuse on.
 */

export interface DayRunCounts {
  /** Inbound runs that reached a reservation — what `daily_draft_cap` counts. */
  runs: number;
  /** The same, for one chat — `runsPerChatPerDay`. Zero when no chat was asked about. */
  chat: number;
  /** input + output + cache-write tokens of every run — what `daily_token_cap` counts. */
  tokens: number;
  drafts: number;
  errors: number;
}

/**
 * The runs since `dayStart` (a Tashkent day's start, ISO). Takes the handle:
 * the reservation reads it inside its own transaction, under the cap lock,
 * and a pooled read there would wait for an eleventh connection (#714).
 */
export async function dayRunCounts(
  dayStart: string,
  chat: { managerUserId: string; peerId: bigint } | null,
  handle: Db | Tx = db,
): Promise<DayRunCounts> {
  const chatClause = chat
    ? sql`AND manager_user_id = ${chat.managerUserId} AND peer_id = ${String(chat.peerId)}::bigint`
    : sql`AND false`;
  const [row] = await handle.execute<{ runs: number; chat: number; tokens: string; drafts: number; errors: number }>(sql`
    SELECT
      count(*) FILTER (WHERE trigger = 'inbound' AND outcome NOT IN ('refused', 'capped', 'notice'))::int AS runs,
      count(*) FILTER (WHERE trigger = 'inbound' AND outcome NOT IN ('refused', 'capped', 'notice') ${chatClause})::int AS chat,
      coalesce(sum(input_tokens + output_tokens + cache_write_tokens), 0)::bigint::text AS tokens,
      count(*) FILTER (WHERE outcome = 'draft')::int AS drafts,
      count(*) FILTER (WHERE outcome = 'error')::int AS errors
    FROM agent_runs WHERE created_at >= ${dayStart}::timestamptz`);
  return {
    runs: Number(row?.runs ?? 0),
    chat: Number(row?.chat ?? 0),
    tokens: Number(row?.tokens ?? 0),
    drafts: Number(row?.drafts ?? 0),
    errors: Number(row?.errors ?? 0),
  };
}

/**
 * Today's AI sends on an account against the day's ceiling (fit-8, his Q11 ⭐):
 * what a ✅ beyond the ceiling is refused by, and what the page prints.
 */
export async function sendsToday(
  managerUserId: string,
  startedAt: Date | null,
  now: Date,
): Promise<{ used: number; ceiling: number }> {
  const dayStart = tashkentDayStart(tashkentDay(now)).toISOString();
  const [used] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM agent_outbox
     WHERE manager_user_id = ${managerUserId}
       AND status IN ('agent', 'sending', 'sent', 'unknown')
       AND queued_at >= ${dayStart}::timestamptz`);
  // His own average daily sends over the 30 days before the agent started (his Q11 ⭐).
  let ownAverage: number = AGENT_LIMITS.perDay;
  if (startedAt) {
    const from = new Date(startedAt.getTime() - 30 * 86_400_000);
    const [own] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM tg_messages m
       WHERE m.manager_user_id = ${managerUserId} AND m.direction = 'out'
         AND m.sent_at >= ${from.toISOString()}::timestamptz AND m.sent_at < ${startedAt.toISOString()}::timestamptz
         AND NOT EXISTS (SELECT 1 FROM agent_outbox o WHERE o.manager_user_id = m.manager_user_id AND o.tg_message_id = m.tg_message_id)`);
    ownAverage = Number(own?.n ?? 0) / 30;
  }
  return { used: Number(used?.n ?? 0), ceiling: dailySendCeiling({ startedAt, ownAverage, now }) };
}
