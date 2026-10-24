import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  agentCalcLinks,
  agentConversations,
  attachments,
  calcRequests,
  clients,
  leads,
  tgChatRules,
  tgMessageFlags,
  tgMessages,
  users,
} from '../../platform/db/schema';
import { phoneSiblingClients } from '../client-cabinet/service';
import { parseManualFacts } from '../calc/intake-manual';
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
  /** A typed-code bind whose chat phone is not on the card: no cargo, no balance (his Q19 ⭐). */
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

function mediaOf(contentType: string | null, fileName: string | null): ChatMessage['media'] {
  if (!contentType) return null;
  if (contentType.startsWith('image/')) return 'photo';
  if (contentType.startsWith('audio/')) return /voice/iu.test(fileName ?? '') || contentType.includes('ogg') ? 'voice' : 'audio';
  return 'document';
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

/** The chat's identity, decided by the server. */
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
    .select({ strength: agentConversations.identityStrength })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, managerUserId), eq(agentConversations.peerId, peerId)));

  const clientId = newest?.clientId ?? null;
  const leadId = clientId ? null : (newest?.leadId ?? null);
  let strength: IdentityStrength | null = null;
  if (conv?.strength === 'typed_code' && rule?.clientId === clientId) strength = 'typed_code';
  else if (clientId && rule?.decision === 'include' && rule.clientId === clientId) strength = 'rule';
  else if (clientId) strength = 'phone';
  else if (leadId) strength = 'lead';

  let codes: { id: string; clientCode: string }[] = [];
  let customerName: string | null = null;
  let managerId: string | null = null;
  let cargoAllowed = false;
  if (clientId) {
    codes = await phoneSiblingClients(clientId);
    const [c] = await db
      .select({ name: clients.name, phones: clients.phones, managerId: clients.salesManagerId })
      .from(clients)
      .where(eq(clients.id, clientId));
    customerName = c?.name ?? null;
    managerId = c?.managerId ?? null;
    if (strength === 'typed_code') {
      // The bind came from a code HE typed: the chat's phone must be on the
      // card before the agent speaks about cargo or money in it (leak-4).
      const phones = Array.isArray(c?.phones) ? (c!.phones as string[]) : [];
      const chat = (rule?.peerPhone ?? '').replace(/\D/gu, '').slice(-9);
      cargoAllowed = chat.length === 9 && phones.some((p) => p.replace(/\D/gu, '').slice(-9) === chat);
    } else {
      cargoAllowed = true;
    }
  } else if (leadId) {
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

