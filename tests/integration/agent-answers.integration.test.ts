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
import { announceAgentCalc, handleHandBack, HAND_BACK_RETRY_S, priceDraftFromText } from '@/modules/wms/agent/calc-loop';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { priceRefusalText } from '@/modules/wms/agent/bot-door';
import { decideDraft, noteIdFor } from '@/modules/wms/agent/decide';
import { priceReplyText } from '@/modules/wms/agent/price-reply';
import { AGENT_LOCALES } from '@/modules/wms/agent/locale';
import { WAREHOUSE_SENTENCES } from '@/modules/wms/agent/policy';
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
    await inbound('Сколько это будет стоить?');
    await db.insert(agentConversations).values({ managerUserId: ownerId, peerId: PEER, locale: 'ru' });
    const [offersBefore] = await db.select({ n: sql<number>`count(*)::int` }).from(calcOffers).where(eq(calcOffers.entityId, deal.id));

    const r = await priceDraftFromText(ownerId, requestId, '1250');
    expect(r).toMatchObject({ ok: true });
    const d = await liveDraft();
    expect(d).toMatchObject({ kind: 'price', offerId: null, language: 'ru', blocked: false });
    expect(d!.proposedBody).toBe(priceReplyText('ru', 'podklyuch', 1250));
    expect(d!.proposedBody).toContain('1 250');
    const sources = (d!.policy as { memory: { sources: { value: number; kind: string; label: string }[] } }).memory.sources;
    expect(sources).toEqual([{ value: 1250, kind: 'money', label: 'sizning narxingiz', origin: 'tool' }]);

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
    expect(r).toEqual({ ok: false, code: 'editing_open' });
    const rows = await db.select().from(agentDrafts).where(eq(agentDrafts.peerId, PEER));
    expect(rows.map((x) => x.id)).toEqual([editing!.id]);
    // A figure he did not type — more than cents — is not his price either.
    expect(await priceDraftFromText(ownerId, requestId, '12.3456')).toEqual({ ok: false, code: 'bad_number' });
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
    const actions = d!.actions as { type: string; certificate?: unknown; fromOurWarehouse?: boolean }[];
    expect(actions.map((x) => x.type)).toEqual(['calc_submit', 'set_followup', 'mute']);
    // No certificate field at all (B8): the company obtains it, and nothing reads a choice.
    expect(actions[0]).not.toHaveProperty('certificate');
    // A named city with a warehouse of ours is priced as it always was (his third set «3»).
    expect(actions[0]!.fromOurWarehouse).toBe(false);

    const r = await decideDraft(actor(), d!.id, 'send', { digest: await cardDigestOf(d!.id) }, ctx());
    expect(r).toMatchObject({ ok: true, status: 'approved' });
    const [req] = await db.select().from(calcRequests).where(eq(calcRequests.noteId, noteIdFor(d!.id)));
    expect(req).toMatchObject({ hasCertificate: true, freightZone: 'kashgar' });
    const [note] = await db.select({ note: crmActivities.note }).from(crmActivities).where(eq(crmActivities.id, noteIdFor(d!.id)));
    expect(note!.note).toContain("Kelib chiqish sertifikati: kompaniya o'zi oladi");
    expect(note!.note).not.toContain('Xitoydagi omborimizdan');

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

// ---------------------------------------------------------------------------
// The review of this package (2026-10-24): what each finding looks like on a
// real database once fixed.

describe('«💵 Narx yozaman» after the review — the language it answers, and a figure he must say twice', () => {
  it('writes the price in the language of the message it answers, not the last run’s', async () => {
    const { requestId } = await linkedRequest();
    // The last run was Uzbek; the customer has since written in Russian.
    await db.insert(agentConversations).values({ managerUserId: ownerId, peerId: PEER, locale: 'uz' });
    await inbound('Сколько будет стоить доставка?');
    expect(await priceDraftFromText(ownerId, requestId, '1250')).toMatchObject({ ok: true });
    const d = await liveDraft();
    expect(d).toMatchObject({ language: 'ru' });
    expect(d!.proposedBody).toBe(priceReplyText('ru', 'podklyuch', 1250));
  });

  it('asks «1.250» back — 1250 or 1,25 — and writes nothing', async () => {
    const { requestId } = await linkedRequest();
    await inbound('Narxi qancha?');
    const r = await priceDraftFromText(ownerId, requestId, '1.250');
    expect(r).toEqual({ ok: false, code: 'ambiguous_number', readings: { thousands: 1250, decimal: '1,25' } });
    expect(priceRefusalText(r as never, '1.250')).toContain('1250 dollarmi yoki 1,25 dollarmi');
    expect(await liveDraft()).toBeNull();
  });
});

