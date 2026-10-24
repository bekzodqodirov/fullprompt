import 'dotenv/config';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The landing hands the AI VED pass to pg-boss, and nothing here asks the
// queue itself — so it is stood in for and records what was sent.
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
  calcGroups,
  calcOffers,
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  dealLines,
  deals,
  dealStages,
  events,
  notifications,
  roles,
  tasks,
  tgAccountGuard,
  tgAccounts,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { announceAgentCalc, handleHandBack, priceDraftFromText } from '@/modules/wms/agent/calc-loop';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { decideDraft, noteIdFor } from '@/modules/wms/agent/decide';
import { priceReplyText } from '@/modules/wms/agent/price-reply';
import { JOB_AGENT_HAND_BACK } from '@/modules/wms/agent/queues';
import { handleInbound, runOwnerTriggered } from '@/modules/wms/agent/run';
import { RAIL_OWNER_QUESTION } from '@/modules/wms/agent/worthy';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

/**
 * His answers of 2026-10-24 (docs/AI-SOTUVCHI.md §17.14), against a real
 * database: «💵 Narx yozaman» writes the customer's sentence and nothing on
 * the deal (6 b); avia is quoted from his rate and hedged like the truck;
 * rail is always his question; every agent calculation lands with the
 * company's certificate, on the zone the customer named, and with all of
 * its actions run; a VED hand-back is queued, and an owner-triggered run
 * asks the chat's own rules first.
 *
 * The model is SCRIPTED (CI has no key). agent_config and the CRM send switch
 * are CONFIGURATION on the one shared database (#183): snapshotted, restored.
 * Fixture people are deactivated, never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const PEER = BigInt(`76${SUFFIX}`);
let ownerId = '';
let vedId = '';
let accountId = '';
let clientId = '';
let snapshot: AgentConfig | null = null;
let sendingBefore = false;
let msgSeq = 5000n;
const madeDeals: string[] = [];
const madeRequests: string[] = [];

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99894${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

async function inbound(body: string, agoMs = 60_000): Promise<bigint> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({
    clientId,
    managerUserId: ownerId,
    peerId: PEER,
    tgMessageId: msgSeq,
    direction: 'in',
    body,
    sentAt: new Date(Date.now() - agoMs),
  });
  return msgSeq;
}

const job = (anchor: bigint) => ({
  managerUserId: ownerId,
  peerId: String(PEER),
  anchorTgMessageId: String(anchor),
  origin: 'live' as const,
});

function scripted(steps: { name: string; input: Record<string, unknown> }[]): CallModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let i = 0;
  const fn = (async (req: ModelRequest): Promise<ModelResponse> => {
    requests.push(req);
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    return {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: `t${i}`, name: step.name, input: step.input }],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }) as CallModel & { requests: ModelRequest[] };
  fn.requests = requests;
  return fn;
}

function compose(text: string, extra: Record<string, unknown> = {}) {
  return {
    name: 'compose_reply',
    input: {
      reply_needed: true,
      reply_text: text,
      language: 'uz',
      gloss_uz: '',
      category: 'price',
      confidence: 0.8,
      needs_owner: false,
      owner_question: '',
      next_step: 'quote',
      actions: [],
      used_fact_ids: [],
      cited_message_refs: [],
      ...extra,
    },
  };
}

const actor = () => ({ id: ownerId, roles: ['super_admin'], permissions: new Set<string>(['crm.leads.view_all']) });
const ctx = () => ({ actorId: ownerId });

async function liveDraft() {
  const [d] = await db
    .select()
    .from(agentDrafts)
    .where(and(eq(agentDrafts.managerUserId, ownerId), eq(agentDrafts.peerId, PEER), inArray(agentDrafts.status, ['pending', 'editing'])));
  return d ?? null;
}

async function cardDigestOf(draftId: string): Promise<string> {
  const [row] = await db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
  return (row!.payload as { digest: string }).digest;
}

/** A deal of the fixture client and a request on it, linked to the chat — the shape `decideDraft` leaves. */
async function linkedRequest(over: Partial<typeof calcRequests.$inferInsert> = {}) {
  const [stage] = await db.select({ id: dealStages.id }).from(dealStages).orderBy(asc(dealStages.sortOrder)).limit(1);
  const [deal] = await db
    .insert(deals)
    .values({ code: `AI-${SUFFIX}-${madeDeals.length + 1}`, clientId, stageId: stage!.id, createdBy: ownerId })
    .returning();
  madeDeals.push(deal!.id);
  const [req] = await db
    .insert(calcRequests)
    .values({
      entityType: 'deal',
      entityId: deal!.id,
      requestedBy: ownerId,
      itemCount: 1,
      section: 'podklyuch',
      dueAt: new Date(Date.now() + 3_600_000),
      ...over,
    })
    .returning({ id: calcRequests.id });
  madeRequests.push(req!.id);
  await db.insert(agentCalcLinks).values({ requestId: req!.id, rootRequestId: req!.id, managerUserId: ownerId, peerId: PEER });
  return { deal: deal!, requestId: req!.id };
}

