import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  agentCalcLinks,
  agentConfig,
  agentDrafts,
  agentOffers,
  agentOutbox,
  auditLog,
  calcGroups,
  calcOffers,
  calcRequests,
  calcVersions,
  clients,
  clientTransactions,
  dealStages,
  deals,
  events,
  expenseCategories,
  expenses,
  leadStages,
  leads,
  moneyAccounts,
  notifications,
  roles,
  settings,
  telegramLinks,
  tgAccountGuard,
  tgAccounts,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { enqueue, getBoss } from '@/modules/platform/jobs/boss';
import { AGENT_SEAT_KEY } from '@/modules/platform/settings/agent-seat';
import { handleAfterSent, OFFER_WORDS, queueMissedAfterSent } from '@/modules/wms/agent/after-sent';
import { calcPriceFor, MARKUP_CONFIRMED_KEY, type CalcPriceMark } from '@/modules/wms/agent/calc-price';
import { renderDraftCard } from '@/modules/wms/agent/card-io';
import { __forgetAgentFullP2Ready, __pretendAgentFullP2Behind, __restoreAgentConfig, readAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { loadContext } from '@/modules/wms/agent/context';
import { agentRowById, applyAgentOutcome } from '@/modules/wms/agent/outbox-store';
import { AFTER_SENT_RETRY_LIMIT, JOB_AGENT_AFTER_SENT } from '@/modules/wms/agent/queues';
import { offersFor, recordOffer } from '@/modules/wms/calc/workspace';
import { quoteHistoryFor } from '@/modules/wms/calc/history';
import { payableOffersSql } from '@/modules/wms/calc/upsale';
import { payUpsale, upsaleRows } from '@/modules/wms/calc/upsale-service';
import { arriveOnDeal, removeArrived } from '../fixtures/deal-cargo';

/**
 * The full AI seller, part 2, package P4 against a real database (SPEC-P2-v2 §2.4, §2.4a, §3.2, §3.4): what a reply
 * settles on the card once it REACHED the customer — the job queued from the listener's `sent` branch alone (one job
 * per row, pg-boss's real table), the VED price the machine quoted written as the card's offer with its mark in the
 * offer's own transaction, every «no» said on the card, commission never paid to a machine, and the lead moved on the
 * machine's own layer.
 *
 * pg-boss is REAL here (a replay must be proven ONE job on its own table); its jobs this file makes are removed, and
 * the boss is stopped. CONFIGURATION is the next file's input on the one shared database (#183): agent_config, the
 * seat, the markup, the two AI stage settings, the commission category and quote_valid_days are snapshotted and put
 * back in `finally`; the stages, leads, deals, requests and chats this file mints are removed; fixture people are
 * deactivated, never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
let seq = BigInt(`86${SUFFIX}`) * 1000n;
const next = () => ++seq;
const DAY = 86_400_000;
const peers: bigint[] = [];

let holderId = '';
let colleagueId = '';
let sellerId = '';
let accountId = '';
let agentSnapshot: AgentConfig | null = null;
const SETTING_KEYS = [
  AGENT_SEAT_KEY,
  'agent_calc_markup_kind',
  'agent_calc_markup_value',
  MARKUP_CONFIRMED_KEY,
  'quote_valid_days',
  'crm_ai_contacted_stage',
  'crm_ai_quoted_stage',
  'upsale_expense_category_id',
];
const settingsBefore = new Map<string, unknown>();
const stage: Record<'start' | 'contacted' | 'calc' | 'quoted' | 'won', string> = { start: '', contacted: '', calc: '', quoted: '', won: '' };
const madeLeads: string[] = [];
const madeRequests: string[] = [];
const madeDeals: string[] = [];
const madeClients: string[] = [];
const madeReceipts: string[] = [];
const madeOutbox: string[] = [];
let moneyAccountId = '';
let categoryId = '';
let fxId = '';

async function rawSetting(key: string): Promise<unknown> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return row ? row.value : null;
}

async function putSetting(key: string, value: unknown): Promise<void> {
  if (value === null) await db.delete(settings).where(eq(settings.key, key));
  else await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99891${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

async function freshLead(owner: string | null = holderId, stageId = stage.start): Promise<string> {
  const [l] = await db
    .insert(leads)
    .values({ name: `P4 lid ${SUFFIX}-${madeLeads.length + 1}`, stageId, ownerId: owner, nextActionAt: '2026-12-01', nextActionNote: 'qo‘ng‘iroq' })
    .returning({ id: leads.id });
  madeLeads.push(l!.id);
  return l!.id;
}

interface Chat {
  peer: bigint;
  leadId: string | null;
  clientId: string | null;
  anchor: bigint;
}

/** A chat: the customer's line, an hour ago. */
async function chatOn(card: { leadId?: string; clientId?: string }): Promise<Chat> {
  const peer = next();
  peers.push(peer);
  const anchor = next();
  await db.insert(tgMessages).values({
    leadId: card.leadId ?? null,
    clientId: card.clientId ?? null,
    managerUserId: holderId,
    peerId: peer,
    tgMessageId: anchor,
    direction: 'in',
    body: 'Rastamojka qancha bo‘ladi? Kurtka 100 dona.',
    sentAt: new Date(Date.now() - 60 * 60_000),
  });
  return { peer, leadId: card.leadId ?? null, clientId: card.clientId ?? null, anchor };
}

/**
 * The AI's submitting reply «yubordim», SENT in the machine's words (a draft, its outbox row, its Telegram line) — the
 * chain's price is the machine's to state only where it said «javob kelishi bilan aytaman» itself (calc-price
 * `submitReplyOf`). Its own after-sent outcome is recorded, so the sweep's net never counts it.
 */
async function submitted(chat: Chat, requestId: string): Promise<void> {
  const ours = next();
  const at = new Date(Date.now() - 55 * 60_000);
  const body = 'Hisoblatishga yubordim, javob kelishi bilan aytaman.';
  await db.insert(tgMessages).values({ leadId: chat.leadId, clientId: chat.clientId, managerUserId: holderId, peerId: chat.peer, tgMessageId: ours, direction: 'out', body, sentAt: at });
  const [d] = await db
    .insert(agentDrafts)
    .values({
      managerUserId: holderId,
      peerId: chat.peer,
      leadId: chat.leadId,
      clientId: chat.clientId,
      anchorTgMessageId: chat.anchor,
      status: 'approved',
      kind: 'reply',
      proposedBody: body,
      actions: [{ type: 'calc_submit', section: 'rastamojka', facts: {}, fromOurWarehouse: false, citedMessageIds: [] }],
      policy: { afterSent: { at: at.toISOString(), offer: [], stage: 'kind' } },
    })
    .returning({ id: agentDrafts.id });
  await db.insert(agentOutbox).values({
    draftId: d!.id,
    managerUserId: holderId,
    peerId: chat.peer,
    leadId: chat.leadId,
    clientId: chat.clientId,
    body,
    randomId: next(),
    answersTgMessageId: chat.anchor,
    status: 'sent',
    step: 'send',
    nextStepAt: at,
    queuedBy: holderId,
    sentAt: at,
    tgMessageId: ours,
  });
  await db.update(agentCalcLinks).set({ draftId: d!.id }).where(eq(agentCalcLinks.requestId, requestId));
}

/** A request on a card — linked to the chat (the AI submitted it, and its «yubordim» went) or not. */
async function request(card: { type: 'lead' | 'deal'; id: string }, link: Chat | null, opts: { volumeM3?: string; weightKg?: string } = {}): Promise<string> {
  const [r] = await db
    .insert(calcRequests)
    .values({
      entityType: card.type,
      entityId: card.id,
      requestedBy: holderId,
      itemCount: 1,
      section: 'rastamojka',
      dueAt: new Date(Date.now() + 3_600_000),
      requestedAt: new Date(Date.now() - 50 * 60_000),
      volumeM3: opts.volumeM3 ?? null,
      weightKg: opts.weightKg ?? null,
    })
    .returning({ id: calcRequests.id });
  madeRequests.push(r!.id);
  if (link) {
    await db.insert(agentCalcLinks).values({ requestId: r!.id, rootRequestId: r!.id, managerUserId: holderId, peerId: link.peer });
    await submitted(link, r!.id);
  }
  return r!.id;
}

/** The VED's «Готово» answer, `ago` before now. */
async function answered(requestId: string, amount: string, ago = 30 * 60_000) {
  await db
    .update(calcRequests)
    .set({ completedAt: new Date(Date.now() - ago), completedVia: 'task', answerAmount: amount, answerCurrency: 'USD' })
    .where(eq(calcRequests.id, requestId));
}

/** A lead chat whose linked request the VED answered — and the price the machine quoted for it, as it stored it. */
async function pricedChain(opts: { owner?: string | null; amount?: string } = {}) {
  const leadId = await freshLead(opts.owner === undefined ? holderId : opts.owner);
  const chat = await chatOn({ leadId });
  const requestId = await request({ type: 'lead', id: leadId }, chat);
  await answered(requestId, opts.amount ?? '1234.56');
  const priced = await calcPriceFor({ managerUserId: holderId, peerId: chat.peer });
  if (!priced.ok) throw new Error(`fixture: ${priced.reason}`);
  return { chat, leadId, requestId, marks: priced.prices };
}

/**
 * A reply of `kind`, approved, and its outbox row at `status` (default: SENT a few minutes ago, with its thread line).
 * The draft's stored memory is `memory` — what the run wrote.
 */
async function reply(
  chat: Chat,
  opts: {
    kind?: 'reply' | 'price' | 'hand_back';
    memory?: Record<string, unknown>;
    finalBody?: string | null;
    language?: string | null;
    status?: 'agent' | 'sent' | 'cancelled' | 'unknown' | 'failed';
    sentAgoMs?: number;
    afterSent?: Record<string, unknown>;
  } = {},
): Promise<{ draftId: string; outboxId: string }> {
  const status = opts.status ?? 'sent';
  const at = new Date(Date.now() - (opts.sentAgoMs ?? 5 * 60_000));
  const body = opts.finalBody ?? 'Rastamojka narxi 1 359 $ bo‘ladi.';
  const tgId = status === 'sent' ? next() : null;
  if (tgId !== null) {
    await db.insert(tgMessages).values({ leadId: chat.leadId, clientId: chat.clientId, managerUserId: holderId, peerId: chat.peer, tgMessageId: tgId, direction: 'out', body, sentAt: at });
  }
  const [d] = await db
    .insert(agentDrafts)
    .values({
      managerUserId: holderId,
      peerId: chat.peer,
      leadId: chat.leadId,
      clientId: chat.clientId,
      anchorTgMessageId: chat.anchor,
      status: 'approved',
      kind: opts.kind ?? 'reply',
      proposedBody: 'Rastamojka narxi 1 359 $ bo‘ladi.',
      finalBody: opts.finalBody ?? null,
      language: opts.language === undefined ? 'uz' : opts.language,
      decidedBy: holderId,
      decidedAt: at,
      policy: {
        memory: opts.memory ?? {},
        card: { customerLabel: 'P4 mijoz', lastOut: null, customerLines: [] },
        notes: [],
        ...(opts.afterSent ? { afterSent: opts.afterSent } : {}),
      },
    })
    .returning({ id: agentDrafts.id });
  const [o] = await db
    .insert(agentOutbox)
    .values({
      draftId: d!.id,
      managerUserId: holderId,
      peerId: chat.peer,
      leadId: chat.leadId,
      clientId: chat.clientId,
      body,
      randomId: next(),
      answersTgMessageId: chat.anchor,
      status,
      step: 'send',
      nextStepAt: at,
      queuedBy: holderId,
      sentAt: status === 'sent' ? at : null,
      tgMessageId: tgId,
    })
    .returning({ id: agentOutbox.id });
  madeOutbox.push(o!.id);
  return { draftId: d!.id, outboxId: o!.id };
}

const draftOf = async (id: string) => (await db.select().from(agentDrafts).where(eq(agentDrafts.id, id)))[0]!;
const leadOf = async (id: string) => (await db.select().from(leads).where(eq(leads.id, id)))[0]!;
const offersOn = async (requestId: string) => db.select().from(calcOffers).where(eq(calcOffers.requestId, requestId));
const marksOn = async (requestId: string) => db.select().from(agentOffers).where(eq(agentOffers.requestId, requestId));
const calcMemory = (marks: CalcPriceMark[]) => ({ calcPrices: marks, sources: [{ kind: 'money', value: marks[0]!.total, origin: 'tool' }] });

async function afterSentJobs(outboxId: string) {
  return db.execute<{ id: string; state: string; retry_limit: number; outbox: string | null }>(sql`
    SELECT id::text, state::text, retry_limit, data->>'outboxId' AS outbox FROM pgboss.job WHERE name = ${JOB_AGENT_AFTER_SENT} AND id = ${outboxId}::uuid`);
}

beforeAll(async () => {
  agentSnapshot = await readAgentConfig();
  if (!agentSnapshot) throw new Error('0138 is not applied on this database');
  for (const key of SETTING_KEYS) settingsBefore.set(key, await rawSetting(key));
  holderId = await makeUser(`P4 egasi ${SUFFIX}`, 'super_admin', '01');
  colleagueId = await makeUser(`P4 hamkasb ${SUFFIX}`, 'sales_manager', '02');
  sellerId = await makeUser(`P4 sotuvchi ${SUFFIX}`, 'sales_manager', '03');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: holderId, tgPhone: `+99892${SUFFIX}01`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date(), workAccount: true })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  // The holder's staff chat is LINKED: a recorded offer would push its text and sheet there (recordOffer) — so its
  // absence after the machine's offer is the `push: false` and not a chat nobody could reach.
  await db.insert(telegramLinks).values({ userId: holderId, telegramChatId: BigInt(`77${SUFFIX}01`), status: 'linked', linkedAt: new Date() });
  const kinds = [
    ['start', 'open', 9_401],
    ['contacted', 'open', 9_402],
    ['calc', 'open', 9_403],
    ['quoted', 'open', 9_404],
    ['won', 'won', 9_405],
  ] as const;
  for (const [key, kind, sortOrder] of kinds) {
    const [s] = await db.insert(leadStages).values({ name: `P4 ${key} ${SUFFIX}`, kind, sortOrder }).returning({ id: leadStages.id });
    stage[key] = s!.id;
  }
  await db
    .update(agentConfig)
    .set({ mode: 'shadow', ownerUserId: holderId, sessionExclusiveAt: new Date(), sessionExclusiveBy: holderId, startedAt: new Date(Date.now() - 30 * DAY) })
    .where(eq(agentConfig.id, 1));
  await putSetting('quote_valid_days', 30);
  await putSetting('crm_ai_contacted_stage', null);
  await putSetting('crm_ai_quoted_stage', null);
  // The commission's own fixtures (payUpsale's doors before its claim): a category, a USD till, a USD rate.
  const [acct] = await db.insert(moneyAccounts).values({ name: `P4 kassa ${SUFFIX}`, currency: 'USD' }).returning({ id: moneyAccounts.id });
  moneyAccountId = acct!.id;
  const [cat] = await db.insert(expenseCategories).values({ name: `P4 ulush ${SUFFIX}` }).returning({ id: expenseCategories.id });
  categoryId = cat!.id;
  await putSetting('upsale_expense_category_id', categoryId);
  const [fx] = await db.execute<{ id: string }>(sql`
    INSERT INTO fx_rates (id, currency, rate_to_usd, effective_date, entered_by)
    VALUES (gen_random_uuid(), 'USD', 1, CURRENT_DATE, ${holderId}::uuid)
    ON CONFLICT (currency, effective_date) DO NOTHING
    RETURNING id`);
  fxId = fx?.id ?? '';
});

