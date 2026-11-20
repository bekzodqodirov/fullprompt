import 'dotenv/config';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropDrainKicksSince } from './drain-kicks';
import type { CallModel, ModelRequest, ModelResponse } from '@/modules/platform/ai/model';
import { db } from '@/modules/platform/db/client';
import {
  agentAutoChats,
  agentAutoConfig,
  agentAutoVerdicts,
  agentConfig,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  agentSendCaps,
  auditLog,
  clients,
  notifications,
  roles,
  settings,
  tgAccountGuard,
  tgAccounts,
  tgMessages,
  tgOutbox,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { AGENT_SEAT_KEY } from '@/modules/platform/settings/agent-seat';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import {
  AUTO_NOT_GONE_NOTICE,
  AutoConfigError,
  autoFeedback,
  pressDueAutos,
  pressNow,
  readAutoConfig,
  rejudgeNightHeld,
  ringSilentCard,
  setAutoCategories,
  setAutoNightPrices,
  setAutoPriceHold,
  setAutoTalkHold,
  __restoreAutoConfig,
  type AutoConfig,
} from '@/modules/wms/agent/auto-send';
import { readAgentConfig, __forgetAgentAutoReady, __pretendAgentAutoBehind, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { agentRowById, sendFactsFor } from '@/modules/wms/agent/outbox-store';
import { handleInbound } from '@/modules/wms/agent/run';
import { JOB_AGENT_AFTER_SENT } from '@/modules/wms/agent/queues';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

/**
 * Stage 1a, P1 «To'siq», against a real database (docs/ai-toliq/qurish/STAGE-0-1A.md §4.2, §7, J3, J4, J10, J11, J31):
 * ordinary talk goes AT ONCE — the run presses its own reply, no card on his screen, the card written silent — while a
 * price waits its hold on a card that rang; what the night bars waits for the morning and is judged again then.
 *
 * Seams (`forced`, auto-send's two exports wrapped — never a second implementation): a verdict the savepoint refuses
 * (J4), a hook that runs between the draft and the run's own press, the run's press skipped, and a press that reads the
 * run's STORED calls the way the sweep does (J3).
 *
 * The CLOCK is agent-auto.integration's: the machine runs on `T0`, a daytime instant twenty minutes or more in the
 * past; the night and the morning are T0's own day's. Configuration rows and settings are snapshotted and put back
 * (#183); fixture users are deactivated, never deleted (the audit FK).
 */

const forced = vi.hoisted(() => ({
  breakVerdict: false,
  skipPress: false,
  storedTools: false,
  beforePress: null as null | ((draftId: string) => Promise<void>),
}));
vi.mock('@/modules/wms/agent/auto-send', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/agent/auto-send')>();
  return {
    ...real,
    // A plan the savepoint refuses: «waiting» with no due time breaks the row's own CHECK — a real failed insert.
    recordAutoVerdictInTx: (...args: Parameters<typeof real.recordAutoVerdictInTx>) =>
      real.recordAutoVerdictInTx(args[0], args[1], forced.breakVerdict ? { ...args[2], dueAt: null } : args[2]),
    pressNow: async (...args: Parameters<typeof real.pressNow>) => {
      if (forced.skipPress) return null;
      const hook = forced.beforePress;
      forced.beforePress = null;
      if (hook) await hook(args[0]);
      return real.pressNow(args[0], args[1], forced.storedTools ? (undefined as unknown as typeof args[2]) : args[2]);
    },
  };
});

const SUFFIX = String(Date.now()).slice(-6);
const PEER = BigInt(`68${SUFFIX}`);
const PEER2 = BigInt(`69${SUFFIX}`);
const PEERS = [PEER, PEER2];
let ownerId = '';
let otherId = '';
let plainId = '';
let accountId = '';
let clientId = '';
let client2Id = '';
const madeUsers: string[] = [];
let agentSnapshot: AgentConfig | null = null;
let autoSnapshot: AutoConfig | null = null;
const settingsBefore = new Map<string, unknown>();
let seatBefore: unknown = undefined;
let vouchedBefore: Date | null = null;
let msgSeq = 9000n;

function machineClock(): Date {
  const now = new Date(Date.now() - 20 * 60_000);
  const hour = (now.getUTCHours() + 5) % 24;
  if (hour >= 9 && hour < 20) return now;
  const t = new Date(now);
  t.setUTCHours(9, 0, 0, 0);
  if (t.getTime() > now.getTime()) t.setUTCDate(t.getUTCDate() - 1);
  return t;
}
const T0 = machineClock();
const HOLD_MS = 120_000;
const DUE = new Date(T0.getTime() + HOLD_MS + 1_000);
/** 08:00 Tashkent of T0's own day — the first working minute — and a wall-clock time on that day. */
const MORNING = (() => {
  const d = new Date(T0);
  d.setUTCHours(3, 0, 0, 0);
  return d;
})();
const at = (h: number, m: number, s = 0) => new Date(MORNING.getTime() + ((h - 8) * 3600 + m * 60 + s) * 1000);
/** 23:00 Tashkent the night before T0's day. */
const NIGHT = at(-1, 0);

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99891${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  madeUsers.push(u!.id);
  return u!.id;
}

async function inbound(body: string, peer = PEER, when: Date = T0): Promise<bigint> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({
    clientId: peer === PEER2 ? client2Id : clientId,
    managerUserId: ownerId,
    peerId: peer,
    tgMessageId: msgSeq,
    direction: 'in',
    body,
    sentAt: new Date(when.getTime() - 60_000),
  });
  return msgSeq;
}

