import 'dotenv/config';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** pg-boss is never started in this process: every job the code would queue is caught here. */
const queued = vi.hoisted(() => [] as { name: string; data: unknown; options: unknown }[]);
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (name: string, data: unknown, options: unknown) => {
    queued.push({ name, data, options });
  }),
}));

import type { CallModel, ModelRequest, ModelResponse } from '@/modules/platform/ai/model';
import { db } from '@/modules/platform/db/client';
import {
  agentAutoConfig,
  agentAutoVerdicts,
  agentCalcLinks,
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOffers,
  agentOutbox,
  agentRuns,
  auditLog,
  calcOffers,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  dealStages,
  deals,
  leadStages,
  leads,
  notifications,
  roles,
  settings,
  tgAccountGuard,
  tgAccounts,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { AGENT_SEAT_KEY } from '@/modules/platform/settings/agent-seat';
import { getSetting, setSetting, SETTINGS_AUDIT_ID } from '@/modules/platform/settings/service';
import { handleAfterSent } from '@/modules/wms/agent/after-sent';
import { pressDueAutos, readAutoConfig, __restoreAutoConfig, type AutoConfig } from '@/modules/wms/agent/auto-send';
import { announceAgentCalc, handleCalcAnswer, priceDraftFromText } from '@/modules/wms/agent/calc-loop';
import { calcPriceFor, MARKUP_CONFIRMED_KEY } from '@/modules/wms/agent/calc-price';
import { renderDraftCard } from '@/modules/wms/agent/card-io';
import { AgentConfigError, confirmCalcMarkup, readAgentConfig, setCalcMarkup, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { decideDraft } from '@/modules/wms/agent/decide';
import { draftOfferStands } from '@/modules/wms/agent/drafts';
import { agentRowById, applyAgentOutcome, sendFactsFor } from '@/modules/wms/agent/outbox-store';
import { handleInbound, CALC_PRICE_UNSAID } from '@/modules/wms/agent/run';
import { agentSendVerdict, liveHeadVerdict, runAgentStep, type AgentTelegram, type HeadMessage } from '@/modules/wms/agent/send-step';
import { AGENT_LIMITS } from '@/modules/wms/agent/limits';
import { isNudge } from '@/modules/wms/agent/worthy';
import { JOB_AGENT_CALC_ANSWER, type AgentCalcAnswerJob } from '@/modules/wms/agent/queues';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';
import { armWait, dropWait, flushWaitWrites, nowSec } from '@/modules/platform/telegram/waits';
import { tgErrorKind } from '@/modules/wms/crm/telegram-guard';

/**
 * «VED javobi → ustama bilan narx» against a real database (SPEC-P2-v2 §2, package P3): the price `calcPriceFor` makes
 * of a linked chain's answer or seal, the job the VED's answer queues (never a run inside the VED's request), the
 * machine's draft that quotes it through `calc_price` — the floor in no prompt part and no memory — pressed and sent
 * past our own «yubordim» (K1), and every way the price stops standing (a later seal, a newer answer, the clock, a
 * concession, a markup edit) at the press, at his ✅ and at the send step. His 💵 outranks the machine's.
 *
 * The model is SCRIPTED (CI has no key). The machine's clock is `T0`, a daytime instant in the past. CONFIGURATION is
 * the next file's input on the one shared database (#183): agent_config, agent_auto_config, the send switch and the
 * markup's three settings are snapshotted and put back in `finally`; the stage, leads, requests and chats this file
 * mints are removed. Fixture people are deactivated, never deleted.
 */

const SUFFIX = String(Date.now()).slice(-6);
let seq = BigInt(`84${SUFFIX}`) * 1000n;
const next = () => ++seq;
const peers: bigint[] = [];

function machineClock(): Date {
  const now = new Date(Date.now() - 20 * 60_000);
  const hour = (now.getUTCHours() + 5) % 24;
  if (hour >= 9 && hour < 20) return now;
  const t = new Date(now);
  t.setUTCHours(9, 0, 0, 0); // 14:00 Tashkent
  if (t.getTime() > now.getTime()) t.setUTCDate(t.getUTCDate() - 1);
  return t;
}
const T0 = machineClock();
const HOLD_MS = 120_000;
const DUE = new Date(T0.getTime() + HOLD_MS + 1_000);
const FOUR = ['greeting', 'qualification', 'faq', 'status'];
const DAY = 86_400_000;

let holderId = '';
let colleagueId = '';
let accountId = '';
let stageId = '';
let agentSnapshot: AgentConfig | null = null;
let autoSnapshot: AutoConfig | null = null;
let sendingBefore = false;
const SETTING_KEYS = ['agent_calc_markup_kind', 'agent_calc_markup_value', MARKUP_CONFIRMED_KEY, 'quote_valid_days', AGENT_SEAT_KEY];
const settingsBefore = new Map<string, unknown>();
const madeLeads: string[] = [];
const madeRequests: string[] = [];
const madeClients: string[] = [];

async function rawSetting(key: string): Promise<unknown> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return row ? row.value : null;
}

async function putSetting(key: string, value: unknown): Promise<void> {
  if (value === null) await db.delete(settings).where(eq(settings.key, key));
  else await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

async function markup(kind: 'percent' | 'fixed', value: string, confirmed: string | null = null) {
  await putSetting('agent_calc_markup_kind', kind);
  await putSetting('agent_calc_markup_value', value);
  await putSetting(MARKUP_CONFIRMED_KEY, confirmed);
}

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99895${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

async function freshLead(owner: string | null = holderId): Promise<string> {
  const [l] = await db
    .insert(leads)
    .values({ name: `P3 narx lid ${SUFFIX}-${madeLeads.length + 1}`, stageId, ownerId: owner })
    .returning({ id: leads.id });
  madeLeads.push(l!.id);
  return l!.id;
}

interface Chat {
  peer: bigint;
  leadId: string;
  anchor: bigint;
}

/** A lead chat: the customer's request line, `ago` before T0. */
async function chatOn(leadId: string, body = 'Rastamojka qancha bo‘ladi? Kurtka 100 dona.', ago = 60 * 60_000): Promise<Chat> {
  const peer = next();
  peers.push(peer);
  const anchor = next();
  await db.insert(tgMessages).values({ leadId, managerUserId: holderId, peerId: peer, tgMessageId: anchor, direction: 'in', body, sentAt: new Date(T0.getTime() - ago) });
  return { peer, leadId, anchor };
}

/** A request on a card — linked to the chat (the AI submitted it) or not (a seller's own job on the same card). */
async function request(card: string, section: string, link: Chat | null, opts: { supersedes?: string; requestedAt?: Date } = {}): Promise<string> {
  const [r] = await db
    .insert(calcRequests)
    .values({
      entityType: 'lead',
      entityId: card,
      requestedBy: holderId,
      itemCount: 1,
      section,
      dueAt: new Date(Date.now() + 3_600_000),
      supersedesRequestId: opts.supersedes ?? null,
      requestedAt: opts.requestedAt ?? new Date(T0.getTime() - 50 * 60_000),
    })
    .returning({ id: calcRequests.id });
  madeRequests.push(r!.id);
  if (link) await db.insert(agentCalcLinks).values({ requestId: r!.id, rootRequestId: opts.supersedes ?? r!.id, managerUserId: holderId, peerId: link.peer });
  return r!.id;
}

/** The AI's submitting reply «yubordim», SENT after the request line (a draft, its outbox row, its Telegram line). */
async function submitted(chat: Chat, requestId: string, opts: { sent?: boolean; fromOurWarehouse?: boolean } = {}): Promise<bigint> {
  const ours = next();
  const at = new Date(T0.getTime() - 40 * 60_000);
  await db.insert(tgMessages).values({ leadId: chat.leadId, managerUserId: holderId, peerId: chat.peer, tgMessageId: ours, direction: 'out', body: 'Hisoblatishga yubordim, javob kelishi bilan aytaman.', sentAt: at });
  const [d] = await db
    .insert(agentDrafts)
    .values({
      managerUserId: holderId,
      peerId: chat.peer,
      leadId: chat.leadId,
      anchorTgMessageId: chat.anchor,
      status: 'approved',
      kind: 'reply',
      proposedBody: 'Hisoblatishga yubordim, javob kelishi bilan aytaman.',
      actions: [{ type: 'calc_submit', section: 'rastamojka', facts: {}, fromOurWarehouse: opts.fromOurWarehouse === true, citedMessageIds: [] }],
    })
    .returning({ id: agentDrafts.id });
  await db.insert(agentOutbox).values({
    draftId: d!.id,
    managerUserId: holderId,
    peerId: chat.peer,
    leadId: chat.leadId,
    body: 'Hisoblatishga yubordim, javob kelishi bilan aytaman.',
    randomId: next(),
    answersTgMessageId: chat.anchor,
    status: opts.sent === false ? 'agent' : 'sent',
    step: 'send',
    nextStepAt: at,
    queuedBy: holderId,
    sentAt: opts.sent === false ? null : at,
    tgMessageId: opts.sent === false ? null : ours,
  });
  await db.update(agentCalcLinks).set({ draftId: d!.id }).where(eq(agentCalcLinks.requestId, requestId));
  return ours;
}

/** The VED's «Готово» answer, `ago` before now (completed). */
async function answered(requestId: string, amount: string, opts: { currency?: string; ago?: number } = {}) {
  await db
    .update(calcRequests)
    .set({ completedAt: new Date(Date.now() - (opts.ago ?? 30 * 60_000)), completedVia: 'task', answerAmount: amount, answerCurrency: opts.currency ?? 'USD' })
    .where(eq(calcRequests.id, requestId));
}

/** A seal (the request's version 1), the request closed by it. */
async function sealed(
  requestId: string,
  total: string,
  opts: { section?: string; validMs?: number; discount?: string; density?: string | null; bandOverrideMin?: string | null; at?: Date; customs?: string; freight?: string; extras?: string } = {},
): Promise<string> {
  const at = opts.at ?? new Date(Date.now() - 30 * 60_000);
  const [v] = await db
    .insert(calcVersions)
    .values({
      requestId,
      versionNo: 1,
      sealedAt: at,
      sealedBy: holderId,
      validUntil: new Date(Date.now() + (opts.validMs ?? 10 * DAY)),
      section: opts.section ?? 'rastamojka',
      totalUsd: total,
      customsUsd: opts.customs ?? '0',
      freightUsd: opts.freight ?? '0',
      extrasUsd: opts.extras ?? '0',
      discountUsd: opts.discount ?? '0',
      density: opts.density ?? null,
      bandOverrideMin: opts.bandOverrideMin ?? null,
    })
    .returning({ id: calcVersions.id });
  await db.update(calcRequests).set({ completedAt: at, completedVia: 'sealed', currentVersionNo: 1 }).where(eq(calcRequests.id, requestId));
  return v!.id;
}

/** The model, scripted: each step one tool call; every request it is sent is kept (the floor must be in none). */
function scripted(steps: { name: string; input: Record<string, unknown> }[], seen: ModelRequest[] = []): CallModel {
  let i = 0;
  return (async (req: ModelRequest): Promise<ModelResponse> => {
    seen.push(req);
    const step = steps[Math.min(i, steps.length - 1)]!;
    i += 1;
    return {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: `t${i}`, name: step.name, input: step.input }],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  }) as CallModel;
}

let replySeq = 0;
const letters = (n: number) => String(n).split('').map((d) => 'abcdefghij'[Number(d)]).join('');
/** Each reply worded apart — G10's same-text fuse warns from the fourth chat, and a warning refuses every machine press. */
const priceReply = (figure: string) => `Rastamojka narxi ${figure} $ bo‘ladi, ${letters(Number(SUFFIX))}${letters(++replySeq)}.`;

const compose = (text: string) => ({
  name: 'compose_reply',
  input: {
    reply_needed: true,
    reply_text: text,
    language: 'uz',
    gloss_uz: '',
    category: 'price',
    confidence: 0.9,
    needs_owner: false,
    owner_question: '',
    next_step: 'quote',
    actions: [],
    used_fact_ids: [],
    cited_message_refs: [],
  },
});

const PRICED = (figure: string) => [{ name: 'calc_price', input: {} }, compose(priceReply(figure))];

let cardSeq = 700;
/** His Telegram shows this draft's card since `at` — what the staff drain writes when it sends it. */
async function shown(draftId: string, at: Date) {
  cardSeq += 1;
  const merge = { tg: { chatId: 7_900_000_000 + Number(SUFFIX), messageId: cardSeq }, shown: { draftId, at: at.toISOString() } };
  await db
    .update(notifications)
    .set({ status: 'sent', sentAt: at, payload: sql`${notifications.payload} || ${JSON.stringify(merge)}::jsonb` })
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
}

const draftOf = async (id: string) => (await db.select().from(agentDrafts).where(eq(agentDrafts.id, id)))[0]!;
const verdictOf = async (id: string) => (await db.select().from(agentAutoVerdicts).where(eq(agentAutoVerdicts.draftId, id)))[0] ?? null;
const outboxOf = async (id: string) => db.select().from(agentOutbox).where(eq(agentOutbox.draftId, id));
const person = () => ({ id: holderId, roles: ['super_admin'], permissions: new Set<string>(['crm.leads.view_all']) });

async function digestOf(draftId: string): Promise<string> {
  const [row] = await db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
  return (row!.payload as { digest: string }).digest;
}

async function armAuto(categories: string[] = [...FOUR, 'calc_price']) {
  await db
    .update(agentAutoConfig)
    .set({ armedAt: new Date(T0.getTime() - 3_600_000), armedBy: holderId, holdSec: HOLD_MS / 1000, perDay: null, maxChars: 400, minConfidence: '0.80', categories, disarmedAt: null, disarmReason: null })
    .where(eq(agentAutoConfig.id, 1));
}

/** The whole linked chain the VED answered: a lead chat, its request, the AI's sent «yubordim», the answer. */
async function answeredChain(amount = '1234.56', opts: { owner?: string | null; fromOurWarehouse?: boolean } = {}) {
  const leadId = await freshLead(opts.owner === undefined ? holderId : opts.owner);
  const chat = await chatOn(leadId);
  const requestId = await request(leadId, 'rastamojka', chat);
  const ours = await submitted(chat, requestId, { fromOurWarehouse: opts.fromOurWarehouse });
  await answered(requestId, amount);
  return { chat, requestId, ours };
}

/** The VED answer's run, on the machine's clock; its card reached him then. */
async function priceDraft(chainOf: { chat: Chat; requestId: string }, steps = PRICED('1359'), seen: ModelRequest[] = []) {
  const job: AgentCalcAnswerJob = {
    managerUserId: holderId,
    peerId: String(chainOf.chat.peer),
    requestId: chainOf.requestId,
    sourceKey: `calc:${chainOf.requestId}:answer`,
  };
  const out = await handleCalcAnswer(job, { callModel: scripted(steps, seen), now: () => T0 });
  expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
  const draftId = (out as { draftId: string }).draftId;
  await shown(draftId, T0);
  return draftId;
}

/** Telegram as the send step sees it: the live head is `head`, and a send answers a fresh id. */
function fakeTg(head: HeadMessage[]): AgentTelegram & { sent: number } {
  const tg = {
    sent: 0,
    history: async () => head,
    readHistory: async () => {},
    setTyping: async () => {},
    markUnread: async () => {},
    send: async () => {
      tg.sent += 1;
      return { tgMessageId: next() };
    },
  };
  return tg;
}

const stepCtx = () => ({ accountId, caughtUp: () => true, random: () => 0 });
const STEP_NOW = () => new Date(T0.getTime() + 5 * 60_000);

beforeAll(async () => {
  agentSnapshot = await readAgentConfig();
  autoSnapshot = await readAutoConfig();
  if (!agentSnapshot || !autoSnapshot) throw new Error('0138/0145 are not applied on this database');
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  for (const key of SETTING_KEYS) settingsBefore.set(key, await rawSetting(key));
  holderId = await makeUser(`P3 narx egasi ${SUFFIX}`, 'super_admin', '01');
  colleagueId = await makeUser(`P3 narx hamkasb ${SUFFIX}`, 'sales_manager', '02');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: holderId, tgPhone: `+99896${SUFFIX}01`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date(), workAccount: true })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  const [s] = await db.insert(leadStages).values({ name: `P3 narx ${SUFFIX}`, kind: 'open', sortOrder: 9_301 }).returning({ id: leadStages.id });
  stageId = s!.id;
  await db
    .update(agentConfig)
    .set({
      mode: 'shadow',
      ownerUserId: holderId,
      sessionExclusiveAt: new Date(),
      sessionExclusiveBy: holderId,
      startedAt: new Date(Date.now() - 30 * DAY),
      dailyDraftCap: 150,
      dailyTokenCap: 3_000_000,
      humanPauseMin: 120,
    })
    .where(eq(agentConfig.id, 1));
  await setSetting('tg_sending_enabled', true, holderId);
  await putSetting('quote_valid_days', 30);
});

