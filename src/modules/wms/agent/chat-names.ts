import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, leads, tgChatRules } from '../../platform/db/schema';
import { phoneSiblingClients } from '../client-cabinet/service';

/**
 * Every name a chat is known by — the client and its phone siblings, the lead, the peer's own Telegram title
 * (review I3). A lead chat has no client, and the old lookup by `clientId` alone gave a lead's general fact no names
 * to refuse at all. ONE home (moved out of bot-door): the bot's «📌/👤» writer refuses a GENERAL fact naming them,
 * and his ✍️ answer's redraft (spec SPEC-P1-v2 §2.2, owner-answer `ownerPersonalOf`) knows them for this chat's own.
 */
export async function knownNamesFor(d: { managerUserId: string; peerId: bigint; clientId: string | null; leadId: string | null }): Promise<string[]> {
  const names: string[] = [];
  if (d.clientId) {
    const ids = (await phoneSiblingClients(d.clientId)).map((c) => c.id);
    if (ids.length > 0) {
      for (const c of await db.select({ name: clients.name }).from(clients).where(inArray(clients.id, ids))) names.push(c.name);
    }
  }
  if (d.leadId) {
    const [l] = await db.select({ name: leads.name }).from(leads).where(eq(leads.id, d.leadId));
    // A «📵» lead with no title is named by a placeholder, not by a person.
    const { PHONELESS_LEAD_NAME } = await import('../crm/chat-rules');
    if (l && l.name !== PHONELESS_LEAD_NAME) names.push(l.name);
  }
  const [rule] = await db
    .select({ title: tgChatRules.peerTitle })
    .from(tgChatRules)
    .where(and(eq(tgChatRules.managerUserId, d.managerUserId), eq(tgChatRules.peerId, d.peerId)));
  if (rule?.title) names.push(rule.title);
  return names;
}