describe('a recalculation retires the 💵 typed on the price it replaces (review A1)', () => {
  it('a pending price draft on the old request is superseded and says why; a price on another job stays', async () => {
    const { requestId: priced } = await linkedRequest({ completedAt: new Date(), completedBy: vedId, completedVia: 'task', answerAmount: '900.00', answerCurrency: 'USD' });
    await inbound('Narxi qancha?');
    const r = await priceDraftFromText(ownerId, priced, '1250');
    expect(r).toMatchObject({ ok: true });
    const draftId = (r as { draftId: string }).draftId;
    expect((await liveDraft())!.policy).toMatchObject({ priceRequestId: priced });

    // A recalculation of ANOTHER chain of the same chat leaves it alone.
    const { requestId: other } = await linkedRequest();
    const [otherFix] = await db
      .insert(calcRequests)
      .values({ entityType: 'deal', entityId: madeDeals.at(-1)!, requestedBy: ownerId, itemCount: 1, section: 'yolkira', dueAt: new Date(), supersedesRequestId: other })
      .returning({ id: calcRequests.id });
    madeRequests.push(otherFix!.id);
    await announceAgentCalc(otherFix!.id, 'recalc');
    expect((await liveDraft())?.id).toBe(draftId);

    const [fix] = await db
      .insert(calcRequests)
      .values({ entityType: 'deal', entityId: madeDeals[madeDeals.length - 2]!, requestedBy: ownerId, itemCount: 1, section: 'podklyuch', dueAt: new Date(), supersedesRequestId: priced })
      .returning({ id: calcRequests.id });
    madeRequests.push(fix!.id);
    expect(await announceAgentCalc(fix!.id, 'recalc')).toBe(true);
    const [after] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
    expect(after).toMatchObject({ status: 'superseded' });
    expect(after!.policy).toMatchObject({ stale: 'recalc' });
    // …so the old card's ✅ is refused, never sent.
    expect(await decideDraft(actor(), draftId, 'send', {}, ctx())).toMatchObject({ ok: false, code: 'not_live' });
    expect(await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, draftId))).toHaveLength(0);
  });

  it('a price he already approved, still waiting to leave, is named on the recalculation message', async () => {
    const { requestId: priced, deal } = await linkedRequest({ completedAt: new Date(), completedBy: vedId, completedVia: 'task', answerAmount: '900.00', answerCurrency: 'USD' });
    await inbound('Narxi qancha?');
    const r = await priceDraftFromText(ownerId, priced, '1250');
    const draftId = (r as { draftId: string }).draftId;
    expect(await decideDraft(actor(), draftId, 'send', { digest: await cardDigestOf(draftId) }, ctx())).toMatchObject({ ok: true });
    const [fix] = await db
      .insert(calcRequests)
      .values({ entityType: 'deal', entityId: deal.id, requestedBy: ownerId, itemCount: 1, section: 'podklyuch', dueAt: new Date(), supersedesRequestId: priced })
      .returning({ id: calcRequests.id });
    madeRequests.push(fix!.id);
    await announceAgentCalc(fix!.id, 'recalc');
    const [ping] = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentCalcAnswered')))
      .orderBy(sql`${notifications.createdAt} DESC`)
      .limit(1);
    const text = (ping!.payload as { text: string }).text;
    expect(text).toContain('eski narx endi amal qilmaydi');
    expect(text).toContain('Siz bergan narx hali ketmagan');
    expect(text).toContain(priceReplyText('uz', 'podklyuch', 1250));
  });
});

