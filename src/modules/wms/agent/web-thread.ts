import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import { agentOutbox } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { agentTablesReady } from './config';

/**
 * The AI sotuvchi on the conversation screens (spec §17.12): a 🤖 on every
 * bubble the agent sent, and an approved reply still waiting to leave drawn
 * in the thread as «🤖 08:30 da ketadi» — cancellable by its account holder.
 *
 * The customer never sees the 🤖: it is derived here, from `agent_outbox`,
 * at render — nothing is written onto the message. ONE query per surface,
 * over the rows that surface already drew; never one per bubble.
 */

/** The bubble keys the marker reads: whose account, and Telegram's own id. */
export interface MarkableMessage {
  id: string;
  direction: string;
  managerUserId: string;
  tgMessageId: bigint | string | null | undefined;
}

/** «<manager>:<tg message id>» — the pair `agent_outbox_message_idx` covers. */
const keyOf = (managerUserId: string, tgMessageId: bigint | string) => `${managerUserId}:${String(tgMessageId)}`;

/**
 * The ids of the messages (of those given) the AI sotuvchi sent. Out rows
 * only — an inbound row is never ours — and one statement for the page.
 */
export async function agentSentIds(messages: readonly MarkableMessage[]): Promise<Set<string>> {
  const out = messages.filter((m) => m.direction === 'out' && m.tgMessageId !== null && m.tgMessageId !== undefined);
  if (out.length === 0 || !(await agentTablesReady())) return new Set();
  const managers = [...new Set(out.map((m) => m.managerUserId))];
  const ids = [...new Set(out.map((m) => String(m.tgMessageId)))];
  try {
    const rows = await db
      .select({ managerUserId: agentOutbox.managerUserId, tgMessageId: agentOutbox.tgMessageId })
      .from(agentOutbox)
      .where(
        and(
          inArray(agentOutbox.managerUserId, managers),
          inArray(
            agentOutbox.tgMessageId,
            ids.map((id) => BigInt(id)),
          ),
        ),
      );
    const sent = new Set(rows.filter((r) => r.tgMessageId !== null).map((r) => keyOf(r.managerUserId, r.tgMessageId!)));
    return new Set(out.filter((m) => sent.has(keyOf(m.managerUserId, m.tgMessageId!))).map((m) => m.id));
  } catch (err) {
    // A marker is a nicety on a thread that must render regardless.
    logger.warn({ err }, '[agent] bubble markers not read');
    return new Set();
  }
}

/** An approved AI reply that has not left yet. */
export interface WaitingAgentReply {
  id: string;
  draftId: string;
  managerUserId: string;
  body: string;
  status: 'agent' | 'sending';
  /** When its next step is due — the night rule's 08:30, or a gap. */
  nextStepAt: Date;
  /** The read step is done: past it, a cancel would leave his phone's unread badge cleared (regression-12). */
  readDone: boolean;
  step: string;
}

/**
 * The waiting AI replies of one conversation — keyed by the client (and its
 * thread's sibling, the caller resolves that) or by the lead, scoped like the
 * thread itself: the viewer's own account, or every account for the
 * supervision view.
 */
export async function waitingAgentReplies(
  key: { clientId?: string | null; leadId?: string | null },
  viewer: { id: string; all?: boolean },
): Promise<WaitingAgentReply[]> {
  if (!key.clientId && !key.leadId) return [];
  if (!(await agentTablesReady())) return [];
  try {
    const owner = or(
      key.clientId ? eq(agentOutbox.clientId, key.clientId) : sql`false`,
      key.leadId ? eq(agentOutbox.leadId, key.leadId) : sql`false`,
    );
    const rows = await db
      .select({
        id: agentOutbox.id,
        draftId: agentOutbox.draftId,
        managerUserId: agentOutbox.managerUserId,
        body: agentOutbox.body,
        status: agentOutbox.status,
        nextStepAt: agentOutbox.nextStepAt,
        readDone: agentOutbox.readDone,
        step: agentOutbox.step,
      })
      .from(agentOutbox)
      .where(
        and(
          owner,
          inArray(agentOutbox.status, ['agent', 'sending']),
          viewer.all ? undefined : eq(agentOutbox.managerUserId, viewer.id),
        ),
      )
      .orderBy(asc(agentOutbox.nextStepAt))
      .limit(10);
    return rows.map((r) => ({ ...r, status: r.status === 'sending' ? 'sending' : 'agent' }));
  } catch (err) {
    logger.warn({ err }, '[agent] waiting replies not read');
    return [];
  }
}

/** A waiting reply its holder may still take back: not sending, and the dialog not yet marked read. */
export function cancellable(row: { status: string; readDone: boolean }): boolean {
  return row.status === 'agent' && !row.readDone;
}

export type CancelRefusal = 'not_found' | 'not_account_holder' | 'too_late' | 'not_ready';

export class AgentCancelError extends Error {
  constructor(public readonly code: CancelRefusal) {
    super(code);
  }
}

/** What the card prints after a cancel (card-io prints an unknown reason verbatim). */
export const CANCELLED_BY_HOLDER = 'o‘zingiz bekor qildingiz';

/**
 * «Bekor qilish» on a waiting AI reply — its ACCOUNT HOLDER only (a message
 * leaves a personal account only by its holder; taking one back is the same
 * decision, leak-5). A compare-and-set: the row must still be 'agent' AND not
 * past the read step, so a reply the listener has started typing is never
 * half-stopped from the web, and a press that loses the race says so. The
 * card is re-rendered after the commit.
 */
export async function cancelAgentReply(
  actor: { id: string },
  outboxId: string,
  ctx: AuditContext,
): Promise<{ draftId: string; clientId: string | null; leadId: string | null }> {
  if (!(await agentTablesReady())) throw new AgentCancelError('not_ready');
  const [row] = await db.select().from(agentOutbox).where(eq(agentOutbox.id, outboxId));
  if (!row) throw new AgentCancelError('not_found');
  if (row.managerUserId !== actor.id) throw new AgentCancelError('not_account_holder');
  const done = await db.transaction(async (tx) => {
    const [hit] = await tx
      .update(agentOutbox)
      .set({ status: 'cancelled', lastError: CANCELLED_BY_HOLDER })
      .where(and(eq(agentOutbox.id, outboxId), eq(agentOutbox.status, 'agent'), eq(agentOutbox.readDone, false)))
      .returning({ id: agentOutbox.id });
    if (!hit) return false;
    await writeAudit(tx, ctx, {
      entityType: 'agent_outbox',
      entityId: outboxId,
      action: 'status_change',
      before: { status: 'agent' },
      after: { status: 'cancelled', draftId: row.draftId },
    });
    return true;
  });
  if (!done) throw new AgentCancelError('too_late');
  try {
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(row.draftId);
  } catch (err) {
    logger.warn({ err, outboxId }, '[agent] card not refreshed after cancel');
  }
  return { draftId: row.draftId, clientId: row.clientId, leadId: row.leadId };
}
