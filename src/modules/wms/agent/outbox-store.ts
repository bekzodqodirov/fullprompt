import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentOutbox } from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import { accountFlooded, accountRestricted, agentBlocked, type AlarmAccount } from '../crm/account-alarm';
import { readGuard } from '../crm/account-guard';
import { recordSent } from '../crm/outbox';
import { floodEnds } from '../crm/telegram-guard';
import { agentRunning, readAgentConfig } from './config';
import { AGENT_LIMITS, dailySendCeiling, sendJitterMs } from './limits';
import { asksAnew, type AgentOutboxRow, type AgentStepStore, type SendFacts, type StepOutcome } from './send-step';
import { offerStandsFor, onAgentOutboxSettled } from './settle-hooks';
import { isNudge } from './worthy';

/**
 * The database half of the agent pump (spec §17.8): which row is due, every
 * fact `agentSendVerdict` decides from — all read at THIS tick, never carried
 * over from the approval — the one compare-and-set before the send, and what
 * each step's outcome writes.
 *
 * The listener holds the session and calls these; `send-step.ts` holds the
 * decisions. Nothing here talks to Telegram: what an outcome still needs from
 * the connection (mark the dialog unread, end a dead session) comes back in
 * the report for the listener to do.
 */

type OutboxSelect = typeof agentOutbox.$inferSelect;

function toRow(r: OutboxSelect): AgentOutboxRow {
  return {
    id: r.id,
    draftId: r.draftId,
    managerUserId: r.managerUserId,
    peerId: r.peerId,
    clientId: r.clientId,
    leadId: r.leadId,
    body: r.body,
    randomId: r.randomId,
    replyToTgMessageId: r.replyToTgMessageId,
    answersTgMessageId: r.answersTgMessageId,
    status: r.status as AgentOutboxRow['status'],
    step: r.step as AgentOutboxRow['step'],
    nextStepAt: r.nextStepAt,
    typingCount: r.typingCount,
    readDone: r.readDone,
    queuedAt: r.queuedAt,
    releaseAt: r.releaseAt,
  };
}

/** One row by id, in the step machine's shape (the tests, and anything that re-reads a held row). */
export async function agentRowById(id: string): Promise<AgentOutboxRow | null> {
  const [row] = await db.select().from(agentOutbox).where(eq(agentOutbox.id, id));
  return row ? toRow(row) : null;
}

/**
 * The one row this account may step now — or none.
 *
 * ONE reply in flight per account (ban-7): a row past its read (typing or
 * sending) is continued before anything else is touched, and while it waits
 * for its own clock no other row starts. Two replies typed at once from one
 * personal account is not something a person does, and every SetTyping is a
 * call of its own on Telegram's side. Otherwise the row whose clock came due
 * first. The steps are due by `next_step_at`, never by how often the pump is
 * knocked (regression-9).
 */
