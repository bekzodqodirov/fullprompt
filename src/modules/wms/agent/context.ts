import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  agentCalcLinks,
  agentConversations,
  attachments,
  calcRequests,
  clients,
  clientTelegramLinks,
  leads,
  tgChatRules,
  tgMessageFlags,
  tgMessages,
  tgPeerIndex,
  users,
} from '../../platform/db/schema';
import { phoneSiblingClients } from '../client-cabinet/service';
import { parseManualFacts } from '../calc/intake-manual';
import { phoneFingerprint } from '../crm/peer-index';
import { normalizeDigits } from './digits';
import { AGENT_LIMITS } from './limits';
import { dominantScript, type AgentLocale, type ScriptName } from './locale';

/**
 * What one run may know (spec §17.5, review leak-1): THIS chat and nothing
 * else. The first design searched his out messages to OTHER customers for
 * «similar situations» — their names, factories, discounts — and a colleague
 * whose number sits in the client book is a «customer» to the classifier. So
 * there is no cross-chat read here at all; style comes from the guide he
 * approved, masked.
 *
 * Everything is keyed by (account, Telegram person). The identity comes from
 * the SERVER — the chat's own stored classification — never from the model or
 * from anything the customer typed.
 */

export type IdentityStrength = 'phone' | 'cabinet' | 'rule' | 'typed_code' | 'lead';

export interface ChatIdentity {
  clientId: string | null;
  leadId: string | null;
  strength: IdentityStrength | null;
  /** The chat's client and its phone siblings (fit-12), the chat's own first. */
  codes: { id: string; clientCode: string }[];
  customerName: string | null;
  /** The customer's own manager — the one name a reply may carry (G6). */
  managerName: string | null;
  /**
   * May the agent speak about cargo and money here? Only when the CHAT itself
   * proves the client — its phone on the card, or the customer's own cabinet
   * link (his Q19 ⭐, review I1). A bind a person made by hand is not proof.
   */
  cargoAllowed: boolean;
}

export interface ChatMessage {
  /** «#n» — the index the model cites; resolved back by the server, never trusted. */
  ref: string;
  id: string;
  tgMessageId: bigint;
  direction: 'in' | 'out';
  body: string;
  media: 'photo' | 'voice' | 'audio' | 'document' | 'other' | null;
  fileName: string | null;
  sentAt: Date;
  autoSent: boolean;
  editedAt: Date | null;
}

export interface MeasureCandidate {
  /** «w1», «v1» — what the yo'lkira tool takes instead of a figure (money-2). */
  ref: string;
  kind: 'weight' | 'volume';
  value: number;
  messageRef: string;
}

export interface AgentContext {
  managerUserId: string;
  peerId: bigint;
  messages: ChatMessage[];
  anchor: ChatMessage | null;
  /** Inbound since our last out message, oldest first. */
  burst: ChatMessage[];
  lastOut: ChatMessage | null;
  identity: ChatIdentity;
  storedLocale: AgentLocale | null;
  customerScript: ScriptName | null;
  measures: MeasureCandidate[];
  openCalcs: { requestId: string; section: string | null; createdAt: Date; status: string }[];
  /** The chat's include rule names a lead or a client the screen decided. */
  ruleDecision: string | null;
}