beforeEach(async () => {
  // The markup the machine priced with, vouched for; the seat named on the holder. Each test says what it changes.
  await putSetting('agent_calc_markup_kind', 'percent');
  await putSetting('agent_calc_markup_value', '10');
  await putSetting(MARKUP_CONFIRMED_KEY, 'percent:10');
  await putSetting(AGENT_SEAT_KEY, holderId);
  await db.update(agentConfig).set({ ownerUserId: holderId }).where(eq(agentConfig.id, 1));
});

afterEach(() => {
  vi.restoreAllMocks();
  __forgetAgentFullP2Ready();
});

afterAll(async () => {
  try {
    if (madeOutbox.length) {
      // By the job's id and by the row it names: a job queued under another id (a red proof's) names the row too.
      await db
        .execute(
          sql`DELETE FROM pgboss.job WHERE name = ${JOB_AGENT_AFTER_SENT}
                AND (id IN (${sql.join(madeOutbox.map((id) => sql`${id}::uuid`), sql`, `)})
                     OR data->>'outboxId' IN (${sql.join(madeOutbox.map((id) => sql`${id}`), sql`, `)}))`,
        )
        .catch(() => undefined);
    }
    // A payout an un-fenced run made (a red proof) names its expense: the pointer goes before the row.
    const paid = await db
      .select({ expenseId: calcOffers.payoutExpenseId })
      .from(calcOffers)
      .where(madeRequests.length ? inArray(calcOffers.requestId, madeRequests) : sql`false`);
    const expenseIds = paid.map((p) => p.expenseId).filter((e): e is string => e !== null);
    if (madeRequests.length) {
      await db.update(calcOffers).set({ payoutExpenseId: null, payoutAt: null, payoutBy: null, payoutUsd: null }).where(inArray(calcOffers.requestId, madeRequests));
      await db.delete(calcOffers).where(inArray(calcOffers.requestId, madeRequests));
      // A seal-anchored offer names its version, not its request.
      const versions = await db.select({ id: calcVersions.id }).from(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
      if (versions.length) await db.delete(calcOffers).where(inArray(calcOffers.versionId, versions.map((v) => v.id)));
    }
    if (expenseIds.length) await db.delete(expenses).where(inArray(expenses.id, expenseIds));
    if (peers.length) {
      await db.delete(agentCalcLinks).where(inArray(agentCalcLinks.peerId, peers));
      await db.delete(agentOutbox).where(inArray(agentOutbox.peerId, peers));
      await db.delete(agentDrafts).where(inArray(agentDrafts.peerId, peers));
      await db.delete(tgMessages).where(inArray(tgMessages.peerId, peers));
    }
    await db.delete(notifications).where(inArray(notifications.userId, [holderId, colleagueId, sellerId]));
    await db.delete(telegramLinks).where(eq(telegramLinks.userId, holderId));
    if (madeRequests.length) await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await removeArrived(madeReceipts);
    if (madeClients.length) await db.delete(clientTransactions).where(inArray(clientTransactions.clientId, madeClients));
    if (madeDeals.length) await db.delete(deals).where(inArray(deals.id, madeDeals));
    if (madeClients.length) await db.update(clients).set({ active: false }).where(inArray(clients.id, madeClients));
    if (madeLeads.length) {
      await db.delete(events).where(inArray(events.entityId, madeLeads));
      await db.delete(leads).where(inArray(leads.id, madeLeads));
    }
    await db.delete(leadStages).where(inArray(leadStages.id, Object.values(stage).filter(Boolean)));
    await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
    await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
    if (fxId) await db.execute(sql`DELETE FROM fx_rates WHERE id = ${fxId}::uuid`);
  } finally {
    await __restoreAgentConfig(agentSnapshot);
    for (const [key, value] of settingsBefore) await putSetting(key, value);
    await db.update(moneyAccounts).set({ active: false }).where(eq(moneyAccounts.id, moneyAccountId));
    await db.update(expenseCategories).set({ active: false }).where(eq(expenseCategories.id, categoryId));
    await db.update(users).set({ active: false }).where(inArray(users.id, [holderId, colleagueId, sellerId]));
    await getBoss()
      .stop({ graceful: false, wait: true })
      .catch(() => undefined);
    await pgClient.end();
  }
});

describe('the job is queued from the listener’s `sent` branch alone — one job per row (§3.2 crm 5)', () => {
  it('a sent outcome queues ONE job named by the row; its replay after a blip is still one job', async () => {
    const c = await pricedChain();
    const { outboxId } = await reply(c.chat, { status: 'agent', memory: calcMemory(c.marks) });
    const row = (await agentRowById(outboxId))!;
    const account = { id: accountId, managerUserId: holderId, managerName: 'P4' };
    const tgId = next();
    await applyAgentOutcome(row, { kind: 'sent', tgMessageId: tgId }, account);
    // The listener replays an outcome whose bookkeeping blipped — the same row, the same outcome.
    await applyAgentOutcome(row, { kind: 'sent', tgMessageId: tgId }, account);
    const jobs = await afterSentJobs(outboxId);
    expect(jobs.map((j) => [j.outbox, j.retry_limit])).toEqual([[outboxId, AFTER_SENT_RETRY_LIMIT]]);
    expect((await db.select().from(agentOutbox).where(eq(agentOutbox.id, outboxId)))[0]!.status).toBe('sent');
  });

  it('a cancel, an unknown and a failure — each settles the card and queues NOTHING', async () => {
    const c = await pricedChain();
    const account = { id: accountId, managerUserId: holderId, managerName: 'P4' };
    const outcomes = [
      { kind: 'cancel', reason: 'human_replied', markUnread: false },
      { kind: 'unknown', reason: 'timeout' },
      { kind: 'failed', reason: 'MESSAGE_EMPTY', markUnread: false, error: { kind: 'message_final', code: 'MESSAGE_EMPTY' } },
    ] as const;
    for (const outcome of outcomes) {
      const { outboxId } = await reply(c.chat, { status: 'agent', memory: calcMemory(c.marks) });
      await applyAgentOutcome((await agentRowById(outboxId))!, outcome as never, account);
      expect(await afterSentJobs(outboxId), outcome.kind).toHaveLength(0);
    }
  });

  it('the sweep’s net: a sent row with no recorded outcome is queued — not one too young, too old or already recorded', async () => {
    const c = await pricedChain();
    const due = await reply(c.chat, { memory: calcMemory(c.marks) });
    const young = await reply(c.chat, { memory: calcMemory(c.marks), sentAgoMs: 30_000 });
    const old = await reply(c.chat, { memory: calcMemory(c.marks), sentAgoMs: 25 * 3_600_000 });
    const recorded = await reply(c.chat, { memory: calcMemory(c.marks), afterSent: { at: new Date().toISOString(), offer: [], stage: 'x' } });
    const cancelled = await reply(c.chat, { status: 'cancelled', memory: calcMemory(c.marks) });
    const seen: string[] = [];
    await queueMissedAfterSent(new Date(), async (id) => {
      seen.push(id);
      return id;
    });
    expect(seen).toContain(due.outboxId);
    for (const not of [young, old, recorded, cancelled]) expect(seen).not.toContain(not.outboxId);
    // Its enqueue names the job by the row (jobs.ts): a job that exists — waiting, running or failed — is not doubled.
    const send = () => enqueue(JOB_AGENT_AFTER_SENT, { outboxId: due.outboxId }, { id: due.outboxId, retryLimit: AFTER_SENT_RETRY_LIMIT });
    expect(await send()).toBe(due.outboxId);
    expect(await send()).toBeNull();
    expect(await afterSentJobs(due.outboxId)).toHaveLength(1);
  });
});

describe('the offer — written onto the card after the price WENT (§2.4)', () => {
  it('one calc_offers row + its mark, no CalcOffer push, the card’s price, the locale mapped; a retry writes nothing twice', async () => {
    const c = await pricedChain();
    const { draftId, outboxId } = await reply(c.chat, { memory: calcMemory(c.marks), language: 'uz_cyrl' });
    const out = await handleAfterSent({ outboxId });
    expect(out).toEqual({ outcome: 'done', offer: ['💳 Kartaga yozildi: 1 359 $'], stage: 'not_configured' });
    const [offer, ...more] = await offersOn(c.requestId);
    expect(more).toHaveLength(0);
    expect(offer).toMatchObject({ clientPriceUsd: '1359.00', offeredBy: holderId, locale: 'uz', belowFloor: false, entityType: 'lead', entityId: c.leadId });
    expect(await marksOn(c.requestId)).toEqual([expect.objectContaining({ offerId: offer!.id, requestId: c.requestId, draftId })]);
    expect((await leadOf(c.leadId)).quotedAmount).toBe('1359.00');
    // The customer already has the price: no forwardable second «offer» lands in the holder's chat.
    const pushed = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, holderId), eq(notifications.type, 'CalcOffer')));
    expect(pushed).toHaveLength(0);
    // The card says it, and the card's offer list marks it «🤖 AI».
    const d = await draftOf(draftId);
    expect(renderDraftCard(d, (await db.select().from(agentOutbox).where(eq(agentOutbox.id, outboxId)))[0]!)).toContain('💳 Kartaga yozildi: 1 359 $');
    expect((await offersFor('lead', c.leadId)).map((o) => [o.clientPriceUsd, o.byAi])).toEqual([['1359.00', true]]);
    // The audit names the machine; no floor, no rule in it (law 4).
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'calc_offer'), eq(auditLog.entityId, offer!.id)));
    expect(audit!.after).toMatchObject({ clientPriceUsd: 1359, via: 'ai' });
    expect(JSON.stringify(audit!.after)).not.toMatch(/1234|percent/u);
    // A redelivery of the same job: recorded, nothing written twice.
    expect(await handleAfterSent({ outboxId })).toEqual({ outcome: 'recorded_before' });
    // A retry whose first attempt died after the offer (no record yet): the mark answers, no second offer.
    await db.update(agentDrafts).set({ policy: sql`${agentDrafts.policy} - 'afterSent'` }).where(eq(agentDrafts.id, draftId));
    expect(await handleAfterSent({ outboxId })).toMatchObject({ outcome: 'done', offer: ['💳 Kartaga yozildi: 1 359 $'] });
    expect(await offersOn(c.requestId)).toHaveLength(1);
  });

  it('ONE transaction: a mark that cannot be written leaves no offer and no price on the card', async () => {
    const c = await pricedChain();
    const err = await recordOffer(
      { requestId: c.requestId },
      { clientPriceUsd: 1359, locale: 'uz', mayApprove: false, push: false, machine: { draftId: randomUUID() } },
      { actorId: holderId },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(await offersOn(c.requestId)).toHaveLength(0);
    expect(await marksOn(c.requestId)).toHaveLength(0);
    expect((await leadOf(c.leadId)).quotedAmount).toBeNull();
  });

  it('❌ (no row), a send-step cancel, an unknown and a failure — no offer, no price on the card', async () => {
    const c = await pricedChain();
    expect(await handleAfterSent({ outboxId: randomUUID() })).toEqual({ outcome: 'gone' });
    for (const status of ['cancelled', 'unknown', 'failed'] as const) {
      const { outboxId } = await reply(c.chat, { status, memory: calcMemory(c.marks) });
      expect(await handleAfterSent({ outboxId })).toEqual({ outcome: 'not_sent', status });
    }
    expect(await offersOn(c.requestId)).toHaveLength(0);
    expect((await leadOf(c.leadId)).quotedAmount).toBeNull();
  });

  it('his ✏️ words went — no offer; the card says to write it by hand', async () => {
    const c = await pricedChain();
    const { outboxId } = await reply(c.chat, { memory: calcMemory(c.marks), finalBody: 'Narxi 1 400 $ bo‘ladi, aka.' });
    expect(await handleAfterSent({ outboxId })).toMatchObject({ offer: [OFFER_WORDS.notWritten(OFFER_WORDS.ownText)] });
    expect(await offersOn(c.requestId)).toHaveLength(0);
  });

  it('the quote expired between the send and the job — no offer, said in words', async () => {
    const c = await pricedChain();
    const { outboxId } = await reply(c.chat, { memory: calcMemory(c.marks) });
    await answered(c.requestId, '1234.56', 31 * DAY);
    const out = await handleAfterSent({ outboxId });
    expect(out).toMatchObject({ offer: ['💳 Kartaga yozilmadi: VED javobining muddati o‘tgan'] });
    expect(await offersOn(c.requestId)).toHaveLength(0);
  });

  it('a markup edited after the send — the quoted figure no longer stands: no offer', async () => {
    const c = await pricedChain();
    const { outboxId } = await reply(c.chat, { memory: calcMemory(c.marks) });
    await putSetting('agent_calc_markup_value', '12');
    expect(await handleAfterSent({ outboxId })).toMatchObject({ offer: [OFFER_WORDS.notWritten(OFFER_WORDS.moved)] });
    expect(await offersOn(c.requestId)).toHaveLength(0);
  });

  it('holder ≠ seat — no offer, said: no seat named, or the seat is somebody else', async () => {
    const c = await pricedChain();
    await putSetting(AGENT_SEAT_KEY, null);
    const first = await reply(c.chat, { memory: calcMemory(c.marks) });
    expect(await handleAfterSent({ outboxId: first.outboxId })).toMatchObject({ offer: [OFFER_WORDS.notWritten(OFFER_WORDS.noSeat)] });
    await putSetting(AGENT_SEAT_KEY, colleagueId);
    const second = await reply(c.chat, { memory: calcMemory(c.marks) });
    expect(await handleAfterSent({ outboxId: second.outboxId })).toMatchObject({ offer: [OFFER_WORDS.notWritten(OFFER_WORDS.seatMoved)] });
    // The seat names the holder but the reply left from an account the AI no longer speaks from.
    await putSetting(AGENT_SEAT_KEY, holderId);
    await db.update(agentConfig).set({ ownerUserId: colleagueId }).where(eq(agentConfig.id, 1));
    const third = await reply(c.chat, { memory: calcMemory(c.marks) });
    expect(await handleAfterSent({ outboxId: third.outboxId })).toMatchObject({ offer: [OFFER_WORDS.notWritten(OFFER_WORDS.seatMoved)] });
    expect(await offersOn(c.requestId)).toHaveLength(0);
  });

  it('a colleague’s card — never the AI’s offer (it would overwrite his price and displace his offer)', async () => {
    const c = await pricedChain({ owner: colleagueId });
    const { outboxId } = await reply(c.chat, { memory: calcMemory(c.marks) });
    expect(await handleAfterSent({ outboxId })).toMatchObject({ offer: [OFFER_WORDS.notWritten(OFFER_WORDS.foreign)] });
    expect(await offersOn(c.requestId)).toHaveLength(0);
    expect((await leadOf(c.leadId)).quotedAmount).toBeNull();
  });

  it('one migration behind 0149 — nothing written, said; the list reads as before', async () => {
    const c = await pricedChain();
    const { outboxId } = await reply(c.chat, { memory: calcMemory(c.marks) });
    __pretendAgentFullP2Behind();
    expect(await handleAfterSent({ outboxId })).toMatchObject({ offer: [OFFER_WORDS.notWritten(OFFER_WORDS.behind)] });
    expect(await offersFor('lead', c.leadId)).toEqual([]);
  });
});

