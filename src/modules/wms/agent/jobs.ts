import type PgBoss from 'pg-boss';
import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { aiConfigured } from '../../platform/ai/model';
import { db } from '../../platform/db/client';
import { agentDrafts, agentOutbox, agentRuns, tgMessages } from '../../platform/db/schema';
import { enqueue } from '../../platform/jobs/boss';
import { logger } from '../../platform/logger';
import { actorGrants } from '../../platform/rbac/authorize';
import { canLogInSql } from '../../platform/users/login';
import { agentRunning, agentTablesReady, readAgentConfig } from './config';
import { AGENT_LIMITS } from './limits';
import {
  INBOUND_START_AFTER_S,
  JOB_AGENT_HAND_BACK,
  JOB_AGENT_HUMAN_REPLY,
  JOB_AGENT_INBOUND,
  JOB_AGENT_SWEEP,
  type AgentHandBackJob,
  type AgentHumanReplyJob,
  type AgentInboundJob,
} from './queues';

/**
 * The agent's workers (spec §17.3): the inbound run, his own reply retiring
 * the live draft, and a one-minute sweep for what no event carries — the
 * 24-hour expiry, the deploy gap, an errored run's one retry, an action stuck
 * after its commit. Every job asks `agentTablesReady()` first.
 */

export async function registerAgentWorkers(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_AGENT_INBOUND);
  await boss.work<AgentInboundJob>(JOB_AGENT_INBOUND, async (jobs) => {
    const { handleInbound } = await import('./run');
    for (const job of jobs) {
      try {
        const out = await handleInbound(job.data);
        logger.info({ peer: job.data.peerId, ...out }, '[agent] inbound');
      } catch (err) {
        // retryLimit 0: a re-delivered model call is a second bill for one
        // message. The sweep retries an errored run once, deliberately.
        logger.error({ err }, '[agent] inbound job failed');
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

export async function agentSweep(now: Date = new Date()): Promise<{ expired: number; retired: number; gap: number; retried: number; actions: number }> {
  if (!(await agentTablesReady())) return { expired: 0, retired: 0, gap: 0, retried: 0, actions: 0 };

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

  const config = await readAgentConfig();
  let gap = 0;
  let retried = 0;
  if (agentRunning(config) && aiConfigured()) {
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
      gap += 1;
    }

    // 4. An errored run gets ONE more try (fit-15); a second failure lets the ordinary ClientWaiting nudge fire.
    const errored = await db
      .select({ peerId: agentRuns.peerId, anchor: agentRuns.anchorTgMessageId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.managerUserId, config.ownerUserId),
          eq(agentRuns.trigger, 'inbound'),
          eq(agentRuns.outcome, 'error'),
          eq(agentRuns.attempt, 0),
          lt(agentRuns.createdAt, new Date(now.getTime() - 2 * 60_000)),
          gt(agentRuns.createdAt, new Date(now.getTime() - 60 * 60_000)),
          // `${agentRuns}.col`, never `${agentRuns.col}`: drizzle renders a
          // single-table select's columns unqualified, and inside the
          // subquery that would bind to r2 (#128).
          sql`NOT EXISTS (SELECT 1 FROM agent_runs r2 WHERE r2.manager_user_id = ${agentRuns}.manager_user_id
                AND r2.peer_id = ${agentRuns}.peer_id AND r2.anchor_tg_message_id = ${agentRuns}.anchor_tg_message_id
                AND r2.attempt = 1)`,
          sql`NOT EXISTS (SELECT 1 FROM tg_messages m2 WHERE m2.manager_user_id = ${agentRuns}.manager_user_id
                AND m2.peer_id = ${agentRuns}.peer_id AND m2.direction = 'in'
                AND m2.tg_message_id > ${agentRuns}.anchor_tg_message_id)`,
        ),
      );
    for (const e of errored) {
      if (e.anchor === null) continue;
      await enqueue(JOB_AGENT_INBOUND, {
        managerUserId: config.ownerUserId,
        peerId: String(e.peerId),
        anchorTgMessageId: String(e.anchor),
        attempt: 1,
        origin: 'sweep',
      } satisfies AgentInboundJob, { retryLimit: 0, startAfter: INBOUND_START_AFTER_S });
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
  return { expired: expired.length, retired: retired.length, gap, retried, actions: stuck.length };
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
