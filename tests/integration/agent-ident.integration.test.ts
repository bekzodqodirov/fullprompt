import 'dotenv/config';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The re-queued calculation hands the AI VED pass to pg-boss; nothing here
// asks the queue itself, so it is stood in for and records what was sent.
const queued = vi.hoisted(() => [] as { name: string; data: unknown }[]);
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: async (name: string, data: unknown) => {
    queued.push({ name, data });
  },
}));

import type { CallModel, ModelRequest, ModelResponse } from '@/modules/platform/ai/model';
import { db } from '@/modules/platform/db/client';
import {
  agentCalcLinks,
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  auditLog,
  calcGroups,
  calcOffers,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  dealLines,
  deals,
  events,
  kbFacts,
  leadStages,
  leads,
  notifications,
  roles,
  tasks,
  tgAccountGuard,
  tgAccounts,
  tgChatRules,
  tgMessageFlags,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { agentPress } from '@/modules/wms/agent/bot-door';
import { renderDraftCard } from '@/modules/wms/agent/card-io';
import { __restoreAgentConfig, readAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { chatIdentity } from '@/modules/wms/agent/context';
import { decideDraft, noteIdFor } from '@/modules/wms/agent/decide';
import { agentSweep, OWNER_QUESTION_WAIT_MS, remindOwnerQuestions } from '@/modules/wms/agent/jobs';
import { kbSearch, writeKbFact } from '@/modules/wms/agent/kb';
import { purgeAgentChat } from '@/modules/wms/agent/purge';
import { handleInbound } from '@/modules/wms/agent/run';
import { humanOutBodies } from '@/modules/wms/agent/style';
import { assertFactSeen, editKbFact } from '@/modules/wms/agent/web-kb';
import { webDrafts, webKbFacts } from '@/modules/wms/agent/web-page';
import { MAX_OPEN_PER_REQUESTER } from '@/modules/wms/calc/service';
import { JOB_CALC_PREFILL } from '@/modules/wms/calc/jobs';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';
import { decideChat } from '@/modules/wms/crm/chat-rules';

/**
 * The final review's identity and knowledge package, on a real database —
 * whose chat an approved reply still belongs to (K2, K7), what a chat must
 * prove before cargo and money (K9), what a won lead keeps (K25), what a fact
 * carries into the knowledge and through an edit (K6, K8), who reads the
 * page (K10), what the style corpus may read (K11), a run its process died
 * inside (K24), a calculation the queue refused once (K26) and his
 * unanswered question's reminder (K30).
 *
 * The model is SCRIPTED (CI has no key). agent_config and the CRM send switch
 * are CONFIGURATION on the one shared database (#183): snapshotted in
 * beforeAll, restored in afterAll. Fixture people are deactivated, never
 * deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
/** One chat per scenario, so no scenario's rows are another's input (#154). */
const peer = (n: number) => BigInt(`74${SUFFIX}${String(n).padStart(2, '0')}`);
const PEERS = Array.from({ length: 12 }, (_, i) => peer(i + 1));
let ownerId = '';
let sellerId = '';
let vedId = '';
let accountId = '';
let clientId = '';
let otherClientId = '';
let leadStageId = '';
let snapshot: AgentConfig | null = null;
let sendingBefore = false;
let msgSeq = 7000n;
const madeLeads: string[] = [];
const madeRequests: string[] = [];
const madeFacts: string[] = [];

const CLIENT_PHONE = `+99897${SUFFIX}11`;
const OTHER_NAME = `Saidaxon Boshqayeva ${SUFFIX}`;

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99895${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

const actor = () => ({ id: ownerId, roles: ['super_admin'], permissions: new Set<string>(['crm.leads.view_all']) });
const ctx = () => ({ actorId: ownerId });

async function message(
  peerId: bigint,
  input: { body?: string; direction?: 'in' | 'out'; agoMs?: number; clientId?: string | null; leadId?: string | null } = {},
): Promise<{ tgId: bigint; rowId: string }> {
  msgSeq += 1n;
  const owner = input.clientId === undefined && input.leadId === undefined ? { clientId } : { clientId: input.clientId ?? null, leadId: input.leadId ?? null };
  const [row] = await db
    .insert(tgMessages)
    .values({
      ...owner,
      managerUserId: ownerId,
      peerId,
      tgMessageId: msgSeq,
      direction: input.direction ?? 'in',
      body: input.body ?? 'Yukim qayerda?',
      sentAt: new Date(Date.now() - (input.agoMs ?? 60_000)),
    })
    .returning({ id: tgMessages.id });
  return { tgId: msgSeq, rowId: row!.id };
}

async function draft(peerId: bigint, over: Partial<typeof agentDrafts.$inferInsert> = {}): Promise<string> {
  const [d] = await db
    .insert(agentDrafts)
    .values({
      managerUserId: ownerId,
      peerId,
      anchorTgMessageId: over.anchorTgMessageId ?? 1n,
      clientId,
      status: 'pending',
      finalBody: 'Tekshirib aytaman.',
      ...over,
    })
    .returning({ id: agentDrafts.id });
  return d!.id;
}

/** An approved draft and its outbox row, waiting — the shape `decideDraft` writes. */
async function waiting(peerId: bigint, status: 'agent' | 'sending' = 'agent', owner: { clientId: string | null } = { clientId }) {
  const draftId = await draft(peerId, { status: 'approved', decidedBy: ownerId, decidedAt: new Date(), clientId: owner.clientId });
  msgSeq += 1n;
  const [o] = await db
    .insert(agentOutbox)
    .values({
      draftId,
      managerUserId: ownerId,
      peerId,
      clientId: owner.clientId,
      body: 'Ertalab javob.',
      randomId: BigInt(`6${SUFFIX}${String(msgSeq).padStart(6, '0')}`),
      answersTgMessageId: 1n,
      status,
      queuedBy: ownerId,
      nextStepAt: new Date(Date.now() + 6 * 3_600_000),
    })
    .returning({ id: agentOutbox.id });
  return { draftId, outboxId: o!.id };
}

async function outboxRow(id: string) {
  const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.id, id));
  return o!;
}

async function draftRow(id: string) {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, id));
  return d!;
}