describe('the offer history says «🤖 AI» — a mechanical markup is no seller’s promise (§2.4a)', () => {
  it('the newest offer on a sealed quote is the AI’s: the price history marks it; one migration behind it reads as before', async () => {
    const leadId = await freshLead();
    const chat = await chatOn({ leadId });
    const requestId = await request({ type: 'lead', id: leadId }, chat);
    const at = new Date(Date.now() - 30 * 60_000);
    const [v] = await db
      .insert(calcVersions)
      .values({ requestId, versionNo: 1, sealedAt: at, sealedBy: holderId, validUntil: new Date(Date.now() + 10 * DAY), section: 'rastamojka', totalUsd: '1300' })
      .returning({ id: calcVersions.id });
    await db.update(calcRequests).set({ completedAt: at, completedVia: 'sealed', currentVersionNo: 1 }).where(eq(calcRequests.id, requestId));
    const code = `85${SUFFIX}01`;
    await db.insert(calcGroups).values({ requestId, seq: 1, label: 'Kurtka', tnvedCode: code });
    await recordOffer({ versionId: v!.id }, { clientPriceUsd: 1400, locale: 'uz' }, { actorId: sellerId });
    const { draftId } = await reply(chat, { status: 'cancelled' });
    await recordOffer({ versionId: v!.id }, { clientPriceUsd: 1430, locale: 'uz', mayApprove: false, push: false, machine: { draftId } }, { actorId: holderId });
    const [row] = await quoteHistoryFor(code, { scope: 'all', viewerId: holderId });
    expect(row).toMatchObject({ versionId: v!.id, clientPriceUsd: 1430, offerByAi: true });
    // A price the reader may not see carries no mark either.
    const [none] = await quoteHistoryFor(code, { scope: 'none', viewerId: holderId });
    expect(none).toMatchObject({ clientPriceUsd: null, offerByAi: false });
    __pretendAgentFullP2Behind();
    expect((await quoteHistoryFor(code, { scope: 'all', viewerId: holderId }))[0]).toMatchObject({ clientPriceUsd: 1430, offerByAi: false });
  });
});