async function clearChat() {
  await db.delete(agentCalcLinks).where(eq(agentCalcLinks.peerId, PEER));
  await db.delete(agentOutbox).where(eq(agentOutbox.peerId, PEER));
  await db.delete(agentDrafts).where(eq(agentDrafts.peerId, PEER));
  await db.delete(agentRuns).where(eq(agentRuns.peerId, PEER));
  await db.delete(agentConversations).where(eq(agentConversations.peerId, PEER));
  await db.delete(tgMessages).where(eq(tgMessages.peerId, PEER));
  await db.delete(notifications).where(and(eq(notifications.userId, ownerId), sql`${notifications.type} LIKE 'Agent%'`));
  queued.length = 0;
}

beforeAll(async () => {
  snapshot = await readAgentConfig();
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  ownerId = await makeUser(`AI javoblar ${SUFFIX}`, 'super_admin', '01');
  vedId = await makeUser(`VED javoblar ${SUFFIX}`, 'ved_manager', '02');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: ownerId, tgPhone: `+99892${SUFFIX}76`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date() })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `AJ${SUFFIX}`, name: `Javob Mijoz ${SUFFIX}`, phones: [`+99897${SUFFIX}88`], salesManagerId: ownerId })
    .returning({ id: clients.id });
  clientId = c!.id;
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
      aviaUsdPerKg: '17.00',
    })
    .where(eq(agentConfig.id, 1));
  await setSetting('tg_sending_enabled', true, ownerId);
});

beforeEach(async () => {
  await clearChat();
  await stampAgentPump(accountId, true);
});

