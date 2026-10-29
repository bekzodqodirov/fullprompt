import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { leadSources, leads } from '../../platform/db/schema';
import { isAgentSource } from '../crm/agent-source';
import type { SendWindow } from './send-step';

/**
 * Which quiet hours an AI reply in this chat obeys — the one home of «is this
 * the client-finding agent's prospect», asked by the ✅ (`decideDraft`) and by
 * every send step (`sendFactsFor`), so the press and the send cannot disagree.
 *
 * A chat bound to a LEAD (no client) whose source is `agent` is the agent's
 * prospect: somebody it found on the open internet and pushed to a seller
 * (docs/AGENT-FEED.md §2). Its playbook allows a message only Monday-Saturday
 * 10:00-17:00 Tashkent (`AGENT_LIMITS.agentLeadWindow`). A chat bound to a
 * client — the lead won, or never a lead — and a lead from any other door keep
 * the night rule, exactly as before (the merge review: keep main's behaviour
 * for every non-agent chat).
 *
 * The lead's OWN source and nothing else: an agent push that JOINED a lead an
 * advert or the person's own message had opened is a conversation the person
 * started, and the lead's source still names that door.
 */
export async function sendWindowFor(chat: { clientId: string | null; leadId: string | null }): Promise<SendWindow> {
  if (chat.clientId || !chat.leadId) return 'default';
  const [row] = await db
    .select({ key: leadSources.key })
    .from(leads)
    .innerJoin(leadSources, eq(leadSources.id, leads.sourceId))
    .where(eq(leads.id, chat.leadId));
  return isAgentSource(row?.key) ? 'agent_lead' : 'default';
}