beforeEach(async () => {
  queued.length = 0;
  await armAuto();
  await markup('percent', '10', 'percent:10');
  await putSetting(AGENT_SEAT_KEY, null);
  await stampAgentPump(accountId, true);
});

afterAll(async () => {
  try {
    if (peers.length) {
      await db.delete(agentCalcLinks).where(inArray(agentCalcLinks.peerId, peers));
      await db.delete(agentOutbox).where(inArray(agentOutbox.peerId, peers));
      await db.delete(agentDrafts).where(inArray(agentDrafts.peerId, peers));
      await db.delete(agentRuns).where(inArray(agentRuns.peerId, peers));
      await db.delete(agentConversations).where(inArray(agentConversations.peerId, peers));
      await db.delete(tgMessages).where(inArray(tgMessages.peerId, peers));
    }
    await db.delete(notifications).where(and(inArray(notifications.userId, [holderId, colleagueId]), like(notifications.type, 'Agent%')));
    if (madeRequests.length) {
      await db.update(calcRequests).set({ supersedesRequestId: null }).where(inArray(calcRequests.id, madeRequests));
      await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    }
    if (madeLeads.length) await db.delete(leads).where(inArray(leads.id, madeLeads));
    if (madeClients.length) {
      await db.delete(deals).where(inArray(deals.clientId, madeClients));
      await db.delete(clients).where(inArray(clients.id, madeClients));
    }
    if (stageId) await db.delete(leadStages).where(eq(leadStages.id, stageId));
    await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
    await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  } finally {
    await __restoreAgentConfig(agentSnapshot);
    await __restoreAutoConfig(autoSnapshot);
    await setSetting('tg_sending_enabled', sendingBefore, null);
    for (const [key, value] of settingsBefore) await putSetting(key, value);
    await db.update(users).set({ active: false }).where(inArray(users.id, [holderId, colleagueId]));
  }
});