async function lead(name: string, phone: string, wonBy: string | null): Promise<string> {
  const [l] = await db
    .insert(leads)
    .values({ name, phone, stageId: leadStageId, ownerId, clientId: wonBy, createdBy: ownerId })
    .returning({ id: leads.id });
  madeLeads.push(l!.id);
  return l!.id;
}

function scripted(steps: { name: string; input: Record<string, unknown> }[]): CallModel {
  let i = 0;
  return (async (_req: ModelRequest): Promise<ModelResponse> => {
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    return {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: `t${i}`, name: step.name, input: step.input }],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }) as CallModel;
}

async function clearChats() {
  await db.delete(agentCalcLinks).where(inArray(agentCalcLinks.peerId, PEERS));
  await db.delete(agentOutbox).where(inArray(agentOutbox.peerId, PEERS));
  await db.delete(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' IN (SELECT id::text FROM agent_drafts WHERE peer_id IN (${sql.join(PEERS.map((p) => sql`${String(p)}::bigint`), sql`, `)}))`);
  await db.delete(agentDrafts).where(inArray(agentDrafts.peerId, PEERS));
  await db.delete(agentRuns).where(inArray(agentRuns.peerId, PEERS));
  await db.delete(agentConversations).where(inArray(agentConversations.peerId, PEERS));
  await db.delete(tgChatRules).where(inArray(tgChatRules.peerId, PEERS));
  await db.delete(tgMessages).where(inArray(tgMessages.peerId, PEERS));
  await db.delete(notifications).where(and(inArray(notifications.userId, [ownerId, sellerId]), sql`${notifications.type} LIKE 'Agent%'`));
  queued.length = 0;
}

beforeAll(async () => {
  snapshot = await readAgentConfig();
  if (!snapshot) throw new Error('0136 is not applied on this database');
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  ownerId = await makeUser(`AI ident egasi ${SUFFIX}`, 'super_admin', '01');
  sellerId = await makeUser(`AI ident sotuvchi ${SUFFIX}`, 'sales_manager', '02');
  vedId = await makeUser(`AI ident VED ${SUFFIX}`, 'ved_manager', '03');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: ownerId, tgPhone: `+99893${SUFFIX}74`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date() })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `AK${SUFFIX}`, name: `Ident Mijoz ${SUFFIX}`, phones: [CLIENT_PHONE], salesManagerId: ownerId })
    .returning({ id: clients.id });
  clientId = c!.id;
  const [o] = await db
    .insert(clients)
    .values({ clientCode: `AM${SUFFIX}`, name: OTHER_NAME, phones: [`+99897${SUFFIX}22`], salesManagerId: ownerId })
    .returning({ id: clients.id });
  otherClientId = o!.id;
  const [stage] = await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'open')).orderBy(asc(leadStages.sortOrder)).limit(1);
  leadStageId = stage!.id;
  await db
    .update(agentConfig)
    .set({
      mode: 'shadow',
      ownerUserId: ownerId,
      sessionExclusiveAt: new Date(),
      sessionExclusiveBy: ownerId,
      startedAt: new Date(Date.now() - 30 * 86_400_000),
      dailyDraftCap: 150,
      dailyTokenCap: 3_000_000,
      humanPauseMin: 120,
    })
    .where(eq(agentConfig.id, 1));
  await setSetting('tg_sending_enabled', true, ownerId);
});

