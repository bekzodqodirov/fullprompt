import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  agentCalcLinks,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  kbFacts,
  notifications,
  tgPeerPulls,
} from '../../platform/db/schema';
import { agentTablesReady } from './config';

/**
 * Every agent row of one chat, removed (review leak-9) — called by
 * `purgeExcludedChat` before it deletes the messages themselves. Every table
 * carrying (manager_user_id, peer_id) is named here, and a derived fence
 * (`tests/unit/agent-purge.test.ts`) reads the schema to say so. The cards'
 * quoted customer text is blanked; `tg_message_flags` follows its message by
 * its own ON DELETE CASCADE.
 */
export const PURGED_TABLES = [
  'agent_conversations',
  'agent_runs',
  'agent_drafts',
  'agent_outbox',
  'agent_calc_links',
  'tg_peer_pulls',
] as const;

export async function purgeAgentChat(managerUserId: string, peerId: bigint): Promise<{ drafts: number }> {
  if (!(await agentTablesReady())) return { drafts: 0 };
  return db.transaction(async (tx) => {
    const drafts = await tx
      .select({ id: agentDrafts.id })
      .from(agentDrafts)
      .where(and(eq(agentDrafts.managerUserId, managerUserId), eq(agentDrafts.peerId, peerId)));
    const ids = drafts.map((d) => d.id);
    if (ids.length > 0) {
      // Facts learned in this chat (scope client/lead, born from its drafts).
      await tx.delete(kbFacts).where(sql`${kbFacts.scope} <> 'general' AND ${kbFacts.sourceRef}->>'draftId' IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
      await tx
        .update(notifications)
        .set({ payload: sql`${notifications.payload} || '{"text":"🗑 Suhbat shaxsiy deb o‘chirildi.","live":false}'::jsonb` })
        .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`));
    }
    await tx.delete(agentOutbox).where(and(eq(agentOutbox.managerUserId, managerUserId), eq(agentOutbox.peerId, peerId)));
    await tx.delete(agentCalcLinks).where(and(eq(agentCalcLinks.managerUserId, managerUserId), eq(agentCalcLinks.peerId, peerId)));
    if (ids.length > 0) await tx.delete(agentDrafts).where(inArray(agentDrafts.id, ids));
    await tx.delete(agentRuns).where(and(eq(agentRuns.managerUserId, managerUserId), eq(agentRuns.peerId, peerId)));
    await tx.delete(agentConversations).where(and(eq(agentConversations.managerUserId, managerUserId), eq(agentConversations.peerId, peerId)));
    await tx.delete(tgPeerPulls).where(and(eq(tgPeerPulls.managerUserId, managerUserId), eq(tgPeerPulls.peerId, peerId)));
    return { drafts: ids.length };
  });
}
