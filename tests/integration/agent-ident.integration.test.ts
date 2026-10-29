import 'dotenv/config';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

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
import { sendsSilently } from '@/modules/platform/notifications/night';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { agentPress, QUESTION_DROPPED } from '@/modules/wms/agent/bot-door';
import { LANDING_CLAIM, renderDraftCard } from '@/modules/wms/agent/card-io';
import { __restoreAgentConfig, readAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { chatIdentity } from '@/modules/wms/agent/context';
import { decideDraft, LANDING_STALE_MS, noteIdFor } from '@/modules/wms/agent/decide';
import { withdrawMovedReplies, withdrawRepliesFor } from '@/modules/wms/agent/drafts';
import { agentSweep, OWNER_QUESTION_WAIT_MS, remindOwnerQuestions } from '@/modules/wms/agent/jobs';
import { kbSearch, writeKbFact } from '@/modules/wms/agent/kb';
import { purgeAgentChat } from '@/modules/wms/agent/purge';
import { handleInbound } from '@/modules/wms/agent/run';
import { humanOutBodies, knownNamesForMask } from '@/modules/wms/agent/style';
import { addGeneralFact, assertFactSeen, editKbFact } from '@/modules/wms/agent/web-kb';
import { webDrafts, webKbFacts } from '@/modules/wms/agent/web-page';
import { MAX_OPEN_PER_REQUESTER } from '@/modules/wms/calc/service';
import { JOB_CALC_PREFILL } from '@/modules/wms/calc/jobs';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';
import { attachPeerToCard, decideChat, openLeadForChat } from '@/modules/wms/crm/chat-rules';

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
const PEERS = Array.from({ length: 32 }, (_, i) => peer(i + 1));
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
/** Clients a scenario mints for itself (a lead to win, a phone pair) — deleted with the file's own two. */
const madeClients: string[] = [];

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
async function waiting(
  peerId: bigint,
  status: 'agent' | 'sending' = 'agent',
  owner: { clientId: string | null; leadId?: string | null } = { clientId },
) {
  const leadId = owner.clientId ? null : (owner.leadId ?? null);
  const draftId = await draft(peerId, { status: 'approved', decidedBy: ownerId, decidedAt: new Date(), clientId: owner.clientId, leadId });
  msgSeq += 1n;
  const [o] = await db
    .insert(agentOutbox)
    .values({
      draftId,
      managerUserId: ownerId,
      peerId,
      clientId: owner.clientId,
      leadId,
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

/** A pending podklyuch draft carrying a calc_submit — the model scripted (CI has no key). */
async function calcDraft(p: bigint, owner: { clientId?: string | null; leadId?: string | null } = {}): Promise<string> {
  const { tgId: anchor } = await message(p, { body: 'Xitoydan Toshkentga podklyuch kerak: 3 kub 500 kg, kurtka 100 dona', ...owner });
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
  return d!.id;
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
  if (!snapshot) throw new Error('0138 is not applied on this database');
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
  await db.delete(kbFacts).where(inArray(kbFacts.clientId, [clientId, otherClientId, ...madeClients]));
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
  const dealIds = (await db.select({ id: deals.id }).from(deals).where(inArray(deals.clientId, [clientId, otherClientId, ...madeClients]))).map((d) => d.id);
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
  await db.delete(events).where(inArray(events.entityId, [clientId, otherClientId, ...madeClients]));
  await db.delete(clients).where(inArray(clients.id, [clientId, otherClientId, ...madeClients]));
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
    // …and says the fact went in without the question he saw on the card (F8).
    expect(yes.reply).toContain(QUESTION_DROPPED);
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

/** Today's `hour:minute` on the Tashkent clock (UTC+5) — the reminder rings by day only (F9), never by the clock this file happens to run at. */
function tashkentAt(hour: number, minute = 0): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour - 5, minute));
}

/** His AgentNotice rows — this file's owner is this file's own (#653): asserted instead of the sweep's whole-database count (F6). */
async function ownerNotices() {
  return db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentNotice')));
}

describe('his unanswered question, reminded once (K30, his 14)', () => {
  it('a question waiting more than 30 minutes gets ONE reminder naming its chat — counts, no customer text', async () => {
    const p = PEERS[0]!;
    const now = tashkentAt(12);
    const old = await draft(p, { needsOwner: true, ownerQuestion: `Mijoz Bobur so‘rayapti ${SUFFIX}`, createdAt: new Date(now.getTime() - OWNER_QUESTION_WAIT_MS - 60_000) });
    const fresh = await draft(PEERS[1]!, { needsOwner: true, ownerQuestion: 'Yangi savol', createdAt: new Date(now.getTime() - 5 * 60_000) });
    // The sweep is the whole database's (other files' managers have questions too): this file's own rows are the oracle (F6).
    await remindOwnerQuestions(now);
    const cards = await ownerNotices();
    expect(cards).toHaveLength(1);
    const payload = cards[0]!.payload as { text: string; peerId: string };
    expect(payload.peerId).toBe(String(p));
    expect(payload.text).toContain('30 daqiqa');
    expect(payload.text).not.toContain('Bobur');
    expect((await draftRow(old)).ownerRemindedAt).not.toBeNull();
    expect((await draftRow(fresh)).ownerRemindedAt).toBeNull();
    // Once: the next sweep finds it already reminded.
    await remindOwnerQuestions(new Date(now.getTime() + 60_000));
    expect(await ownerNotices()).toHaveLength(1);
  });

  it('…by DAY: a question crossing the half hour at night is reminded by the first sweep after 08:00 — audibly, and in ONE notice for all of them (F9)', async () => {
    const night = tashkentAt(3);
    const first = await draft(PEERS[24]!, { needsOwner: true, ownerQuestion: 'Kechasi savol', createdAt: new Date(night.getTime() - 40 * 60_000) });
    const second = await draft(PEERS[25]!, { needsOwner: true, ownerQuestion: 'Yana savol', createdAt: new Date(night.getTime() - 35 * 60_000) });
    // 03:00: claimed now, it would arrive silent (night.ts) — and, once-only, never ring at all.
    await remindOwnerQuestions(night);
    expect(await ownerNotices()).toHaveLength(0);
    expect((await draftRow(first)).ownerRemindedAt).toBeNull();
    expect((await draftRow(second)).ownerRemindedAt).toBeNull();
    const morning = tashkentAt(8, 1);
    await remindOwnerQuestions(morning);
    const cards = await ownerNotices();
    // Two questions crossed: ONE notice saying «2 ta», never two copies of it.
    expect(cards).toHaveLength(1);
    const payload = cards[0]!.payload as { text: string; peerId: string };
    expect(payload.text).toContain('Javobsiz savollar: 2 ta');
    // It names the chat of the newest question it reminds of.
    expect(payload.peerId).toBe(String(PEERS[25]));
    expect(sendsSilently('AgentNotice', payload, morning)).toBe(false);
    expect((await draftRow(first)).ownerRemindedAt).not.toBeNull();
    expect((await draftRow(second)).ownerRemindedAt).not.toBeNull();
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
    const draftId = await calcDraft(p);
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
    const first = await decideDraft(actor(), draftId, 'send', {}, ctx());
    expect(first).toEqual({ ok: false, code: 'calc_not_queued', detail: 'too_many_open' });
    const refused = await draftRow(draftId);
    expect(refused).toMatchObject({ status: 'pending', actionStatus: 'failed', actionError: 'too_many_open' });
    const card = renderDraftCard(refused, null);
    expect(card).toContain(`${MAX_OPEN_PER_REQUESTER} ta ochiq so‘rov`);
    expect(card).not.toMatch(/Kartadan qo.lda yuboring|too_many_open|already_landed/u);

    // One of the twenty answered: the very next ✅ lands the job the note promised — never «already landed».
    await db.update(calcRequests).set({ completedAt: new Date(), completedBy: vedId, completedVia: 'task' }).where(eq(calcRequests.id, busy[0]!.id));
    const second = await decideDraft(actor(), draftId, 'send', {}, ctx());
    expect(second).toMatchObject({ ok: true, status: 'approved' });
    const landed = await db.select().from(calcRequests).where(eq(calcRequests.noteId, noteIdFor(draftId)));
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ section: 'podklyuch', source: 'bot', hasCertificate: true, freightZone: 'cn' });
    expect((second as { requestId?: string }).requestId).toBe(landed[0]!.id);
    // The AI VED hodimi is handed the re-asked job like a first landing.
    expect(queued.some((q) => q.name === JOB_CALC_PREFILL && (q.data as { requestId?: string }).requestId === landed[0]!.id)).toBe(true);
    // The note was written once — by the ✅ that landed: the landing refuses before it writes a card or a note.
    expect(await db.select({ id: crmActivities.id }).from(crmActivities).where(eq(crmActivities.id, noteIdFor(draftId)))).toHaveLength(1);
  });

  it('a chat whose lead was won or lost since is refused in words, and nothing is written on the closed card', async () => {
    const p = PEERS[31]!;
    // The test above leaves twenty jobs open, and that refusal is asked first.
    await db
      .update(calcRequests)
      .set({ completedAt: new Date(), completedBy: vedId, completedVia: 'task' })
      .where(and(eq(calcRequests.requestedBy, ownerId), isNull(calcRequests.completedAt)));
    const l = await lead(`Yopiq lid ${SUFFIX}`, `+99891${SUFFIX}44`, null);
    const draftId = await calcDraft(p, { clientId: null, leadId: l });
    const [lost] = await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'lost')).limit(1);
    await db.update(leads).set({ stageId: lost!.id, lostReason: 'test' }).where(eq(leads.id, l));
    const pressed = await decideDraft(actor(), draftId, 'send', {}, ctx());
    expect(pressed).toEqual({ ok: false, code: 'calc_not_queued', detail: 'lead_closed' });
    expect(await draftRow(draftId)).toMatchObject({ status: 'pending', actionStatus: 'failed', actionError: 'lead_closed' });
    expect(renderDraftCard(await draftRow(draftId), null)).toContain('lidi yopilgan');
    expect(await db.select({ id: crmActivities.id }).from(crmActivities).where(eq(crmActivities.id, noteIdFor(draftId)))).toHaveLength(0);
    expect(await db.select({ id: calcRequests.id }).from(calcRequests).where(eq(calcRequests.entityId, l))).toHaveLength(0);
  });
});