beforeEach(async () => {
  await clearChats();
  await stampAgentPump(accountId, true);
});

afterAll(async () => {
  await clearChats();
  if (madeFacts.length) await db.delete(kbFacts).where(inArray(kbFacts.id, madeFacts));
  // By OWNER too (#523): a red proof that drops a fact's provenance leaves a
  // copy no draft id finds — and its FK would stop the client's own delete.
  await db.delete(kbFacts).where(inArray(kbFacts.clientId, [clientId, otherClientId]));
  if (madeLeads.length) await db.delete(kbFacts).where(inArray(kbFacts.leadId, madeLeads));
  const requests = await db
    .select({ id: calcRequests.id, taskId: calcRequests.taskId })
    .from(calcRequests)
    .where(inArray(calcRequests.requestedBy, [ownerId]));
  const requestIds = [...new Set([...requests.map((r) => r.id), ...madeRequests])];
  const taskIds = requests.map((r) => r.taskId).filter((t): t is string => Boolean(t));
  if (requestIds.length) {
    await db.delete(calcOffers).where(inArray(calcOffers.requestId, requestIds));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, requestIds));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, requestIds));
    await db.delete(calcRequests).where(inArray(calcRequests.id, requestIds));
  }
  if (taskIds.length) {
    await db.delete(events).where(inArray(events.entityId, taskIds));
    await db.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  const dealIds = (await db.select({ id: deals.id }).from(deals).where(inArray(deals.clientId, [clientId, otherClientId]))).map((d) => d.id);
  if (dealIds.length) {
    await db.delete(events).where(inArray(events.entityId, dealIds));
    await db.delete(crmActivities).where(and(eq(crmActivities.entityType, 'deal'), inArray(crmActivities.entityId, dealIds)));
    await db.delete(dealLines).where(inArray(dealLines.dealId, dealIds));
    await db.delete(deals).where(inArray(deals.id, dealIds));
  }
  if (madeLeads.length) {
    await db.delete(events).where(inArray(events.entityId, madeLeads));
    await db.delete(leads).where(inArray(leads.id, madeLeads));
  }
  await db.delete(notifications).where(inArray(notifications.userId, [ownerId, sellerId, vedId]));
  await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(events).where(inArray(events.entityId, [clientId, otherClientId]));
  await db.delete(clients).where(inArray(clients.id, [clientId, otherClientId]));
  await __restoreAgentConfig(snapshot);
  await setSetting('tg_sending_enabled', sendingBefore, ownerId);
  await db.update(users).set({ active: false }).where(inArray(users.id, [ownerId, sellerId, vedId]));
});