describe('calcPriceFor — the VED figure plus his markup, for this chat’s linked chains only (§2.2, §00)', () => {
  it('a rastamojka «Готово» answer: 1 234,56 → +10 % → 1 359 $, the floor only on the holder’s card line', async () => {
    const c = await answeredChain();
    const r = await calcPriceFor({ managerUserId: holderId, peerId: c.chat.peer });
    expect(r).toEqual({
      ok: true,
      prices: [{ requestId: c.requestId, section: 'rastamojka', anchor: 'answer', anchorId: c.requestId, rule: 'percent:10', total: 1359 }],
      cardLine: '🧮 rastamojka: VED 1 234,56 $ · ustama 10 % → mijozga 1 359 $',
      fromOurWarehouse: false,
      // No goods were listed on the job: nothing names it beyond its section.
      goods: [''],
    });
  });

  it('a seal: 1 300 → 1 430 (the integer rule, never 1 431); podklyuch and yo’lkira on the WHOLE figure (§00 A2)', async () => {
    const leadId = await freshLead();
    const chat = await chatOn(leadId);
    const r1 = await request(leadId, 'rastamojka', chat);
    await submitted(chat, r1);
    const v1 = await sealed(r1, '1300');
    expect(await calcPriceFor({ managerUserId: holderId, peerId: chat.peer, requestId: r1 })).toMatchObject({
      ok: true,
      prices: [{ anchor: 'seal', anchorId: v1, total: 1430 }],
    });
    // Podklyuch: customs 500 + extras 100 + the freight LIST price 700 — the markup on all 1 300 of it.
    const lead2 = await freshLead();
    const chat2 = await chatOn(lead2);
    const r2 = await request(lead2, 'podklyuch', chat2);
    await submitted(chat2, r2);
    await sealed(r2, '1300', { section: 'podklyuch', customs: '500', freight: '700', extras: '100' });
    expect(await calcPriceFor({ managerUserId: holderId, peerId: chat2.peer })).toMatchObject({ ok: true, prices: [{ section: 'podklyuch', total: 1430 }] });
    // A podklyuch «Готово» answer and a yo'lkira job the VED answered: priced on the whole figure.
    for (const section of ['podklyuch', 'yolkira']) {
      const l = await freshLead();
      const ch = await chatOn(l);
      const r = await request(l, section, ch);
      await submitted(ch, r);
      await answered(r, '800');
      expect(await calcPriceFor({ managerUserId: holderId, peerId: ch.peer })).toMatchObject({ ok: true, prices: [{ section, anchor: 'answer', total: 880 }] });
    }
  });

  it('the markup EMPTY is «no markup»: the floor rounded up, the card says «ustamasiz»; garbage in the row refuses', async () => {
    await markup('percent', '');
    const c = await answeredChain('1350.50');
    expect(await calcPriceFor({ managerUserId: holderId, peerId: c.chat.peer })).toMatchObject({
      ok: true,
      prices: [{ rule: 'none', total: 1351 }],
      cardLine: '🧮 rastamojka: VED 1 350,50 $ · ustamasiz → mijozga 1 351 $',
    });
    await markup('fixed', '150');
    expect(await calcPriceFor({ managerUserId: holderId, peerId: c.chat.peer })).toMatchObject({ ok: true, prices: [{ rule: 'fixed:150', total: 1501 }] });
    await markup('percent', 'oops');
    expect(await calcPriceFor({ managerUserId: holderId, peerId: c.chat.peer })).toEqual({ ok: false, reason: 'markup_unreadable' });
  });

  it('a card with a seller’s yo’lkira seal beside the AI’s rastamojka answer: the rastamojka price only', async () => {
    const leadId = await freshLead();
    const chat = await chatOn(leadId);
    const sellers = await request(leadId, 'yolkira', null);
    await sealed(sellers, '900', { section: 'yolkira', at: new Date(Date.now() - 2 * 3_600_000) });
    const ai = await request(leadId, 'rastamojka', chat);
    await submitted(chat, ai);
    await answered(ai, '1000', { ago: 60 * 60_000 });
    expect(await calcPriceFor({ managerUserId: holderId, peerId: chat.peer })).toMatchObject({
      ok: true,
      prices: [{ requestId: ai, section: 'rastamojka', total: 1100 }],
    });
  });

  it('each refusal with its reason, no digit in its words — expired, not in dollars, a concession, a card moved, outranked', async () => {
    const refusal = async (r: Awaited<ReturnType<typeof calcPriceFor>>) => (r.ok ? 'ok' : r.reason);
    // Expired: the answer is older than quote_valid_days (30).
    const old = await answeredChain();
    await answered(old.requestId, '1234.56', { ago: 31 * DAY });
    expect(await refusal(await calcPriceFor({ managerUserId: holderId, peerId: old.chat.peer }))).toBe('expired');
    // A UZS answer.
    const uzs = await answeredChain();
    await answered(uzs.requestId, '15000000', { currency: 'UZS' });
    expect(await refusal(await calcPriceFor({ managerUserId: holderId, peerId: uzs.chat.peer }))).toBe('not_usd');
    // A discounted seal; a band override below the density.
    for (const opts of [{ discount: '50' }, { density: '200', bandOverrideMin: '100' }]) {
      const l = await freshLead();
      const ch = await chatOn(l);
      const r = await request(l, 'rastamojka', ch);
      await submitted(ch, r);
      await sealed(r, '1300', opts);
      expect(await refusal(await calcPriceFor({ managerUserId: holderId, peerId: ch.peer })), JSON.stringify(opts)).toBe('discounted');
    }
    // An override ABOVE the density is the VED charging more, no concession.
    const l = await freshLead();
    const ch = await chatOn(l);
    const r = await request(l, 'rastamojka', ch);
    await submitted(ch, r);
    await sealed(r, '1300', { density: '200', bandOverrideMin: '250' });
    expect(await refusal(await calcPriceFor({ managerUserId: holderId, peerId: ch.peer }))).toBe('ok');
    // The request's card is no longer the chat's (another lead).
    const elsewhere = await freshLead();
    const own = await freshLead();
    const moved = await chatOn(own);
    const onOther = await request(elsewhere, 'rastamojka', moved);
    await submitted(moved, onOther);
    await answered(onOther, '1000');
    expect(await refusal(await calcPriceFor({ managerUserId: holderId, peerId: moved.peer }))).toBe('card_moved');
    // A newer USD answer of another job on the same card outranks it.
    const out = await answeredChain();
    const newer = await request(out.chat.leadId, 'yolkira', null);
    await answered(newer, '10', { ago: 60_000 });
    expect(await refusal(await calcPriceFor({ managerUserId: holderId, peerId: out.chat.peer }))).toBe('not_standing');
    // A chat with nothing linked.
    const lone = await chatOn(await freshLead());
    expect(await refusal(await calcPriceFor({ managerUserId: holderId, peerId: lone.peer }))).toBe('not_linked');
  });
});