/** A tray rule on a chat, by default the file's client bound by hand on a number no card holds (no proof). */
async function ruleOn(p: bigint, over: Partial<typeof tgChatRules.$inferInsert> = {}): Promise<string> {
  const [rule] = await db
    .insert(tgChatRules)
    .values({
      managerUserId: ownerId,
      peerId: p,
      decision: 'include',
      clientId,
      peerTitle: 'Notanish',
      peerPhone: `+99890${SUFFIX}${String(p).slice(-2)}`,
      decidedBy: ownerId,
      decidedAt: new Date(),
      ...over,
    })
    .returning({ id: tgChatRules.id });
  return rule!.id;
}

async function madeClient(code: string, phones: string[]): Promise<string> {
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `${code}${SUFFIX}`, name: `Qo‘shimcha ${code} ${SUFFIX}`, phones, salesManagerId: ownerId })
    .returning({ id: clients.id });
  madeClients.push(c!.id);
  return c!.id;
}

describe('a bind moved elsewhere is the new customer from the press — and takes the old one’s replies (ident fix F1)', () => {
  it('«Qo‘shish» on ANOTHER code: the chat is that code at once, and a draft written for the old one is refused at ✅', async () => {
    const p = PEERS[12]!;
    const ruleId = await ruleOn(p);
    // The stored row names the old client until the customer writes again.
    const { tgId } = await message(p);
    await decideChat({ id: ruleId, decision: 'pending' }, ctx());
    await decideChat({ id: ruleId, decision: 'include', clientId: otherClientId }, ctx());
    expect(await chatIdentity(ownerId, p)).toMatchObject({ clientId: otherClientId, strength: 'rule', customerName: OTHER_NAME });
    // A draft minted between the rebind and the next inbound — the 💵 answer, a hand-back, the sweep's retry.
    const late = await draft(p, { anchorTgMessageId: tgId, clientId });
    expect(await decideDraft(actor(), late, 'send', {}, ctx())).toEqual({ ok: false, code: 'identity_changed' });
    expect(await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, late))).toHaveLength(0);
  });

  it('«Yangi lid» from a stale tab on a bound chat: the chat is the lead, the client’s live draft expires, its waiting reply is cancelled', async () => {
    const p = PEERS[13]!;
    const ruleId = await ruleOn(p);
    const { tgId } = await message(p);
    const live = await draft(p, { anchorTgMessageId: tgId });
    const held = await waiting(p);
    const { leadId } = await openLeadForChat(ruleId, ctx());
    madeLeads.push(leadId);
    expect(await chatIdentity(ownerId, p)).toMatchObject({ clientId: null, leadId, strength: 'lead', codes: [] });
    expect((await draftRow(live)).status).toBe('expired');
    const row = await outboxRow(held.outboxId);
    expect(row.status).toBe('cancelled');
    expect(row.lastError).toMatch(/^identity_changed/u);
  });

  it('a card’s «Chatni qo‘shish» naming another customer takes the old one’s waiting reply too', async () => {
    const p = PEERS[14]!;
    await ruleOn(p);
    await message(p);
    const held = await waiting(p);
    await attachPeerToCard({ peerId: p, managerUserId: ownerId, clientId: otherClientId }, ctx());
    expect((await outboxRow(held.outboxId)).status).toBe('cancelled');
  });
});