const job = (anchor: bigint, peer = PEER) => ({ managerUserId: ownerId, peerId: String(peer), anchorTgMessageId: String(anchor), origin: 'live' as const });

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

const TAG = SUFFIX.split('').map((d) => 'abcdefghij'[Number(d)]).join('');
const REPLY = `Ha, Xitoydan olib kelamiz. Qanday yuk ${TAG}?`;

function compose(text = REPLY, extra: Record<string, unknown> = {}) {
  return {
    name: 'compose_reply',
    input: {
      reply_needed: true,
      reply_text: text,
      language: 'uz',
      gloss_uz: '',
      category: 'faq',
      confidence: 0.9,
      needs_owner: false,
      owner_question: '',
      next_step: 'qualify',
      actions: [],
      used_fact_ids: [],
      cited_message_refs: [],
      ...extra,
    },
  };
}

const actorOf = (id: string) => ({ id, roles: ['super_admin'], permissions: new Set<string>(['crm.leads.view_all']) });
const plainActor = (id: string) => ({ id, roles: ['sales_manager'], permissions: new Set<string>(['crm.leads.view_all']) });

const QUESTIONS = ['Salom, Xitoydan yuk olib kelasizlarmi?', 'Assalomu alaykum, Guanchjoudan ham olasizmi?', 'Yiwudan ham yuk tashiysizmi?', 'Qaysi shaharlardan yuk olasizlar?'];
const PRICED = "5 kub, 1000 kg yukingiz uchun Toshkentgacha yo'lkira taxminan 800 $ bo'ladi. Boj va QQS alohida hisoblanadi.";
const PRICE_QUESTIONS = ["Yiwudan Toshkentga 5 kub 1000 kg yuk bor, yo'lkira qancha bo'ladi?", "Yiwudan Toshkentga 5 kub 1000 kg kiyim bor, narxi qancha?"];

/** One inbound line and the run that drafts it — ordinary talk unless the steps say otherwise. */
async function drafted(opts: { peer?: bigint; steps?: { name: string; input: Record<string, unknown> }[]; now?: Date; question?: string } = {}) {
  const peer = opts.peer ?? PEER;
  const now = opts.now ?? T0;
  const anchor = await inbound(opts.question ?? QUESTIONS[Number(msgSeq % BigInt(QUESTIONS.length))]!, peer, now);
  const out = await handleInbound(job(anchor, peer), { callModel: scripted(opts.steps ?? [compose()]), now: () => now });
  expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, (out as { draftId: string }).draftId));
  return d!;
}

