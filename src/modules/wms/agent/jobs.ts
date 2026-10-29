import type PgBoss from 'pg-boss';
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { aiConfigured } from '../../platform/ai/model';
import { db } from '../../platform/db/client';
import { agentDrafts, agentOutbox, agentRuns, tgMessages } from '../../platform/db/schema';
import { enqueue } from '../../platform/jobs/boss';
import { logger } from '../../platform/logger';
import { actorGrants } from '../../platform/rbac/authorize';
import { quietHour } from '../../platform/telegram/send';
import { canLogInSql } from '../../platform/users/login';
import { TELEGRAM_SERVICE_PEER } from '../crm/telegram-import';
import { agentRunning, agentTablesReady, readAgentConfig } from './config';
import { AGENT_LIMITS } from './limits';
import {
  EDIT_ATTEMPT_BASE,
  INBOUND_START_AFTER_S,
  isFirstAsk,
  JOB_AGENT_HAND_BACK,
  JOB_AGENT_HUMAN_REPLY,
  JOB_AGENT_INBOUND,
  JOB_AGENT_SWEEP,
  REDRAFT_ATTEMPT_BASE,
  type AgentHandBackJob,
  type AgentHumanReplyJob,
  type AgentInboundJob,
} from './queues';

/**
 * The agent's workers (spec §17.3): the inbound run, his own reply retiring
 * the live draft, and a one-minute sweep for what no event carries — the
 * 24-hour expiry, his unanswered question's one reminder, a run its process
 * died inside, the deploy gap, an errored run's one retry, an action stuck
 * after its commit. Every job asks `agentTablesReady()` first.
 */

/**
 * Why a run started when it did, for the `[agent] inbound` line (2026-10-29:
 * a card that came 23 minutes after the customer's lines, and a log that
 * could not say whether the job waited in the queue or was born late). The
 * ORIGIN says who asked — the live hook, an edit, a stranger's pull answered
 * on the bot's card or the web tray, the sweep's gap pass or retry, his ✅/❌
 * asking again (`redraft`) — `waited` that it looked once and waited out the
 * customer's typing or a bare greeting (run `reschedule`), and the clocks
 * say how long it waited: `lagMs` past the moment it was allowed to start (a
 * busy or stopped worker), `queuedMs` since it was put on the queue. Both
 * from pg-boss's own columns (`includeMetadata`), the database's one clock;
 * a job without them (an old caller) logs the origin alone. Never a word of
 * the chat — the peer's id is all the line names.
 */
export function inboundLogFields(job: {
  data: AgentInboundJob;
  startAfter?: Date | string | null;
  createdOn?: Date | string | null;
  startedOn?: Date | string | null;
}): {
  peer: string;
  origin: AgentInboundJob['origin'];
  attempt: number;
  waited?: AgentInboundJob['waited'];
  lagMs?: number;
  queuedMs?: number;
} {
  const at = (value: Date | string | null | undefined): number | null => {
    if (value === null || value === undefined) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  };
  const started = at(job.startedOn);
  const allowed = at(job.startAfter);
  const created = at(job.createdOn);
  return {
    peer: job.data.peerId,
    origin: job.data.origin,
    attempt: job.data.attempt ?? 0,
    ...(job.data.waited ? { waited: job.data.waited } : {}),
    ...(started !== null && allowed !== null ? { lagMs: Math.max(0, started - allowed) } : {}),
    ...(started !== null && created !== null ? { queuedMs: Math.max(0, started - created) } : {}),
  };
}