describe('a hand-back that cannot draft now is tried again, or said (review A9)', () => {
  const handBack = (requestId: string, attempt?: number) => ({
    managerUserId: ownerId,
    peerId: String(PEER),
    requestId,
    reason: 'Tovar nomi yetarli emas',
    ...(attempt === undefined ? {} : { attempt }),
  });

  it('during a tg-listen rebuild: recorded without the key, queued once more — and the retry still drafts', async () => {
    const { requestId } = await linkedRequest();
    await inbound('Hisob qachon bo‘ladi?');
    await db.update(tgAccountGuard).set({ agentPumpAt: new Date(Date.now() - 10 * 60_000) }).where(eq(tgAccountGuard.accountId, accountId));
    const requeued: { job: unknown; after: number }[] = [];
    const model = scripted([compose('Tovaringiz nomini aniqroq yozib bera olasizmi?', { category: 'qualification' })]);
    const requeue = async (job: unknown, after: number) => {
      requeued.push({ job, after });
    };
    const first = await handleHandBack(handBack(requestId), { callModel: model, requeue });
    expect(first).toEqual({ outcome: 'refused', reason: 'listener_behind' });
    expect(requeued).toEqual([{ job: handBack(requestId, 1), after: HAND_BACK_RETRY_S }]);
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.peerId, PEER));
    expect(row).toMatchObject({ outcome: 'refused', error: 'listener_behind', sourceKey: null });

    // The listener is back: the retry takes the key and drafts the question.
    await stampAgentPump(accountId, true);
    const second = await handleHandBack(handBack(requestId, 1), { callModel: model, requeue });
    expect(second).toMatchObject({ outcome: 'draft' });
    expect((await liveDraft())!.kind).toBe('hand_back');
    expect(requeued).toHaveLength(1);
  });

  it('a refusal that does not pass by itself — or a retry that is refused again — tells him in words, once', async () => {
    const { requestId } = await linkedRequest();
    await inbound('Hisob qachon bo‘ladi?');
    await db.insert(agentConversations).values({ managerUserId: ownerId, peerId: PEER, humanUntil: new Date(Date.now() + 3_600_000) });
    const requeued: unknown[] = [];
    const out = await handleHandBack(handBack(requestId), {
      callModel: scripted([compose('x')]),
      requeue: async (job) => {
        requeued.push(job);
      },
    });
    expect(out).toEqual({ outcome: 'refused', reason: 'human_active' });
    expect(requeued).toEqual([]);
    const pings = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentCalcAnswered')));
    const texts = pings.map((p) => (p.payload as { text: string }).text);
    expect(texts.filter((t) => t.startsWith('🔁 AI mijozga savol yozmadi'))).toHaveLength(1);
    expect(texts.join('\n')).toContain("Sabab: bu chatda o'zingiz yozayapsiz.");
    expect(texts.join('\n')).toContain('VED sababi: Tovar nomi yetarli emas');

    // The retry of a deploy-minute refusal that meets the listener still behind: said, not queued again.
    await db.delete(agentConversations).where(eq(agentConversations.peerId, PEER));
    await db.update(tgAccountGuard).set({ agentPumpAt: new Date(Date.now() - 10 * 60_000) }).where(eq(tgAccountGuard.accountId, accountId));
    const { requestId: second } = await linkedRequest();
    await handleHandBack(handBack(second, 1), { callModel: scripted([compose('x')]), requeue: async (job) => { requeued.push(job); } });
    expect(requeued).toEqual([]);
  });

  it('a hand-back about rail is his question too, and carries no machine figure (review A4)', async () => {
    await inbound("Temir yo'l bilan 40 kg yuborsak qancha bo'ladi?");
    const out = await runOwnerTriggered(
      { trigger: 'hand_back', managerUserId: ownerId, peerId: PEER, sourceKey: `${SUFFIX}:rail`, instruction: 'x' },
      {
        callModel: scripted([
          { name: 'avia_estimate', input: { weight_ref: 'w1' } },
          compose('Taxminan 680 $ bo‘ladi. Boj va QQS alohida hisoblanadi.'),
        ]),
      },
    );
    expect(out).toMatchObject({ outcome: 'draft', blocked: true });
    const d = await liveDraft();
    expect(d).toMatchObject({ needsOwner: true, ownerQuestion: RAIL_OWNER_QUESTION });
    expect((d!.policy as { blocks: { code: string }[] }).blocks.map((b) => b.code)).toContain('number_unsourced');
  });
});

// ---------------------------------------------------------------------------
// His third set (2026-10-24, §17.14 «3»): a customer who names only China, or
// a Chinese place we have no warehouse in, is quoted from OUR warehouses.