describe('🙋 also stops the replies he approved before it (K2)', () => {
  it('a reply still waiting in the chat is cancelled in the same press — one already claimed is left to its own next step', async () => {
    const p = PEERS[0]!;
    const held = await waiting(p, 'agent');
    const inFlight = await waiting(p, 'sending');
    const { tgId } = await message(p, { body: '??' });
    const d2 = await draft(p, { anchorTgMessageId: tgId });
    expect(await decideDraft(actor(), d2, 'human', {}, ctx())).toMatchObject({ ok: true, status: 'taken_over' });
    const row = await outboxRow(held.outboxId);
    expect(row.status).toBe('cancelled');
    expect(row.lastError).toMatch(/^taken_over:/u);
    expect(renderDraftCard(await draftRow(held.draftId), row)).toContain("suhbatni o'zingizga oldingiz");
    // `sending` is the row in flight: its own next step reads `human_until` (send-step, K2's other half).
    expect((await outboxRow(inFlight.outboxId)).status).toBe('sending');
  });
});

describe('the web tray taking a bind back takes the agent’s replies with it (K7)', () => {
  async function boundChat(p: bigint) {
    const [rule] = await db
      .insert(tgChatRules)
      .values({ managerUserId: ownerId, peerId: p, decision: 'include', clientId, peerTitle: 'Notanish', peerPhone: `+99890${SUFFIX}77`, decidedBy: ownerId, decidedAt: new Date() })
      .returning({ id: tgChatRules.id });
    return rule!.id;
  }

  it('«↩» (pending) expires the client’s live draft and cancels its waiting reply in that chat', async () => {
    const p = PEERS[1]!;
    const ruleId = await boundChat(p);
    const { tgId } = await message(p);
    const live = await draft(p, { anchorTgMessageId: tgId });
    const held = await waiting(p);
    await decideChat({ id: ruleId, decision: 'pending' }, ctx());
    expect((await draftRow(live)).status).toBe('expired');
    const row = await outboxRow(held.outboxId);
    expect(row.status).toBe('cancelled');
    expect(row.lastError).toMatch(/^identity_changed/u);
  });

  it('…and «Bu mijoz» naming the SAME client again keeps everything', async () => {
    const p = PEERS[2]!;
    const ruleId = await boundChat(p);
    const { tgId } = await message(p);
    const live = await draft(p, { anchorTgMessageId: tgId });
    const held = await waiting(p);
    await decideChat({ id: ruleId, decision: 'include', clientId }, ctx());
    expect((await draftRow(live)).status).toBe('pending');
    expect((await outboxRow(held.outboxId)).status).toBe('agent');
  });

  it('a ✅ on a draft whose chat no longer names its client is refused — asked of the server’s identity, not the stored row', async () => {
    const p = PEERS[3]!;
    const ruleId = await boundChat(p);
    const { tgId } = await message(p);
    const live = await draft(p, { anchorTgMessageId: tgId });
    // The bind taken back by a door that tells the agent nothing (the rule written directly).
    await db.update(tgChatRules).set({ decision: 'pending', clientId: null }).where(eq(tgChatRules.id, ruleId));
    expect(await decideDraft(actor(), live, 'send', {}, ctx())).toEqual({ ok: false, code: 'identity_changed' });
    expect((await draftRow(live)).status).toBe('expired');
    expect(await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, live))).toHaveLength(0);
  });
});