describe('the VED’s answer queues the price — never a run inside the VED’s request (§2.3)', () => {
  it('«Готово» on a job the AI submitted: ONE job, keyed by the anchor, the announcement names the price and keeps 💵', async () => {
    const c = await answeredChain();
    const sent: { name: string; data: unknown; options: unknown }[] = [];
    const before = await db.select({ id: agentDrafts.id }).from(agentDrafts).where(eq(agentDrafts.peerId, c.chat.peer));
    expect(await announceAgentCalc(c.requestId, 'done', { amountText: '1234.56 USD' }, { enqueue: async (name, data, options) => void sent.push({ name, data, options }), now: T0 })).toBe(true);
    expect(sent).toEqual([
      {
        name: JOB_AGENT_CALC_ANSWER,
        data: { managerUserId: holderId, peerId: String(c.chat.peer), requestId: c.requestId, sourceKey: `calc:${c.requestId}:answer` },
        options: { retryLimit: 0 },
      },
    ]);
    // Nothing was drafted inline.
    expect(await db.select({ id: agentDrafts.id }).from(agentDrafts).where(eq(agentDrafts.peerId, c.chat.peer))).toHaveLength(before.length);
    const [card] = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, holderId), eq(notifications.type, 'AgentCalcAnswered'), sql`${notifications.payload}->>'requestId' = ${c.requestId}`));
    const p = card!.payload as { text: string; priceable: boolean };
    expect(p.text).toContain('🤖 AI mijozga ustama bilan narx aytadi');
    expect(p.text).toContain('VED 1 234,56 $ · ustama 10 % → mijozga 1 359 $');
    expect(p.priceable).toBe(true);
  });

  it('an answer in the night is queued for 08:30 Tashkent; an estimate, a reply that never went, garbage markup queue nothing', async () => {
    const c = await answeredChain();
    const sent: { options: { startAfter?: number } }[] = [];
    const night = new Date('2026-11-12T18:00:00Z'); // 23:00 Tashkent
    await announceAgentCalc(c.requestId, 'done', { amountText: '1234.56 USD' }, { enqueue: async (_n, _d, options) => void sent.push({ options }), now: night });
    expect(sent[0]!.options.startAfter).toBe((Date.parse('2026-11-13T03:30:00Z') - night.getTime()) / 1000);
    sent.length = 0;
    await announceAgentCalc(c.requestId, 'estimate', { amountText: '900 $' }, { enqueue: async (_n, _d, options) => void sent.push({ options }), now: T0 });
    expect(sent).toHaveLength(0);
    // The submitting reply never went: «javob kelishi bilan aytaman» was never said — only the announcement.
    const leadId = await freshLead();
    const chat = await chatOn(leadId);
    const r = await request(leadId, 'rastamojka', chat);
    await submitted(chat, r, { sent: false });
    await answered(r, '1000');
    await announceAgentCalc(r, 'done', {}, { enqueue: async (_n, _d, options) => void sent.push({ options }), now: T0 });
    expect(sent).toHaveLength(0);
    await markup('percent', 'oops');
    await announceAgentCalc(c.requestId, 'done', {}, { enqueue: async (_n, _d, options) => void sent.push({ options }), now: T0 });
    expect(sent).toHaveLength(0);
    const texts = (await db.select({ payload: notifications.payload }).from(notifications).where(and(eq(notifications.userId, holderId), sql`${notifications.payload}->>'requestId' = ${c.requestId}`))).map(
      (n) => (n.payload as { text: string }).text,
    );
    expect(texts.some((t) => t.includes('ustama sozlamasi buzilgan'))).toBe(true);
  });
});

describe('the machine’s price — drafted, pressed and sent past our own «yubordim» (§2.3, K1)', () => {
  it('the floor reaches no prompt part, no memory and no note; the reply goes by itself and the send step passes it', async () => {
    const c = await answeredChain();
    const seen: ModelRequest[] = [];
    const draftId = await priceDraft(c, PRICED('1359'), seen);
    // The model was offered calc_price, and never shown the VED's own figure or his rule.
    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) {
      expect(req.tools.map((t) => t.name)).toContain('calc_price');
      const all = JSON.stringify({ s: req.system, c: req.systemCached, m: req.messages });
      expect(all).not.toMatch(/1 ?234[.,]56/u);
      expect(all).not.toMatch(/percent:10|ustama 10/u);
    }
    const d = await draftOf(draftId);
    const p = d.policy as { calcAnswer?: { requestId: string }; memory: { calcPrices: unknown[]; sources: { kind: string; value: number }[] }; notes: string[]; card: { calcLine?: string } };
    expect(d.kind).toBe('reply');
    expect(p.calcAnswer).toEqual({ requestId: c.requestId });
    expect(p.memory.calcPrices).toEqual([{ requestId: c.requestId, section: 'rastamojka', anchor: 'answer', anchorId: c.requestId, rule: 'percent:10', total: 1359 }]);
    expect(p.memory.sources.filter((s) => s.kind === 'money').map((s) => s.value)).toEqual([1359]);
    // The floor and the rule only on the holder's card line.
    const { card, ...rest } = p;
    expect(JSON.stringify(rest)).not.toMatch(/1 ?234[.,]56|percent:10.*1234/u);
    expect(card.calcLine).toBe('🧮 rastamojka: VED 1 234,56 $ · ustama 10 % → mijozga 1 359 $');
    const text = renderDraftCard(d, null);
    expect(text).toContain('🧮 VED narxi + ustama');
    expect(text).toContain('VED 1 234,56 $ · ustama 10 % → mijozga 1 359 $');
    // «VED narxi» ticked, the markup vouched for: the price goes by itself.
    expect(await verdictOf(draftId)).toMatchObject({ eligible: true, state: 'waiting', reasons: [] });
    expect(await pressDueAutos(DUE)).toBe(1);
    const [o] = await outboxOf(draftId);
    expect(o).toBeDefined();
    // The send step: our own «yubordim» after the customer's line is forgiven for this owner-started reply.
    const row = (await agentRowById(o!.id))!;
    const tg = fakeTg([
      { id: c.ours, out: true, text: 'Hisoblatishga yubordim, javob kelishi bilan aytaman.', media: false },
      { id: c.chat.anchor, out: false, text: 'Rastamojka qancha bo‘ladi?', media: false },
    ]);
    const store = {
      facts: async (r: typeof row, now: Date) => ({ ...(await sendFactsFor(r, now, stepCtx())), agentOn: true, ownerUserId: holderId, sendingEnabled: true }),
      claimSend: async (id: string) =>
        (await db.update(agentOutbox).set({ status: 'sending' }).where(and(eq(agentOutbox.id, id), eq(agentOutbox.status, 'agent'))).returning({ id: agentOutbox.id })).length > 0,
    };
    const deps = { tg, store, classify: tgErrorKind, isNudge, now: STEP_NOW };
    expect(await runAgentStep(row, deps)).toMatchObject({ kind: 'advance', step: 'read' });
    expect(await runAgentStep({ ...row, step: 'send' }, deps)).toMatchObject({ kind: 'sent' });
    expect(tg.sent).toBe(1);
  });

  it('the first price after a markup change waits for him — his ✅ then vouches for the rule', async () => {
    await markup('percent', '10', null);
    const c = await answeredChain();
    const draftId = await priceDraft(c);
    expect((await verdictOf(draftId))!.reasons).toEqual(['markup_unconfirmed']);
    expect(await decideDraft(person(), draftId, 'send', { digest: await digestOf(draftId) }, { actorId: holderId })).toMatchObject({ ok: true });
    expect(await rawSetting(MARKUP_CONFIRMED_KEY)).toBe('percent:10');
    // `none` is a rule like any other: an edit to empty re-arms the wait.
    await markup('percent', '', 'percent:10');
    const c2 = await answeredChain();
    const d2 = await priceDraft(c2, PRICED('1235'));
    expect((await verdictOf(d2))!.reasons).toEqual(['markup_unconfirmed']);
  });

  it('a run that made no calc_price call carries the note — no machine press', async () => {
    const c = await answeredChain();
    const draftId = await priceDraft(c, [compose('VED javobi keldi, narxni tez orada aytaman.')]);
    const d = await draftOf(draftId);
    expect((d.policy as { notes: string[] }).notes).toContain(CALC_PRICE_UNSAID);
    expect((await verdictOf(draftId))!.reasons).toContain('notes');
  });

  it('two machine replies already in the chat: the price waits for him (`streak`, his §7 Q8 ⭐)', async () => {
    const c = await answeredChain();
    for (let i = 0; i < 2; i++) {
      const [d] = await db
        .insert(agentDrafts)
        .values({ managerUserId: holderId, peerId: c.chat.peer, leadId: c.chat.leadId, anchorTgMessageId: c.chat.anchor, status: 'approved', kind: 'reply', proposedBody: `x${i}` })
        .returning({ id: agentDrafts.id });
      const at = new Date(T0.getTime() - (10 - i) * 60_000);
      await db.insert(agentAutoVerdicts).values({ draftId: d!.id, managerUserId: holderId, peerId: c.chat.peer, eligible: true, state: 'pressed', dueAt: at, pressedAt: at });
    }
    const draftId = await priceDraft(c);
    expect((await verdictOf(draftId))!.reasons).toEqual(['streak']);
  });
});