export async function registerAgentWorkers(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_AGENT_INBOUND);
  // `includeMetadata`: the line below names how long the job waited (calc/jobs.ts asks the same way).
  await boss.work<AgentInboundJob>(JOB_AGENT_INBOUND, { includeMetadata: true }, async (jobs) => {
    const { handleInbound } = await import('./run');
    for (const job of jobs) {
      try {
        const out = await handleInbound(job.data);
        logger.info({ ...inboundLogFields(job), ...out }, '[agent] inbound');
      } catch (err) {
        // retryLimit 0: a re-delivered model call is a second bill for one
        // message. The sweep retries an errored run once, deliberately.
        logger.error({ err, ...inboundLogFields(job) }, '[agent] inbound job failed');
      }
    }
  });
  await boss.createQueue(JOB_AGENT_HUMAN_REPLY);
  await boss.work<AgentHumanReplyJob>(JOB_AGENT_HUMAN_REPLY, async (jobs) => {
    for (const job of jobs) {
      try {
        await retireOnHumanReply(job.data.managerUserId, BigInt(job.data.peerId), BigInt(job.data.tgMessageId));
      } catch (err) {
        logger.error({ err }, '[agent] human-reply job failed');
      }
    }
  });
  await boss.createQueue(JOB_AGENT_HAND_BACK);
  await boss.work<AgentHandBackJob>(JOB_AGENT_HAND_BACK, async (jobs) => {
    const { handleHandBack } = await import('./calc-loop');
    for (const job of jobs) {
      try {
        const out = await handleHandBack(job.data);
        logger.info({ peer: job.data.peerId, requestId: job.data.requestId, ...out }, '[agent] hand-back');
      } catch (err) {
        // Sent with retryLimit 0, like the inbound run: a second delivery is a
        // second model bill, and the run's source_key keeps it once anyway.
        logger.error({ err }, '[agent] hand-back job failed');
      }
    }
  });
  await boss.createQueue(JOB_AGENT_SWEEP);
  await boss.schedule(JOB_AGENT_SWEEP, '* * * * *');
  await boss.work(JOB_AGENT_SWEEP, async () => {
    try {
      await agentSweep();
    } catch (err) {
      logger.error({ err }, '[agent] sweep failed');
    }
  });
}

/**
 * A 'reserved' run older than this died with its process (K24): five times
 * the model loop's own 90-second wall clock (run.ts `LOOP_WALL_MS`) and the
 * writes after it — no live run is still that young-looking.
 */
export const INTERRUPTED_RUN_MS = 5 * 60_000;

/**
 * How long an errored ask stays the sweep's to retry (step 4) — and so how
 * long a press may count it as a card on its way (decide `redraftNewest`).
 */
export const ERRORED_RETRY_WINDOW_MS = 60 * 60_000;

/**
 * His 14 (2026-10-24, «escalation wait 30 min»): a question the agent put to
 * HIM (`needs_owner`) and he has not answered gets one reminder after half an
 * hour — the customer is waiting on his word, and the AI will not answer for
 * him. One per question (`owner_reminded_at`), counts only: the card it
 * points to already carries the customer's words, and a reminder that quoted
 * them would be one more copy of a customer's text in his chat (leak-13).
 */
export const OWNER_QUESTION_WAIT_MS = 30 * 60_000;

/** The reminder's words — a count, never a customer's text or name. */
export function ownerQuestionReminderText(waiting: number): string {
  return `🔔 AI sizdan so‘ragan savolga 30 daqiqadan beri javob yo‘q — mijoz javobingizni kutyapti, AI o‘zi javob bermaydi. Javobsiz savollar: ${waiting} ta. Kartani ko‘ring yoki «Suhbatlar → AI sotuvchi → Savollar».`;
}

/**
 * One reminder per MANAGER for the questions that crossed the half hour since
 * the last sweep — claimed per draft by its own column, so two sweeps at once
 * remind once — and only by DAY (ident fix F9). The reminder exists to ring:
 * claimed at 07:10 it would arrive silent (an AgentNotice is night-silent,
 * night.ts) and, being once-only, no question asked in the night would ever
 * ring at all. So the night claims nothing, and the first sweep after 08:00
 * Tashkent reminds of every one, audibly. Three questions crossing in one
 * minute are ONE notice, never three copies of «3 ta».
 *
 * It names the CHAT of the newest question it reminds of (`peerId`, the key
 * the purge finds an AgentNotice by): a count carries no customer's words
 * (leak-13), and a purged chat takes the notice that pointed at it. The count
 * is every question still waiting on him, the newly crossed and the ones
 * already reminded alike. Returns how many questions it claimed.
 */