describe('a client that came through a lead must be proven by the chat (K9) — and keeps the lead’s knowledge (K25)', () => {
  it('a rule-less chat whose rows came through a won lead serves no cargo until the chat proves it — then does', async () => {
    const p = PEERS[4]!;
    const leadPhone = `+99891${SUFFIX}55`;
    const l = await lead(`Lid ident ${SUFFIX}`, leadPhone, clientId);
    // The listener filed the stranger's chat under the lead (a work account, no rule); the win stamped the client.
    await message(p, { clientId, leadId: l });
    // …and the agent's own reply is filed under the client alone, the newest row.
    await message(p, { direction: 'out', agoMs: 30_000, clientId, leadId: null });
    const before = await chatIdentity(ownerId, p);
    expect(before).toMatchObject({ clientId, cargoAllowed: false, strength: 'lead', leadId: l });
    // The lead's number on the client's card IS the chat's proof.
    await db.update(clients).set({ phones: [CLIENT_PHONE, leadPhone] }).where(eq(clients.id, clientId));
    try {
      expect(await chatIdentity(ownerId, p)).toMatchObject({ clientId, cargoAllowed: true, strength: 'phone' });
    } finally {
      await db.update(clients).set({ phones: [CLIENT_PHONE] }).where(eq(clients.id, clientId));
    }
  });

  it('a chat the listener classified by its own phone stays proven — no lead in its rows', async () => {
    const p = PEERS[5]!;
    await message(p);
    expect(await chatIdentity(ownerId, p)).toMatchObject({ clientId, cargoAllowed: true, strength: 'phone', leadId: null });
  });

  it('«👤 Faqat shu mijoz» said on the lead is still read after the win', async () => {
    const p = PEERS[6]!;
    // Another code than the K9 lead's: a client carries one lead (0021's `leads_client_unique`).
    const l = await lead(`Lid bilim ${SUFFIX}`, `+99891${SUFFIX}66`, otherClientId);
    await message(p, { clientId: otherClientId, leadId: l, body: 'Qadoqlash qanday?' });
    const id = await writeKbFact(
      { scope: 'lead', leadId: l, question: `Qadoqlash ${SUFFIX}`, answer: `Qutilarni o‘zi qadoqlaydi ${SUFFIX}.`, sourceRef: { test: SUFFIX } },
      ctx(),
    );
    madeFacts.push(id);
    const identity = await chatIdentity(ownerId, p);
    expect(identity).toMatchObject({ clientId: otherClientId, leadId: l, cargoAllowed: false });
    // run.ts asks exactly this: the chat's proven codes (none here) and its lead.
    const hits = await kbSearch({ clientIds: identity.cargoAllowed ? identity.codes.map((c) => c.id) : [], leadId: identity.leadId }, `Qadoqlash ${SUFFIX}`);
    expect(hits.map((h) => h.id)).toContain(id);
  });
});