afterAll(async () => {
  await clearChat();
  // What the landings left: their requests, tasks, the deal they opened, its notes.
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
  const dealIds = [
    ...new Set([...madeDeals, ...(await db.select({ id: deals.id }).from(deals).where(eq(deals.clientId, clientId))).map((d) => d.id)]),
  ];
  if (dealIds.length) {
    await db.delete(calcOffers).where(inArray(calcOffers.entityId, dealIds));
    await db.delete(events).where(inArray(events.entityId, dealIds));
    await db.delete(crmActivities).where(and(eq(crmActivities.entityType, 'deal'), inArray(crmActivities.entityId, dealIds)));
    await db.delete(dealLines).where(inArray(dealLines.dealId, dealIds));
    await db.delete(deals).where(inArray(deals.id, dealIds));
  }
  await db.delete(notifications).where(inArray(notifications.userId, [ownerId, vedId]));
  await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(events).where(eq(events.entityId, clientId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await __restoreAgentConfig(snapshot);
  await setSetting('tg_sending_enabled', sendingBefore, ownerId);
  await db.update(users).set({ active: false }).where(inArray(users.id, [ownerId, vedId]));
});

describe('«💵 Narx yozaman» — the price goes to the customer ONLY (his 6 b)', () => {
  it('drafts his figure as one sentence in the chat’s language and writes nothing on the deal', async () => {
    // A request the VED answered with «Готово» — exactly where the old door
    // recorded an offer and wrote the client price onto the card.
    const { deal, requestId } = await linkedRequest({
      completedAt: new Date(),
      completedBy: vedId,
      completedVia: 'task',
      answerAmount: '900.00',
      answerCurrency: 'USD',
    });
    await inbound('Narxi qancha bo‘ladi?');
    await db.insert(agentConversations).values({ managerUserId: ownerId, peerId: PEER, locale: 'ru' });
    const [offersBefore] = await db.select({ n: sql<number>`count(*)::int` }).from(calcOffers).where(eq(calcOffers.entityId, deal.id));

    const r = await priceDraftFromText(ownerId, requestId, '1250');
    expect(r).toMatchObject({ ok: true });
    const d = await liveDraft();
    expect(d).toMatchObject({ kind: 'price', offerId: null, language: 'ru', blocked: false });
    expect(d!.proposedBody).toBe(priceReplyText('ru', 'podklyuch', 1250));
    expect(d!.proposedBody).toContain('1 250');
    const sources = (d!.policy as { memory: { sources: { value: number; kind: string; label: string }[] } }).memory.sources;
    expect(sources).toEqual([{ value: 1250, kind: 'money', label: 'sizning narxingiz' }]);

    // Nothing on the deal: no offer row, the card's price untouched.
    const [offersAfter] = await db.select({ n: sql<number>`count(*)::int` }).from(calcOffers).where(eq(calcOffers.entityId, deal.id));
    expect(offersAfter!.n).toBe(offersBefore!.n);
    const [after] = await db.select().from(deals).where(eq(deals.id, deal.id));
    expect(after!.quotedAmount).toBe(deal.quotedAmount);
    expect(after!.updatedAt.getTime()).toBe(deal.updatedAt.getTime());
  });

  it('works on an AI-VED «taxmin» card too — a request with no seal and no answer', async () => {
    const { requestId } = await linkedRequest();
    await inbound('Qancha?');
    const r = await priceDraftFromText(ownerId, requestId, '1 300.50');
    expect(r).toMatchObject({ ok: true });
    expect((await liveDraft())!.proposedBody).toBe(priceReplyText('uz', 'podklyuch', 1300.5));
  });

  it('refuses before anything is written — his own reply to this chat is being typed', async () => {
    const { requestId } = await linkedRequest();
    const anchor = await inbound('Qancha?');
    const [editing] = await db
      .insert(agentDrafts)
      .values({ managerUserId: ownerId, peerId: PEER, clientId, anchorTgMessageId: anchor, proposedBody: 'x', status: 'editing' })
      .returning({ id: agentDrafts.id });
    const r = await priceDraftFromText(ownerId, requestId, '1250');
    expect(r).toMatchObject({ ok: false, code: 'refused' });
    expect((r as { detail?: string }).detail).toContain('yozayotgan');
    const rows = await db.select().from(agentDrafts).where(eq(agentDrafts.peerId, PEER));
    expect(rows.map((x) => x.id)).toEqual([editing!.id]);
    // A figure he did not type — more than cents — is not his price either.
    expect(await priceDraftFromText(ownerId, requestId, '12.345')).toEqual({ ok: false, code: 'bad_number' });
  });
});

describe('avia — his rate × the customer’s kilos, hedged like the truck', () => {
  it('a hedged avia figure is a sendable draft; the same figure unhedged is blocked (G11)', async () => {
    const a = await inbound('Guanchjoudan avia bilan 40 kg yuk bor, narxi qancha?');
    const out = await handleInbound(job(a), {
      callModel: scripted([
        { name: 'avia_estimate', input: { weight_ref: 'w1' } },
        compose('Avia bilan taxminan 680 $ bo‘ladi, yetib borishi 2-5 kun. Boj va QQS alohida hisoblanadi.'),
      ]),
    });
    expect(out).toMatchObject({ outcome: 'draft', blocked: false });

    const b = await inbound('Yana 40 kg avia bilan?');
    const bare = await handleInbound(job(b), {
      callModel: scripted([{ name: 'avia_estimate', input: { weight_ref: 'w1' } }, compose('Avia 680 $.')]),
    });
    expect(bare).toMatchObject({ outcome: 'draft', blocked: true });
    const d = await liveDraft();
    expect((d!.policy as { blocks: { code: string }[] }).blocks.map((x) => x.code)).toContain('estimate_unhedged');
  });
});

describe('rail is his question (his «Temir yo‘l mendan so‘rasin»)', () => {
  it('a burst about rail is forced to needs_owner with his question, whatever the model said', async () => {
    const a = await inbound("Temir yo'l bilan 20 tonna yuborsak qancha bo'ladi?");
    const out = await handleInbound(job(a), { callModel: scripted([compose('Aniqlab aytaman.')]) });
    expect(out).toMatchObject({ outcome: 'draft' });
    const d = await liveDraft();
    expect(d).toMatchObject({ needsOwner: true, ownerQuestion: RAIL_OWNER_QUESTION });
  });
});

describe('an agent calculation lands like a seller’s — every action, the company’s certificate, the named zone', () => {
  it('✅ lands the job with has_certificate, on Kashgar’s zone, and runs the follow-up and the mute too', async () => {
    const a = await inbound('Qashqardan Toshkentga podklyuch kerak: 3 kub 500 kg, kurtka 100 dona');
    const tomorrow = tashkentDay(new Date(Date.now() + 86_400_000));
    const out = await handleInbound(job(a), {
      callModel: scripted([
        { name: 'calc_checklist', input: { section: 'podklyuch', goods: [{ name: 'kurtka', quantity: 100, weight_kg: null }] } },
        compose('Hisoblatishga yubordim, javob kelishi bilan aytaman.', {
          category: 'qualification',
          next_step: 'calc',
          actions: [
            { type: 'calc_submit', section: 'podklyuch', cited_message_refs: ['#1'], date: '', note: '' },
            { type: 'set_followup', section: '', cited_message_refs: [], date: tomorrow, note: 'javobni aytish' },
            { type: 'mute', section: '', cited_message_refs: [], date: '', note: 'test' },
          ],
        }),
      ]),
    });
    expect(out).toMatchObject({ outcome: 'draft', blocked: false });
    const d = await liveDraft();
    const actions = d!.actions as { type: string; certificate?: unknown }[];
    expect(actions.map((x) => x.type)).toEqual(['calc_submit', 'set_followup', 'mute']);
    expect(actions[0]!.certificate).toBeNull();

    const r = await decideDraft(actor(), d!.id, 'send', { digest: await cardDigestOf(d!.id) }, ctx());
    expect(r).toMatchObject({ ok: true, status: 'approved' });
    const [req] = await db.select().from(calcRequests).where(eq(calcRequests.noteId, noteIdFor(d!.id)));
    expect(req).toMatchObject({ hasCertificate: true, freightZone: 'kashgar' });
    const [note] = await db.select({ note: crmActivities.note }).from(crmActivities).where(eq(crmActivities.id, noteIdFor(d!.id)));
    expect(note!.note).toContain("Kelib chiqish sertifikati: kompaniya o'zi oladi");

    // Every action ran, and only then is it 'done' (A10).
    const [after] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, d!.id));
    expect(after!.actionStatus).toBe('done');
    const [conv] = await db.select().from(agentConversations).where(and(eq(agentConversations.managerUserId, ownerId), eq(agentConversations.peerId, PEER)));
    expect(conv!.mutedAt).not.toBeNull();
    const [client] = await db.select({ next: clients.nextActionAt }).from(clients).where(eq(clients.id, clientId));
    expect(String(client!.next)).toBe(tomorrow);
  });
});