describe('the tray’s «same customer» is the ✅’s (ident fix F11)', () => {
  it('naming the client a WON lead became keeps that lead’s draft and its waiting reply — and the ✅ still lets it through', async () => {
    const p = PEERS[15]!;
    const won = await madeClient('AW', [`+99897${SUFFIX}44`]);
    const l = await lead(`Lid yutildi ${SUFFIX}`, `+99891${SUFFIX}77`, won);
    const ruleId = await ruleOn(p, { clientId: null, leadId: l });
    const { tgId } = await message(p, { clientId: null, leadId: l });
    const live = await draft(p, { anchorTgMessageId: tgId, clientId: null, leadId: l });
    const held = await waiting(p, 'agent', { clientId: null, leadId: l });
    await decideChat({ id: ruleId, decision: 'include', clientId: won }, ctx());
    expect((await draftRow(live)).status).toBe('pending');
    expect((await outboxRow(held.outboxId)).status).toBe('agent');
    expect(await decideDraft(actor(), live, 'send', {}, ctx())).toMatchObject({ ok: true, status: 'approved' });
  });

  it('…and so does re-picking a phone SIBLING of the bound code — one person, two codes (fit-12)', async () => {
    const p = PEERS[16]!;
    const shared = `+99897${SUFFIX}55`;
    const first = await madeClient('AS', [shared]);
    const sibling = await madeClient('AT', [shared]);
    const ruleId = await ruleOn(p, { clientId: first });
    const { tgId } = await message(p, { clientId: first });
    const live = await draft(p, { anchorTgMessageId: tgId, clientId: first });
    const held = await waiting(p, 'agent', { clientId: first });
    await decideChat({ id: ruleId, decision: 'include', clientId: sibling }, ctx());
    expect((await draftRow(live)).status).toBe('pending');
    expect((await outboxRow(held.outboxId)).status).toBe('agent');
  });
});