describe('what a fact carries into every prompt (K6)', () => {
  it('a price in the QUESTION is a price in the knowledge — refused like one in the answer', async () => {
    await expect(
      writeKbFact({ scope: 'general', question: `Qarzi 1500$ bo‘lsa bo‘lib to‘lasa bo‘ladimi (${SUFFIX})`, answer: 'Ha, bo‘ladi.', knownNames: [] }, ctx()),
    ).rejects.toMatchObject({ code: 'money' });
  });

  async function answeredQuestion(p: bigint, question: string, answer: string): Promise<string> {
    return draft(p, { status: 'approved', decidedBy: ownerId, decidedAt: new Date(), needsOwner: true, ownerQuestion: question, finalBody: answer });
  }

  it('the bot’s 📌 stores HIS answer alone — never the model’s account of this one customer', async () => {
    const p = PEERS[7]!;
    const d = await answeredQuestion(p, `Mijoz qarzi 1500$ ni bo‘lib to‘lasa bo‘ladimi, 12 kub mebel ham bor? ${SUFFIX}`, `Ha, bo‘lib to‘lash mumkin ${SUFFIX}.`);
    const ask = await agentPress(ownerId, 'g', d, undefined);
    const token = /:([0-9a-f]{8})$/u.exec(ask.buttons?.[0]?.[0]?.callback_data ?? '')?.[1];
    expect(token, 're-anchor: the 📌 yes button').toBeTruthy();
    const yes = await agentPress(ownerId, 'g', d, token);
    expect(yes.toast).toContain('Umumiy qoida saqlandi');
    const [fact] = await db.select().from(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' = ${d}`);
    expect(fact).toMatchObject({ scope: 'general', question: null, answer: `Ha, bo‘lib to‘lash mumkin ${SUFFIX}.` });
  });

  it('…and is checked against EVERY name the book holds, as the page’s own add form is', async () => {
    const p = PEERS[8]!;
    const d = await answeredQuestion(p, 'Qaysi omborga?', `Bu haqda ${OTHER_NAME} bilan gaplashing.`);
    const ask = await agentPress(ownerId, 'g', d, undefined);
    const token = /:([0-9a-f]{8})$/u.exec(ask.buttons?.[0]?.[0]?.callback_data ?? '')?.[1];
    const yes = await agentPress(ownerId, 'g', d, token);
    expect(yes.reply).toContain("mijoz ma'lumoti bor");
    expect(await db.select().from(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' = ${d}`)).toHaveLength(0);
  });
});

describe('an edited fact keeps where it was born (K8)', () => {
  it('the corrected copy of a 👤 fact still names its draft — the chat’s purge takes it — and the audit keeps no words', async () => {
    const p = PEERS[9]!;
    const d = await draft(p, { status: 'approved', decidedBy: ownerId, decidedAt: new Date() });
    const first = await writeKbFact(
      { scope: 'client', clientId, question: null, answer: `Ali akaga faqat ertalab qo‘ng‘iroq ${SUFFIX}.`, sourceRef: { draftId: d } },
      ctx(),
    );
    const second = await editKbFact(first, { question: null, answer: `Ali akaga faqat kechqurun qo‘ng‘iroq ${SUFFIX}.` }, ctx());
    const [edited] = await db.select().from(kbFacts).where(eq(kbFacts.id, second));
    expect((edited!.sourceRef as Record<string, unknown>).draftId).toBe(d);
    const [audit] = await db
      .select({ before: auditLog.before })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'kb_fact'), eq(auditLog.entityId, first), eq(auditLog.action, 'update')));
    expect(JSON.stringify(audit!.before)).not.toContain('ertalab');
    await purgeAgentChat(ownerId, p);
    expect(await db.select({ id: kbFacts.id }).from(kbFacts).where(inArray(kbFacts.id, [first, second]))).toHaveLength(0);
  });
});

describe('the page reads another account only for the supervision view (K10)', () => {
  const seller = () => ({ id: sellerId, roles: ['sales_manager'] as const, permissions: new Set<string>(['crm.leads']) });

  it('a configured owner without it sees neither another account’s drafts nor its customers’ facts — and cannot touch them', async () => {
    const p = PEERS[10]!;
    const { tgId } = await message(p);
    const mine = await draft(p, { anchorTgMessageId: tgId });
    const fact = await writeKbFact(
      { scope: 'client', clientId, question: null, answer: `Faqat shu mijoz ${SUFFIX}.`, sourceRef: { draftId: mine } },
      ctx(),
    );
    const general = await writeKbFact({ scope: 'general', question: `Umumiy ${SUFFIX}`, answer: 'Dushanba-shanba ishlaymiz.', knownNames: [] }, ctx());
    madeFacts.push(general);
    const ids = (lists: Awaited<ReturnType<typeof webDrafts>>) => [...lists.pending, ...lists.questions].map((d) => d.id);
    expect(ids(await webDrafts(actor()))).toContain(mine);
    expect(ids(await webDrafts(seller()))).not.toContain(mine);
    const sellerFacts = (await webKbFacts(seller())).facts.map((f) => f.id);
    expect(sellerFacts).not.toContain(fact);
    expect(sellerFacts).toContain(general);
    expect((await webKbFacts(actor())).facts.map((f) => f.id)).toContain(fact);
    await expect(assertFactSeen(seller(), fact)).rejects.toMatchObject({ code: 'not_found' });
    await expect(assertFactSeen(seller(), general)).resolves.toBeUndefined();
  });
});