describe('a VED hand-back — queued off the VED’s button, and the chat’s own rules first', () => {
  it('«Qaytarish» queues the run (retryLimit 0) instead of waiting on the model', async () => {
    const { requestId } = await linkedRequest();
    const sent: { name: string; data: unknown; options: unknown }[] = [];
    const ok = await announceAgentCalc(requestId, 'returned', { reason: 'Tovar nomi yetarli emas' }, {
      enqueue: async (name, data, options) => {
        sent.push({ name, data, options });
      },
    });
    expect(ok).toBe(true);
    expect(sent).toEqual([
      {
        name: JOB_AGENT_HAND_BACK,
        data: { managerUserId: ownerId, peerId: String(PEER), requestId, reason: 'Tovar nomi yetarli emas' },
        options: { retryLimit: 0 },
      },
    ]);
    // Nothing ran under the press.
    expect(await db.select().from(agentRuns).where(eq(agentRuns.peerId, PEER))).toHaveLength(0);

    // …and the worker's side drafts the customer's question, once.
    await inbound('Hisob qachon bo‘ladi?');
    const model = scripted([compose('Tovaringiz nomini aniqroq yozib bera olasizmi?', { category: 'qualification' })]);
    const out = await handleHandBack(sent[0]!.data as never, { callModel: model });
    expect(out).toMatchObject({ outcome: 'draft' });
    expect((await liveDraft())!.kind).toBe('hand_back');
    expect(await handleHandBack(sent[0]!.data as never, { callModel: model })).toMatchObject({ outcome: 'stood_down', reason: 'duplicate' });
  });

  it('a chat he took with 🙋 gets no hand-back draft — refused and recorded', async () => {
    await inbound('Hisob qachon bo‘ladi?');
    await db
      .insert(agentConversations)
      .values({ managerUserId: ownerId, peerId: PEER, humanUntil: new Date(Date.now() + 3_600_000) });
    const model = scripted([compose('Aniqlab aytaman.')]);
    const out = await runOwnerTriggered(
      { trigger: 'hand_back', managerUserId: ownerId, peerId: PEER, sourceKey: `${SUFFIX}:returned`, instruction: 'x' },
      { callModel: model },
    );
    expect(out).toEqual({ outcome: 'refused', reason: 'human_active' });
    expect(model.requests).toHaveLength(0);
    expect(await liveDraft()).toBeNull();
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.peerId, PEER));
    expect(runs.map((x) => ({ trigger: x.trigger, outcome: x.outcome, error: x.error }))).toEqual([
      { trigger: 'hand_back', outcome: 'refused', error: 'human_active' },
    ]);
  });
});