/** A truck quote the money clause admits («Narx» ticked in `beforeEach`), its card not yet shown. */
async function quoted(opts: { peer?: bigint; now?: Date } = {}) {
  return drafted({
    ...opts,
    question: PRICE_QUESTIONS[Number(msgSeq % 2n)]!,
    steps: [{ name: 'yolkira_estimate', input: { weight_ref: 'w1', volume_ref: 'v1' } }, compose(PRICED, { category: 'price' })],
  });
}

async function verdictOf(draftId: string) {
  const [v] = await db.select().from(agentAutoVerdicts).where(eq(agentAutoVerdicts.draftId, draftId));
  return v ?? null;
}

async function outboxOf(draftId: string) {
  const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, draftId));
  return o ?? null;
}

/** Every copy of a draft's card, newest first. */
async function cardsOf(draftId: string) {
  return db
    .select({ id: notifications.id, status: notifications.status, payload: notifications.payload, createdAt: notifications.createdAt })
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`))
    .orderBy(desc(notifications.createdAt));
}

let cardMessageSeq = 500;
/** What the staff drain writes on a copy it sends (`sent_at`, `tg`, `shown`, `rang`) — `rang` false: sent silently. */
async function sent(notificationId: string, when: Date, draftId: string, rang = true) {
  cardMessageSeq += 1;
  const merge = { tg: { chatId: 7_600_000_000 + Number(SUFFIX), messageId: cardMessageSeq }, shown: { draftId, at: when.toISOString() }, rang };
  await db
    .update(notifications)
    .set({ status: 'sent', sentAt: when, payload: sql`${notifications.payload} || ${JSON.stringify(merge)}::jsonb` })
    .where(eq(notifications.id, notificationId));
}

async function clearChats() {
  await db
    .execute(
      sql`DELETE FROM pgboss.job WHERE name = ${JOB_AGENT_AFTER_SENT}
            AND data->>'outboxId' IN (SELECT id::text FROM agent_outbox WHERE peer_id IN (${sql.join(PEERS.map((p) => sql`${String(p)}::bigint`), sql`, `)}))`,
    )
    .catch(() => undefined);
  await db.delete(agentOutbox).where(inArray(agentOutbox.peerId, PEERS));
  await db.delete(agentDrafts).where(inArray(agentDrafts.peerId, PEERS));
  await db.delete(agentRuns).where(inArray(agentRuns.peerId, PEERS));
  await db.delete(agentConversations).where(inArray(agentConversations.peerId, PEERS));
  await db.delete(agentAutoChats).where(eq(agentAutoChats.managerUserId, ownerId));
  await db.delete(tgOutbox).where(inArray(tgOutbox.peerId, PEERS));
  await db.delete(tgMessages).where(inArray(tgMessages.peerId, PEERS));
  await db.delete(notifications).where(and(eq(notifications.userId, ownerId), like(notifications.type, 'Agent%')));
}

const SETTING_KEYS = ['tg_sending_enabled', 'agent_talk_hold_sec', 'agent_night_prices'] as const;

beforeAll(async () => {
  agentSnapshot = await readAgentConfig();
  autoSnapshot = await readAutoConfig();
  for (const key of SETTING_KEYS) settingsBefore.set(key, await getSetting(key));
  const [seat] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, AGENT_SEAT_KEY));
  seatBefore = seat?.value;
  const [caps] = await db.select({ at: agentSendCaps.tariffConfirmedAt }).from(agentSendCaps).where(eq(agentSendCaps.id, 1));
  vouchedBefore = caps?.at ?? null;
  ownerId = await makeUser(`Toliq egasi ${SUFFIX}`, 'super_admin', '01');
  otherId = await makeUser(`Toliq boshqa ${SUFFIX}`, 'super_admin', '02');
  plainId = await makeUser(`Toliq sotuvchi ${SUFFIX}`, 'sales_manager', '03');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: ownerId, tgPhone: `+99894${SUFFIX}11`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date(), workAccount: true })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  const [c] = await db.insert(clients).values({ clientCode: `TQ${SUFFIX}`, name: `Toliq Mijoz ${SUFFIX}`, phones: [`+99895${SUFFIX}15`], salesManagerId: ownerId }).returning({ id: clients.id });
  clientId = c!.id;
  const [c2] = await db.insert(clients).values({ clientCode: `TR${SUFFIX}`, name: `Toliq Ikki ${SUFFIX}`, phones: [`+99895${SUFFIX}16`], salesManagerId: ownerId }).returning({ id: clients.id });
  client2Id = c2!.id;
});

beforeEach(async () => {
  __forgetAgentAutoReady();
  Object.assign(forced, { breakVerdict: false, skipPress: false, storedTools: false, beforePress: null });
  await clearChats();
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
  // Armed the day before; «Narx» ticked; the price hold two minutes. Talk at once and a table price at night — his ⭐.
  await db
    .update(agentAutoConfig)
    .set({
      armedAt: new Date(NIGHT.getTime() - 86_400_000),
      armedBy: ownerId,
      holdSec: HOLD_MS / 1000,
      perDay: null,
      maxChars: 400,
      categories: ['greeting', 'qualification', 'faq', 'status', 'price'],
      disarmedAt: null,
      disarmReason: null,
    })
    .where(eq(agentAutoConfig.id, 1));
  await setSetting('tg_sending_enabled', true, ownerId);
  await setSetting('agent_talk_hold_sec', 0, ownerId);
  await setSetting('agent_night_prices', 'table', ownerId);
  await db.delete(settings).where(eq(settings.key, AGENT_SEAT_KEY));
  // The China column vouched for a moment ago (the price tests' own precondition, agent-auto's `vouch`).
  await db.update(agentSendCaps).set({ tariffConfirmedAt: new Date() }).where(eq(agentSendCaps.id, 1));
  await db.update(tgAccounts).set({ workAccount: true }).where(eq(tgAccounts.id, accountId));
  await stampAgentPump(accountId, true);
});

afterEach(() => {
  Object.assign(forced, { breakVerdict: false, skipPress: false, storedTools: false, beforePress: null });
});

const KICKS_FROM = new Date().toISOString();
afterAll(async () => {
  await dropDrainKicksSince(KICKS_FROM);
  __forgetAgentAutoReady();
  await clearChats();
  await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(clients).where(inArray(clients.id, [clientId, client2Id]));
  await __restoreAgentConfig(agentSnapshot);
  await __restoreAutoConfig(autoSnapshot);
  for (const [key, value] of settingsBefore) await setSetting(key as (typeof SETTING_KEYS)[number], value as never, ownerId);
  if (seatBefore === undefined) await db.delete(settings).where(eq(settings.key, AGENT_SEAT_KEY));
  else await db.insert(settings).values({ key: AGENT_SEAT_KEY, value: seatBefore }).onConflictDoUpdate({ target: settings.key, set: { value: seatBefore } });
  await db.update(agentSendCaps).set({ tariffConfirmedAt: vouchedBefore }).where(eq(agentSendCaps.id, 1));
  await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
});

describe('talk goes at once — the run presses its own reply (his 11 a, J3, J10)', () => {
  it('pressed by the run itself, with no card on his screen; the card queued SILENT', async () => {
    const d = await drafted();
    expect(await verdictOf(d.id)).toMatchObject({ eligible: true, state: 'pressed' });
    expect(await outboxOf(d.id)).toMatchObject({ status: 'agent' });
    const [card] = await cardsOf(d.id);
    expect(card!.status).toBe('pending');
    expect((card!.payload as { silent?: unknown }).silent).toBe(true);
  });

  it('a cargo-status reply is pressed at once — the press reads the calls the run made, not a row still unwritten (J3)', async () => {
    const d = await drafted({ steps: [{ name: 'cargo_status', input: {} }, compose(`Yukingizni tekshirdim ${TAG}. Batafsil kerak bo‘lsa yozing.`, { category: 'status' })] });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'pressed' });
  });

  it('…and the calls are on the run’s row BEFORE the draft: a press reading the stored row then (the sweep’s way) finds them (J3)', async () => {
    let stored: unknown = null;
    forced.storedTools = true;
    forced.beforePress = async () => {
      const [run] = await db.select({ toolCalls: agentRuns.toolCalls }).from(agentRuns).where(eq(agentRuns.peerId, PEER)).orderBy(desc(agentRuns.createdAt)).limit(1);
      stored = run?.toolCalls ?? null;
    };
    const d = await drafted({ steps: [{ name: 'cargo_status', input: {} }, compose(`Yukingizni tekshirdim ${TAG}. Batafsil kerak bo‘lsa yozing.`, { category: 'status' })] });
    expect(stored).toEqual([expect.objectContaining({ name: 'cargo_status', ok: true })]);
    expect(await verdictOf(d.id)).toMatchObject({ state: 'pressed' });
  });

  it('a verdict the savepoint refused: no row, and its card RINGS — nothing will press it (J4)', async () => {
    forced.breakVerdict = true;
    const d = await drafted();
    expect(await verdictOf(d.id)).toBeNull();
    expect(await outboxOf(d.id)).toBeNull();
    const [card] = await cardsOf(d.id);
    expect((card!.payload as { silent?: unknown }).silent).toBe(false);
  });

  it('the run’s press claims only ITS due row: a price is not due, and nothing is pressed', async () => {
    const d = await quoted();
    expect(await pressNow(d.id, T0, [])).toBeNull();
    expect(await verdictOf(d.id)).toMatchObject({ state: 'waiting' });
  });
});

describe('a price waits its hold on a card that rang', () => {
  it('waiting, due a hold after, the card not silent; the sweep presses only once the card reached him a hold ago', async () => {
    const d = await quoted();
    const v = await verdictOf(d.id);
    expect(v, JSON.stringify(v?.reasons)).toMatchObject({ eligible: true, state: 'waiting' });
    expect(v!.dueAt!.getTime()).toBe(T0.getTime() + HOLD_MS);
    const [card] = await cardsOf(d.id);
    expect((card!.payload as { silent?: unknown }).silent).toBe(false);
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await verdictOf(d.id)).toMatchObject({ state: 'waiting', outcome: 'unseen' });
    await sent(card!.id, T0, d.id);
    expect(await pressDueAutos(new Date(DUE.getTime() + 61_000))).toBe(1);
    expect(await outboxOf(d.id)).toMatchObject({ status: 'agent' });
  });

  it('the NEXT waiting draft on the same re-pointed card row rings: `silent` is written false, never left over', async () => {
    forced.skipPress = true;
    const talk = await drafted();
    const [first] = await cardsOf(talk.id);
    expect((first!.payload as { silent?: unknown }).silent).toBe(true);
    const price = await quoted({ now: new Date(T0.getTime() + 30_000) });
    const rows = await cardsOf(price.id);
    expect(rows.map((r) => r.id)).toEqual([first!.id]);
    expect((rows[0]!.payload as { silent?: unknown }).silent).toBe(false);
  });
});

describe('a hold-0 press that does not go rings (§4.2)', () => {
  const takeChat = async () => {
    await db
      .insert(agentConversations)
      .values({ managerUserId: ownerId, peerId: PEER, humanUntil: new Date(Date.now() + 3_600_000) })
      .onConflictDoUpdate({ target: [agentConversations.managerUserId, agentConversations.peerId], set: { humanUntil: new Date(Date.now() + 3_600_000) } });
  };
  const notices = () =>
    db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentNotice')));

  it('refused while its card is still queued: the card loses `silent` — and no notice', async () => {
    forced.beforePress = takeChat;
    const d = await drafted();
    expect(await verdictOf(d.id)).toMatchObject({ state: 'refused', reasons: ['human_active'] });
    const [card] = await cardsOf(d.id);
    expect((card!.payload as { silent?: unknown }).silent).toBe(false);
    expect(await notices()).toHaveLength(0);
  });

  it('refused after its card went out silently: ONE notice that names the chat — and a second refusal says nothing', async () => {
    forced.beforePress = async (draftId) => {
      const [card] = await cardsOf(draftId);
      await sent(card!.id, T0, draftId, false);
      await takeChat();
    };
    const d = await drafted();
    expect(await verdictOf(d.id)).toMatchObject({ state: 'refused' });
    const rows = await notices();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ peerId: String(PEER) });
    expect(String((rows[0]!.payload as { text?: unknown }).text)).toContain(AUTO_NOT_GONE_NOTICE);
    expect(await ringSilentCard(d.id)).toBe('none');
    expect(await notices()).toHaveLength(1);
  });
});

describe('the press asks the gate’s own warning predicate (ONE list)', () => {
  it('a reply that warns «questions» goes — the ✅’s re-run of the policy frees it as the gate did', async () => {
    const d = await drafted({ steps: [compose(`Qanday yuk ${TAG}? Necha kub?`)] });
    expect(((d.policy as { warnings?: { code: string }[] }).warnings ?? []).map((w) => w.code)).toContain('questions');
    expect(await verdictOf(d.id)).toMatchObject({ state: 'pressed' });
  });

  it('a colleague named between the draft and the press (`staff_name`, one word) is refused `auto_warning` at the ✅', async () => {
    const name = `Qudratbek${TAG}`;
    forced.beforePress = async () => {
      await makeUser(`${name} Sinovov`, 'sales_manager', '09');
    };
    const d = await drafted({ steps: [compose(`${name} sizga yordam beradi. Qanday yuk ${TAG}?`)] });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'refused' });
    expect((await verdictOf(d.id))!.outcome).toMatch(/^auto_warning:.*staff_name/u);
    expect(await outboxOf(d.id)).toBeNull();
  });
});

describe('his CRM reply on its way is HIS answer (J11)', () => {
  it('a queued CRM reply typed after the line: the send step reads «he replied» — the at-once reply never goes beside it', async () => {
    const d = await drafted();
    const row = (await agentRowById((await outboxOf(d.id))!.id))!;
    const ctx = { accountId, caughtUp: () => true, random: () => 0 };
    expect((await sendFactsFor(row, DUE, ctx)).humanReplied).toBe(false);
    await db.insert(tgOutbox).values({ clientId, managerUserId: ownerId, peerId: PEER, body: 'Men o‘zim yozaman', status: 'queued', queuedBy: ownerId, queuedAt: new Date() });
    expect((await sendFactsFor(row, DUE, ctx)).humanReplied).toBe(true);
    // A reply queued BEFORE the line answers something older: not his answer to this one.
    await db.delete(tgOutbox).where(eq(tgOutbox.peerId, PEER));
    await db.insert(tgOutbox).values({ clientId, managerUserId: ownerId, peerId: PEER, body: 'Eski javob', status: 'queued', queuedBy: ownerId, queuedAt: new Date(T0.getTime() - 3_600_000) });
    expect((await sendFactsFor(row, DUE, ctx)).humanReplied).toBe(false);
  });
});

describe('the night bars a class by his setting; the morning judges it again (his 4 a, J31)', () => {
  it('at 23:00 ordinary talk goes at once', async () => {
    const d = await drafted({ now: NIGHT });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'pressed' });
  });

  it('a table price under «table» goes at night after its hold — and one whose card landed silently is not refused «night» at 08:01', async () => {
    const d = await quoted({ now: at(7, 58) });
    expect(await verdictOf(d.id)).toMatchObject({ eligible: true, state: 'waiting' });
    const [card] = await cardsOf(d.id);
    await sent(card!.id, at(7, 58, 30), d.id, false);
    expect(await pressDueAutos(at(8, 1))).toBe(1);
    expect(await verdictOf(d.id)).toMatchObject({ state: 'pressed' });
  });

  it('under «none» a table price waits for the morning; at 08:00 it is judged again — a fresh hold and a card that RINGS; pressed after it, not before', async () => {
    await setSetting('agent_night_prices', 'none', ownerId);
    const d = await quoted({ now: NIGHT });
    expect(await verdictOf(d.id)).toMatchObject({ eligible: false, state: null, reasons: ['night'] });
    // The night's card went out silently, as the drain sends at night.
    const [nightCard] = await cardsOf(d.id);
    await sent(nightCard!.id, new Date(NIGHT.getTime() + 5_000), d.id, false);
    // The row was written at 23:00 (in life `created_at` is the scheduling's own moment).
    await db.update(agentAutoVerdicts).set({ createdAt: NIGHT }).where(eq(agentAutoVerdicts.draftId, d.id));
    // Still the night at 07:59: nothing moves.
    expect(await rejudgeNightHeld(at(7, 59))).toBe(0);
    expect(await pressDueAutos(at(8, 0))).toBe(0);
    const v = await verdictOf(d.id);
    expect(v).toMatchObject({ eligible: true, state: 'waiting', reasons: [] });
    expect(v!.dueAt!.getTime()).toBe(at(8, 2).getTime());
    // A fresh copy of the card, queued to ring.
    const copies = await cardsOf(d.id);
    expect(copies).toHaveLength(2);
    expect(copies[0]!.status).toBe('pending');
    expect((copies[0]!.payload as { silent?: unknown }).silent).toBe(false);
    // Judged once a morning: the next sweep leaves it be — no third copy, the same due time.
    await rejudgeNightHeld(at(8, 1));
    expect(await cardsOf(d.id)).toHaveLength(2);
    expect((await verdictOf(d.id))!.dueAt!.getTime()).toBe(at(8, 2).getTime());
    // Not before its own hold on the ringing copy.
    expect(await pressDueAutos(at(8, 2, 5))).toBe(0);
    await sent(copies[0]!.id, at(8, 0, 5), d.id, true);
    expect(await pressDueAutos(at(8, 3, 10))).toBe(1);
    expect(await outboxOf(d.id)).toMatchObject({ status: 'agent' });
  });
});

describe('who may mark a reply the machine sent 👎 (the evening sample, his 9 a)', () => {
  it('the holder; a super_admin only while the holder is the AI seat; a colleague never', async () => {
    const a = await drafted();
    const b = await drafted({ peer: PEER2 });
    expect(await autoFeedback(actorOf(otherId), a.id)).toEqual({ ok: false, code: 'not_account_holder' });
    await db.insert(settings).values({ key: AGENT_SEAT_KEY, value: ownerId }).onConflictDoUpdate({ target: settings.key, set: { value: ownerId } });
    expect(await autoFeedback(plainActor(plainId), a.id)).toEqual({ ok: false, code: 'not_account_holder' });
    expect(await autoFeedback(actorOf(otherId), a.id)).toEqual({ ok: true, disarmed: false });
    expect(await autoFeedback(actorOf(ownerId), b.id)).toMatchObject({ ok: true });
  });
});

describe('his boxes (J34) and his kinds', () => {
  const refused = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof AutoConfigError ? e.code : String(e)));

  it('«Oddiy javob kutishi (soniya)»: 0-600, the holder’s or a super_admin’s, audited — and a talk reply then waits it', async () => {
    for (const bad of [-1, 601, 1.5, Number.NaN]) expect(await refused(setAutoTalkHold(actorOf(ownerId), bad, { actorId: ownerId })), String(bad)).toBe('bad_value');
    expect(await refused(setAutoTalkHold(plainActor(plainId), 30, { actorId: plainId }))).toBe('forbidden');
    expect(await setAutoTalkHold(actorOf(otherId), 90, { actorId: otherId })).toBe(90);
    expect(await getSetting('agent_talk_hold_sec')).toBe(90);
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'settings'), eq(auditLog.actorId, otherId)))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    expect(audit!.after).toEqual({ agent_talk_hold_sec: 90 });
    const d = await drafted();
    const v = await verdictOf(d.id);
    expect(v).toMatchObject({ state: 'waiting' });
    expect(v!.dueAt!.getTime()).toBe(T0.getTime() + 90_000);
    expect((await cardsOf(d.id))[0]!.payload).toMatchObject({ silent: false });
  });

  it('the price hold: 30-600 on the layer’s own row; the night choice: none / table / all', async () => {
    for (const bad of [29, 601, 0]) expect(await refused(setAutoPriceHold(actorOf(ownerId), bad, { actorId: ownerId })), String(bad)).toBe('bad_value');
    expect((await setAutoPriceHold(actorOf(ownerId), 300, { actorId: ownerId })).holdSec).toBe(300);
    expect(await refused(setAutoNightPrices(actorOf(ownerId), 'sometimes', { actorId: ownerId }))).toBe('bad_value');
    expect(await refused(setAutoNightPrices(plainActor(plainId), 'all', { actorId: plainId }))).toBe('forbidden');
    for (const value of ['none', 'all', 'table']) expect(await setAutoNightPrices(actorOf(ownerId), value, { actorId: ownerId })).toBe(value);
    expect(await getSetting('agent_night_prices')).toBe('table');
  });

  it('the kinds box: none of the three ticked stores the four ordinary kinds; «Narx» stores five (the CHECK wants one)', async () => {
    const FOUR = ['greeting', 'qualification', 'faq', 'status'];
    expect((await setAutoCategories(actorOf(ownerId), [], { actorId: ownerId })).categories).toEqual(FOUR);
    expect((await setAutoCategories(actorOf(ownerId), ['price'], { actorId: ownerId })).categories).toEqual([...FOUR, 'price']);
  });
});

describe('«botmisiz?» is no step-down (his 1 b)', () => {
  it('after a machine reply it turns no chat off and disarms nothing; a pre-1a chat-off row keeps its chat out until its own end', async () => {
    await drafted();
    const q = await inbound('Siz botmisiz?', PEER, new Date(T0.getTime() + 60_000));
    await handleInbound(job(q), { callModel: scripted([compose()]), now: () => new Date(T0.getTime() + 60_000) });
    expect(await db.select().from(agentAutoChats).where(eq(agentAutoChats.managerUserId, ownerId))).toHaveLength(0);
    expect((await readAutoConfig())!.armed).toBe(true);
    await db.insert(agentAutoChats).values({ managerUserId: ownerId, peerId: PEER2, offUntil: new Date(Date.now() + 86_400_000), reason: 'bot_question' });
    const d = await drafted({ peer: PEER2 });
    expect(await verdictOf(d.id)).toMatchObject({ eligible: false, reasons: ['chat_off'] });
  });
});

describe('one migration behind (0145 absent)', () => {
  it('a reply is written with no plan, nothing is pressed, the morning re-judge does nothing — and nothing throws', async () => {
    __pretendAgentAutoBehind();
    try {
      const d = await drafted();
      expect(await db.select().from(agentAutoVerdicts).where(eq(agentAutoVerdicts.draftId, d.id))).toHaveLength(0);
      expect(await pressNow(d.id, T0, [])).toBeNull();
      expect(await rejudgeNightHeld(at(8, 0))).toBe(0);
      expect(await pressDueAutos(DUE)).toBe(0);
      expect(await outboxOf(d.id)).toBeNull();
    } finally {
      __forgetAgentAutoReady();
    }
  });
});