export function mediaOf(contentType: string | null, fileName: string | null): ChatMessage['media'] {
  if (!contentType) return null;
  if (contentType.startsWith('image/')) return 'photo';
  if (contentType.startsWith('audio/')) return /voice/iu.test(fileName ?? '') || contentType.includes('ogg') ? 'voice' : 'audio';
  return 'document';
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

const last9 = (raw: unknown): string | null => {
  const d = (typeof raw === 'string' ? raw : '').replace(/\D/gu, '');
  return d.length >= 9 ? d.slice(-9) : null;
};

export type ChatProof = 'phone' | 'cabinet';

/**
 * What the CHAT ITSELF carries that says it is one of these clients' person
 * (his Q19 ⭐: «no cargo or balance until the chat's phone is on the card»;
 * review I1). Three things count, and nothing a person typed or picked:
 *
 *  - the chat's phone (the tray's `peer_phone`) on one of the cards — the
 *    client's or a phone sibling's (fit-12, the cabinet's «same person»);
 *  - the listener's hashed peer index naming that number — the only phone a
 *    lookback-attached chat carries (0064 stores no number, by design);
 *  - a LINKED cabinet: the customer shared their own Telegram-verified number
 *    with the company bot, and a private chat's id is the person's id.
 *
 * A hidden number has none of the first two, so a hand-made bind on one stays
 * closed by construction until the customer links the cabinet.
 */
export async function chatProof(
  managerUserId: string,
  peerId: bigint,
  clientIds: readonly string[],
  peerPhone: string | null,
): Promise<ChatProof | null> {
  if (clientIds.length === 0) return null;
  const cards = await db.select({ phones: clients.phones }).from(clients).where(inArray(clients.id, [...clientIds]));
  const tails = new Set<string>();
  const prints = new Set<string>();
  for (const card of cards) {
    for (const raw of Array.isArray(card.phones) ? (card.phones as unknown[]) : []) {
      const tail = last9(raw);
      if (!tail) continue;
      tails.add(tail);
      const print = phoneFingerprint(tail);
      if (print) prints.add(print);
    }
  }
  const chat = last9(peerPhone);
  if (chat && tails.has(chat)) return 'phone';
  if (prints.size > 0) {
    const [indexed] = await db
      .select({ hash: tgPeerIndex.phoneHash })
      .from(tgPeerIndex)
      .where(and(eq(tgPeerIndex.managerUserId, managerUserId), eq(tgPeerIndex.peerId, peerId)));
    if (indexed && prints.has(indexed.hash)) return 'phone';
  }
  const [link] = await db
    .select({ id: clientTelegramLinks.id })
    .from(clientTelegramLinks)
    .where(
      and(
        eq(clientTelegramLinks.telegramChatId, peerId),
        eq(clientTelegramLinks.status, 'linked'),
        inArray(clientTelegramLinks.clientId, [...clientIds]),
      ),
    )
    .limit(1);
  return link ? 'cabinet' : null;
}

/**
 * The chat's identity, decided by the server.
 *
 * A chat with NO rule row was given its client by the listener's own phone
 * classifier — that is proof. EVERY rule-derived bind is checked against the
 * chat (review I1), whoever made it: the echo flow's typed code, the web
 * tray's «Bu mijoz» (a stranger card exists only because the number was NOT
 * on any card, leak-4), a lookback attach, and messages a rule stored before
 * it was taken back (↩, a second code, the web tray's «pending» or
 * «Shaxsiy») — their `client_id` / `lead_id` outlive the decision.
 *
 * Such leftovers are HISTORY, not identity: when the rule no longer includes
 * the chat, a stored client stands only if the chat itself proves it, and a
 * stored lead not at all. «It serves no cargo» was not enough — the client's
 * id still scoped the knowledge search, named the customer in the prompt,
 * and carried a calculation approved later onto that client's deal (review
 * I1/I7).
 */
export async function chatIdentity(managerUserId: string, peerId: bigint): Promise<ChatIdentity & { ruleDecision: string | null }> {
  const [newest] = await db
    .select({ clientId: tgMessages.clientId, leadId: tgMessages.leadId })
    .from(tgMessages)
    .where(and(eq(tgMessages.managerUserId, managerUserId), eq(tgMessages.peerId, peerId)))
    .orderBy(desc(tgMessages.sentAt))
    .limit(1);
  const [rule] = await db
    .select({ decision: tgChatRules.decision, clientId: tgChatRules.clientId, leadId: tgChatRules.leadId, peerPhone: tgChatRules.peerPhone })
    .from(tgChatRules)
    .where(and(eq(tgChatRules.managerUserId, managerUserId), eq(tgChatRules.peerId, peerId)))
    .limit(1);
  const [conv] = await db
    .select({ strength: agentConversations.identityStrength, clientId: agentConversations.identityClientId })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, managerUserId), eq(agentConversations.peerId, peerId)));

  let clientId = newest?.clientId ?? null;
  let leadId = clientId ? null : (newest?.leadId ?? null);
  let strength: IdentityStrength | null = null;
  let codes: { id: string; clientCode: string }[] = clientId ? await phoneSiblingClients(clientId) : [];
  let customerName: string | null = null;
  let managerId: string | null = null;
  let cargoAllowed = false;
  // Only the chat's own proof is asked of a rule-derived client, once.
  const proof = clientId && rule ? await chatProof(managerUserId, peerId, codes.map((x) => x.id), rule.peerPhone) : null;
  if (rule && rule.decision !== 'include' && proof === null) {
    // Taken back: the stored messages name nobody this chat now is.
    clientId = null;
    leadId = null;
    codes = [];
  }
  if (clientId) {
    const [c] = await db
      .select({ name: clients.name, managerId: clients.salesManagerId })
      .from(clients)
      .where(eq(clients.id, clientId));
    customerName = c?.name ?? null;
    managerId = c?.managerId ?? null;
    if (!rule) {
      strength = 'phone';
      cargoAllowed = true;
    } else {
      const named = rule.decision === 'include' && rule.clientId === clientId;
      const typed = named && conv?.strength === 'typed_code' && conv.clientId === clientId;
      cargoAllowed = proof !== null;
      strength = typed ? 'typed_code' : named ? 'rule' : (proof ?? 'rule');
    }
  } else if (leadId) {
    strength = 'lead';
    const [l] = await db.select({ name: leads.name, ownerId: leads.ownerId }).from(leads).where(eq(leads.id, leadId));
    customerName = l?.name ?? null;
    managerId = l?.ownerId ?? null;
  }
  let managerName: string | null = null;
  if (managerId) {
    const [u] = await db.select({ name: users.fullName }).from(users).where(eq(users.id, managerId));
    managerName = u?.name ?? null;
  }
  return { clientId, leadId, strength, codes, customerName, managerName, cargoAllowed, ruleDecision: rule?.decision ?? null };
}