describe('the price stops standing — at the press, at his ✅ and at the send step (§2.5)', () => {
  const later = async (c: { chat: Chat; requestId: string }) => {
    // A later seal of another job on the same card.
    const r = await request(c.chat.leadId, 'yolkira', null);
    await sealed(r, '500', { section: 'yolkira', at: new Date() });
  };
  const newer = async (c: { chat: Chat; requestId: string }) => {
    const r = await request(c.chat.leadId, 'yolkira', null);
    await answered(r, '20', { ago: 0 });
  };
  const expired = async (c: { chat: Chat; requestId: string }) => {
    await answered(c.requestId, '1234.56', { ago: 31 * DAY });
  };
  const markupEdit = async () => {
    await putSetting('agent_calc_markup_value', '12');
  };

  it.each([
    ['a later seal on the same card', later],
    ['a newer answer on the same card', newer],
    ['the quote’s clock', expired],
    ['a markup edit', markupEdit],
  ] as const)('%s: refused at the press, at his ✅ and at the send step', async (_name, change) => {
    // At the press.
    const a = await answeredChain();
    const atPress = await priceDraft(a);
    expect((await verdictOf(atPress))!.state).toBe('waiting');
    await change(a);
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await outboxOf(atPress)).toHaveLength(0);
    expect((await verdictOf(atPress))!.outcome).toMatch(/calc_price_moved/u);
    await markup('percent', '10', 'percent:10');
    // At his ✅.
    const b = await answeredChain();
    const atOk = await priceDraft(b);
    await change(b);
    expect(await draftOfferStands(atOk)).toBe('calc_price_moved');
    expect(await decideDraft(person(), atOk, 'send', { digest: await digestOf(atOk) }, { actorId: holderId })).toEqual({ ok: false, code: 'calc_price_moved' });
    await markup('percent', '10', 'percent:10');
    // At the send step: approved while it stood, moved before it went.
    const s = await answeredChain();
    const atSend = await priceDraft(s);
    expect(await decideDraft(person(), atSend, 'send', { digest: await digestOf(atSend) }, { actorId: holderId })).toMatchObject({ ok: true });
    await change(s);
    const [o] = await outboxOf(atSend);
    const facts = await sendFactsFor((await agentRowById(o!.id))!, STEP_NOW(), stepCtx());
    expect(facts.offerStands).toBe('calc_price_moved');
    expect(agentSendVerdict((await agentRowById(o!.id))!, { ...facts, agentOn: true, ownerUserId: holderId, sendingEnabled: true })).toEqual({
      ok: false,
      final: true,
      reason: 'calc_price_moved',
    });
  });

  it('a discount added by a correction’s seal: the old price stops standing', async () => {
    const leadId = await freshLead();
    const chat = await chatOn(leadId);
    const root = await request(leadId, 'rastamojka', chat);
    await submitted(chat, root);
    await sealed(root, '1300');
    const draftId = await priceDraft({ chat, requestId: root }, PRICED('1430'));
    // The VED re-opens it as a correction, sealed with a discount.
    const fix = await request(leadId, 'rastamojka', null, { supersedes: root, requestedAt: new Date() });
    await sealed(fix, '1200', { discount: '100', at: new Date() });
    expect(await draftOfferStands(draftId)).toBe('calc_price_moved');
    expect(await calcPriceFor({ managerUserId: holderId, peerId: chat.peer })).toEqual({ ok: false, reason: 'discounted' });
  });

  it('a recalculation retires the AI’s price draft of kind `reply` (§2.5, `retirePricesOf` widened)', async () => {
    const c = await answeredChain();
    const draftId = await priceDraft(c);
    const fix = await request(c.chat.leadId, 'rastamojka', null, { supersedes: c.requestId, requestedAt: new Date() });
    expect(await announceAgentCalc(fix, 'recalc')).toBe(true);
    const d = await draftOf(draftId);
    expect(d.status).toBe('superseded');
    expect((d.policy as { stale?: string }).stale).toBe('recalc');
  });

  it('a markup change through its own door retires a pending machine price and cancels an approved one still waiting', async () => {
    const pending = await answeredChain();
    const p = await priceDraft(pending);
    const waiting = await answeredChain();
    const w = await priceDraft(waiting);
    expect(await decideDraft(person(), w, 'send', { digest: await digestOf(w) }, { actorId: holderId })).toMatchObject({ ok: true });
    const holder = { id: holderId, roles: ['super_admin'] };
    expect(await setCalcMarkup(holder, { kind: 'fixed', value: '150' }, { actorId: holderId })).toMatchObject({ kind: 'fixed', value: '150' });
    const dp = await draftOf(p);
    expect(dp.status).toBe('superseded');
    expect((dp.policy as { stale?: string }).stale).toBe('markup');
    expect(renderDraftCard(dp, null)).toContain('Ustama o‘zgardi');
    const [o] = await outboxOf(w);
    expect(o).toMatchObject({ status: 'cancelled' });
    expect(o!.lastError).toMatch(/^calc_price_moved/u);
    // Audited under the settings' entity id with both keys.
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, SETTINGS_AUDIT_ID), sql`${auditLog.after} ? 'agent_calc_markup_value'`))
      .orderBy(sql`${auditLog.createdAt} DESC`)
      .limit(1);
    expect(audit!.after).toMatchObject({ agent_calc_markup_kind: 'fixed', agent_calc_markup_value: '150' });
  });
});

describe('his doors on the markup (§2.1)', () => {
  it('a colleague may not; a value out of bounds is refused; «✅ Ustama to‘g‘ri» stamps the rule as it stands', async () => {
    const refused = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof AgentConfigError ? e.code : String(e)));
    expect(await refused(setCalcMarkup({ id: colleagueId, roles: ['sales_manager'] }, { kind: 'percent', value: '5' }, { actorId: colleagueId }))).toBe('forbidden');
    for (const [kind, value] of [
      ['percent', '0'],
      ['percent', '100.5'],
      ['fixed', '5001'],
      ['fixed', '1.5'],
      ['other', '5'],
    ]) {
      expect(await refused(setCalcMarkup({ id: holderId, roles: ['super_admin'] }, { kind: kind!, value: value! }, { actorId: holderId })), `${kind}:${value}`).toBe('bad_value');
    }
    expect(await setCalcMarkup({ id: holderId, roles: ['super_admin'] }, { kind: 'percent', value: '7,5' }, { actorId: holderId })).toMatchObject({ value: '7.5' });
    expect(await confirmCalcMarkup({ id: holderId, roles: ['super_admin'] }, 'percent:7.5', { actorId: holderId })).toBe('percent:7.5');
    expect(await rawSetting(MARKUP_CONFIRMED_KEY)).toBe('percent:7.5');
    expect(await setCalcMarkup({ id: holderId, roles: ['super_admin'] }, { kind: 'percent', value: '' }, { actorId: holderId })).toMatchObject({ value: '' });
    expect(await confirmCalcMarkup({ id: holderId, roles: ['super_admin'] }, 'none', { actorId: holderId })).toBe('none');
  });
});

describe('his 💵 beside the AI’s price (§2.3, judge money 11, hands 5)', () => {
  it('his 💵 approved, then the VED answer’s job: it stands down — exactly one price goes', async () => {
    const c = await answeredChain();
    const own = await priceDraftFromText(holderId, c.requestId, '1300');
    expect(own).toMatchObject({ ok: true });
    const ownId = (own as { draftId: string }).draftId;
    expect(await decideDraft(person(), ownId, 'send', { digest: await digestOf(ownId) }, { actorId: holderId })).toMatchObject({ ok: true });
    const out = await handleCalcAnswer({ managerUserId: holderId, peerId: String(c.chat.peer), requestId: c.requestId, sourceKey: `calc:${c.requestId}:answer` }, { callModel: scripted(PRICED('1359')), now: () => T0 });
    expect(out).toEqual({ outcome: 'stood_down', reason: 'owner_price' });
    const machine = await db.select({ id: agentDrafts.id }).from(agentDrafts).where(and(eq(agentDrafts.peerId, c.chat.peer), sql`${agentDrafts.policy} ? 'calcAnswer'`));
    expect(machine).toHaveLength(0);
  });

  it('his «💵 Narx yozaman» armed for the chain: the job stands down too — the wait is his figure on its way', async () => {
    const c = await answeredChain();
    const botChat = 7_950_000_000 + Number(SUFFIX);
    armWait(botChat, 'agent_price', { requestId: c.requestId }, 600_000, nowSec());
    try {
      const out = await handleCalcAnswer({ managerUserId: holderId, peerId: String(c.chat.peer), requestId: c.requestId, sourceKey: `calc:${c.requestId}:answer` }, { callModel: scripted(PRICED('1359')), now: () => T0 });
      expect(out).toEqual({ outcome: 'stood_down', reason: 'owner_price' });
    } finally {
      dropWait(botChat, 'agent_price');
      await flushWaitWrites();
    }
  });

  it('the AI’s price SENT, then his 💵: asked first («AI narxi ketgan»), drafted on the next press', async () => {
    const c = await answeredChain();
    const draftId = await priceDraft(c);
    expect(await decideDraft(person(), draftId, 'send', { digest: await digestOf(draftId) }, { actorId: holderId })).toMatchObject({ ok: true });
    await db.update(agentOutbox).set({ status: 'sent', sentAt: new Date() }).where(eq(agentOutbox.draftId, draftId));
    expect(await priceDraftFromText(holderId, c.requestId, '1300')).toEqual({ ok: false, code: 'ai_price_sent', total: 1359, by: 'ai' });
    expect(await priceDraftFromText(holderId, c.requestId, '1300')).toMatchObject({ ok: true });
  });

  it('his 💵 while the AI’s approved price still waits: the AI’s row is taken back, his goes', async () => {
    const c = await answeredChain();
    const draftId = await priceDraft(c);
    expect(await decideDraft(person(), draftId, 'send', { digest: await digestOf(draftId) }, { actorId: holderId })).toMatchObject({ ok: true });
    expect(await priceDraftFromText(holderId, c.requestId, '1300')).toMatchObject({ ok: true });
    const [o] = await outboxOf(draftId);
    expect(o).toMatchObject({ status: 'cancelled' });
    expect(o!.lastError).toMatch(/^owner_price/u);
  });
});