export async function dueAgentRow(managerUserId: string, now: Date): Promise<AgentOutboxRow | null> {
  const [inFlight] = await db
    .select()
    .from(agentOutbox)
    .where(
      and(
        eq(agentOutbox.managerUserId, managerUserId),
        eq(agentOutbox.status, 'agent'),
        inArray(agentOutbox.step, ['typing', 'send']),
      ),
    )
    .orderBy(agentOutbox.nextStepAt)
    .limit(1);
  if (inFlight) return inFlight.nextStepAt.getTime() <= now.getTime() ? toRow(inFlight) : null;
  const [due] = await db
    .select()
    .from(agentOutbox)
    .where(
      and(
        eq(agentOutbox.managerUserId, managerUserId),
        eq(agentOutbox.status, 'agent'),
        sql`${agentOutbox.nextStepAt} <= ${now.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(agentOutbox.nextStepAt, agentOutbox.queuedAt)
    .limit(1);
  return due ? toRow(due) : null;
}

/** A raw timestamp as epoch milliseconds — `db.execute` hands timestamps back as TEXT (history.ts). */
const msOf = (column: SQL) => sql`(extract(epoch FROM ${column}) * 1000)::float8`;
const dateOf = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

/**
 * A file this system KEPT from the message — the stored record's «it carries a
 * medium» for `asksAnew` (review S4), asked by the send's stored check and by
 * the ✅'s own re-check (`chatMoved`). Not `has_media`: that is true of a
 * sticker and of a link's preview too, neither of which the live head counts
 * as media — and a stored check wider than the head would cancel what the
 * head lets through. A photo whose bytes are still downloading reads as none
 * for a moment; the live head, read again before the read and before the
 * send, sees it.
 */
export function keptFileSql(messageId: SQL): SQL<boolean> {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM attachments k WHERE k.entity_type = 'tg_message' AND k.entity_id = ${messageId})`;
}

type ChatFactsRow = {
  anchor_sent_ms: number | null;
  anchor_deleted: boolean;
  anchor_edited: boolean;
  human_replied: boolean;
  peer_has_written: boolean;
  last_inbound_ms: number | null;
  muted: boolean;
  excluded: boolean;
  newest_client_id: string | null;
  newest_lead_id: string | null;
  newest_found: boolean;
  chat_today: number;
  last_hour: number;
  today: number;
  last_chat_ms: number | null;
  last_account_ms: number | null;
};

/**
 * Everything the chat itself says about this row, in ONE statement: the
 * listener's pool of ten is shared by every account's pump, so a step costs a
 * handful of round trips rather than a dozen parallel ones.
 *
 *   anchor        — the stored row the reply answers, its delete flag, and
 *                   whether it was edited after the draft read it (regression-10);
 *   human_replied — an OUT row after the anchor that is not an AI send: his
 *                   phone, a colleague on his account, or the CRM;
 *   peer_has_written — G7 per PEER (ban-8): an inbound from THIS Telegram
 *                   person on this account, never `clientHasWritten`, whose
 *                   «any peer of the client» is null for a lead and too wide
 *                   for a client;
 *   newest        — the chat's newest stored row's owner (leak-4);
 *   last_inbound  — when the customer last wrote, for the night rule (S3);
 *   caps          — AI sends only, the Tashkent day and the last hour —
 *                   every row handed to Telegram: 'sent', and 'unknown'
 *                   (S5: perhaps delivered, and a fuse that cannot see it
 *                   lets the next reply go as if it were not), each on the
 *                   moment it left (`sent_at`, else the claim before the
 *                   send).
 */
async function chatFacts(row: AgentOutboxRow, now: Date): Promise<ChatFactsRow> {
  const m = sql`${row.managerUserId}::uuid`;
  const p = sql`${row.peerId.toString()}::bigint`;
  const anchor = sql`${row.answersTgMessageId.toString()}::bigint`;
  const dayStart = sql`${tashkentDayStart(tashkentDay(now)).toISOString()}::timestamptz`;
  const hourAgo = sql`${new Date(now.getTime() - 3_600_000).toISOString()}::timestamptz`;
  const rows = await db.execute<ChatFactsRow>(sql`
    SELECT
      ${msOf(sql`a.sent_at`)} AS anchor_sent_ms,
      (f.deleted_at IS NOT NULL) AS anchor_deleted,
      (a.edited_at IS NOT NULL AND (d.anchor_edited_at IS NULL OR a.edited_at > d.anchor_edited_at)) AS anchor_edited,
      EXISTS (
        SELECT 1 FROM tg_messages o
         WHERE o.manager_user_id = ${m} AND o.peer_id = ${p}
           AND o.direction = 'out' AND o.tg_message_id > ${anchor}
           AND NOT EXISTS (
             SELECT 1 FROM agent_outbox x
              WHERE x.manager_user_id = o.manager_user_id AND x.peer_id = o.peer_id
                AND x.tg_message_id = o.tg_message_id)
      ) AS human_replied,
      EXISTS (
        SELECT 1 FROM tg_messages i
         WHERE i.manager_user_id = ${m} AND i.peer_id = ${p} AND i.direction = 'in'
      ) AS peer_has_written,
      ${msOf(sql`(
        SELECT max(li.sent_at) FROM tg_messages li
         WHERE li.manager_user_id = ${m} AND li.peer_id = ${p} AND li.direction = 'in')`)} AS last_inbound_ms,
      EXISTS (
        SELECT 1 FROM agent_conversations c
         WHERE c.manager_user_id = ${m} AND c.peer_id = ${p} AND c.muted_at IS NOT NULL
      ) AS muted,
      EXISTS (
        SELECT 1 FROM tg_chat_rules r
         WHERE r.manager_user_id = ${m} AND r.peer_id = ${p} AND r.decision = 'exclude'
      ) AS excluded,
      nw.client_id AS newest_client_id,
      nw.lead_id AS newest_lead_id,
      (nw.found IS NOT NULL) AS newest_found,
      caps.chat_today, caps.last_hour, caps.today,
      ${msOf(sql`caps.last_chat`)} AS last_chat_ms,
      ${msOf(sql`caps.last_account`)} AS last_account_ms
    FROM (SELECT 1) one
    LEFT JOIN tg_messages a
      ON a.manager_user_id = ${m} AND a.peer_id = ${p} AND a.tg_message_id = ${anchor}
    LEFT JOIN tg_message_flags f ON f.message_id = a.id
    LEFT JOIN agent_drafts d ON d.id = ${row.draftId}::uuid
    LEFT JOIN LATERAL (
      SELECT n.client_id, n.lead_id, 1 AS found FROM tg_messages n
       WHERE n.manager_user_id = ${m} AND n.peer_id = ${p}
       ORDER BY n.tg_message_id DESC
       LIMIT 1
    ) nw ON true
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE s.peer_id = ${p} AND s.at >= ${dayStart})::int AS chat_today,
             count(*) FILTER (WHERE s.at >= ${hourAgo})::int AS last_hour,
             count(*) FILTER (WHERE s.at >= ${dayStart})::int AS today,
             max(s.at) FILTER (WHERE s.peer_id = ${p}) AS last_chat,
             max(s.at) AS last_account
        FROM (
          SELECT x.peer_id, coalesce(x.sent_at, x.step_claimed_at) AS at FROM agent_outbox x
           WHERE x.manager_user_id = ${m} AND x.status IN ('sent', 'unknown')
        ) s
       WHERE s.at >= least(${dayStart}, ${hourAgo})
    ) caps`);
  return rows[0]!;
}

/**
 * Does the customer's newer line want its OWN answer? «??», «alo» and a
 * closing token do not, a new question does, and so does a photo, a voice
 * note or a file (`asksAnew`, the rule the live head asks — S4) — and a line
 * the customer deleted asks nothing.
 */
async function newerSubstantiveInbound(row: AgentOutboxRow): Promise<boolean> {
  const rows = await db.execute<{ body: string | null; kept: boolean }>(sql`
    SELECT i.body, ${keptFileSql(sql`i.id`)} AS kept FROM tg_messages i
      LEFT JOIN tg_message_flags f ON f.message_id = i.id
     WHERE i.manager_user_id = ${row.managerUserId}::uuid
       AND i.peer_id = ${row.peerId.toString()}::bigint
       AND i.direction = 'in'
       AND i.tg_message_id > ${row.answersTgMessageId.toString()}::bigint
       AND f.deleted_at IS NULL
     ORDER BY i.tg_message_id
     LIMIT 50`);
  return rows.some((r) => asksAnew({ text: r.body ?? '', media: r.kept === true }, isNudge));
}

/**
 * His own average daily sends from this account over the 30 days before the
 * agent was first switched on (his Q11 ⭐ — the ramp is computed, not typed,
 * ban-11). The window never moves once `started_at` is set, so the answer is
 * kept per (account, start) for the life of the process.
 */
const ownAverageMemo = new Map<string, number>();

async function ownAverage(managerUserId: string, startedAt: Date): Promise<number> {
  const key = `${managerUserId}|${startedAt.toISOString()}`;
  const known = ownAverageMemo.get(key);
  if (known !== undefined) return known;
  const from = new Date(startedAt.getTime() - 30 * 86_400_000).toISOString();
  const rows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM tg_messages m
     WHERE m.manager_user_id = ${managerUserId}::uuid
       AND m.direction = 'out'
       AND m.sent_at >= ${from}::timestamptz
       AND m.sent_at < ${startedAt.toISOString()}::timestamptz
       AND NOT EXISTS (
         SELECT 1 FROM agent_outbox x
          WHERE x.manager_user_id = m.manager_user_id AND x.peer_id = m.peer_id
            AND x.tg_message_id = m.tg_message_id)`);
  const average = Number(rows[0]?.n ?? 0) / 30;
  ownAverageMemo.set(key, average);
  return average;
}

/** Tests: a fresh process, as far as the ramp's memo knows. */
export function __forgetOwnAverage(): void {
  ownAverageMemo.clear();
}

export interface StoreContext {
  accountId: string;
  /** This process finished its start-up catch-up (ban-3). */
  caughtUp: () => boolean;
  /** The human pump's in-memory flood clock — a fast path beside the guard row's. */
  memoryFloodUntil?: () => Date | null;
  random?: () => number;
}

function later(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/** Every fact the verdict decides from, read now. Exported for the integration tests. */
export async function sendFactsFor(row: AgentOutboxRow, now: Date, ctx: StoreContext): Promise<SendFacts> {
  const config = await readAgentConfig();
  const guard = await readGuard(ctx.accountId);
  const sendingEnabled = (await getSetting('tg_sending_enabled')) === true;
  const chat = await chatFacts(row, now);
  const substantive = await newerSubstantiveInbound(row);
  const offerStands = await offerStandsFor(row.draftId);
  const average = config?.startedAt ? await ownAverage(row.managerUserId, config.startedAt) : 0;

  const identityChanged =
    chat.newest_found &&
    (row.clientId !== null ? chat.newest_client_id !== row.clientId : chat.newest_lead_id !== row.leadId);

  return {
    now,
    agentOn: agentRunning(config),
    ownerUserId: config?.ownerUserId ?? null,
    sendingEnabled,
    accountPaused: guard.pausedAt !== null,
    floodUntil: later(guard.floodUntil, ctx.memoryFloodUntil?.() ?? null),
    caughtUp: ctx.caughtUp(),
    anchorSentAt: dateOf(chat.anchor_sent_ms),
    anchorDeleted: chat.anchor_deleted,
    anchorEditedSinceDraft: chat.anchor_edited,
    humanReplied: chat.human_replied,
    newerSubstantiveInbound: substantive,
    peerHasWritten: chat.peer_has_written,
    lastInboundAt: dateOf(chat.last_inbound_ms),
    conversationMuted: chat.muted,
    ruleExcluded: chat.excluded,
    identityChanged,
    offerStands,
    sentToChatToday: Number(chat.chat_today),
    sentLastHour: Number(chat.last_hour),
    sentToday: Number(chat.today),
    dailyCeiling: dailySendCeiling({ startedAt: config?.startedAt ?? null, ownAverage: average, now }),
    lastChatSendAt: dateOf(chat.last_chat_ms),
    lastAccountSendAt: dateOf(chat.last_account_ms),
    accountGapMs: sendJitterMs(ctx.random),
  };
}

/**
 * 'agent' → 'sending', for this row only — the CAS the send step takes
 * BEFORE the invoke (build-3). False when somebody moved it first: «off»
 * cancelled it, the owner withdrew it, a forced off swept it.
 */
export async function claimAgentSend(rowId: string): Promise<boolean> {
  const rows = await db
    .update(agentOutbox)
    .set({ status: 'sending', stepClaimedAt: new Date() })
    .where(and(eq(agentOutbox.id, rowId), eq(agentOutbox.status, 'agent')))
    .returning({ id: agentOutbox.id });
  return rows.length > 0;
}

export function agentStepStore(ctx: StoreContext): AgentStepStore {
  return {
    facts: (row, now) => sendFactsFor(row, now, ctx),
    claimSend: claimAgentSend,
  };
}

/** What the listener still has to do with the connection after an outcome is written. */
export interface OutcomeReport {
  /** The row reached a final state (its card was asked to say so). */
  final: boolean;
  /** The customer's question was read on his phone and nothing went (regression-12). */
  markUnread: boolean;
  /** Telegram ended the session — the listener's own session-dead path. */
  sessionDead: string | null;
}

/** AI replies that met a customer who had blocked the account, inside the window (map P13). */
export async function blocksSince(managerUserId: string, since: Date): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM agent_outbox
     WHERE manager_user_id = ${managerUserId}::uuid
       AND status = 'failed'
       AND last_error LIKE 'USER_IS_BLOCKED%'
       AND coalesce(step_claimed_at, queued_at) >= ${since.toISOString()}::timestamptz`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * A recipient's final answer mutes this conversation for the agent: they
 * blocked us, their privacy forbids it, the account is gone. The FIRST mute
 * and its reason stand — a person's own 🔇 is not rewritten by a machine's.
 */
async function muteConversation(row: AgentOutboxRow, reason: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO agent_conversations (manager_user_id, peer_id, muted_at, mute_reason, updated_at)
    VALUES (${row.managerUserId}::uuid, ${row.peerId.toString()}::bigint, now(), ${reason.slice(0, 200)}, now())
    ON CONFLICT (manager_user_id, peer_id) DO UPDATE
      SET muted_at = coalesce(agent_conversations.muted_at, EXCLUDED.muted_at),
          mute_reason = coalesce(agent_conversations.mute_reason, EXCLUDED.mute_reason),
          updated_at = now()`);
}

async function settled(row: AgentOutboxRow): Promise<void> {
  // Best-effort: the card is a view of the row, and the row is already right.
  await onAgentOutboxSettled(row.id).catch(() => undefined);
}

const LIVE = ['agent', 'sending'] as const;

/**
 * Write one step's outcome.
 *
 * Re-runnable by design: a database that drops out halfway leaves the
 * listener holding this outcome and calling again (the `unsettled` idiom,
 * `isDbUnreachable` only) — so every write names the states it may move
 * from, and a write that already landed matches nothing the second time.
 */
export async function applyAgentOutcome(
  row: AgentOutboxRow,
  outcome: StepOutcome,
  account: AlarmAccount,
  now: Date = new Date(),
): Promise<OutcomeReport> {
  const quiet: OutcomeReport = { final: false, markUnread: false, sessionDead: null };
  switch (outcome.kind) {
    case 'advance': {
      await db
        .update(agentOutbox)
        .set({
          step: outcome.step,
          nextStepAt: outcome.nextStepAt,
          ...(outcome.readDone !== undefined ? { readDone: outcome.readDone } : {}),
          ...(outcome.typingCount !== undefined ? { typingCount: outcome.typingCount } : {}),
        })
        .where(and(eq(agentOutbox.id, row.id), eq(agentOutbox.status, 'agent')));
      return quiet;
    }
    case 'wait': {
      // A night hold moves the approval's own clock with it (S2, S3): the reply waits for the morning it is
      // now promised for, and its six hours count from there.
      await db
        .update(agentOutbox)
        .set({ nextStepAt: outcome.nextStepAt, ...(outcome.reason === 'night' ? { releaseAt: outcome.nextStepAt } : {}) })
        .where(and(eq(agentOutbox.id, row.id), eq(agentOutbox.status, 'agent')));
      return quiet;
    }
    case 'cancel': {
      await db
        .update(agentOutbox)
        .set({ status: 'cancelled', lastError: outcome.reason })
        .where(and(eq(agentOutbox.id, row.id), eq(agentOutbox.status, 'agent')));
      await settled(row);
      return { final: true, markUnread: outcome.markUnread, sessionDead: null };
    }
    case 'sent': {
      await db
        .update(agentOutbox)
        .set({ status: 'sent', sentAt: now, tgMessageId: outcome.tgMessageId, lastError: null })
        .where(and(eq(agentOutbox.id, row.id), inArray(agentOutbox.status, [...LIVE])));
      // The thread's copy — Telegram does not echo a message sent on this
      // connection (round 53), so this row is the only record the CRM will
      // have. A RANDOM_ID_DUPLICATE gives no id: the message went, its echo
      // cannot be written (stated; the card says it was sent).
      if (outcome.tgMessageId !== null) {
        await recordSent({
          clientId: row.clientId,
          leadId: row.leadId,
          managerUserId: row.managerUserId,
          peerId: row.peerId,
          tgMessageId: outcome.tgMessageId,
          body: row.body,
          replyToTgMessageId: row.replyToTgMessageId,
          sentAt: now,
        });
      }
      await settled(row);
      return { final: true, markUnread: false, sessionDead: null };
    }
    case 'unknown': {
      // Handed to Telegram, answer lost: NEVER re-sent (ban-5). The card
      // asks him to look at the chat; a second message is the one outcome
      // worse than none.
      await db
        .update(agentOutbox)
        .set({ status: 'unknown', lastError: outcome.reason.slice(0, 500) })
        .where(and(eq(agentOutbox.id, row.id), inArray(agentOutbox.status, [...LIVE])));
      await settled(row);
      return { final: true, markUnread: false, sessionDead: null };
    }
    case 'flooded': {
      // The row goes back to waiting FIRST, so a forced «off» below finds it
      // as an approved reply and cancels it with the rest.
      await db
        .update(agentOutbox)
        .set({ status: 'agent', nextStepAt: floodEnds(outcome.seconds, now) })
        .where(and(eq(agentOutbox.id, row.id), inArray(agentOutbox.status, [...LIVE])));
      await accountFlooded(account, { method: outcome.method, seconds: outcome.seconds, source: 'raise' }, now);
      return quiet;
    }
    case 'failed': {
      await db
        .update(agentOutbox)
        .set({ status: 'failed', lastError: outcome.reason.slice(0, 500) })
        .where(and(eq(agentOutbox.id, row.id), inArray(agentOutbox.status, [...LIVE])));
      const error = outcome.error;
      let sessionDead: string | null = null;
      switch (error.kind) {
        case 'restricted':
          await accountRestricted(account, { pause: error.pause, code: error.code });
          break;
        case 'session':
          sessionDead = error.code;
          break;
        case 'recipient_final':
          await muteConversation(row, error.code);
          if (error.code === 'USER_IS_BLOCKED') {
            const since = new Date(now.getTime() - AGENT_LIMITS.blockWindowDays * 86_400_000);
            if ((await blocksSince(row.managerUserId, since)) >= 2) await agentBlocked(account);
          }
          break;
        default:
          break;
      }
      await settled(row);
      // A dead session cannot mark anything; every other refusal leaves the
      // question read with nothing sent, so the badge comes back.
      return { final: true, markUnread: outcome.markUnread && sessionDead === null, sessionDead };
    }
  }
}

/**
 * Replies that ended after their read step with nothing sent — the
 * customer's question shows as read on his phone and no answer went
 * (regression-12). The pump's own aborts are restored as they happen; this
 * also finds the ones somebody ELSE ended: «off» on the screen, the forced
 * «off» of an alarm, a draft retired elsewhere. An 'unknown' row is not one
 * of them — the message may well be in the chat. A day back and no further:
 * a badge given back tomorrow is noise, not a reminder.
 */
export async function badgesToRestore(
  managerUserId: string,
  now: Date,
): Promise<{ id: string; peerId: bigint; lastError: string | null }[]> {
  const rows = await db
    .select({ id: agentOutbox.id, peerId: agentOutbox.peerId, lastError: agentOutbox.lastError })
    .from(agentOutbox)
    .where(
      and(
        eq(agentOutbox.managerUserId, managerUserId),
        eq(agentOutbox.readDone, true),
        inArray(agentOutbox.status, ['cancelled', 'failed', 'expired']),
        sql`${agentOutbox.queuedAt} >= ${new Date(now.getTime() - 86_400_000).toISOString()}::timestamptz`,
      ),
    )
    .orderBy(agentOutbox.queuedAt)
    .limit(5);
  return rows;
}

/**
 * The badge is back (or could not be, on a dead session): `read_done` on a
 * FINAL row means «the read we did still stands on his phone», so it is
 * cleared — and the row is never given back twice.
 */
export async function badgeRestored(id: string): Promise<void> {
  await db
    .update(agentOutbox)
    .set({ readDone: false })
    .where(and(eq(agentOutbox.id, id), inArray(agentOutbox.status, ['cancelled', 'failed', 'expired'])));
}

/**
 * A reply was being SENT when the listener died: nobody can tell from here
 * whether Telegram has it, so it is 'unknown' — never re-sent (ban-5), the
 * card asks him to look. The human queue's `recoverInFlight`, with the agent's
 * stricter answer: a person may press «send again», the machine may not.
 */
export async function recoverAgentInFlight(managerUserId: string): Promise<string[]> {
  const rows = await db
    .update(agentOutbox)
    .set({ status: 'unknown', lastError: 'listener restarted while sending — check Telegram' })
    .where(and(eq(agentOutbox.managerUserId, managerUserId), eq(agentOutbox.status, 'sending')))
    .returning({ id: agentOutbox.id });
  return rows.map((r) => r.id);
}