/** The chat's live messages, newest `limit`, oldest first — deleted ones never (leak-8). */
export async function chatMessages(managerUserId: string, peerId: bigint, limit: number = AGENT_LIMITS.contextMessages): Promise<ChatMessage[]> {
  const rows = await db
    .select({
      id: tgMessages.id,
      tgMessageId: tgMessages.tgMessageId,
      direction: tgMessages.direction,
      body: tgMessages.body,
      hasMedia: tgMessages.hasMedia,
      sentAt: tgMessages.sentAt,
      editedAt: tgMessages.editedAt,
      autoSent: tgMessageFlags.autoSent,
    })
    .from(tgMessages)
    .leftJoin(tgMessageFlags, eq(tgMessageFlags.messageId, tgMessages.id))
    .where(
      and(
        eq(tgMessages.managerUserId, managerUserId),
        eq(tgMessages.peerId, peerId),
        isNull(tgMessageFlags.deletedAt),
      ),
    )
    .orderBy(desc(tgMessages.sentAt), desc(tgMessages.tgMessageId))
    .limit(limit);
  rows.reverse();
  const ids = rows.filter((r) => r.hasMedia).map((r) => r.id);
  const files = ids.length
    ? await db
        .select({ entityId: attachments.entityId, contentType: attachments.contentType, fileName: attachments.fileName })
        .from(attachments)
        .where(and(eq(attachments.entityType, 'tg_message'), inArray(attachments.entityId, ids)))
        .orderBy(asc(attachments.createdAt))
    : [];
  const fileOf = new Map(files.map((f) => [f.entityId, f]));

  let total = 0;
  const out: ChatMessage[] = [];
  // Newest kept when the history is longer than the budget (money-11).
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    const body = clip(normalizeDigits(r.body ?? ''), AGENT_LIMITS.contextMessageChars);
    if (total + body.length > AGENT_LIMITS.contextTotalChars && out.length > 0) break;
    total += body.length;
    const f = fileOf.get(r.id);
    out.unshift({
      ref: '',
      id: r.id,
      tgMessageId: r.tgMessageId,
      direction: r.direction === 'out' ? 'out' : 'in',
      body,
      media: r.hasMedia ? (mediaOf(f?.contentType ?? null, f?.fileName ?? null) ?? 'other') : null,
      fileName: f?.fileName ?? null,
      sentAt: r.sentAt,
      autoSent: r.autoSent === true,
      editedAt: r.editedAt,
    });
  }
  out.forEach((m, i) => (m.ref = `#${i + 1}`));
  return out;
}