export async function remindOwnerQuestions(now: Date): Promise<number> {
  if (quietHour(now)) return 0;
  const cutoff = new Date(now.getTime() - OWNER_QUESTION_WAIT_MS).toISOString();
  // `created_ms` as a number: a raw execute hands timestamps back as TEXT (history.ts's lesson).
  const claimed = await db.execute<{ manager_user_id: string; peer_id: string; created_ms: number }>(sql`
    UPDATE agent_drafts SET owner_reminded_at = now()
     WHERE status = 'pending' AND needs_owner AND owner_reminded_at IS NULL
       AND created_at < ${cutoff}::timestamptz
    RETURNING manager_user_id::text, peer_id::text, (extract(epoch FROM created_at) * 1000)::float8 AS created_ms`);
  if (claimed.length === 0) return 0;
  const { notifyStaffTelegram } = await import('../../platform/notifications/staff');
  // The newest claimed question per manager names the notice's chat.
  const newest = new Map<string, { peerId: string; at: number }>();
  for (const r of claimed) {
    const at = Number(r.created_ms);
    const seen = newest.get(r.manager_user_id);
    if (!seen || at > seen.at) newest.set(r.manager_user_id, { peerId: r.peer_id, at });
  }
  for (const [managerUserId, { peerId }] of newest) {
    const [row] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM agent_drafts
       WHERE manager_user_id = ${managerUserId}::uuid AND status = 'pending' AND needs_owner
         AND created_at < ${cutoff}::timestamptz`);
    await notifyStaffTelegram({
      userIds: [managerUserId],
      type: 'AgentNotice',
      text: ownerQuestionReminderText(Number(row?.n ?? 0)),
      extra: { peerId: String(peerId) },
    });
  }
  return claimed.length;
}

/**
 * The chats whose run is already on its way: an `agent.inbound` job still
 * WAITING to be picked up for the anchor, from pg-boss's own table — keyed
 * `peer:anchor` for this account (2026-10-29). The sweep's two passes below
 * looked only at `agent_runs`, and a run writes its row when it STARTS, so
 * while one job waited behind a busy worker every sweep added another for
 * the same line, a minute apart — and the one serial worker then had to
 * carry each of them to its «duplicate» before it reached the next
 * customer's chat. No `singletonKey`: the queues are standard (queues.ts).
 *
 * Waiting only, never 'active': a job a killed process was running stays
 * 'active' until pg-boss expires it a quarter of an hour later, and the two
 * passes are exactly what recovers that line (K24); a job really running
 * writes its `agent_runs` row in its first moments, and that the passes
 * already ask. A database with no pg-boss schema yet (a fresh test db) has
 * no jobs.
 */
export async function inboundJobsWaiting(managerUserId: string): Promise<Set<string>> {
  const [present] = await db.execute<{ job: boolean }>(sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS job`);
  if (!present?.job) return new Set();
  const rows = await db.execute<{ peer_id: string | null; anchor: string | null }>(sql`
    SELECT data->>'peerId' AS peer_id, data->>'anchorTgMessageId' AS anchor
      FROM pgboss.job
     WHERE name = ${JOB_AGENT_INBOUND}
       AND state IN ('created', 'retry')
       AND data->>'managerUserId' = ${managerUserId}`);
  return new Set(rows.map((r) => `${r.peer_id}:${r.anchor}`));
}

/**
 * The press's question (decide `redraftNewest`), one state wider than the
 * sweep's: a job WAITING, as above, or one the worker has just PICKED UP and
 * that has not written its run yet — between pg-boss's fetch and `reserve`
 * the run reads the chat, asks whether the customer is typing, `draftWorthy`
 * and eligibility, and neither table says anything of it (review: ✅ in that
 * window answered «o‘zingiz javob bering», and the card came anyway). Only a
 * pick-up younger than `INTERRUPTED_RUN_MS` — an older 'active' is a killed
 * process's, which the sweep recovers (K24) — and started at or after
 * `since`: for the anchor his card answers, a job picked up before the card
 * was written is the card's own run finishing, not a new one.
 */