describe('commission is never paid to a machine (§2.4a)', () => {
  /** A deal of its own, its cargo arrived as quoted, a «Готово» answer of 1 000 $, invoiced and collected at 1 300 $. */
  async function payableDeal() {
    const [cl] = await db
      .insert(clients)
      .values({ clientCode: `PF${SUFFIX}${madeClients.length + 1}`, name: `P4 pul ${SUFFIX}`, phones: [] })
      .returning({ id: clients.id });
    madeClients.push(cl!.id);
    const ds = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
    const [d] = await db
      .insert(deals)
      .values({ code: `PF-${SUFFIX}-${madeDeals.length + 1}`, clientId: cl!.id, stageId: ds!.id, title: 'P4 pul', createdBy: holderId })
      .returning({ id: deals.id });
    madeDeals.push(d!.id);
    madeReceipts.push(await arriveOnDeal({ dealId: d!.id, clientId: cl!.id, actorId: holderId, m3: 10, kg: 500 }));
    const requestId = await request({ type: 'deal', id: d!.id }, null, { volumeM3: '10', weightKg: '500' });
    await answered(requestId, '1000');
    const day = new Date().toISOString().slice(0, 10);
    for (const type of ['charge', 'payment'] as const) {
      await db.insert(clientTransactions).values({
        clientId: cl!.id,
        dealId: d!.id,
        type,
        amount: '1300',
        currency: 'USD',
        rateToUsd: '1',
        amountUsd: '1300',
        txDate: day,
        note: `P4 ${type}`,
        createdBy: holderId,
      });
    }
    return { dealId: d!.id, requestId };
  }

  const unpaidOn = async (dealId: string, machineOffers: boolean) =>
    (
      await db.execute<{ id: string; payable_usd: string }>(
        sql`SELECT id::text, payable_usd::text FROM (${payableOffersSql({ machineOffers })}) p WHERE p.entity_id = ${dealId}::uuid AND p.payout_expense_id IS NULL`,
      )
    ).map((r) => [r.id, Number(r.payable_usd)]);
  const listed = async (offerId: string, sellerFilter: string) =>
    (await upsaleRows('all', holderId, { sellerId: sellerFilter, walk: 'fifo' })).rows.find((r) => r.offerId === offerId) ?? null;

  it('never payable, never listed, refused by the payout — and an OLDER person’s offer on the same job is not promoted', async () => {
    const { dealId, requestId } = await payableDeal();
    const human = await recordOffer({ requestId }, { clientPriceUsd: 1300, locale: 'uz' }, { actorId: sellerId });
    // The control: before the AI's price, the seller's promise is owed (300 $ over the 1 000 $ floor).
    expect(await unpaidOn(dealId, true)).toEqual([[human.id, 300]]);
    expect((await listed(human.id, sellerId))?.state).toBe('payable');

    const chat = await chatOn({ clientId: madeClients.at(-1)! });
    const { draftId } = await reply(chat, { status: 'cancelled' });
    const ai = await recordOffer({ requestId }, { clientPriceUsd: 1100, locale: 'uz', mayApprove: false, push: false, machine: { draftId } }, { actorId: holderId });
    // The AI's price is the job's newest promise (rn 1) — excluded AFTER the rank: nothing on the job is owed.
    expect(await unpaidOn(dealId, true)).toEqual([]);
    expect(await listed(ai.id, holderId)).toBeNull();
    expect(await listed(human.id, sellerId)).toBeNull();
    await expect(payUpsale([ai.id], { accountId: moneyAccountId, currency: 'USD', expenseDate: new Date().toISOString().slice(0, 10) }, { actorId: holderId })).rejects.toMatchObject({
      code: 'offer_not_payable',
    });
    // Re-pointing the AI's account moves no money: the mark is per offer, written once.
    await db.update(agentConfig).set({ ownerUserId: sellerId }).where(eq(agentConfig.id, 1));
    expect(await unpaidOn(dealId, true)).toEqual([]);
    // Today's fragment (the probe false — one migration behind): the AI's offer WOULD be the payable one.
    expect(await unpaidOn(dealId, false)).toEqual([[ai.id, 100]]);
    __pretendAgentFullP2Behind();
    expect((await listed(ai.id, holderId))?.state).toBe('payable');
  });

  it('the rendered fragment with the probe false carries no word of agent_offers', () => {
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(payableOffersSql({ machineOffers: false })).sql).not.toContain('agent_offers');
    expect(dialect.sqlToQuery(payableOffersSql({ machineOffers: true })).sql).toContain('agent_offers');
  });
});