/** The figures a customer stated, each as a REFERENCE the yo'lkira tool can take (money-2). */
export function measureCandidates(messages: readonly ChatMessage[]): MeasureCandidate[] {
  const out: MeasureCandidate[] = [];
  let w = 0;
  let v = 0;
  for (const m of messages) {
    if (m.direction !== 'in' || !m.body) continue;
    const facts = parseManualFacts(m.body);
    if (Number(facts.weightKg) > 0) out.push({ ref: `w${++w}`, kind: 'weight', value: Number(facts.weightKg), messageRef: m.ref });
    if (Number(facts.volumeM3) > 0) out.push({ ref: `v${++v}`, kind: 'volume', value: Number(facts.volumeM3), messageRef: m.ref });
  }
  return out;
}

/** The dominant script of the customer's last five inbound messages with ≥ 3 letters (fit-6). */
export function customerScriptOf(messages: readonly ChatMessage[]): ScriptName | null {
  const texts = messages
    .filter((m) => m.direction === 'in' && [...m.body.matchAll(/\p{L}/gu)].length >= 3)
    .slice(-5)
    .map((m) => m.body);
  if (texts.length === 0) return null;
  const s = dominantScript(texts.join('\n'));
  return s === 'none' ? null : s;
}

/** The whole context for a run. */
export async function loadContext(managerUserId: string, peerId: bigint, anchorTgMessageId: bigint | null): Promise<AgentContext> {
  const [identity, messages] = await Promise.all([chatIdentity(managerUserId, peerId), chatMessages(managerUserId, peerId)]);
  const lastOutIndex = messages.map((m) => m.direction).lastIndexOf('out');
  const lastOut = lastOutIndex >= 0 ? messages[lastOutIndex]! : null;
  const burst = messages.slice(lastOutIndex + 1).filter((m) => m.direction === 'in');
  const anchor =
    anchorTgMessageId === null
      ? ([...messages].reverse().find((m) => m.direction === 'in') ?? null)
      : (messages.find((m) => m.tgMessageId === anchorTgMessageId) ?? null);
  const [conv] = await db
    .select({ locale: agentConversations.locale })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, managerUserId), eq(agentConversations.peerId, peerId)));
  const calcs = await db
    .select({
      requestId: agentCalcLinks.requestId,
      section: calcRequests.section,
      completedAt: calcRequests.completedAt,
      returnReason: calcRequests.returnReason,
      createdAt: agentCalcLinks.createdAt,
    })
    .from(agentCalcLinks)
    .innerJoin(calcRequests, eq(calcRequests.id, agentCalcLinks.requestId))
    .where(and(eq(agentCalcLinks.managerUserId, managerUserId), eq(agentCalcLinks.peerId, peerId)))
    .orderBy(desc(agentCalcLinks.createdAt))
    .limit(5);
  return {
    managerUserId,
    peerId,
    messages,
    anchor,
    burst,
    lastOut,
    identity,
    storedLocale: (conv?.locale as AgentLocale | null) ?? null,
    customerScript: customerScriptOf(messages),
    measures: measureCandidates(messages),
    openCalcs: calcs.map((c) => ({
      requestId: c.requestId,
      section: c.section ?? null,
      createdAt: c.createdAt,
      // Words, never the answer's amount (leak-10): the model learns that a
      // price exists, not what it is.
      status: c.completedAt ? (c.returnReason ? 'returned' : 'answered') : 'open',
    })),
    ruleDecision: identity.ruleDecision,
  };
}