describe('the customer asks again while the price waits (§2.3, judge money 17)', () => {
  it('«qachon?» — the inbound run is offered calc_price and restates the same figure', async () => {
    const c = await answeredChain();
    const q = next();
    await db.insert(tgMessages).values({ leadId: c.chat.leadId, managerUserId: holderId, peerId: c.chat.peer, tgMessageId: q, direction: 'in', body: 'Narx qachon bo‘ladi?', sentAt: new Date(T0.getTime() - 2 * 60_000) });
    const seen: ModelRequest[] = [];
    const out = await handleInbound(
      { managerUserId: holderId, peerId: String(c.chat.peer), anchorTgMessageId: String(q), origin: 'live' },
      { callModel: scripted(PRICED('1359'), seen), now: () => T0 },
    );
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
    expect(seen[0]!.tools.map((t) => t.name)).toContain('calc_price');
    const d = await draftOf((out as { draftId: string }).draftId);
    expect((d.policy as { memory: { calcPrices: { total: number }[] } }).memory.calcPrices.map((m) => m.total)).toEqual([1359]);
  });

  it('a chat with no answered job is never offered the tool (the list is today’s)', async () => {
    const leadId = await freshLead();
    const chat = await chatOn(leadId, 'Salom, yuk bor.', 2 * 60_000);
    const seen: ModelRequest[] = [];
    await handleInbound(
      { managerUserId: holderId, peerId: String(chat.peer), anchorTgMessageId: String(chat.anchor), origin: 'live' },
      { callModel: scripted([compose('Assalomu alaykum! Yukingiz haqida yozing.')], seen), now: () => T0 },
    );
    expect(seen[0]!.tools.map((t) => t.name)).not.toContain('calc_price');
  });
});

describe('every outcome of the VED answer’s run that leaves no price is said to him (§2.3, judge hands 5)', () => {
  it('his 🙋 on the chat: refused, and the 💵 door comes with the reason', async () => {
    const c = await answeredChain();
    await db
      .insert(agentConversations)
      .values({ managerUserId: holderId, peerId: c.chat.peer, humanUntil: new Date(Date.now() + DAY) })
      .onConflictDoUpdate({ target: [agentConversations.managerUserId, agentConversations.peerId], set: { humanUntil: new Date(Date.now() + DAY) } });
    const out = await handleCalcAnswer({ managerUserId: holderId, peerId: String(c.chat.peer), requestId: c.requestId, sourceKey: `calc:${c.requestId}:answer` }, { callModel: scripted(PRICED('1359')), now: () => T0 });
    expect(out).toMatchObject({ outcome: 'refused', reason: 'human_active' });
    const [said] = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, holderId), eq(notifications.type, 'AgentCalcAnswered'), sql`${notifications.payload}->>'text' LIKE '%VED narxini yozmadi%'`, sql`${notifications.payload}->>'requestId' = ${c.requestId}`));
    expect(said).toBeDefined();
    expect(said!.payload).toMatchObject({ priceable: true });
  });
});

/** A reply of ours that WENT: the draft's outbox row sent, and its Telegram copy in the chat. */
async function wentOut(draftId: string, at: Date): Promise<bigint> {
  const [o] = await outboxOf(draftId);
  expect(o, 'an outbox row after the ✅').toBeDefined();
  const tgId = next();
  await db.update(agentOutbox).set({ status: 'sent', sentAt: at, tgMessageId: tgId }).where(eq(agentOutbox.id, o!.id));
  await db.insert(tgMessages).values({ leadId: o!.leadId, clientId: o!.clientId, managerUserId: holderId, peerId: o!.peerId, tgMessageId: tgId, direction: 'out', body: o!.body, sentAt: at });
  return tgId;
}

/** The customer writes again — a line newer than everything in the chat. */
async function customerSays(chat: { peer: bigint; leadId?: string; clientId?: string }, body: string, at = new Date(T0.getTime() - 2 * 60_000)): Promise<bigint> {
  const id = next();
  await db.insert(tgMessages).values({ leadId: chat.leadId ?? null, clientId: chat.clientId ?? null, managerUserId: holderId, peerId: chat.peer, tgMessageId: id, direction: 'in', body, sentAt: at });
  return id;
}

/** His 💵 drafted, approved by his ✅ — its outbox row waiting. */
async function ownPrice(requestId: string, figure: string): Promise<string> {
  const own = await priceDraftFromText(holderId, requestId, figure);
  expect(own, JSON.stringify(own)).toMatchObject({ ok: true });
  const id = (own as { draftId: string }).draftId;
  expect(await decideDraft(person(), id, 'send', { digest: await digestOf(id) }, { actorId: holderId })).toMatchObject({ ok: true });
  return id;
}

/** The tools' own answers the model read back (never the model's own words), from the requests it was sent. */
function toolTextOf(seen: ModelRequest[]): string {
  const results = (seen.at(-1)?.messages ?? []).flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((b) => (b as { type?: string }).type === 'tool_result') : [],
  );
  return JSON.stringify(results);
}

/**
 * A coded client's chat with TWO jobs the AI submitted — each on its own deal (a new deal per request), each with its
 * own sent «yubordim» and its own goods: job A answered 1 000 $ two days ago (→ 1 100), job B 1 234,56 $ now (→ 1 359).
 */
async function twoJobs() {
  const [cl] = await db
    .insert(clients)
    .values({ clientCode: `PF${SUFFIX}${madeClients.length + 1}`.slice(0, 10), name: `P3 ikki ish ${SUFFIX}`, phones: [], salesManagerId: holderId })
    .returning({ id: clients.id });
  madeClients.push(cl!.id);
  const open = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const mkDeal = async (n: number) =>
    (await db.insert(deals).values({ code: `PF-${SUFFIX}-${madeClients.length}-${n}`, clientId: cl!.id, stageId: open!.id, title: 'ikki ish', createdBy: holderId, ownerId: holderId }).returning({ id: deals.id }))[0]!.id;
  const peer = next();
  peers.push(peer);
  const job = async (goods: string, askedAt: Date, amount: string, answeredAgo: number) => {
    const anchor = next();
    await db.insert(tgMessages).values({ clientId: cl!.id, managerUserId: holderId, peerId: peer, tgMessageId: anchor, direction: 'in', body: `Rastamojka qancha? ${goods}.`, sentAt: askedAt });
    const deal = await mkDeal(madeRequests.length);
    const [r] = await db
      .insert(calcRequests)
      .values({ entityType: 'deal', entityId: deal, requestedBy: holderId, itemCount: 1, section: 'rastamojka', dueAt: new Date(Date.now() + 3_600_000), requestedAt: new Date(askedAt.getTime() + 5 * 60_000) })
      .returning({ id: calcRequests.id });
    madeRequests.push(r!.id);
    await db.insert(calcRequestItems).values({ requestId: r!.id, seq: 1, name: goods });
    await db.insert(agentCalcLinks).values({ requestId: r!.id, rootRequestId: r!.id, managerUserId: holderId, peerId: peer, createdAt: new Date(askedAt.getTime() + 5 * 60_000) });
    const ours = next();
    const at = new Date(askedAt.getTime() + 6 * 60_000);
    await db.insert(tgMessages).values({ clientId: cl!.id, managerUserId: holderId, peerId: peer, tgMessageId: ours, direction: 'out', body: 'Hisoblatishga yubordim, javob kelishi bilan aytaman.', sentAt: at });
    const [sd] = await db
      .insert(agentDrafts)
      .values({ managerUserId: holderId, peerId: peer, clientId: cl!.id, anchorTgMessageId: anchor, status: 'approved', kind: 'reply', proposedBody: 'Hisoblatishga yubordim, javob kelishi bilan aytaman.', actions: [{ type: 'calc_submit', section: 'rastamojka', facts: {}, fromOurWarehouse: false, citedMessageIds: [] }] })
      .returning({ id: agentDrafts.id });
    await db.insert(agentOutbox).values({ draftId: sd!.id, managerUserId: holderId, peerId: peer, clientId: cl!.id, body: 'Hisoblatishga yubordim, javob kelishi bilan aytaman.', randomId: next(), answersTgMessageId: anchor, status: 'sent', step: 'send', nextStepAt: at, queuedBy: holderId, sentAt: at, tgMessageId: ours });
    await db.update(agentCalcLinks).set({ draftId: sd!.id }).where(eq(agentCalcLinks.requestId, r!.id));
    await answered(r!.id, amount, { ago: answeredAgo });
    return r!.id;
  };
  const a = await job('kurtka 100 dona', new Date(T0.getTime() - 3 * DAY), '1000', 2 * DAY);
  const b = await job('oyoq kiyim 200 juft', new Date(T0.getTime() - 60 * 60_000), '1234.56', 30 * 60_000);
  return { peer, clientId: cl!.id, a, b };
}