describe('«from China» is priced from our China warehouses, and the reply says so (his third set «3»)', () => {
  const condition = 'Bu narx yukni Xitoydagi omborimizga yuborsangiz, omborimizdan hisoblanadi.';
  const factory = 'Zavoddan omborimizgacha olib kelish alohida hisoblanadi.';

  it('the website figure on the China column, blocked until both sentences are in the reply', async () => {
    const a = await inbound("Xitoydan Toshkentga 5 kub 1000 kg yuk bor, yo'lkira qancha bo'ladi?");
    const model = scripted([
      { name: 'yolkira_estimate', input: { weight_ref: 'w1', volume_ref: 'v1' } },
      compose("Yo'lkira taxminan 800 $ bo'ladi. Boj va QQS alohida hisoblanadi."),
    ]);
    const bare = await handleInbound(job(a), { callModel: model });
    expect(bare).toMatchObject({ outcome: 'draft', blocked: true });
    // The tool hands the model both sentences in every language it may answer in — a Persian, Chinese or
    // Uzbek Cyrillic reply had to invent its own words before, against a check that asks for exact ones.
    const toolText = model.requests[1]!.messages
      .flatMap((m) => m.content)
      .find((x): x is { type: 'tool_result'; tool_use_id: string; content: string } => x.type === 'tool_result')!.content;
    for (const l of AGENT_LOCALES) {
      expect(toolText, l).toContain(WAREHOUSE_SENTENCES[l].condition);
      expect(toolText, l).toContain(WAREHOUSE_SENTENCES[l].factory);
    }
    const d = await liveDraft();
    expect((d!.policy as { blocks: { code: string }[] }).blocks.map((x) => x.code)).toEqual(['warehouse_condition']);
    expect((d!.policy as { memory: { fromOurWarehouse?: boolean } }).memory.fromOurWarehouse).toBe(true);

    const b = await inbound('Xitoydan 5 kub 1000 kg, narxi qancha?');
    const said = await handleInbound(job(b), {
      callModel: scripted([
        { name: 'yolkira_estimate', input: { weight_ref: 'w1', volume_ref: 'v1' } },
        compose(`Yo'lkira taxminan 800 $ bo'ladi. Boj va QQS alohida hisoblanadi. ${condition} ${factory}`),
      ]),
    });
    expect(said).toMatchObject({ outcome: 'draft', blocked: false });
  });

  it('a city one of our warehouses stands in is quoted as it always was — no condition asked', async () => {
    const a = await inbound("Yiwudan Toshkentga 5 kub 1000 kg yuk bor, yo'lkira qancha bo'ladi?");
    const out = await handleInbound(job(a), {
      callModel: scripted([
        { name: 'yolkira_estimate', input: { weight_ref: 'w1', volume_ref: 'v1' } },
        compose("Yo'lkira taxminan 800 $ bo'ladi. Boj va QQS alohida hisoblanadi."),
      ]),
    });
    expect(out).toMatchObject({ outcome: 'draft', blocked: false });
  });

  it('a podklyuch job from China lands on the China column and its note says the factory leg is extra', async () => {
    const a = await inbound('Xitoydan Toshkentga podklyuch kerak: 3 kub 500 kg, kurtka 100 dona');
    const out = await handleInbound(job(a), {
      callModel: scripted([
        { name: 'calc_checklist', input: { section: 'podklyuch', goods: [{ name: 'kurtka', quantity: 100, weight_kg: null }] } },
        compose('Hisoblatishga yubordim, javob kelishi bilan aytaman.', {
          category: 'qualification',
          next_step: 'calc',
          actions: [{ type: 'calc_submit', section: 'podklyuch', cited_message_refs: ['#1'], date: '', note: '' }],
        }),
      ]),
    });
    expect(out).toMatchObject({ outcome: 'draft', blocked: false });
    const d = await liveDraft();
    expect((d!.actions as { fromOurWarehouse?: boolean }[])[0]!.fromOurWarehouse).toBe(true);
    expect(await decideDraft(actor(), d!.id, 'send', { digest: await cardDigestOf(d!.id) }, ctx())).toMatchObject({ ok: true });
    const [req] = await db.select().from(calcRequests).where(eq(calcRequests.noteId, noteIdFor(d!.id)));
    expect(req).toMatchObject({ freightZone: 'cn', fromCity: 'Xitoy' });
    const [note] = await db.select({ note: crmActivities.note }).from(crmActivities).where(eq(crmActivities.id, noteIdFor(d!.id)));
    expect(note!.note).toContain('Narx Xitoydagi omborimizdan; zavoddan omborgacha olib kelish alohida.');

    // …and his 💵 on that job's answer tells the customer the same two things
    // with his figure (a job sent from Yiwu, or with no draft behind it, does
    // not — the «💵 Narx yozaman» tests above pin the bare sentence).
    const priced = await priceDraftFromText(ownerId, req!.id, '1250');
    expect(priced).toMatchObject({ ok: true });
    const [pd] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, (priced as { draftId: string }).draftId));
    expect(pd!.proposedBody).toContain(WAREHOUSE_SENTENCES.uz.condition);
    expect(pd!.proposedBody).toContain(WAREHOUSE_SENTENCES.uz.factory);
    expect(pd!.proposedBody!.startsWith(priceReplyText('uz', 'podklyuch', 1250))).toBe(true);
  });

  it('…and so does one from a Chinese city we have no warehouse in — Dongguan, which read as «not said» (fix round)', async () => {
    const a = await inbound('Dongguandan Toshkentga podklyuch kerak: 3 kub 500 kg, kurtka 100 dona');
    const out = await handleInbound(job(a), {
      callModel: scripted([
        { name: 'calc_checklist', input: { section: 'podklyuch', goods: [{ name: 'kurtka', quantity: 100, weight_kg: null }] } },
        compose('Hisoblatishga yubordim, javob kelishi bilan aytaman.', {
          category: 'qualification',
          next_step: 'calc',
          actions: [{ type: 'calc_submit', section: 'podklyuch', cited_message_refs: ['#1'], date: '', note: '' }],
        }),
      ]),
    });
    expect(out).toMatchObject({ outcome: 'draft', blocked: false });
    const d = await liveDraft();
    expect((d!.actions as { fromOurWarehouse?: boolean }[])[0]!.fromOurWarehouse).toBe(true);
    expect(await decideDraft(actor(), d!.id, 'send', { digest: await cardDigestOf(d!.id) }, ctx())).toMatchObject({ ok: true });
    const [req] = await db.select().from(calcRequests).where(eq(calcRequests.noteId, noteIdFor(d!.id)));
    expect(req).toMatchObject({ freightZone: 'cn', fromCity: 'Dongguan' });
    const [note] = await db.select({ note: crmActivities.note }).from(crmActivities).where(eq(crmActivities.id, noteIdFor(d!.id)));
    expect(note!.note).toContain('Narx Xitoydagi omborimizdan; zavoddan omborgacha olib kelish alohida.');
  });
});