describe('the style corpus reads only what he still stands behind (K11)', () => {
  it('a message he deleted is not his words any more', async () => {
    const p = PEERS[11]!;
    const kept = await message(p, { direction: 'out', body: `Assalomu alaykum, qoldi ${SUFFIX}` });
    const gone = await message(p, { direction: 'out', body: `Noto‘g‘ri mijozga ketdi ${SUFFIX}` });
    await db.insert(tgMessageFlags).values({ messageId: gone.rowId, deletedAt: new Date() });
    void kept;
    const bodies = await humanOutBodies(ownerId);
    expect(bodies).toContain(`Assalomu alaykum, qoldi ${SUFFIX}`);
    expect(bodies).not.toContain(`Noto‘g‘ri mijozga ketdi ${SUFFIX}`);
  });
});

describe('his unanswered question, reminded once (K30, his 14)', () => {
  it('a question waiting more than 30 minutes gets ONE reminder naming its chat — counts, no customer text', async () => {
    const p = PEERS[0]!;
    const old = await draft(p, { needsOwner: true, ownerQuestion: `Mijoz Bobur so‘rayapti ${SUFFIX}`, createdAt: new Date(Date.now() - OWNER_QUESTION_WAIT_MS - 60_000) });
    const fresh = await draft(PEERS[1]!, { needsOwner: true, ownerQuestion: 'Yangi savol', createdAt: new Date(Date.now() - 5 * 60_000) });
    const now = new Date();
    expect(await remindOwnerQuestions(now)).toBe(1);
    const cards = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentNotice')));
    expect(cards).toHaveLength(1);
    const payload = cards[0]!.payload as { text: string; peerId: string };
    expect(payload.peerId).toBe(String(p));
    expect(payload.text).toContain('30 daqiqa');
    expect(payload.text).not.toContain('Bobur');
    expect((await draftRow(old)).ownerRemindedAt).not.toBeNull();
    expect((await draftRow(fresh)).ownerRemindedAt).toBeNull();
    // Once: the next sweep finds it already reminded.
    expect(await remindOwnerQuestions(new Date())).toBe(0);
  });
});

describe('a run its process died inside (K24)', () => {
  it('a «reserved» row long past any loop’s wall clock becomes an error the one retry can take', async () => {
    const p = PEERS[2]!;
    const { tgId } = await message(p);
    const [run] = await db
      .insert(agentRuns)
      .values({ managerUserId: ownerId, peerId: p, trigger: 'inbound', anchorTgMessageId: tgId, createdAt: new Date(Date.now() - 10 * 60_000) })
      .returning({ id: agentRuns.id });
    const [young] = await db
      .insert(agentRuns)
      .values({ managerUserId: ownerId, peerId: p, trigger: 'owner_edit', sourceKey: `young-${SUFFIX}`, createdAt: new Date(Date.now() - 30_000) })
      .returning({ id: agentRuns.id });
    await agentSweep(new Date());
    const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, run!.id));
    expect(after).toMatchObject({ outcome: 'error', error: 'interrupted' });
    const [still] = await db.select().from(agentRuns).where(eq(agentRuns.id, young!.id));
    expect(still!.outcome, 'a run still inside its wall clock is left alone').toBe('reserved');
  });
});