describe('fix pass 1 — what goes by itself (the VED price)', () => {
  it('his 💵 SENT, then the customer asks again: the machine prices nothing — the tool refuses, the reply cannot quote, no press (finding 1)', async () => {
    const c = await answeredChain();
    const ownId = await ownPrice(c.requestId, '1500');
    await wentOut(ownId, new Date(T0.getTime() - 10 * 60_000));
    expect(await calcPriceFor({ managerUserId: holderId, peerId: c.chat.peer })).toEqual({ ok: false, reason: 'owner_priced' });
    const q = await customerSays(c.chat, 'Yaxshi. Narxi qancha edi, yana bir aytib yuboring?');
    const seen: ModelRequest[] = [];
    const out = await handleInbound({ managerUserId: holderId, peerId: String(c.chat.peer), anchorTgMessageId: String(q), origin: 'live' }, { callModel: scripted(PRICED('1359'), seen), now: () => T0 });
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
    expect(toolTextOf(seen)).toContain('Narx AYTMA');
    const d = await draftOf((out as { draftId: string }).draftId);
    expect((d.policy as { memory: { calcPrices?: unknown[] } }).memory.calcPrices ?? []).toEqual([]);
    expect(d.blocked).toBe(true);
    expect((await verdictOf(d.id))!.eligible).toBe(false);
    expect(await pressDueAutos(DUE)).toBe(0);
    // His 💵 approved and never sent (a morning line cancelled it): his figure still outranks the machine's.
    const n = await answeredChain();
    const held = await ownPrice(n.requestId, '1500');
    await db.update(agentOutbox).set({ status: 'cancelled', lastError: 'anchor_superseded' }).where(eq(agentOutbox.draftId, held));
    expect(await calcPriceFor({ managerUserId: holderId, peerId: n.chat.peer })).toEqual({ ok: false, reason: 'owner_priced' });
  });

  it('the machine price counting down, then his «💵 Narx yozaman» armed: the press refuses in his words (finding 1, the gate)', async () => {
    const c = await answeredChain();
    const draftId = await priceDraft(c);
    expect((await verdictOf(draftId))!.state).toBe('waiting');
    const botChat = 7_960_000_000 + Number(SUFFIX);
    armWait(botChat, 'agent_price', { requestId: c.requestId }, 600_000, nowSec());
    try {
      expect(await pressDueAutos(DUE)).toBe(0);
      expect(await outboxOf(draftId)).toHaveLength(0);
      const v = await verdictOf(draftId);
      expect(v!.outcome).toMatch(/calc_owner_priced/u);
      expect(v!.outcome).not.toMatch(/calc_price_moved/u);
    } finally {
      dropWait(botChat, 'agent_price');
      await flushWaitWrites();
    }
  });

  it('two jobs on two deals: the VED answer’s run prices ITS job alone — another job’s figure cannot go (finding 2)', async () => {
    const j = await twoJobs();
    const seen: ModelRequest[] = [];
    const wrong = `Rastamojka narxi 1100 $ bo‘ladi, ${letters(Number(SUFFIX))}${letters(++replySeq)}.`;
    const out = await handleCalcAnswer(
      { managerUserId: holderId, peerId: String(j.peer), requestId: j.b, sourceKey: `calc:${j.b}:answer` },
      { callModel: scripted([{ name: 'calc_price', input: {} }, compose(wrong)], seen), now: () => T0 },
    );
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
    const tool = toolTextOf(seen);
    expect(tool).toContain('1359 $');
    expect(tool).not.toContain('1100 $');
    // The job is named by its goods, so the model and his card know which cargo the figure is for.
    expect(tool).toContain('oyoq kiyim');
    const d = await draftOf((out as { draftId: string }).draftId);
    await shown(d.id, T0);
    expect(d.blocked).toBe(true);
    expect((d.policy as { memory: { calcPrices?: unknown[] } }).memory.calcPrices ?? []).toEqual([]);
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await outboxOf(d.id)).toHaveLength(0);
  });

  it('two jobs answered, the customer asks: the tool names each job, the draft keeps only what it states, and the machine presses none (finding 2)', async () => {
    const j = await twoJobs();
    const q = await customerSays({ peer: j.peer, clientId: j.clientId }, 'Narxlar chiqdimi?');
    const seen: ModelRequest[] = [];
    const out = await handleInbound({ managerUserId: holderId, peerId: String(j.peer), anchorTgMessageId: String(q), origin: 'live' }, { callModel: scripted(PRICED('1359'), seen), now: () => T0 });
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
    const tool = toolTextOf(seen);
    expect(tool).toContain('kurtka');
    expect(tool).toContain('oyoq kiyim');
    const d = await draftOf((out as { draftId: string }).draftId);
    await shown(d.id, T0);
    const p = d.policy as { memory: { calcPrices: { requestId: string; total: number }[] }; notes: string[] };
    expect(p.memory.calcPrices.map((m) => [m.requestId, m.total])).toEqual([[j.b, 1359]]);
    expect(p.notes.join(' ')).toContain('bir nechta VED narxi');
    expect((await verdictOf(d.id))!.reasons).toContain('notes');
    expect(await pressDueAutos(DUE)).toBe(0);
  });

  it('a reply that states NO VED figure keeps no price, writes no offer and moves the card nowhere as a quote (finding 3)', async () => {
    await putSetting(AGENT_SEAT_KEY, holderId);
    const c = await answeredChain();
    const unsaid = `VED javobi keldi, narxni sizga tez orada aytamiz, ${letters(Number(SUFFIX))}${letters(++replySeq)}.`;
    const draftId = await priceDraft(c, [{ name: 'calc_price', input: {} }, compose(unsaid)]);
    const d = await draftOf(draftId);
    const p = d.policy as { memory: { calcPrices?: unknown[] }; notes: string[] };
    expect(p.memory.calcPrices ?? []).toEqual([]);
    expect(p.notes).toContain(CALC_PRICE_UNSAID);
    expect(await decideDraft(person(), draftId, 'send', { digest: await digestOf(draftId) }, { actorId: holderId })).toMatchObject({ ok: true });
    const [o] = await outboxOf(draftId);
    const tgId = next();
    await db.insert(tgMessages).values({ leadId: c.chat.leadId, managerUserId: holderId, peerId: c.chat.peer, tgMessageId: tgId, direction: 'out', body: o!.body, sentAt: new Date() });
    await applyAgentOutcome((await agentRowById(o!.id))!, { kind: 'sent', tgMessageId: tgId } as never, { id: accountId, managerUserId: holderId, managerName: 'P3' });
    const after = await handleAfterSent({ outboxId: o!.id });
    expect(after).toMatchObject({ outcome: 'done', offer: [] });
    expect(await db.select().from(calcOffers).where(eq(calcOffers.requestId, c.requestId))).toHaveLength(0);
    const [lead] = await db.select({ quoted: leads.quotedAmount }).from(leads).where(eq(leads.id, c.chat.leadId));
    expect(lead!.quoted).toBeNull();
  });

  it('a stored mark the sent words do not state writes no offer; a restated figure writes no second row (finding 3, the offer step)', async () => {
    await putSetting(AGENT_SEAT_KEY, holderId);
    const c = await answeredChain();
    const draftId = await priceDraft(c);
    expect(await decideDraft(person(), draftId, 'send', { digest: await digestOf(draftId) }, { actorId: holderId })).toMatchObject({ ok: true });
    const [o] = await outboxOf(draftId);
    // The words that went name no figure, whatever the draft remembered.
    await db.update(agentOutbox).set({ body: `Narxni hozir aytaman, ${letters(++replySeq)}.` }).where(eq(agentOutbox.id, o!.id));
    await wentOut(draftId, new Date());
    expect(await handleAfterSent({ outboxId: o!.id })).toMatchObject({ outcome: 'done', offer: [] });
    expect(await db.select().from(calcOffers).where(eq(calcOffers.requestId, c.requestId))).toHaveLength(0);
    // Two replies that each state the same figure on the same answer: ONE offer row, never two.
    const twice = await answeredChain();
    for (let i = 0; i < 2; i++) {
      if (i === 1) await customerSays(twice.chat, `Yana bir bor ayting-chi ${letters(i)}?`, new Date(T0.getTime() - 60_000));
      const id = await priceDraft(twice, PRICED('1359'));
      expect(await decideDraft(person(), id, 'send', { digest: await digestOf(id) }, { actorId: holderId })).toMatchObject({ ok: true });
      const [row] = await outboxOf(id);
      await wentOut(id, new Date(Date.now() + i * 1000));
      expect(await handleAfterSent({ outboxId: row!.id })).toMatchObject({ outcome: 'done', offer: ['💳 Kartaga yozildi: 1 359 $'] });
      await db.update(agentRuns).set({ sourceKey: null }).where(eq(agentRuns.sourceKey, `calc:${twice.requestId}:answer`));
    }
    expect(await db.select().from(calcOffers).where(eq(calcOffers.requestId, twice.requestId))).toHaveLength(1);
    expect(await db.select().from(agentOffers).where(eq(agentOffers.requestId, twice.requestId))).toHaveLength(1);
  });

  it('his second 💵 while his first still waits: the first is taken back, ONE price goes (finding 4)', async () => {
    const c = await answeredChain();
    const first = await ownPrice(c.requestId, '1300');
    expect((await outboxOf(first))[0]!.status).toBe('agent');
    expect(await priceDraftFromText(holderId, c.requestId, '1250')).toMatchObject({ ok: true });
    const [o] = await outboxOf(first);
    expect(o).toMatchObject({ status: 'cancelled' });
    expect(o!.lastError).toMatch(/^owner_price/u);
    // His first already in flight (claimed by the pump): asked first, never a second sent past it.
    const f = await answeredChain();
    const flying = await ownPrice(f.requestId, '1300');
    await db.update(agentOutbox).set({ status: 'sending' }).where(eq(agentOutbox.draftId, flying));
    expect(await priceDraftFromText(holderId, f.requestId, '1250')).toEqual({ ok: false, code: 'ai_price_sent', total: 1300, by: 'owner' });
    expect((await outboxOf(flying))[0]!.status).toBe('sending');
  });

  it('his 💵 sent, the customer bargains, his next 💵 drafts at once; with no newer line it is asked first (finding 11)', async () => {
    const c = await answeredChain();
    const first = await ownPrice(c.requestId, '1250');
    await wentOut(first, new Date(T0.getTime() - 10 * 60_000));
    // No line of the customer's since his figure went: a second 💵 would follow on the same line — asked.
    expect(await priceDraftFromText(holderId, c.requestId, '1100')).toEqual({ ok: false, code: 'ai_price_sent', total: 1250, by: 'owner' });
    const b = await answeredChain();
    const sent = await ownPrice(b.requestId, '1250');
    await wentOut(sent, new Date(T0.getTime() - 10 * 60_000));
    await customerSays(b.chat, 'Qimmat ekan, arzonroq bo‘lmaydimi?', new Date(T0.getTime() - 5 * 60_000));
    expect(await priceDraftFromText(holderId, b.requestId, '1100')).toMatchObject({ ok: true });
  });

  it('the «yubordim» went in HIS ✏️ words: no machine price on that chain, and the live head never forgives his message (finding 5)', async () => {
    const c = await answeredChain();
    const own = 'Hisoblatishga yubordim. Narxni o‘zim aytaman, taxminan 1500 $ atrofida bo‘ladi.';
    const [link] = await db.select().from(agentCalcLinks).where(eq(agentCalcLinks.requestId, c.requestId));
    await db.update(agentDrafts).set({ finalBody: own }).where(eq(agentDrafts.id, link!.draftId!));
    await db.update(agentOutbox).set({ body: own }).where(eq(agentOutbox.draftId, link!.draftId!));
    await db.update(tgMessages).set({ body: own }).where(and(eq(tgMessages.peerId, c.chat.peer), eq(tgMessages.tgMessageId, c.ours)));
    expect(await calcPriceFor({ managerUserId: holderId, peerId: c.chat.peer })).toEqual({ ok: false, reason: 'owner_words' });
    const sent: unknown[] = [];
    await announceAgentCalc(c.requestId, 'done', { amountText: '1234.56 USD' }, { enqueue: async (_n, d) => void sent.push(d), now: T0 });
    expect(sent).toHaveLength(0);
    // An owner-started reply on this chat (a VED answer's, written by any door): his ✏️ line after the anchor is HIS.
    const [d] = await db
      .insert(agentDrafts)
      .values({ managerUserId: holderId, peerId: c.chat.peer, leadId: c.chat.leadId, anchorTgMessageId: c.chat.anchor, status: 'approved', kind: 'reply', proposedBody: 'Rastamojka narxi 1359 $ bo‘ladi.', policy: { calcAnswer: { requestId: c.requestId } } })
      .returning({ id: agentDrafts.id });
    const [row] = await db
      .insert(agentOutbox)
      .values({ draftId: d!.id, managerUserId: holderId, peerId: c.chat.peer, leadId: c.chat.leadId, body: 'Rastamojka narxi 1359 $ bo‘ladi.', randomId: next(), answersTgMessageId: c.chat.anchor, status: 'agent', step: 'send', nextStepAt: T0, queuedBy: holderId })
      .returning({ id: agentOutbox.id });
    const facts = await sendFactsFor((await agentRowById(row!.id))!, STEP_NOW(), stepCtx());
    expect([...facts.forgivenOut]).not.toContain(c.ours);
    // …while the machine's own «yubordim» stays forgiven.
    await db.update(agentDrafts).set({ finalBody: null }).where(eq(agentDrafts.id, link!.draftId!));
    expect([...(await sendFactsFor((await agentRowById(row!.id))!, STEP_NOW(), stepCtx())).forgivenOut]).toContain(c.ours);
    await db.update(agentDrafts).set({ finalBody: own }).where(eq(agentDrafts.id, link!.draftId!));
    // The live head as Telegram shows it: his ✏️ line after the customer's — the machine's reply never goes past it.
    const head = [
      { id: c.ours, out: true, text: own, media: false },
      { id: c.chat.anchor, out: false, text: 'Rastamojka qancha bo‘ladi?', media: false },
    ];
    const facts2 = await sendFactsFor((await agentRowById(row!.id))!, STEP_NOW(), stepCtx());
    expect(liveHeadVerdict(head, c.chat.anchor, isNudge, AGENT_LIMITS.headMessages, facts2.forgivenOut)).toEqual({ ok: false, reason: 'human_replied' });
  });

  it('a chain whose «yubordim» never went (his ❌ after a lost race): no machine price on it, even when the customer asks (finding 6)', async () => {
    const leadId = await freshLead();
    const chat = await chatOn(leadId);
    const requestId = await request(leadId, 'rastamojka', chat);
    const [rejected] = await db
      .insert(agentDrafts)
      .values({ managerUserId: holderId, peerId: chat.peer, leadId, anchorTgMessageId: chat.anchor, status: 'rejected', kind: 'reply', proposedBody: 'Hisoblatishga yubordim.', actions: [{ type: 'calc_submit', section: 'rastamojka', facts: {}, fromOurWarehouse: false, citedMessageIds: [] }] })
      .returning({ id: agentDrafts.id });
    await db.update(agentCalcLinks).set({ draftId: rejected!.id }).where(eq(agentCalcLinks.requestId, requestId));
    await answered(requestId, '1234.56');
    expect(await calcPriceFor({ managerUserId: holderId, peerId: chat.peer })).toEqual({ ok: false, reason: 'not_linked' });
    const q = await customerSays(chat, 'Assalomu alaykum, rastamojka narxi chiqdimi?');
    const seen: ModelRequest[] = [];
    const out = await handleInbound({ managerUserId: holderId, peerId: String(chat.peer), anchorTgMessageId: String(q), origin: 'live' }, { callModel: scripted(PRICED('1359'), seen), now: () => T0 });
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
    const d = await draftOf((out as { draftId: string }).draftId);
    expect((d.policy as { memory: { calcPrices?: unknown[] } }).memory.calcPrices ?? []).toEqual([]);
    expect(d.blocked).toBe(true);
    expect(await pressDueAutos(DUE)).toBe(0);
  });

  it('«✅ Ustama to‘g‘ri» vouches only for the rule his page showed — a rule changed since is refused (finding 9)', async () => {
    const holder = { id: holderId, roles: ['super_admin'] };
    await markup('percent', '10', null);
    // Another writer moves the rule while his page still shows +10 %.
    await setCalcMarkup(holder, { kind: 'fixed', value: '1' }, { actorId: holderId });
    const refused = await confirmCalcMarkup(holder, 'percent:10', { actorId: holderId }).then(
      () => 'ok',
      (e: unknown) => (e instanceof AgentConfigError ? e.code : String(e)),
    );
    expect(refused).toBe('markup_changed');
    expect(await rawSetting(MARKUP_CONFIRMED_KEY)).toBeNull();
    expect(await confirmCalcMarkup(holder, 'fixed:1', { actorId: holderId })).toBe('fixed:1');
  });
});