export async function inboundJobsComing(managerUserId: string, since: Date, now: Date = new Date()): Promise<Set<string>> {
  const [present] = await db.execute<{ job: boolean }>(sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS job`);
  if (!present?.job) return new Set();
  const floor = new Date(Math.max(since.getTime(), now.getTime() - INTERRUPTED_RUN_MS)).toISOString();
  const rows = await db.execute<{ peer_id: string | null; anchor: string | null }>(sql`
    SELECT data->>'peerId' AS peer_id, data->>'anchorTgMessageId' AS anchor
      FROM pgboss.job
     WHERE name = ${JOB_AGENT_INBOUND}
       AND data->>'managerUserId' = ${managerUserId}
       AND (state IN ('created', 'retry') OR (state = 'active' AND started_on >= ${floor}::timestamptz))`);
  return new Set(rows.map((r) => `${r.peer_id}:${r.anchor}`));
}

async function refreshCardOf(draftId: string): Promise<void> {
  const { refreshAgentCard } = await import('./card-io');
  await refreshAgentCard(draftId).catch((err: unknown) => logger.warn({ err, draftId }, '[agent] card not refreshed'));
}

/**
 * He answered the chat himself (fit-3): the live draft is his no more —
 * `taken_over`, and its card says «o'zingiz javob berdingiz». An out row that
 * is the agent's own send (its echo) retires nothing.
 */
export async function retireOnHumanReply(managerUserId: string, peerId: bigint, tgMessageId: bigint): Promise<number> {
  if (!(await agentTablesReady())) return 0;
  const [ours] = await db
    .select({ id: agentOutbox.id })
    .from(agentOutbox)
    .where(and(eq(agentOutbox.managerUserId, managerUserId), eq(agentOutbox.tgMessageId, tgMessageId)));
  if (ours) return 0;
  const retired = await db
    .update(agentDrafts)
    .set({ status: 'taken_over', updatedAt: new Date() })
    .where(
      and(
        eq(agentDrafts.managerUserId, managerUserId),
        eq(agentDrafts.peerId, peerId),
        inArray(agentDrafts.status, ['pending', 'editing']),
        lt(agentDrafts.anchorTgMessageId, tgMessageId),
      ),
    )
    .returning({ id: agentDrafts.id });
  for (const r of retired) await refreshCardOf(r.id);
  return retired.length;
}

export async function agentSweep(
  now: Date = new Date(),
): Promise<{ expired: number; retired: number; gap: number; retried: number; actions: number; reminded: number; interrupted: number }> {
  if (!(await agentTablesReady())) return { expired: 0, retired: 0, gap: 0, retried: 0, actions: 0, reminded: 0, interrupted: 0 };

  // 1. A draft lives as long as its anchor's reply window (fit-3).
  const expired = await db.execute<{ id: string }>(sql`
    UPDATE agent_drafts d SET status = 'expired', updated_at = now()
      FROM tg_messages m
     WHERE d.status IN ('pending', 'editing')
       AND m.manager_user_id = d.manager_user_id AND m.peer_id = d.peer_id AND m.tg_message_id = d.anchor_tg_message_id
       AND m.sent_at < ${new Date(now.getTime() - AGENT_LIMITS.draftTtlMs).toISOString()}::timestamptz
    RETURNING d.id`);
  for (const r of expired) await refreshCardOf(r.id);

  // 2. His own reply the hook did not carry (a CRM reply is recorded by the
  //    pump, not by NewMessage) — the human-reply fallback.
  const retired = await db.execute<{ id: string }>(sql`
    UPDATE agent_drafts d SET status = 'taken_over', updated_at = now()
     WHERE d.status IN ('pending', 'editing')
       AND EXISTS (
         SELECT 1 FROM tg_messages m
          WHERE m.manager_user_id = d.manager_user_id AND m.peer_id = d.peer_id
            AND m.direction = 'out' AND m.tg_message_id > d.anchor_tg_message_id
            AND NOT EXISTS (SELECT 1 FROM agent_outbox o WHERE o.manager_user_id = m.manager_user_id AND o.tg_message_id = m.tg_message_id)
            AND NOT EXISTS (SELECT 1 FROM tg_message_flags f WHERE f.message_id = m.id AND f.deleted_at IS NOT NULL))
    RETURNING d.id`);
  for (const r of retired) await refreshCardOf(r.id);

  // 2a. A question to him still unanswered after half an hour — reminded once (his 14, K30).
  const reminded = await remindOwnerQuestions(now);

  // 2b. A run the process died inside (final review K24): `reserve` writes the
  //     row as 'reserved' and only the run's `finally` settles it — every
  //     deploy's container restart, the watchdog's kill and an OOM skip that
  //     `finally`, and pg-boss redelivers nothing (retryLimit 0). Left
  //     'reserved', the deploy-gap pass below sees «a run exists» and the
  //     retry pass looks only at 'error', so the customer's message was never
  //     drafted and nothing said so. Long past any loop's wall clock it is an
  //     error — the one retry below then takes it, as it takes a throw.
  const interrupted = await db.execute<{ id: string }>(sql`
    UPDATE agent_runs SET outcome = 'error', error = 'interrupted'
     WHERE outcome = 'reserved'
       AND created_at < ${new Date(now.getTime() - INTERRUPTED_RUN_MS).toISOString()}::timestamptz
    RETURNING id`);
  if (interrupted.length > 0) logger.warn({ runs: interrupted.length }, '[agent] interrupted runs marked as errors');

  const config = await readAgentConfig();
  let gap = 0;
  let retried = 0;
  if (agentRunning(config) && aiConfigured()) {
    // A line whose job is still waiting is asked about by that job, not again.
    const waiting = await inboundJobsWaiting(config.ownerUserId);
    // 3. The deploy gap: a chat whose newest inbound (≤ 30 min) has no run.
    const due = await db.execute<{ peer_id: string; tg_message_id: string }>(sql`
      SELECT DISTINCT ON (m.peer_id) m.peer_id::text, m.tg_message_id::text
        FROM tg_messages m
       WHERE m.manager_user_id = ${config.ownerUserId}
         AND m.sent_at > ${new Date(now.getTime() - 30 * 60_000).toISOString()}::timestamptz
         AND (m.client_id IS NOT NULL OR m.lead_id IS NOT NULL)
       ORDER BY m.peer_id, m.sent_at DESC, m.tg_message_id DESC`);
    for (const row of due) {
      const [newest] = await db
        .select({ direction: tgMessages.direction, sentAt: tgMessages.sentAt })
        .from(tgMessages)
        .where(and(eq(tgMessages.managerUserId, config.ownerUserId), eq(tgMessages.peerId, BigInt(row.peer_id)), eq(tgMessages.tgMessageId, BigInt(row.tg_message_id))));
      if (newest?.direction !== 'in') continue;
      if (now.getTime() - newest.sentAt.getTime() < AGENT_LIMITS.debounceMs + 60_000) continue; // the live hook's job
      if (waiting.has(`${row.peer_id}:${row.tg_message_id}`)) continue;
      const [run] = await db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.managerUserId, config.ownerUserId),
            eq(agentRuns.peerId, BigInt(row.peer_id)),
            eq(agentRuns.anchorTgMessageId, BigInt(row.tg_message_id)),
          ),
        )
        .limit(1);
      if (run) continue;
      await enqueue(JOB_AGENT_INBOUND, {
        managerUserId: config.ownerUserId,
        peerId: row.peer_id,
        anchorTgMessageId: row.tg_message_id,
        origin: 'sweep',
      } satisfies AgentInboundJob, { retryLimit: 0, startAfter: 1 });
      waiting.add(`${row.peer_id}:${row.tg_message_id}`);
      gap += 1;
    }

    // 4. An errored ASK gets ONE more try (fit-15) — the first look, and his
    //    press asking again (queues `isFirstAsk`: a redraft that errored was
    //    never retried while it sat on the retry slot itself) — at the attempt
    //    after it, and only while nothing asked the line since; a second
    //    failure lets the ordinary ClientWaiting nudge fire.
    const errored = await db
      .select({ peerId: agentRuns.peerId, anchor: agentRuns.anchorTgMessageId, attempt: agentRuns.attempt })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.managerUserId, config.ownerUserId),
          eq(agentRuns.trigger, 'inbound'),
          eq(agentRuns.outcome, 'error'),
          sql`(${agentRuns.attempt} = 0 OR (${agentRuns.attempt} >= ${REDRAFT_ATTEMPT_BASE} AND ${agentRuns.attempt} < ${EDIT_ATTEMPT_BASE} AND ${agentRuns.attempt} % 2 = 0))`,
          lt(agentRuns.createdAt, new Date(now.getTime() - 2 * 60_000)),
          gt(agentRuns.createdAt, new Date(now.getTime() - ERRORED_RETRY_WINDOW_MS)),
          // `${agentRuns}.col`, never `${agentRuns.col}`: drizzle renders a
          // single-table select's columns unqualified, and inside the
          // subquery that would bind to r2 (#128).
          sql`NOT EXISTS (SELECT 1 FROM agent_runs r2 WHERE r2.manager_user_id = ${agentRuns}.manager_user_id
                AND r2.peer_id = ${agentRuns}.peer_id AND r2.anchor_tg_message_id = ${agentRuns}.anchor_tg_message_id
                AND r2.trigger = 'inbound' AND r2.attempt > ${agentRuns}.attempt)`,
          sql`NOT EXISTS (SELECT 1 FROM tg_messages m2 WHERE m2.manager_user_id = ${agentRuns}.manager_user_id
                AND m2.peer_id = ${agentRuns}.peer_id AND m2.direction = 'in'
                AND m2.tg_message_id > ${agentRuns}.anchor_tg_message_id)`,
        ),
      );
    for (const e of errored) {
      if (e.anchor === null || !isFirstAsk(e.attempt)) continue;
      if (waiting.has(`${e.peerId}:${e.anchor}`)) continue;
      await enqueue(JOB_AGENT_INBOUND, {
        managerUserId: config.ownerUserId,
        peerId: String(e.peerId),
        anchorTgMessageId: String(e.anchor),
        attempt: e.attempt + 1,
        origin: 'sweep',
      } satisfies AgentInboundJob, { retryLimit: 0, startAfter: INBOUND_START_AFTER_S });
      waiting.add(`${e.peerId}:${e.anchor}`);
      retried += 1;
    }
  }

  // 5. Strangers on the agent owner's account (§17.11, his 3a): ONE card per
  //    peer, no message text, never for a colleague's phone (fit-7).
  if (agentRunning(config)) await strangerCards(config.ownerUserId, now);

  // 6. Actions stuck after their commit (build-6).
  const stuck = await db
    .select({ id: agentDrafts.id, decidedBy: agentDrafts.decidedBy })
    .from(agentDrafts)
    .where(and(eq(agentDrafts.status, 'approved'), eq(agentDrafts.actionStatus, 'pending'), lt(agentDrafts.decidedAt, new Date(now.getTime() - 2 * 60_000))));
  const { runDraftActions } = await import('./decide');
  for (const s of stuck) {
    if (!s.decidedBy) continue;
    const grants = await actorGrants(s.decidedBy);
    await runDraftActions(s.id, { id: s.decidedBy, roles: grants.roles, permissions: grants.permissions }).catch((err: unknown) =>
      logger.warn({ err, draftId: s.id }, '[agent] stuck action still failing'),
    );
  }
  return { expired: expired.length, retired: retired.length, gap, retried, actions: stuck.length, reminded, interrupted: interrupted.length };
}

/**
 * The words of a stranger card — never the message's own text (§17.11). A
 * hidden number (his Q18 ⭐) says so in its first line, and says what binding
 * it to a client can and cannot do: no number can ever be on a card, so the
 * agent will not speak of cargo or money there (his Q19 ⭐, review I1).
 */
export function strangerCardText(title: string | null, phone: string | null): string {
  const who = title?.trim() || 'Nomsiz';
  const ask = 'Kim bu? Tanlang — AI faqat mijoz yoki lidga javob tayyorlaydi.';
  if (phone) return `🆕 Yangi odam yozdi: ${who}\n📞 ${phone}\n\n${ask}`;
  return `📵 Raqami yashirin yangi odam yozdi: ${who}\n\n${ask}\nRaqam yashirin: mijozga bog'lansa ham AI bu chatda yuk va qarzni aytmaydi.`;
}

/**
 * ONE card per peer (agent_conversations.stranger_card_at) for the agent
 * owner's pending tray rules of the last day: a visible number no card
 * carries (the tray's own ask) and a hidden-number first contact (a rule with
 * no `peer_phone`, his Q18 ⭐). Never for a peer in his own contacts — a friend
 * or a colleague is not a lead (fit-7, `peer_contact`) — nor for an active
 * colleague's phone.
 */
export async function strangerCards(ownerUserId: string, now: Date): Promise<number> {
  const rows = await db.execute<{ id: string; peer_id: string; peer_title: string | null; peer_phone: string | null }>(sql`
    SELECT r.id, r.peer_id::text AS peer_id, r.peer_title, r.peer_phone
      FROM tg_chat_rules r
     WHERE r.manager_user_id = ${ownerUserId}
       AND r.decision = 'pending'
       -- 777000, the service chat an old scan may have left pending, is no stranger to ask about.
       AND r.peer_id <> ${TELEGRAM_SERVICE_PEER.toString()}::bigint
       AND r.created_at > ${new Date(now.getTime() - 24 * 3_600_000).toISOString()}::timestamptz
       AND NOT EXISTS (SELECT 1 FROM agent_conversations c
                        WHERE c.manager_user_id = r.manager_user_id AND c.peer_id = r.peer_id
                          AND (c.stranger_card_at IS NOT NULL OR c.peer_contact IS TRUE))
       AND NOT EXISTS (SELECT 1 FROM users u
                        WHERE ${canLogInSql('u')} AND u.phone IS NOT NULL AND r.peer_phone IS NOT NULL
                          AND right(regexp_replace(u.phone, '\\D', '', 'g'), 9) = right(regexp_replace(r.peer_phone, '\\D', '', 'g'), 9))
     ORDER BY r.created_at
     LIMIT 10`);
  const { notifyStaffTelegram } = await import('../../platform/notifications/staff');
  let sent = 0;
  for (const r of rows) {
    // The claim first: one card per peer even when two sweeps overlap — and
    // never once the listener has read the peer as a contact meanwhile.
    const claimed = await db.execute<{ peer_id: string }>(sql`
      INSERT INTO agent_conversations (manager_user_id, peer_id, stranger_card_at)
      VALUES (${ownerUserId}, ${r.peer_id}::bigint, now())
      ON CONFLICT (manager_user_id, peer_id) DO UPDATE SET stranger_card_at = now(), updated_at = now()
        WHERE agent_conversations.stranger_card_at IS NULL AND agent_conversations.peer_contact IS NOT TRUE
      RETURNING peer_id::text`);
    if (claimed.length === 0) continue;
    await notifyStaffTelegram({
      userIds: [ownerUserId],
      type: 'AgentStranger',
      text: strangerCardText(r.peer_title, r.peer_phone),
      extra: { ruleId: r.id },
    });
    sent += 1;
  }
  return sent;
}