describe('the stage step — the machine’s own layer, after the reply went (§3.2)', () => {
  beforeEach(async () => {
    await putSetting('crm_ai_contacted_stage', stage.contacted);
    await putSetting('crm_ai_quoted_stage', stage.quoted);
  });
  afterEach(async () => {
    await putSetting('crm_ai_contacted_stage', null);
    await putSetting('crm_ai_quoted_stage', null);
  });

  const leadChat = async (owner: string | null = holderId) => {
    const leadId = await freshLead(owner);
    return { leadId, chat: await chatOn({ leadId }) };
  };

  it('the first AI reply → «AI birinchi javob berdi»: the booked call date kept, the audit names the machine', async () => {
    const { leadId, chat } = await leadChat();
    const { outboxId, draftId } = await reply(chat, { memory: {} });
    expect(await handleAfterSent({ outboxId })).toEqual({ outcome: 'done', offer: [], stage: 'moved:ai_contacted' });
    const lead = await leadOf(leadId);
    expect(lead.stageId).toBe(stage.contacted);
    expect(lead.nextActionAt).toBe('2026-12-01');
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'lead'), eq(auditLog.entityId, leadId)))
      .orderBy(desc(auditLog.createdAt));
    expect(audit).toMatchObject({ actorId: null, after: { stageId: stage.contacted, via: 'ai', holder: holderId } });
    expect(((await draftOf(draftId)).policy as { afterSent: { stage: string } }).afterSent.stage).toBe('moved:ai_contacted');
  });

  it('an estimate, a VED price and his 💵 each → «AI narx aytdi»', async () => {
    const estimate = await leadChat();
    const e = await reply(estimate.chat, { memory: { estimates: [{ kind: 'yolkira', usd: 900 }] } });
    expect(await handleAfterSent({ outboxId: e.outboxId })).toMatchObject({ stage: 'moved:ai_quoted' });
    expect((await leadOf(estimate.leadId)).stageId).toBe(stage.quoted);

    const c = await pricedChain();
    const p = await reply(c.chat, { memory: calcMemory(c.marks) });
    expect(await handleAfterSent({ outboxId: p.outboxId })).toMatchObject({ stage: 'moved:ai_quoted', offer: ['💳 Kartaga yozildi: 1 359 $'] });
    expect((await leadOf(c.leadId)).stageId).toBe(stage.quoted);

    const his = await leadChat();
    const h = await reply(his.chat, { kind: 'price', finalBody: 'Rastamojka 1 500 $.' });
    expect(await handleAfterSent({ outboxId: h.outboxId })).toMatchObject({ stage: 'moved:ai_quoted' });
    expect((await leadOf(his.leadId)).stageId).toBe(stage.quoted);
  });

  it('a truck estimate while a VED job is open sits on the job (his §7 Q12 ⭐ a); a VED price would not', async () => {
    const { leadId, chat } = await leadChat();
    await request({ type: 'lead', id: leadId }, chat);
    const { outboxId } = await reply(chat, { memory: { estimates: [{ kind: 'yolkira', usd: 900 }] } });
    expect(await handleAfterSent({ outboxId })).toMatchObject({ stage: 'open_calc' });
    expect((await leadOf(leadId)).stageId).toBe(stage.start);
  });

  it('cancelled, unknown, failed — nothing moves', async () => {
    const { leadId, chat } = await leadChat();
    for (const status of ['cancelled', 'unknown', 'failed'] as const) {
      const { outboxId } = await reply(chat, { status });
      expect(await handleAfterSent({ outboxId })).toEqual({ outcome: 'not_sent', status });
    }
    expect((await leadOf(leadId)).stageId).toBe(stage.start);
  });

  it('a refusal by the mover’s own rules completes the job — a colleague’s lead, a won lead, a client chat', async () => {
    const theirs = await leadChat(colleagueId);
    const t = await reply(theirs.chat, { memory: {} });
    expect(await handleAfterSent({ outboxId: t.outboxId })).toEqual({ outcome: 'done', offer: [], stage: 'not_mine' });
    expect((await leadOf(theirs.leadId)).stageId).toBe(stage.start);
    // Recorded: the net leaves it alone, nothing is asked again.
    expect(await handleAfterSent({ outboxId: t.outboxId })).toEqual({ outcome: 'recorded_before' });

    const wonLead = await freshLead(holderId, stage.won);
    const w = await reply(await chatOn({ leadId: wonLead }), { memory: {} });
    expect(await handleAfterSent({ outboxId: w.outboxId })).toMatchObject({ stage: 'current_closed' });
    expect((await leadOf(wonLead)).stageId).toBe(stage.won);

    // A client chat (the row's lead NULL — a won lead's client chat moves nothing): its lead stays where it is.
    const [cl] = await db
      .insert(clients)
      .values({ clientCode: `PC${SUFFIX}`, name: `P4 mijoz ${SUFFIX}`, phones: [] })
      .returning({ id: clients.id });
    madeClients.push(cl!.id);
    const c = await reply(await chatOn({ clientId: cl!.id }), { memory: {} });
    expect(await handleAfterSent({ outboxId: c.outboxId })).toMatchObject({ stage: 'client_chat' });
  });

  it('a database error is the one thing that retries: nothing recorded, the next attempt moves', async () => {
    const { leadId, chat } = await leadChat();
    const { outboxId, draftId } = await reply(chat, { memory: {} });
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(Object.assign(new Error('Connection terminated'), { code: '57P01' }));
    await expect(handleAfterSent({ outboxId })).rejects.toThrow('Connection terminated');
    expect(((await draftOf(draftId)).policy as { afterSent?: unknown }).afterSent).toBeUndefined();
    expect((await leadOf(leadId)).stageId).toBe(stage.start);
    vi.restoreAllMocks();
    expect(await handleAfterSent({ outboxId })).toMatchObject({ stage: 'moved:ai_contacted' });
  });

  it('a quote with «AI narx aytdi» left empty still takes «AI birinchi javob berdi» (a quote is a reply)', async () => {
    await putSetting('crm_ai_quoted_stage', null);
    const { leadId, chat } = await leadChat();
    const { outboxId } = await reply(chat, { memory: { estimates: [{ kind: 'yolkira', usd: 900 }] } });
    expect(await handleAfterSent({ outboxId })).toMatchObject({ stage: 'moved:ai_contacted' });
    expect((await leadOf(leadId)).stageId).toBe(stage.contacted);
  });

  it('the stages empty (how it ships) — nothing moves, the job is done', async () => {
    await putSetting('crm_ai_contacted_stage', null);
    await putSetting('crm_ai_quoted_stage', null);
    const { leadId, chat } = await leadChat();
    const { outboxId } = await reply(chat, { memory: {} });
    expect(await handleAfterSent({ outboxId })).toEqual({ outcome: 'done', offer: [], stage: 'not_configured' });
    expect((await leadOf(leadId)).stageId).toBe(stage.start);
  });
});

describe('the model learns the stage of a LEAD chat (§3.4)', () => {
  it('loadContext reads it for a lead chat; a client chat has none', async () => {
    const leadId = await freshLead(holderId, stage.calc);
    const chat = await chatOn({ leadId });
    expect((await loadContext(holderId, chat.peer, null)).leadStage).toEqual({ name: `P4 calc ${SUFFIX}`, kind: 'open' });
    const [cl] = await db
      .insert(clients)
      .values({ clientCode: `PS${SUFFIX}`, name: `P4 bosqich ${SUFFIX}`, phones: [] })
      .returning({ id: clients.id });
    madeClients.push(cl!.id);
    const clientChat = await chatOn({ clientId: cl!.id });
    expect((await loadContext(holderId, clientChat.peer, null)).leadStage).toBeNull();
  });
});