describe('a ✅ committing in the middle of a withdrawal is still caught (ident fix F3)', () => {
  /** Until a statement on agent_drafts waits on a row lock — through the POOL, never inside a transaction (round VED 2.0 phase 3). */
  async function aWaiterOnDrafts(): Promise<void> {
    for (let i = 0; i < 400; i += 1) {
      const [row] = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%agent_drafts%'`);
      if (Number(row?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('the withdrawal never waited on the approval');
  }

  /**
   * The approval's own two writes — the draft 'approved', its row queued — held
   * open in one transaction while `withdraw` runs, committed once the withdrawal
   * waits on the draft's lock: the interleaving a bot ✅ and a tray press make.
   */
  async function approvalMidWithdrawal(p: bigint, withdraw: () => Promise<unknown>): Promise<string> {
    const { tgId } = await message(p);
    const d = await draft(p, { anchorTgMessageId: tgId });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let outboxId = '';
    const holder = db.transaction(async (tx) => {
      await tx.update(agentDrafts).set({ status: 'approved', decidedBy: ownerId, decidedAt: new Date() }).where(eq(agentDrafts.id, d));
      msgSeq += 1n;
      const [o] = await tx
        .insert(agentOutbox)
        .values({
          draftId: d,
          managerUserId: ownerId,
          peerId: p,
          clientId,
          body: 'Ertalab javob.',
          randomId: BigInt(`7${SUFFIX}${String(msgSeq).padStart(6, '0')}`),
          answersTgMessageId: tgId,
          queuedBy: ownerId,
          nextStepAt: new Date(Date.now() + 6 * 3_600_000),
        })
        .returning({ id: agentOutbox.id });
      outboxId = o!.id;
      await gate;
    });
    while (!outboxId) await new Promise((resolve) => setTimeout(resolve, 10));
    const running = withdraw();
    await aWaiterOnDrafts();
    release();
    await holder;
    await running;
    return outboxId;
  }

  it('the bot’s ↩ (withdrawRepliesFor): the reply approved while it ran is cancelled, not sent with the old name', async () => {
    const p = PEERS[17]!;
    const outboxId = await approvalMidWithdrawal(p, () =>
      withdrawRepliesFor({ managerUserId: ownerId, peerId: p, clientId, leadId: null, why: 'identity_changed: test', note: '↩ test' }),
    );
    expect((await outboxRow(outboxId)).status).toBe('cancelled');
  });

  it('the tray’s doors (withdrawMovedReplies): the same', async () => {
    const p = PEERS[18]!;
    await ruleOn(p, { decision: 'pending', clientId: null });
    const outboxId = await approvalMidWithdrawal(p, () =>
      withdrawMovedReplies({ managerUserId: ownerId, peerId: p, why: 'identity_changed: test', note: '↩ test' }),
    );
    expect((await outboxRow(outboxId)).status).toBe('cancelled');
  });
});

async function answered(p: bigint, question: string, answer: string, over: Partial<typeof agentDrafts.$inferInsert> = {}): Promise<string> {
  return draft(p, { status: 'approved', decidedBy: ownerId, decidedAt: new Date(), needsOwner: true, ownerQuestion: question, finalBody: answer, ...over });
}

async function factOf(draftId: string) {
  const [fact] = await db.select().from(kbFacts).where(sql`${kbFacts.sourceRef}->>'draftId' = ${draftId}`);
  return fact;
}

describe('a fact is refused for a price it states — never for a word beside it (ident fix F7)', () => {
  it('👤: the model’s question with a price WORD costs him nothing — his answer is saved alone, and he is told so', async () => {
    const p = PEERS[19]!;
    const d = await answered(p, 'Mijoz narx so‘rayapti, nima deyay?', 'Ertaga 10 da VED hisoblab beradi.');
    const r = await agentPress(ownerId, 'u', d, undefined);
    expect(r.toast).toContain('Shu mijoz uchun saqlandi');
    expect(r.reply).toContain(QUESTION_DROPPED);
    expect(await factOf(d)).toMatchObject({ scope: 'client', question: null, answer: 'Ertaga 10 da VED hisoblab beradi.' });
  });

  it('…while an answer that states a price is still refused — naming the figure', async () => {
    const p = PEERS[20]!;
    const d = await answered(p, 'Qancha bo‘ladi?', 'Bu safar 250 dollar bo‘ladi.');
    const r = await agentPress(ownerId, 'u', d, undefined);
    expect(r.reply).toMatch(/^«250[^»]*» — narx\. Narx bilimga yozilmaydi/u);
    expect(await factOf(d)).toBeUndefined();
  });

  it('the page’s add form says which number it read as a price — and when only the question’s word made it one', async () => {
    await expect(
      addGeneralFact({ question: 'Narx qayerdan hisoblanadi?', answer: 'Yiwu qabul punktidan — Futian ko‘chasi 88' }, ctx()),
    ).rejects.toMatchObject({ code: 'money_context', detail: '88' });
    await expect(addGeneralFact({ question: null, answer: 'Yo‘lkira 250 dollar.' }, ctx())).rejects.toMatchObject({ code: 'money' });
  });
});

describe('📌 keeps a clean question — a subject-less answer is never served to every chat (ident fix F8)', () => {
  async function pin(d: string) {
    const ask = await agentPress(ownerId, 'g', d, undefined);
    const token = /:([0-9a-f]{8})$/u.exec(ask.buttons?.[0]?.[0]?.callback_data ?? '')?.[1];
    expect(token, 're-anchor: the 📌 yes button').toBeTruthy();
    return agentPress(ownerId, 'g', d, token);
  }

  it('a question with no figure, code, phone or name stays beside his «Ha, bo‘ladi»', async () => {
    // The client book holds «Aka» and «Jasur aka» as NAMES (two other files mint one; a real book has
    // them too). Minted here, so the answer does not hang on which file ran first: a form of address
    // names nobody, and his «aka» is no customer's name.
    const tag = `${Date.now().toString(36)}`.slice(-6).toUpperCase();
    const book = await db
      .insert(clients)
      .values([
        { clientCode: `AK${tag}`, name: 'Aka' },
        { clientCode: `AJ${tag}`, name: 'Jasur aka' },
      ])
      .returning({ id: clients.id });
    onTestFinished(async () => {
      await db.delete(clients).where(inArray(clients.id, book.map((b) => b.id)));
    });
    const whole = await knownNamesForMask(false);
    expect(whole).not.toContain('Aka');
    expect(whole).toContain('Jasur aka');
    const parts = await knownNamesForMask(true);
    expect(parts).toContain('Jasur');
    expect(parts.map((n) => n.toLowerCase())).not.toContain('aka');
    const p = PEERS[21]!;
    const d = await answered(p, 'Kartaga to‘lasa bo‘ladimi?', 'Ha, bo‘ladi aka.');
    const yes = await pin(d);
    expect(yes.toast).toContain('Umumiy qoida saqlandi');
    expect(yes.reply).toBeUndefined();
    expect(await factOf(d)).toMatchObject({ scope: 'general', question: 'Kartaga to‘lasa bo‘ladimi?', answer: 'Ha, bo‘ladi aka.' });
  });

  it('…one naming this customer goes, and he is told the fact went in without it', async () => {
    const p = PEERS[22]!;
    const d = await answered(p, 'Saidaxon opa kartaga to‘lasa bo‘ladimi?', 'Ha, kartaga ham bo‘ladi.', { clientId: otherClientId });
    const yes = await pin(d);
    expect(yes.reply).toContain(QUESTION_DROPPED);
    expect(await factOf(d)).toMatchObject({ scope: 'general', question: null, answer: 'Ha, kartaga ham bo‘ladi.' });
  });
});

describe('🙋 says what it took back (ident fix F10)', () => {
  it('the press names the approved replies it cancelled — and how many were his own words; the page asks first', async () => {
    const p = PEERS[23]!;
    // `waiting` stores his ✏️ words as the body (`finalBody`): his own reply, held for the morning.
    const held = await waiting(p);
    const { tgId } = await message(p, { body: '??' });
    const d2 = await draft(p, { anchorTgMessageId: tgId, finalBody: null, proposedBody: 'Ertalab aniqlab aytaman.' });
    expect((await webDrafts(actor())).pending.find((w) => w.id === d2)?.waitingInChat).toBe(1);
    const r = await agentPress(ownerId, 'h', d2, undefined);
    expect(r.toast).toBe('🙋 Suhbat 24 soat sizniki — 1 ta javob bekor qilindi');
    expect(r.reply).toContain('1 tasi — o‘zingiz yozgan matn');
    expect((await outboxRow(held.outboxId)).status).toBe('cancelled');
  });

  it('…and nothing more when nothing was waiting', async () => {
    const p = PEERS[26]!;
    const { tgId } = await message(p);
    const d = await draft(p, { anchorTgMessageId: tgId });
    expect((await webDrafts(actor())).pending.find((w) => w.id === d)?.waitingInChat).toBe(0);
    const r = await agentPress(ownerId, 'h', d, undefined);
    expect(r).toMatchObject({ toast: '🙋 Suhbat 24 soat sizniki' });
    expect(r.reply).toBeUndefined();
  });
});

describe('a calculation landing is ONE press’s (ident fix F12)', () => {
  it('a ✅ that meets another press landing the same job writes nothing and says so; a claim a dead press left is taken over', async () => {
    const p = PEERS[27]!;
    // Every job of his answered: the queue's cap is not this test's subject.
    await db
      .update(calcRequests)
      .set({ completedAt: new Date(), completedBy: vedId, completedVia: 'task' })
      .where(and(eq(calcRequests.requestedBy, ownerId), isNull(calcRequests.completedAt)));
    const d = await calcDraft(p);
    // Another press is between the intake note and the queue (decide `claimLanding`).
    await db.update(agentDrafts).set({ actionError: LANDING_CLAIM, updatedAt: new Date() }).where(eq(agentDrafts.id, d));
    expect(await decideDraft(actor(), d, 'send', {}, ctx())).toEqual({ ok: false, code: 'calc_in_flight' });
    expect(await db.select().from(calcRequests).where(eq(calcRequests.noteId, noteIdFor(d)))).toHaveLength(0);
    const inFlight = await draftRow(d);
    expect(inFlight).toMatchObject({ status: 'pending', actionError: LANDING_CLAIM });
    expect(renderDraftCard(inFlight, null)).toContain('⏳ Hisoblatish hozir navbatga qo‘yilmoqda');
    // That press died (a deploy): past the claim's window the next ✅ lands the job, once.
    await db.update(agentDrafts).set({ updatedAt: new Date(Date.now() - LANDING_STALE_MS - 60_000) }).where(eq(agentDrafts.id, d));
    expect(await decideDraft(actor(), d, 'send', {}, ctx())).toMatchObject({ ok: true, status: 'approved' });
    expect(await db.select().from(calcRequests).where(eq(calcRequests.noteId, noteIdFor(d)))).toHaveLength(1);
  });

  it('a refusal the next ✅ meets again points to 🙋 — never to ✏️, which keeps the calculation', async () => {
    for (const [p, code] of [[PEERS[28]!, 'too_many_items'], [PEERS[30]!, 'not_found']] as const) {
      const d = await draft(p, { actionStatus: 'failed', actionError: code });
      const card = renderDraftCard(await draftRow(d), null);
      expect(card).toContain('🙋 bosing');
      expect(card).not.toContain('✏️ bilan');
    }
  });
});

describe('what the agent’s runs may say, its owner may read (ident fix F13)', () => {
  const seller = () => ({ id: sellerId, roles: ['sales_manager'] as const, permissions: new Set<string>(['crm.leads']) });

  it('a per-customer fact another account taught is listed to the CURRENT owner — and he may correct or retire it', async () => {
    const p = PEERS[29]!;
    const mine = await draft(p);
    const fact = await writeKbFact(
      { scope: 'client', clientId, question: null, answer: `Faqat ertalab qo‘ng‘iroq qiling ${SUFFIX}.`, sourceRef: { draftId: mine } },
      ctx(),
    );
    expect((await webKbFacts(seller())).facts.map((f) => f.id)).not.toContain(fact);
    // The super_admin moved the agent to the seller's account: his runs are served this fact by its client (kbSearch).
    await db.update(agentConfig).set({ ownerUserId: sellerId }).where(eq(agentConfig.id, 1));
    try {
      expect((await webKbFacts(seller())).facts.map((f) => f.id)).toContain(fact);
      await expect(assertFactSeen(seller(), fact)).resolves.toBeUndefined();
      // …the drafts of the chat it came from stay the other account's.
      expect([...(await webDrafts(seller())).pending].map((d) => d.id)).not.toContain(mine);
    } finally {
      await db.update(agentConfig).set({ ownerUserId: ownerId }).where(eq(agentConfig.id, 1));
    }
  });
});