describe('a day count is the time of the road the customer asked about (fix round)', () => {
  it('«mashinada 5 kunda kelsinmi?» is not answered on the avia tool’s five — at the write, and the memory says why', async () => {
    const a = await inbound('40 kg yuk bor, mashinada 5 kunda kelsinmi?');
    const out = await handleInbound(job(a), {
      callModel: scripted([{ name: 'avia_estimate', input: { weight_ref: 'w1' } }, compose('Odatda 5 kunda yetib keladi.')]),
    });
    expect(out).toMatchObject({ outcome: 'draft', blocked: true });
    const d = await liveDraft();
    const policy = d!.policy as { blocks: { code: string; detail?: string }[]; memory: { askedMode?: string | null } };
    expect(policy.blocks).toContainEqual(expect.objectContaining({ code: 'number_unsourced', detail: '5' }));
    expect(policy.memory.askedMode).toBe('road');
  });

  it('the website’s truck days are no flight’s: «Avia bilan … 15-25 kunda» on them is unsourced', async () => {
    const a = await inbound("Xitoydan Toshkentga 5 kub 1000 kg yuk bor, qancha kunda keladi?");
    const out = await handleInbound(job(a), {
      callModel: scripted([
        { name: 'yolkira_estimate', input: { weight_ref: 'w1', volume_ref: 'v1' } },
        compose('Avia bilan taxminan 15-25 kunda yetib boradi.'),
      ]),
    });
    expect(out).toMatchObject({ outcome: 'draft', blocked: true });
    const d = await liveDraft();
    const blocks = (d!.policy as { blocks: { code: string; detail?: string }[] }).blocks;
    expect(blocks).toContainEqual(expect.objectContaining({ code: 'number_unsourced', detail: '15' }));
  });

  it('…while the same five, asked about avia, is the flight’s and passes', async () => {
    const a = await inbound('40 kg yuk bor, avia bilan necha kunda keladi?');
    const out = await handleInbound(job(a), {
      callModel: scripted([{ name: 'avia_estimate', input: { weight_ref: 'w1' } }, compose('Odatda 2-5 kunda yetib boradi.')]),
    });
    expect(out).toMatchObject({ outcome: 'draft', blocked: false });
  });
});