describe('a calculation the queue refused lands on a later ✅ (K26)', () => {
  it('twenty open requests refuse the first ✅ in words; once one is answered, the next ✅ queues the SAME job', async () => {
    const p = PEERS[3]!;
    const { tgId: anchor } = await message(p, { body: 'Xitoydan Toshkentga podklyuch kerak: 3 kub 500 kg, kurtka 100 dona' });
    const out = await handleInbound(
      { managerUserId: ownerId, peerId: String(p), anchorTgMessageId: String(anchor), origin: 'live' },
      {
        callModel: scripted([
          { name: 'calc_checklist', input: { section: 'podklyuch', goods: [{ name: 'kurtka', quantity: 100, weight_kg: null }] } },
          {
            name: 'compose_reply',
            input: {
              reply_needed: true,
              reply_text: 'Hisoblatishga yubordim, javob kelishi bilan aytaman.',
              language: 'uz',
              gloss_uz: '',
              category: 'qualification',
              confidence: 0.8,
              needs_owner: false,
              owner_question: '',
              next_step: 'calc',
              actions: [{ type: 'calc_submit', section: 'podklyuch', cited_message_refs: ['#1'], date: '', note: '' }],
              used_fact_ids: [],
              cited_message_refs: [],
            },
          },
        ]),
      },
    );
    expect(out).toMatchObject({ outcome: 'draft', blocked: false });
    const [d] = await db.select().from(agentDrafts).where(and(eq(agentDrafts.peerId, p), eq(agentDrafts.status, 'pending')));
    // Twenty jobs of his already wait on the VED (his Q10 ⭐ keeps the cap).
    const busy = await db
      .insert(calcRequests)
      .values(
        Array.from({ length: MAX_OPEN_PER_REQUESTER }, () => ({
          entityType: 'lead',
          entityId: ownerId,
          requestedBy: ownerId,
          itemCount: 0,
          dueAt: new Date(Date.now() + 3_600_000),
        })),
      )
      .returning({ id: calcRequests.id });
    madeRequests.push(...busy.map((b) => b.id));
    const first = await decideDraft(actor(), d!.id, 'send', {}, ctx());
    expect(first).toEqual({ ok: false, code: 'calc_not_queued', detail: 'too_many_open' });
    const refused = await draftRow(d!.id);
    expect(refused).toMatchObject({ status: 'pending', actionStatus: 'failed', actionError: 'too_many_open' });
    const card = renderDraftCard(refused, null);
    expect(card).toContain(`${MAX_OPEN_PER_REQUESTER} ta ochiq so‘rov`);
    expect(card).not.toMatch(/Kartadan qo.lda yuboring|too_many_open|already_landed/u);

    // One of the twenty answered: the very next ✅ lands the job the note promised — never «already landed».
    await db.update(calcRequests).set({ completedAt: new Date(), completedBy: vedId, completedVia: 'task' }).where(eq(calcRequests.id, busy[0]!.id));
    const second = await decideDraft(actor(), d!.id, 'send', {}, ctx());
    expect(second).toMatchObject({ ok: true, status: 'approved' });
    const landed = await db.select().from(calcRequests).where(eq(calcRequests.noteId, noteIdFor(d!.id)));
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ section: 'podklyuch', source: 'bot', hasCertificate: true, freightZone: 'cn' });
    expect((second as { requestId?: string }).requestId).toBe(landed[0]!.id);
    // The AI VED hodimi is handed the re-asked job like a first landing.
    expect(queued.some((q) => q.name === JOB_CALC_PREFILL && (q.data as { requestId?: string }).requestId === landed[0]!.id)).toBe(true);
    // The note was written once, on the first press.
    expect(await db.select({ id: crmActivities.id }).from(crmActivities).where(eq(crmActivities.id, noteIdFor(d!.id)))).toHaveLength(1);
  });
});
