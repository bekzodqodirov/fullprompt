import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { and, eq, inArray, like, notInArray, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  auditLog,
  clients,
  leadSources,
  leadStages,
  leads,
  notifications,
  roles,
  telegramLinks,
  tgAccountGuard,
  tgAccounts,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { __resetTelegramPause, sendPendingTelegram } from '@/modules/platform/notifications/service';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { buttonsFor } from '@/modules/platform/telegram/staff-bot';
import { AUTO_BAD_DISARMED_TOAST, AUTO_BAD_TOAST, AUTO_STOPPED_TOAST, agentCommand, agentPress, autoStatusLine } from '@/modules/wms/agent/bot-door';
import {
  AUTO_RECLAIM_MS,
  autoFeedback,
  autoStepDownOnBlock,
  autoStepDownOnBotQuestion,
  recordAutoVerdictInTx,
  stopAutoForEdit,
  pressDueAutos,
  readAutoConfig,
  setAutoArmed,
  setAutoCategories,
  stopAuto,
  __restoreAutoConfig,
  AutoConfigError,
  type AutoConfig,
} from '@/modules/wms/agent/auto-send';
import {
  forceAgentOff,
  readAgentConfig,
  setAgentMode,
  __forgetAgentAutoReady,
  __pretendAgentAutoBehind,
  __restoreAgentConfig,
  type AgentConfig,
} from '@/modules/wms/agent/config';
import { decideDraft, submitOwnText } from '@/modules/wms/agent/decide';
import { agentSweep } from '@/modules/wms/agent/jobs';
import { agentRowById, applyAgentOutcome, sendFactsFor } from '@/modules/wms/agent/outbox-store';
import { agentSendVerdict } from '@/modules/wms/agent/send-step';
import { purgeAgentChat } from '@/modules/wms/agent/purge';
import { handleInbound } from '@/modules/wms/agent/run';
import { autoPanel, webDrafts, webStats } from '@/modules/wms/agent/web-page';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';
import { setWorkAccount } from '@/modules/wms/crm/telegram-accounts';
import { CANCELLED_BY_HOLDER } from '@/modules/wms/agent/web-thread';

/**
 * A seam in the press (fix pass A): `sendWindowFor` is asked by the gate's facts AND by `decideDraft` before its
 * approval transaction — a hook armed here runs on the call it names, so «a stop that lands while the machine's
 * ✅ is in flight» is a deterministic interleaving, not a race. Untouched (a passthrough) when no hook is armed.
 */
const seam = vi.hoisted(() => ({ hook: null as null | { skip: number; run: () => Promise<void> } }));
vi.mock('@/modules/wms/agent/send-window', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/wms/agent/send-window')>();
  return {
    ...real,
    sendWindowFor: async (...args: Parameters<typeof real.sendWindowFor>) => {
      const h = seam.hook;
      if (h) {
        if (h.skip > 0) h.skip -= 1;
        else {
          seam.hook = null;
          await h.run();
        }
      }
      return real.sendWindowFor(...args);
    },
  };
});

/**
 * «O'zi yuborish» against a real database (docs/AI-SOTUVCHI.md §18.3, his
 * answer of 2026-11-11): the plan the inbound run writes beside its draft, the
 * machine press in the sweep through the same ✅, a person's own decision
 * stopping it, ⏸, the gate's live refusals, the disarms inside «off», the
 * three step-downs and a server one migration behind.
 *
 * The CLOCK: the gate refuses the night, and this suite runs at any hour. So
 * the machine's side runs on `T0` — a daytime instant at least twenty minutes in
 * the PAST (the run's `now`, the sweep's `now`, every message's time) — while
 * a person's presses happen at the real now, AFTER it, as they do in life.
 *
 * agent_config and agent_auto_config are singleton CONFIGURATION rows on the
 * one database every file shares (#183): snapshotted in beforeAll and put back
 * in afterAll. The fixture users are deactivated, never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const PEER = BigInt(`78${SUFFIX}`);
const PEER2 = BigInt(`79${SUFFIX}`);
const OTHERS = [1n, 2n, 3n, 4n].map((n) => BigInt(`76${SUFFIX}`) + n);
let ownerId = '';
let otherId = '';
let accountId = '';
let clientId = '';
let client2Id = '';
/** A lead the client-finding agent found (source `agent`) — its chat is a prospect the layer never answers. */
let prospectLeadId = '';
let agentSnapshot: AgentConfig | null = null;
let autoSnapshot: AutoConfig | null = null;
let sendingBefore = false;
let msgSeq = 5000n;

/** A daytime Tashkent instant at least twenty minutes before now (see the clock above). */
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

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

/** A customer's line, a minute before `at` on the machine's clock — the run that reads it is never late. */
async function inbound(body: string, peer = PEER, at: Date = T0): Promise<bigint> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({
    clientId: peer === PEER2 ? client2Id : clientId,
    managerUserId: ownerId,
    peerId: peer,
    tgMessageId: msgSeq,
    direction: 'in',
    body,
    sentAt: new Date(at.getTime() - 60_000),
  });
  return msgSeq;
}

const job = (anchor: bigint, peer = PEER) => ({
  managerUserId: ownerId,
  peerId: String(peer),
  anchorTgMessageId: String(anchor),
  origin: 'live' as const,
});

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

/** A plain answer the gate admits: no figure, one question, a kind he chose. */
const REPLY = `Ha, Xitoydan olib kelamiz. Qanday yuk ${SUFFIX.split('').map((d) => 'abcdefghij'[Number(d)]).join('')}?`;

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

const QUESTIONS = [
  'Salom, Xitoydan yuk olib kelasizlarmi?',
  'Assalomu alaykum, Guanchjoudan ham olasizmi?',
  'Yiwudan ham yuk tashiysizmi?',
  'Qaysi shaharlardan yuk olasizlar?',
];

const CARD_CHAT = 7_700_000_000 + Number(SUFFIX);
let cardMessageSeq = 900;

/**
 * His Telegram shows this draft's card since `at` — what the staff drain writes on the card's row when it sends it
 * (`sent_at`, `tg` and `shown`), and a successful edit when the row is re-pointed at a newer draft (fix pass A, C4):
 * the machine presses only a card that reached him, `hold` after it did. `sent_at` is when the copy rang — an edit
 * after it rings nothing (the final check: a countdown never rides an old copy).
 */
async function shownAt(draftId: string, at: Date) {
  cardMessageSeq += 1;
  const merge = { tg: { chatId: CARD_CHAT, messageId: cardMessageSeq }, shown: { draftId, at: at.toISOString() } };
  await db
    .update(notifications)
    .set({ status: 'sent', sentAt: at, payload: sql`${notifications.payload} || ${JSON.stringify(merge)}::jsonb` })
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
}

/**
 * One inbound line and the run that drafts it, on the machine's clock. Its card reached him the moment it was
 * written (`shown`, default the run's own `now`) — `null`: it never did (the drain paused, an edit that failed).
 */
async function drafted(
  opts: { peer?: bigint; steps?: { name: string; input: Record<string, unknown> }[]; now?: Date; shown?: Date | null } = {},
) {
  const peer = opts.peer ?? PEER;
  const now = opts.now ?? T0;
  // A different question each time: the same line again is the run's own «repeat» refusal.
  const anchor = await inbound(QUESTIONS[Number(msgSeq % BigInt(QUESTIONS.length))]!, peer, now);
  const out = await handleInbound(job(anchor, peer), { callModel: scripted(opts.steps ?? [compose()]), now: () => now });
  expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
  const draftId = (out as { draftId: string }).draftId;
  if (opts.shown !== null) await shownAt(draftId, opts.shown ?? now);
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  return d!;
}

async function verdictOf(draftId: string) {
  const [v] = await db.select().from(agentAutoVerdicts).where(eq(agentAutoVerdicts.draftId, draftId));
  return v ?? null;
}

async function cardDigestOf(draftId: string): Promise<string> {
  const [row] = await db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
  return (row!.payload as { digest: string }).digest;
}

const ALL_PEERS = [PEER, PEER2, ...OTHERS];

async function clearChats() {
  await db.delete(agentOutbox).where(inArray(agentOutbox.peerId, ALL_PEERS));
  // The verdicts follow their drafts (ON DELETE CASCADE).
  await db.delete(agentDrafts).where(inArray(agentDrafts.peerId, ALL_PEERS));
  await db.delete(agentRuns).where(inArray(agentRuns.peerId, ALL_PEERS));
  await db.delete(agentConversations).where(inArray(agentConversations.peerId, ALL_PEERS));
  await db.delete(agentAutoChats).where(eq(agentAutoChats.managerUserId, ownerId));
  await db.delete(tgMessages).where(inArray(tgMessages.peerId, ALL_PEERS));
  await db.delete(notifications).where(and(eq(notifications.userId, ownerId), like(notifications.type, 'Agent%')));
}

/** The layer as each test starts: armed by the holder, the design's numbers, all four kinds. */
async function armFresh() {
  await db
    .update(agentAutoConfig)
    .set({
      armedAt: new Date(T0.getTime() - 3_600_000),
      armedBy: ownerId,
      holdSec: HOLD_MS / 1000,
      perDay: 30,
      maxChars: 400,
      minConfidence: '0.80',
      categories: ['greeting', 'qualification', 'faq', 'status'],
      disarmedAt: null,
      disarmReason: null,
    })
    .where(eq(agentAutoConfig.id, 1));
}

async function agentOn() {
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
}

beforeAll(async () => {
  agentSnapshot = await readAgentConfig();
  autoSnapshot = await readAutoConfig();
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  ownerId = await makeUser(`Auto egasi ${SUFFIX}`, 'super_admin', '01');
  otherId = await makeUser(`Auto boshqa ${SUFFIX}`, 'super_admin', '02');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: ownerId, tgPhone: `+99894${SUFFIX}01`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date(), workAccount: true })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `AU${SUFFIX}`, name: `Auto Mijoz ${SUFFIX}`, phones: [`+99895${SUFFIX}55`], salesManagerId: ownerId })
    .returning({ id: clients.id });
  clientId = c!.id;
  const [c2] = await db
    .insert(clients)
    .values({ clientCode: `AV${SUFFIX}`, name: `Auto Ikkinchi ${SUFFIX}`, phones: [`+99895${SUFFIX}66`], salesManagerId: ownerId })
    .returning({ id: clients.id });
  client2Id = c2!.id;
  const [source] = await db.select({ id: leadSources.id }).from(leadSources).where(eq(leadSources.key, 'agent'));
  const [stage] = await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'open')).orderBy(leadStages.sortOrder).limit(1);
  const [lead] = await db
    .insert(leads)
    .values({ name: `Auto prospekt ${SUFFIX}`, phone: `+99895${SUFFIX}77`, stageId: stage!.id, sourceId: source!.id, ownerId })
    .returning({ id: leads.id });
  prospectLeadId = lead!.id;
  await setSetting('tg_sending_enabled', true, ownerId);
});

const savedToken = process.env.TELEGRAM_BOT_TOKEN;

beforeEach(async () => {
  __forgetAgentAutoReady();
  seam.hook = null;
  __setTelegramTransport(null);
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  await clearChats();
  await agentOn();
  await armFresh();
  await db.update(tgAccounts).set({ workAccount: true }).where(eq(tgAccounts.id, accountId));
  await stampAgentPump(accountId, true);
});

afterAll(async () => {
  __forgetAgentAutoReady();
  seam.hook = null;
  __setTelegramTransport(null);
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  await clearChats();
  await db
    .delete(notifications)
    .where(and(eq(notifications.type, 'AgentForcedOff'), sql`${notifications.payload}->>'text' LIKE '%o‘zi yuborishi o‘chirildi%'`));
  // The agent's own «off» on a second block (fix pass B) alarms the account's manager and every super_admin by name.
  await db
    .delete(notifications)
    .where(and(eq(notifications.type, 'AgentForcedOff'), sql`${notifications.payload}->>'text' LIKE ${`%Auto egasi ${SUFFIX}%`}`));
  await db.delete(leads).where(eq(leads.id, prospectLeadId));
  await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(clients).where(inArray(clients.id, [clientId, client2Id]));
  await __restoreAgentConfig(agentSnapshot);
  await __restoreAutoConfig(autoSnapshot);
  await setSetting('tg_sending_enabled', sendingBefore, ownerId);
  await db.update(users).set({ active: false }).where(inArray(users.id, [ownerId, otherId]));
});

describe('the plan — written beside the draft by the inbound run', () => {
  it('an eligible reply: a waiting row, due after the hold, with the digest the card carries', async () => {
    const d = await drafted();
    const v = await verdictOf(d.id);
    expect(v).toMatchObject({ eligible: true, reasons: [], state: 'waiting', category: 'faq', confidence: '0.90', managerUserId: ownerId });
    expect(v!.dueAt!.getTime()).toBe(T0.getTime() + HOLD_MS);
    expect(v!.digest).toBe(await cardDigestOf(d.id));
  });

  it('an ineligible one is the rehearsal record: every reason, no state, no due time', async () => {
    const d = await drafted({
      steps: [{ name: 'own_balance', input: {} }, compose('Tekshirib aytaman.', { category: 'price', language: 'en' })],
    });
    const v = await verdictOf(d.id);
    expect(v).toMatchObject({ eligible: false, state: null, dueAt: null });
    expect(v!.reasons).toEqual(['money', 'category', 'language']);
  });

  it('an owner-triggered draft writes no row — the inbound run alone plans', () => {
    const src = readFileSync('src/modules/wms/agent/run.ts', 'utf8');
    const owner = src.slice(src.indexOf('export async function runOwnerTriggered'));
    expect(owner.length).toBeGreaterThan(100);
    expect(owner).not.toMatch(/autoPlan/u);
    const inbound = src.slice(src.indexOf('export async function handleInbound'), src.indexOf('export async function runOwnerTriggered'));
    expect(inbound).toMatch(/autoPlanFor\(/u);
  });

  it('the account not marked «Ish raqami», the chat off, the night: each a reason at the scheduling', async () => {
    await db.update(tgAccounts).set({ workAccount: false }).where(eq(tgAccounts.id, accountId));
    expect((await verdictOf((await drafted()).id))!.reasons).toEqual(['not_work_account']);
    await db.update(tgAccounts).set({ workAccount: true }).where(eq(tgAccounts.id, accountId));

    await db.insert(agentAutoChats).values({ managerUserId: ownerId, peerId: PEER, offUntil: new Date(Date.now() + 86_400_000), reason: 'feedback' });
    expect((await verdictOf((await drafted()).id))!.reasons).toEqual(['chat_off']);
    await db.delete(agentAutoChats).where(eq(agentAutoChats.managerUserId, ownerId));

    // 23:00 Tashkent the night BEFORE T0 (a run in the past, so the listener's stamp still reads fresh):
    // the reply would go at night — the card waits for the morning.
    const night = new Date(T0);
    night.setUTCHours(18, 0, 0, 0);
    if (night.getTime() > T0.getTime()) night.setUTCDate(night.getUTCDate() - 1);
    // In the other chat: this one's lines are dated after it.
    const v = await verdictOf((await drafted({ now: night, peer: PEER2 })).id);
    expect(v!.reasons).toEqual(['night']);
  });

  it('nothing armed: every reply is the rehearsal — refused «not_armed», the card ordinary', async () => {
    await db.update(agentAutoConfig).set({ armedAt: null, armedBy: null }).where(eq(agentAutoConfig.id, 1));
    const v = await verdictOf((await drafted()).id);
    expect(v).toMatchObject({ eligible: false, state: null, reasons: ['not_armed'] });
  });
});

describe('the press — the minute sweep, through the same ✅', () => {
  it('a due eligible reply is pressed: the outbox row queued, the audit says via auto, the holder decided', async () => {
    const d = await drafted();
    // Not due yet: nothing happens.
    expect(await pressDueAutos(new Date(T0.getTime() + 60_000))).toBe(0);
    const out = await agentSweep(DUE);
    expect(out.autoPressed).toBe(1);
    const v = await verdictOf(d.id);
    expect(v).toMatchObject({ state: 'pressed' });
    expect(v!.pressedAt!.getTime()).toBe(DUE.getTime());
    const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, d.id));
    expect(o).toMatchObject({ status: 'agent', queuedBy: ownerId, body: REPLY });
    const [after] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, d.id));
    expect(after).toMatchObject({ status: 'approved', decidedBy: ownerId });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'agent_draft'), eq(auditLog.entityId, d.id), sql`${auditLog.after}->>'status' = 'approved'`));
    expect(audit!.actorId).toBeNull();
    expect((audit!.after as { via?: string }).via).toBe('auto');
    // A second sweep presses nothing twice.
    expect(await pressDueAutos(new Date(DUE.getTime() + 60_000))).toBe(0);
  });

  it('a WARNING on the fresh policy re-run refuses the press and writes nothing — the card stays his', async () => {
    const d = await drafted();
    // The same short text went to four other customers since (G10's same-text fuse: a warning, ✅ stays).
    for (const peer of OTHERS) {
      const [od] = await db
        .insert(agentDrafts)
        .values({ managerUserId: ownerId, peerId: peer, clientId, anchorTgMessageId: 1n, proposedBody: REPLY, status: 'approved', decidedBy: ownerId, decidedAt: new Date() })
        .returning({ id: agentDrafts.id });
      await db.insert(agentOutbox).values({
        draftId: od!.id,
        managerUserId: ownerId,
        peerId: peer,
        clientId,
        body: REPLY,
        randomId: BigInt(Date.now()) * 10n + peer % 10n,
        answersTgMessageId: 1n,
        status: 'sent',
        sentAt: new Date(),
        queuedBy: ownerId,
      });
    }
    expect(await pressDueAutos(DUE)).toBe(0);
    const v = await verdictOf(d.id);
    expect(v).toMatchObject({ state: 'refused' });
    expect(v!.outcome).toMatch(/^auto_warning:.*fingerprint/u);
    const [after] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, d.id));
    expect(after).toMatchObject({ status: 'pending', blocked: false, decidedBy: null });
    expect(await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, d.id))).toHaveLength(0);
    // …and HE may still press past the warning he reads on the card.
    const r = await decideDraft(actorOf(ownerId), d.id, 'send', { digest: await cardDigestOf(d.id) }, { actorId: ownerId });
    expect(r).toMatchObject({ ok: true, status: 'approved' });
  });

  it('the gate is asked AFRESH at the press: the account unmarked since → refused with the reason', async () => {
    const d = await drafted();
    await db.update(tgAccounts).set({ workAccount: false }).where(eq(tgAccounts.id, accountId));
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await verdictOf(d.id)).toMatchObject({ state: 'refused', reasons: ['not_work_account'], outcome: 'not_work_account' });
    expect((await db.select().from(agentDrafts).where(eq(agentDrafts.id, d.id)))[0]!.status).toBe('pending');
  });

  it('the night at the press: a press the sweep reaches after 22:00 is refused «night»', async () => {
    const d = await drafted();
    const night = new Date(T0);
    night.setUTCHours(18, 30, 0, 0);
    if (night.getTime() < DUE.getTime()) night.setUTCDate(night.getUTCDate() + 1);
    expect(await pressDueAutos(night)).toBe(0);
    expect(await verdictOf(d.id)).toMatchObject({ state: 'refused', reasons: ['night'] });
  });

  it('a draft he is editing is never pressed — by the sweep, nor by the machine’s ✅ itself', async () => {
    const d = await drafted();
    // The bot's ✏️ would stop the row; this is a row that kept waiting while the draft went to 'editing'.
    await db.update(agentDrafts).set({ status: 'editing' }).where(eq(agentDrafts.id, d.id));
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await verdictOf(d.id)).toMatchObject({ state: 'gone', outcome: 'editing' });
    // The machine's ✅ refuses an editing draft even where a person's ✅ would send its machine words.
    const digest = await cardDigestOf(d.id);
    expect(await decideDraft(actorOf(ownerId), d.id, 'send', { digest, auto: true }, { actorId: null })).toMatchObject({ ok: false, code: 'not_live' });
    expect((await db.select().from(agentDrafts).where(eq(agentDrafts.id, d.id)))[0]!.status).toBe('editing');
    expect(await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, d.id))).toHaveLength(0);
  });

  it('per day: the cap counts the day’s presses — the second reply of a one-a-day layer waits for him', async () => {
    await db.update(agentAutoConfig).set({ perDay: 1 }).where(eq(agentAutoConfig.id, 1));
    const first = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    expect((await verdictOf(first.id))!.state).toBe('pressed');
    const second = await drafted({ now: new Date(DUE.getTime() + 60_000) });
    expect(await verdictOf(second.id)).toMatchObject({ eligible: false, reasons: ['daily_cap'] });
  });

  it('the streak: two auto replies in a row, then he must speak — his own decision resets it', async () => {
    let at = T0;
    for (let i = 0; i < 2; i++) {
      const d = await drafted({ now: at });
      expect(await pressDueAutos(new Date(at.getTime() + HOLD_MS + 1_000))).toBe(1);
      expect((await verdictOf(d.id))!.state).toBe('pressed');
      at = new Date(at.getTime() + 5 * 60_000);
    }
    const third = await drafted({ now: at });
    expect(await verdictOf(third.id)).toMatchObject({ eligible: false, reasons: ['streak'] });
    // He decides that one himself (❌): the next reply may go by itself again.
    expect(await decideDraft(actorOf(ownerId), third.id, 'reject', {}, { actorId: ownerId })).toMatchObject({ ok: true });
    const fourth = await drafted({ now: new Date(at.getTime() + 60_000) });
    expect(await verdictOf(fourth.id)).toMatchObject({ eligible: true, state: 'waiting' });
  });
});

describe('a person on the card', () => {
  it('his own ✅ stops the waiting auto — the press finds nothing to press', async () => {
    const d = await drafted();
    const r = await decideDraft(actorOf(ownerId), d.id, 'send', { digest: await cardDigestOf(d.id) }, { actorId: ownerId });
    expect(r).toMatchObject({ ok: true, status: 'approved' });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'owner_send', stoppedBy: ownerId });
    expect(await pressDueAutos(DUE)).toBe(0);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'agent_draft'), eq(auditLog.entityId, d.id), sql`${auditLog.after}->>'status' = 'approved'`));
    expect(audit!.actorId).toBe(ownerId);
    expect((audit!.after as { via?: string }).via).toBeUndefined();
  });

  it('his ✏️, ❌ and 🙋 stop it too, each named', async () => {
    for (const [decision, outcome] of [
      ['edit', 'owner_edit'],
      ['reject', 'owner_reject'],
      ['human', 'owner_human'],
    ] as const) {
      await clearChats();
      const d = await drafted();
      expect(await decideDraft(actorOf(ownerId), d.id, decision, {}, { actorId: ownerId })).toMatchObject({ ok: true });
      expect(await verdictOf(d.id), decision).toMatchObject({ state: 'stopped', outcome });
    }
  });

  it('his own words typed for the card (the page’s ✏️ box, no «edit» press) stop it too', async () => {
    const d = await drafted();
    expect(await submitOwnText(actorOf(ownerId), d.id, 'Ha, olib kelamiz. Yukingiz nima?', { actorId: ownerId })).toMatchObject({ ok: true });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'owner_edit', stoppedBy: ownerId });
    expect(await pressDueAutos(DUE)).toBe(0);
  });

  it('a colleague’s press is not his decision — it stops nothing', async () => {
    const d = await drafted();
    expect(await decideDraft(actorOf(otherId), d.id, 'reject', {}, { actorId: otherId })).toEqual({ ok: false, code: 'not_account_holder' });
    expect((await verdictOf(d.id))!.state).toBe('waiting');
  });

  it('⏸: the holder alone; the row stops, the sweep presses nothing, and a second ⏸ says so', async () => {
    const d = await drafted();
    expect(await stopAuto(otherId, d.id)).toEqual({ ok: false, code: 'not_account_holder' });
    expect(await stopAuto(ownerId, d.id)).toEqual({ ok: true });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'pause', stoppedBy: ownerId });
    expect(await pressDueAutos(DUE)).toBe(0);
    expect((await db.select().from(agentDrafts).where(eq(agentDrafts.id, d.id)))[0]!.status).toBe('pending');
    expect(await stopAuto(ownerId, d.id)).toEqual({ ok: false, code: 'not_waiting' });
  });

  it('⏸ after the press: «kech»', async () => {
    const d = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    expect(await stopAuto(ownerId, d.id)).toEqual({ ok: false, code: 'pressed' });
  });
});

describe('arming and disarming', () => {
  it('arming is the holder’s, on a running agent and a work number; disarming is his or any super_admin’s', async () => {
    await db.update(agentAutoConfig).set({ armedAt: null, armedBy: null }).where(eq(agentAutoConfig.id, 1));
    const refused = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof AutoConfigError ? e.code : String(e)));
    expect(await refused(setAutoArmed(actorOf(otherId), true, { actorId: otherId }))).toBe('not_account_holder');
    await db.update(tgAccounts).set({ workAccount: false }).where(eq(tgAccounts.id, accountId));
    expect(await refused(setAutoArmed(actorOf(ownerId), true, { actorId: ownerId }))).toBe('not_work_account');
    await db.update(tgAccounts).set({ workAccount: true }).where(eq(tgAccounts.id, accountId));
    const armed = await setAutoArmed(actorOf(ownerId), true, { actorId: ownerId });
    expect(armed).toMatchObject({ armed: true, armedBy: ownerId, disarmedAt: null });
    const off = await setAutoArmed(actorOf(otherId), false, { actorId: otherId });
    expect(off).toMatchObject({ armed: false, disarmReason: 'manual' });
    await db.update(agentConfig).set({ mode: 'off' }).where(eq(agentConfig.id, 1));
    expect(await refused(setAutoArmed(actorOf(ownerId), true, { actorId: ownerId }))).toBe('agent_off');
  });

  it('the kinds: the holder chooses among the four, at least one, in the design’s order', async () => {
    const refused = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof AutoConfigError ? e.code : String(e)));
    expect(await refused(setAutoCategories(actorOf(ownerId), [], { actorId: ownerId }))).toBe('bad_value');
    expect(await refused(setAutoCategories(actorOf(ownerId), ['price'], { actorId: ownerId }))).toBe('bad_value');
    expect(await refused(setAutoCategories(actorOf(otherId), ['faq'], { actorId: otherId }))).toBe('not_account_holder');
    expect((await setAutoCategories(actorOf(ownerId), ['status', 'greeting'], { actorId: ownerId })).categories).toEqual(['greeting', 'status']);
    // A kind he took out is refused at the scheduling.
    expect((await verdictOf((await drafted()).id))!.reasons).toEqual(['category']);
  });

  it('«off» disarms in its own transaction and stops every waiting reply', async () => {
    const d = await drafted();
    await setAgentMode(actorOf(ownerId), 'off', { actorId: ownerId });
    expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: 'agent_off' });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'disarmed' });
  });

  it('the machine’s own «off» (forceAgentOff) disarms too', async () => {
    const d = await drafted();
    // DELIBERATE EDIT (fix pass B, C10): the reason is a closed list now (forced-off), so the test names a real one.
    expect(await forceAgentOff('flood_repeat')).not.toBeNull();
    expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: 'forced: flood_repeat' });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'disarmed' });
  });
});

describe('the step-downs', () => {
  async function alarms(): Promise<number> {
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentForcedOff'), sql`${notifications.payload}->>'text' LIKE '%o‘zi yuborishi o‘chirildi%'`));
    return rows.length;
  }

  it('👎 on a sent reply: the chat leaves the layer for 30 days; the second 👎 in a week disarms, with an alarm', async () => {
    const a = await drafted();
    const b = await drafted({ peer: PEER2 });
    expect(await pressDueAutos(DUE)).toBe(2);
    expect(await autoFeedback(otherId, a.id)).toEqual({ ok: false, code: 'not_account_holder' });
    expect(await autoFeedback(ownerId, a.id)).toEqual({ ok: true, disarmed: false });
    expect(await autoFeedback(ownerId, a.id)).toEqual({ ok: false, code: 'already' });
    const [off] = await db.select().from(agentAutoChats).where(and(eq(agentAutoChats.managerUserId, ownerId), eq(agentAutoChats.peerId, PEER)));
    expect(off).toMatchObject({ reason: 'feedback' });
    expect(off!.offUntil.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect((await readAutoConfig())!.armed).toBe(true);
    const before = await alarms();
    expect(await autoFeedback(ownerId, b.id)).toEqual({ ok: true, disarmed: true });
    expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: 'feedback' });
    expect(await alarms()).toBe(before + 1);
  });

  it('👎 is for a reply the machine SENT — not one still waiting', async () => {
    const d = await drafted();
    expect(await autoFeedback(ownerId, d.id)).toEqual({ ok: false, code: 'not_sent' });
  });

  it('a block by a customer the machine answered this week disarms; a block elsewhere does not', async () => {
    await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    expect(await autoStepDownOnBlock(ownerId, PEER2, DUE)).toBe(false);
    expect((await readAutoConfig())!.armed).toBe(true);
    expect(await autoStepDownOnBlock(ownerId, PEER, DUE)).toBe(true);
    expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: 'blocked' });
    // The listener's own path calls it, on the block it already counts.
    const src = readFileSync('src/modules/wms/agent/outbox-store.ts', 'utf8');
    const branch = src.slice(src.indexOf("case 'recipient_final':"), src.indexOf('default:', src.indexOf("case 'recipient_final':")));
    expect(branch).toMatch(/USER_IS_BLOCKED[\s\S]*autoStepDownOnBlock\(row\.managerUserId, row\.peerId, now\)/u);
  });

  it('«botmisiz?» after an auto reply: that chat off 30 days; the second such chat in a week disarms', async () => {
    await drafted();
    await drafted({ peer: PEER2 });
    expect(await pressDueAutos(DUE)).toBe(2);
    const later = new Date(DUE.getTime() + 5 * 60_000);
    const q1 = await inbound('Siz botmisiz?', PEER, later);
    expect(await handleInbound(job(q1, PEER), { callModel: scripted([compose()]), now: () => later })).toMatchObject({ outcome: 'notice', reason: 'bot_question' });
    const [off] = await db.select().from(agentAutoChats).where(and(eq(agentAutoChats.managerUserId, ownerId), eq(agentAutoChats.peerId, PEER)));
    expect(off).toMatchObject({ reason: 'bot_question' });
    expect((await readAutoConfig())!.armed).toBe(true);
    const q2 = await inbound('Siz botmisiz?', PEER2, later);
    expect(await handleInbound(job(q2, PEER2), { callModel: scripted([compose()]), now: () => later })).toMatchObject({ outcome: 'notice' });
    expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: 'bot_question' });
  });

  it('«botmisiz?» in a chat the machine never answered changes nothing', async () => {
    const q = await inbound('Siz botmisiz?');
    expect(await handleInbound(job(q), { callModel: scripted([compose()]), now: () => T0 })).toMatchObject({ outcome: 'notice' });
    expect(await db.select().from(agentAutoChats).where(eq(agentAutoChats.managerUserId, ownerId))).toHaveLength(0);
    expect((await readAutoConfig())!.armed).toBe(true);
  });
});

describe('the record and the purge', () => {
  it('the page’s numbers count the machine’s presses apart (stats `autoSent`), never in the rate', async () => {
    const before = await webStats();
    await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    const after = await webStats();
    expect(after.autoSent).toBe(before.autoSent + 1);
    expect(after.decided).toBe(before.decided);
    expect(after.onTheWay).toBe(before.onTheWay);
  });

  it('a purged chat’s card of a reply the machine pressed offers nothing — no ❌, no 🙋, no 👎 (fix pass A)', async () => {
    const d = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    expect(keys(await payloadOf(d.id))).toEqual([['❌ Bekor qilish', '🙋 Suhbat meniki'], ['👎 Xato edi']]);
    await purgeAgentChat(ownerId, PEER);
    expect(buttonsFor('AgentDraft', await payloadOf(d.id))).toBeNull();
  });

  it('a purged chat takes its verdicts and its «off» with it', async () => {
    const d = await drafted();
    await db.insert(agentAutoChats).values({ managerUserId: ownerId, peerId: PEER, offUntil: new Date(Date.now() + 86_400_000), reason: 'feedback' });
    await purgeAgentChat(ownerId, PEER);
    expect(await verdictOf(d.id)).toBeNull();
    expect(await db.select().from(agentAutoChats).where(eq(agentAutoChats.managerUserId, ownerId))).toHaveLength(0);
  });
});

/** The card's notification row as written — what the bot draws the card and its keyboard from. */
async function payloadOf(draftId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
  return row!.payload as Record<string, unknown>;
}

const keys = (payload: Record<string, unknown>) => (buttonsFor('AgentDraft', payload) ?? []).map((r) => r.map((b) => b.text));

describe('the card he reads and presses (stage 2: the words, the payload, the keyboard)', () => {
  it('the FIRST card already counts down: autoAt is the due time, the timer in words, ⏸ first', async () => {
    const d = await drafted();
    const p = await payloadOf(d.id);
    expect(p.autoAt).toBe(new Date(T0.getTime() + HOLD_MS).toISOString());
    expect(p).toMatchObject({ live: true, blocked: false, autoSent: false, autoBad: false });
    expect(String(p.text)).toMatch(/⏱ \d\d:\d\d da o‘zi ketadi — to‘xtatish uchun ⏸ bosing\./u);
    expect(keys(p)).toEqual([['⏸ To‘xtat', '✅ Hozir yubor'], ['✏️ O‘zgartirish'], ['❌ Kerak emas', '🙋 Suhbat meniki']]);
  });

  it('an ineligible reply’s card is today’s card — no timer, no ⏸', async () => {
    const d = await drafted({ steps: [compose('Tekshirib aytaman.', { category: 'complaint' })] });
    const p = await payloadOf(d.id);
    expect(p.autoAt).toBeNull();
    expect(String(p.text)).not.toContain('o‘zi ketadi');
    expect(keys(p)[0]).toEqual(['✅ Yuborish', '✏️ O‘zgartirish']);
  });

  it('⏸ from the bot (op a): stopped, the card his again — its words and its ordinary ✅; a second ⏸ says so', async () => {
    const d = await drafted();
    expect(await agentPress(otherId, 'a', d.id, undefined)).toMatchObject({ toast: 'Bu javob sizning akkauntingizdan emas.' });
    expect(await agentPress(ownerId, 'a', d.id, undefined)).toEqual({ toast: AUTO_STOPPED_TOAST });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'pause' });
    const p = await payloadOf(d.id);
    expect(p.autoAt).toBeNull();
    expect(String(p.text)).toContain('⏸ To‘xtatildi — o‘zingiz qaror qilasiz.');
    expect(keys(p)[0]).toEqual(['✅ Yuborish', '✏️ O‘zgartirish']);
    expect(await agentPress(ownerId, 'a', d.id, undefined)).toEqual({ toast: 'Bu javob endi o‘zi ketmaydi.' });
    expect(await pressDueAutos(DUE)).toBe(0);
  });

  it('pressed: «🤖 AI o‘zi tasdiqladi.» while it goes, «🤖 O‘zi yuborildi (AI).» once it went, and «👎 Xato edi»; 👎 (op f) once, then no button', async () => {
    const d = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    let p = await payloadOf(d.id);
    expect(p).toMatchObject({ live: false, autoAt: null, autoSent: true, autoBad: false });
    // DELIBERATE EDIT (fix pass B, C6): «yuborildi» only for a reply that went — on its way it is «tasdiqladi».
    expect(String(p.text)).toContain('🤖 AI o‘zi tasdiqladi. ✅ Tasdiqlandi');
    expect(String(p.text)).not.toContain('yuborildi');
    // DELIBERATE EDIT (fix pass A, C3): while the reply has not left, the card also offers ❌ «Bekor qilish»
    // and 🙋 — the keyboard this test pins is the one once it went.
    await db.update(agentOutbox).set({ status: 'sent', sentAt: new Date() }).where(eq(agentOutbox.draftId, d.id));
    const { refreshAgentCard } = await import('@/modules/wms/agent/card-io');
    await refreshAgentCard(d.id);
    p = await payloadOf(d.id);
    expect(String(p.text)).toContain('🤖 O‘zi yuborildi (AI). ✅ Yuborildi');
    expect(keys(p)).toEqual([['👎 Xato edi']]);
    expect(await agentPress(ownerId, 'f', d.id, undefined)).toEqual({ toast: AUTO_BAD_TOAST });
    p = await payloadOf(d.id);
    expect(p).toMatchObject({ autoSent: true, autoBad: true });
    expect(String(p.text)).toContain('👎 Xato deb belgilandi — bu suhbatda AI 30 kun o‘zi yozmaydi.');
    expect(buttonsFor('AgentDraft', p)).toBeNull();
    expect(await agentPress(ownerId, 'f', d.id, undefined)).toEqual({ toast: 'Allaqachon belgilangan.' });
  });

  it('the second 👎 in a week answers that the layer switched itself off', async () => {
    const a = await drafted();
    const b = await drafted({ peer: PEER2 });
    expect(await pressDueAutos(DUE)).toBe(2);
    expect(await agentPress(ownerId, 'f', a.id, undefined)).toEqual({ toast: AUTO_BAD_TOAST });
    expect(await agentPress(ownerId, 'f', b.id, undefined)).toEqual({ toast: AUTO_BAD_DISARMED_TOAST });
  });

  it('refused at the press: the card says why in words and is his again', async () => {
    const d = await drafted();
    await db.update(tgAccounts).set({ workAccount: false }).where(eq(tgAccounts.id, accountId));
    expect(await pressDueAutos(DUE)).toBe(0);
    const p = await payloadOf(d.id);
    expect(String(p.text)).toContain('⏱ O‘zi ketmadi: raqam «Ish raqami» deb belgilanmagan — o‘zingiz qaror qiling.');
    expect(p.autoAt).toBeNull();
    expect(keys(p)[0]).toEqual(['✅ Yuborish', '✏️ O‘zgartirish']);
  });

  it('a card too long to show its reply is not pressed — what has no ✅ for him has none for the machine', async () => {
    const d = await drafted();
    const policy = d.policy as { card: Record<string, unknown> };
    await db
      .update(agentDrafts)
      .set({ policy: { ...policy, card: { ...policy.card, customerLabel: `GS${'7'.repeat(3800)}` } } })
      .where(eq(agentDrafts.id, d.id));
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await verdictOf(d.id)).toMatchObject({ state: 'refused', reasons: ['too_long'] });
    expect((await db.select().from(agentDrafts).where(eq(agentDrafts.id, d.id)))[0]!.status).toBe('pending');
    expect(await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, d.id))).toHaveLength(0);
  });

  it('the layer switched off while a reply waited: the card says so and draws today’s keyboard', async () => {
    const d = await drafted();
    await setAutoArmed(actorOf(ownerId), false, { actorId: ownerId });
    const p = await payloadOf(d.id);
    expect(String(p.text)).toContain('O‘zi yuborish o‘chirildi — bu javobni o‘zingiz qaror qilasiz.');
    expect(p.autoAt).toBeNull();
  });

  it('the page reads the same card — ⏸ drawn while it counts down, gone after it', async () => {
    const d = await drafted();
    const viewer = actorOf(ownerId);
    let card = (await webDrafts(viewer)).pending.find((w) => w.id === d.id)!;
    expect(card.autoWaiting).toBe(true);
    expect(card.cardText).toContain('da o‘zi ketadi');
    await stopAuto(ownerId, d.id);
    card = (await webDrafts(viewer)).pending.find((w) => w.id === d.id)!;
    expect(card.autoWaiting).toBe(false);
    expect(card.cardText).toContain('⏸ To‘xtatildi');
  });
});

describe('/agent auto (bot-door `agentCommand`)', () => {
  it('the status answer carries the layer’s line; off says why it was last switched off', async () => {
    expect(await agentCommand(ownerId, '')).toMatch(/🤖 O‘zi yuborish: yoqilgan \(bugun \d+\/30\)\. O‘chirish: \/agent auto off/u);
    expect(await agentCommand(ownerId, 'auto off')).toBe('⏹ O‘zi yuborish o‘chirildi — har bir javobni o‘zingiz ✅ bilan yuborasiz.');
    expect(await agentCommand(ownerId, '')).toContain('🤖 O‘zi yuborish: o‘chiq — oxirgi marta: qo‘lda o‘chirildi. Yoqish: /agent auto on');
    expect(await agentCommand(ownerId, 'auto')).toContain('🤖 O‘zi yuborish: o‘chiq');
  });

  it('on: the holder alone, a work number, a running agent — each refusal in words', async () => {
    await db.update(agentAutoConfig).set({ armedAt: null, armedBy: null }).where(eq(agentAutoConfig.id, 1));
    expect(await agentCommand(otherId, 'auto on')).toBe('O‘zi yuborishni faqat akkaunt egasi yoqadi.');
    await db.update(tgAccounts).set({ workAccount: false }).where(eq(tgAccounts.id, accountId));
    expect(await agentCommand(ownerId, 'auto on')).toBe('Avval raqamni «Ish raqami» deb belgilang.');
    await db.update(tgAccounts).set({ workAccount: true }).where(eq(tgAccounts.id, accountId));
    expect(await agentCommand(ownerId, 'AUTO  ON')).toMatch(/^🤖 O‘zi yuborish yoqildi: mos javob kartasi 2 daqiqa kutadi/u);
    expect((await readAutoConfig())!.armed).toBe(true);
    // Any super_admin may switch it off.
    expect(await agentCommand(otherId, 'auto off')).toContain('o‘chirildi');
    expect((await readAutoConfig())!.armed).toBe(false);
  });
});

describe('the page’s panel (web-page `autoPanel`)', () => {
  it('today’s counts and the sent replies with his 👎 — the reader sees the chats he may read', async () => {
    const sent = await drafted();
    const paused = await drafted({ peer: PEER2 });
    await stopAuto(ownerId, paused.id);
    expect(await pressDueAutos(DUE)).toBe(1);
    // An ineligible one: left to him.
    await drafted({ peer: PEER2, now: new Date(T0.getTime() + 60_000), steps: [compose('Tekshirib aytaman.', { category: 'complaint' })] });
    let panel = (await autoPanel(actorOf(ownerId), ownerId))!;
    expect(panel.config.armed).toBe(true);
    expect(panel.armedByName).toBe(`Auto egasi ${SUFFIX}`);
    expect(panel.workAccount).toBe(true);
    // DELIBERATE EDIT (fix pass B, C6): approved and still with the pump is «yuborilmoqda», never «o‘zi yubordi».
    expect(panel.today).toEqual({ sent: 0, going: 1, unclear: 0, paused: 1, waiting: 0, left: 1 });
    expect(panel.sent.find((r) => r.draftId === sent.id)).toMatchObject({ delivery: 'going', sentAt: null });
    const at = new Date();
    await db.update(agentOutbox).set({ status: 'sent', sentAt: at }).where(eq(agentOutbox.draftId, sent.id));
    panel = (await autoPanel(actorOf(ownerId), ownerId))!;
    expect(panel.today).toEqual({ sent: 1, going: 0, unclear: 0, paused: 1, waiting: 0, left: 1 });
    const row = panel.sent.find((r) => r.draftId === sent.id)!;
    expect(row).toMatchObject({ managerUserId: ownerId, text: REPLY, bad: false, chatHref: `/suhbatlar/${clientId}`, delivery: 'sent' });
    expect(row.sentAt!.getTime()).toBe(at.getTime());
    await autoFeedback(ownerId, sent.id);
    expect((await autoPanel(actorOf(ownerId), ownerId))!.sent.find((r) => r.draftId === sent.id)!.bad).toBe(true);
    // A reader who sees only his own account's chats is shown none of another's.
    const own = await autoPanel({ id: otherId, roles: [], permissions: new Set<string>() }, ownerId);
    expect(own!.sent.some((r) => r.draftId === sent.id)).toBe(false);
  });

  it('«kutmoqda» is a LIVE reply counting down — one the chat already retired is his', async () => {
    const d = await drafted();
    expect((await autoPanel(actorOf(ownerId), ownerId))!.today).toEqual({ sent: 0, going: 0, unclear: 0, paused: 0, waiting: 1, left: 0 });
    // Retired under the waiting row (the sweep would call it gone at its due time).
    await db.update(agentDrafts).set({ status: 'superseded' }).where(eq(agentDrafts.id, d.id));
    expect((await verdictOf(d.id))!.state).toBe('waiting');
    expect((await autoPanel(actorOf(ownerId), ownerId))!.today).toEqual({ sent: 0, going: 0, unclear: 0, paused: 0, waiting: 0, left: 1 });
  });
});

describe('one migration behind — today’s behaviour', () => {
  it('no panel, no status line, «/agent auto» says «yangilanmagan», a card with no timer', async () => {
    __pretendAgentAutoBehind();
    try {
      const d = await drafted();
      expect((await payloadOf(d.id)).autoAt).toBeNull();
      expect(keys(await payloadOf(d.id))[0]).toEqual(['✅ Yuborish', '✏️ O‘zgartirish']);
      expect(await autoPanel(actorOf(ownerId), ownerId)).toBeNull();
      expect(await agentCommand(ownerId, '')).not.toContain('O‘zi yuborish');
      expect(await agentCommand(ownerId, 'auto on')).toBe('Server hali yangilanmagan — o‘zi yuborish yo‘q.');
      expect(await agentPress(ownerId, 'a', d.id, undefined)).toEqual({ toast: 'Server hali yangilanmagan — o‘zi yuborish yo‘q.' });
    } finally {
      __forgetAgentAutoReady();
    }
  });

  it('no verdict row, an ordinary card, nothing pressed, ⏸ says «yangilanmagan», his ✅ as before', async () => {
    __pretendAgentAutoBehind();
    try {
      const d = await drafted();
      expect(await verdictOf(d.id)).toBeNull();
      expect(await pressDueAutos(DUE)).toBe(0);
      expect(await stopAuto(ownerId, d.id)).toEqual({ ok: false, code: 'not_ready' });
      const r = await decideDraft(actorOf(ownerId), d.id, 'send', { digest: await cardDigestOf(d.id) }, { actorId: ownerId });
      expect(r).toMatchObject({ ok: true, status: 'approved' });
      expect((await agentSweep(DUE)).autoPressed).toBe(0);
    } finally {
      __forgetAgentAutoReady();
    }
  });
});

async function outboxOf(draftId: string) {
  const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, draftId));
  return o ?? null;
}

async function draftStatus(draftId: string): Promise<string | undefined> {
  return (await db.select({ status: agentDrafts.status }).from(agentDrafts).where(eq(agentDrafts.id, draftId)))[0]?.status;
}

async function humanUntilOf(peer: bigint): Promise<Date | null> {
  const [c] = await db
    .select({ humanUntil: agentConversations.humanUntil })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, ownerId), eq(agentConversations.peerId, peer)));
  return c?.humanUntil ?? null;
}

/**
 * Fix pass A (the review of stage 2): the press itself. A stop against a claimed row (C2), a person after the
 * machine approved (C3), the hold against the card actually reaching him (C4), a disarm against an in-flight press
 * (C5) and cards counting down to a certain refusal (C8). Each test was red on b44bff74 before its fix.
 */
describe('fix pass A — ⏸ against a claimed row (C2)', () => {
  it('⏸ on a row the sweep claimed and never pressed (it died): stopped — and the reclaim never revives it', async () => {
    const d = await drafted();
    // The sweep claimed it and was killed before its press (a deploy): 'pressing', and nothing in flight.
    await db.update(agentAutoVerdicts).set({ state: 'pressing', claimedAt: DUE }).where(eq(agentAutoVerdicts.draftId, d.id));
    expect(await stopAuto(ownerId, d.id)).toEqual({ ok: true });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'pause', stoppedBy: ownerId });
    // Six minutes on, the reclaim's turn: a stopped row is no row of its.
    expect(await pressDueAutos(new Date(DUE.getTime() + 6 * 60_000))).toBe(0);
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'pause' });
    expect(await outboxOf(d.id)).toBeNull();
    expect(await draftStatus(d.id)).toBe('pending');
  });

  it('⏸ while the machine’s ✅ is in flight, before its approval: «To‘xtatildi» is true — nothing is queued', async () => {
    const d = await drafted();
    let answer: unknown = null;
    // The gate's facts ask the window first; the second ask is decideDraft's own, after the claim and the gate.
    seam.hook = { skip: 1, run: async () => void (answer = await stopAuto(ownerId, d.id)) };
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(answer).toEqual({ ok: true });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'pause' });
    expect(await outboxOf(d.id)).toBeNull();
    expect(await draftStatus(d.id)).toBe('pending');
  });

  it('⏸ on the NEXT row of the sweep’s batch while the first is being pressed stops that one', async () => {
    const a = await drafted();
    // Due a second later: the batch presses A first.
    const b = await drafted({ peer: PEER2, now: new Date(T0.getTime() + 1_000) });
    let answer: unknown = null;
    seam.hook = { skip: 1, run: async () => void (answer = await stopAuto(ownerId, b.id)) };
    expect(await pressDueAutos(new Date(DUE.getTime() + 2_000))).toBe(1);
    expect(answer).toEqual({ ok: true });
    expect((await verdictOf(a.id))!.state).toBe('pressed');
    expect(await verdictOf(b.id)).toMatchObject({ state: 'stopped', outcome: 'pause' });
    expect(await outboxOf(b.id)).toBeNull();
  });

  it('the approval itself refuses a row a stop moved: the machine’s ✅ on a stopped row writes nothing', async () => {
    const d = await drafted();
    await db.update(agentAutoVerdicts).set({ state: 'stopped', outcome: 'pause', stoppedAt: new Date(), stoppedBy: ownerId }).where(eq(agentAutoVerdicts.draftId, d.id));
    const r = await decideDraft(actorOf(ownerId), d.id, 'send', { digest: await cardDigestOf(d.id), auto: true }, { actorId: null });
    expect(r).toEqual({ ok: false, code: 'auto_stopped' });
    expect(await outboxOf(d.id)).toBeNull();
    expect(await draftStatus(d.id)).toBe('pending');
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'pause' });
  });
});

describe('fix pass A — a disarm against an in-flight press (C5)', () => {
  it('«o‘chirish» committed while the machine’s ✅ is in flight: the press loses', async () => {
    const d = await drafted();
    seam.hook = { skip: 1, run: async () => void (await setAutoArmed(actorOf(ownerId), false, { actorId: ownerId })) };
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: 'manual' });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'disarmed' });
    expect(await outboxOf(d.id)).toBeNull();
    expect(await draftStatus(d.id)).toBe('pending');
  });

  it('«Shaxsiy raqam» chosen while the ✅ is in flight: the layer disarms and the press loses', async () => {
    const d = await drafted();
    seam.hook = { skip: 1, run: async () => void (await setWorkAccount(ownerId, false)) };
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: 'not_work_account' });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'disarmed' });
    expect(await outboxOf(d.id)).toBeNull();
  });

  it('the approval re-reads the layer even with no disarm written: armed no more, or not a work number → refused', async () => {
    const a = await drafted();
    // Flipped by hand under the press (no disarm, no stop): the gate read it armed, the approval reads it now.
    seam.hook = { skip: 1, run: async () => void (await db.update(agentAutoConfig).set({ armedAt: null, armedBy: null }).where(eq(agentAutoConfig.id, 1))) };
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await verdictOf(a.id)).toMatchObject({ state: 'refused', outcome: 'auto_disarmed' });
    expect(await outboxOf(a.id)).toBeNull();
    await armFresh();
    const b = await drafted({ peer: PEER2 });
    seam.hook = { skip: 1, run: async () => void (await db.update(tgAccounts).set({ workAccount: false }).where(eq(tgAccounts.id, accountId))) };
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await verdictOf(b.id)).toMatchObject({ state: 'refused', outcome: 'auto_disarmed' });
    expect(await outboxOf(b.id)).toBeNull();
  });

  it('unmarking «Ish raqami» on the agent’s account disarms the layer and gives him the waiting card back', async () => {
    const d = await drafted();
    expect(await setWorkAccount(ownerId, false)).toBe(true);
    expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: 'not_work_account' });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'disarmed' });
    expect(String((await payloadOf(d.id)).text)).toContain('O‘zi yuborish o‘chirildi — bu javobni o‘zingiz qaror qilasiz.');
    expect(await agentCommand(ownerId, '')).toContain('raqam «Ish raqami» emas deb belgilandi');
  });

  it('a disarm takes back the machine’s replies not yet sent — never a person’s', async () => {
    const auto = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    const mine = await drafted({ peer: PEER2 });
    // His own ✅ on the other chat's card — the person's path.
    expect(await decideDraft(actorOf(ownerId), mine.id, 'send', { digest: await cardDigestOf(mine.id) }, { actorId: ownerId })).toMatchObject({ ok: true });
    await setAutoArmed(actorOf(ownerId), false, { actorId: ownerId });
    expect(await outboxOf(auto.id)).toMatchObject({ status: 'cancelled' });
    expect((await outboxOf(auto.id))!.lastError).toMatch(/^auto_off/u);
    expect(await outboxOf(mine.id)).toMatchObject({ status: 'agent' });
    expect(String((await payloadOf(auto.id)).text)).toContain('🤖 AI o‘zi tasdiqlagan edi. ✖ Yuborilmadi — o‘zi yuborish o‘chirildi.');
  });
});

describe('fix pass A — a person after the machine pressed (C3)', () => {
  it('🙋 on the machine-approved card: the chat is his for 24 h, and its reply, not yet sent, is withdrawn', async () => {
    const d = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    const r = await decideDraft(actorOf(ownerId), d.id, 'human', {}, { actorId: ownerId });
    expect(r).toMatchObject({ ok: true, withdrawn: { total: 1, own: 0 } });
    expect(await outboxOf(d.id)).toMatchObject({ status: 'cancelled' });
    expect((await humanUntilOf(PEER))!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it('🙋 once the machine’s reply went: the chat is still his — and the press says the reply already went', async () => {
    const d = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    await db.update(agentOutbox).set({ status: 'sent', sentAt: new Date() }).where(eq(agentOutbox.draftId, d.id));
    const press = await agentPress(ownerId, 'h', d.id, undefined);
    expect(press.toast).toBe('🙋 Suhbat 24 soat sizniki — AI javobi allaqachon ketgan');
    expect((await humanUntilOf(PEER))!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(await outboxOf(d.id)).toMatchObject({ status: 'sent' });
  });

  it('❌ on the machine-approved card cancels that reply; once it is being sent or went — «kech», in words', async () => {
    const a = await drafted();
    const b = await drafted({ peer: PEER2 });
    expect(await pressDueAutos(DUE)).toBe(2);
    expect(await agentPress(ownerId, 'r', a.id, undefined)).toMatchObject({ toast: '❌ Bekor qilindi — javob mijozga ketmaydi' });
    expect(await outboxOf(a.id)).toMatchObject({ status: 'cancelled', lastError: CANCELLED_BY_HOLDER });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'agent_outbox'), eq(auditLog.entityId, (await outboxOf(a.id))!.id)));
    expect(audit).toMatchObject({ actorId: ownerId, action: 'status_change' });
    // The card says it never left, and the panel no longer lists it as sent — it was his to decide.
    expect(String((await payloadOf(a.id)).text)).toContain('🤖 AI o‘zi tasdiqlagan edi. ✖ Yuborilmadi — o‘zingiz qaytarib oldingiz.');
    const panel = (await autoPanel(actorOf(ownerId), ownerId))!;
    expect(panel.sent.map((r) => r.draftId)).toEqual([b.id]);
    // DELIBERATE EDIT (fix pass B, C6): b is still with the pump — on its way, not yet «o‘zi yubordi».
    expect(panel.today).toEqual({ sent: 0, going: 1, unclear: 0, paused: 0, waiting: 0, left: 1 });
    // B: the listener has read the customer's line already — too late to take it back from here.
    await db.update(agentOutbox).set({ readDone: true }).where(eq(agentOutbox.draftId, b.id));
    expect(await decideDraft(actorOf(ownerId), b.id, 'reject', {}, { actorId: ownerId })).toEqual({ ok: false, code: 'auto_sending' });
    expect(await agentPress(ownerId, 'r', b.id, undefined)).toEqual({ toast: 'Kech — javob yuborilmoqda.' });
    await db.update(agentOutbox).set({ status: 'sent', sentAt: new Date() }).where(eq(agentOutbox.draftId, b.id));
    expect(await decideDraft(actorOf(ownerId), b.id, 'reject', {}, { actorId: ownerId })).toEqual({ ok: false, code: 'auto_sent' });
    expect(await agentPress(ownerId, 'r', b.id, undefined)).toEqual({ toast: 'Kech — javob yuborildi.' });
    expect(await outboxOf(b.id)).toMatchObject({ status: 'sent' });
  });

  it('✅ and ✏️ on the machine-approved card: «kech», naming «❌ Bekor qilish»', async () => {
    const d = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    expect(await decideDraft(actorOf(ownerId), d.id, 'send', { digest: await cardDigestOf(d.id) }, { actorId: ownerId })).toEqual({
      ok: false,
      code: 'auto_pressed',
    });
    expect(await decideDraft(actorOf(ownerId), d.id, 'edit', {}, { actorId: ownerId })).toEqual({ ok: false, code: 'auto_pressed' });
    expect((await agentPress(ownerId, 'e', d.id, undefined)).toast).toContain('«❌ Bekor qilish»');
    expect(await stopAuto(ownerId, d.id)).toEqual({ ok: false, code: 'pressed' });
    expect(await outboxOf(d.id)).toMatchObject({ status: 'agent' });
  });

  it('the pressed card offers «❌ Bekor qilish» and «🙋» while its reply waits — only 👎 once it went', async () => {
    const d = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    const p = await payloadOf(d.id);
    expect(keys(p)).toEqual([['❌ Bekor qilish', '🙋 Suhbat meniki'], ['👎 Xato edi']]);
    expect((buttonsFor('AgentDraft', p) ?? []).flat().map((b) => ('callback_data' in b ? b.callback_data : ''))).toEqual([
      `ag:r:${d.id}`,
      `ag:h:${d.id}`,
      `ag:f:${d.id}`,
    ]);
    await db.update(agentOutbox).set({ status: 'sent', sentAt: new Date() }).where(eq(agentOutbox.draftId, d.id));
    const { refreshAgentCard } = await import('@/modules/wms/agent/card-io');
    await refreshAgentCard(d.id);
    expect(keys(await payloadOf(d.id))).toEqual([['👎 Xato edi']]);
  });

  it('after a PERSON’s own ✅, ❌ and 🙋 still answer «faol emas» — the human path is today’s', async () => {
    const d = await drafted();
    expect(await decideDraft(actorOf(ownerId), d.id, 'send', { digest: await cardDigestOf(d.id) }, { actorId: ownerId })).toMatchObject({ ok: true });
    expect(await decideDraft(actorOf(ownerId), d.id, 'reject', {}, { actorId: ownerId })).toMatchObject({ ok: false, code: 'not_live' });
    expect(await decideDraft(actorOf(ownerId), d.id, 'human', {}, { actorId: ownerId })).toMatchObject({ ok: false, code: 'not_live' });
    expect(await outboxOf(d.id)).toMatchObject({ status: 'agent' });
    expect(await humanUntilOf(PEER)).toBeNull();
  });
});

describe('fix pass A — the hold counts from the card reaching him (C4)', () => {
  it('a card that never reached him is not pressed: the timer waits for the card, says so, and runs from its arrival', async () => {
    const d = await drafted({ shown: null });
    expect(await pressDueAutos(DUE)).toBe(0);
    let v = await verdictOf(d.id);
    expect(v).toMatchObject({ state: 'waiting', outcome: 'unseen' });
    expect(v!.dueAt!.getTime()).toBe(DUE.getTime() + 60_000);
    expect(await outboxOf(d.id)).toBeNull();
    let p = await payloadOf(d.id);
    expect(String(p.text)).toContain('⏱ Karta Telegramingizga hali yetib bormadi');
    // ⏸ stays on it: the card counts down still.
    expect(keys(p)[0]).toEqual(['⏸ To‘xtat', '✅ Hozir yubor']);
    // It lands in his Telegram half a minute after its first due time: the hold runs from there.
    const landed = new Date(DUE.getTime() + 30_000);
    await shownAt(d.id, landed);
    expect(await pressDueAutos(new Date(DUE.getTime() + 61_000))).toBe(0);
    v = await verdictOf(d.id);
    expect(v).toMatchObject({ state: 'waiting', outcome: null });
    expect(v!.dueAt!.getTime()).toBe(landed.getTime() + HOLD_MS);
    p = await payloadOf(d.id);
    expect(p.autoAt).toBe(new Date(landed.getTime() + HOLD_MS).toISOString());
    expect(String(p.text)).toMatch(/⏱ \d\d:\d\d da o‘zi ketadi/u);
    expect(await pressDueAutos(new Date(landed.getTime() + HOLD_MS + 1_000))).toBe(1);
    expect((await verdictOf(d.id))!.state).toBe('pressed');
  });

  it('a re-pointed card whose edit did not land: ⏸ on the old draft stops the chat’s live reply — and neither goes', async () => {
    const a = await drafted();
    const t1 = new Date(T0.getTime() + 30_000);
    // The chat's card row now names B — and his Telegram still shows A (the edit never landed).
    const b = await drafted({ now: t1, shown: null });
    expect(await draftStatus(a.id)).toBe('superseded');
    expect(await agentPress(ownerId, 'a', a.id, undefined)).toEqual({ toast: AUTO_STOPPED_TOAST });
    expect(await verdictOf(b.id)).toMatchObject({ state: 'stopped', outcome: 'pause', stoppedBy: ownerId });
    expect((await verdictOf(a.id))!.state).toBe('gone');
    expect(await pressDueAutos(new Date(t1.getTime() + HOLD_MS + 1_000))).toBe(0);
    expect(await outboxOf(b.id)).toBeNull();
  });

  it('⏸ on a dead card with no live reply in the chat says it will not go — never «To‘xtatildi»', async () => {
    const a = await drafted();
    await db.update(agentDrafts).set({ status: 'expired' }).where(eq(agentDrafts.id, a.id));
    expect(await stopAuto(ownerId, a.id)).toEqual({ ok: false, code: 'not_waiting' });
    expect((await verdictOf(a.id))!.state).toBe('gone');
  });

  it('with no ⏸: the re-pointed reply is pressed only once an edit put ITS text on his screen, a hold later', async () => {
    await drafted();
    const t1 = new Date(T0.getTime() + 30_000);
    const b = await drafted({ now: t1, shown: null });
    const dueB = new Date(t1.getTime() + HOLD_MS + 1_000);
    process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
    let editOk = false;
    let edits = 0;
    __setTelegramTransport(async (url) => {
      if (url.endsWith('/editMessageText')) edits += 1;
      return editOk
        ? new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })
        : new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: something went wrong' }), { status: 400 });
    });
    // Telegram refuses the edit: his screen still shows A, and B waits.
    expect(await pressDueAutos(dueB)).toBe(0);
    expect(edits).toBeGreaterThan(0);
    expect(await verdictOf(b.id)).toMatchObject({ state: 'waiting', outcome: 'unseen' });
    expect(((await payloadOf(b.id)).shown as { draftId: string }).draftId).not.toBe(b.id);
    // The next redraw lands: his screen shows B from that moment, and the hold runs from it.
    editOk = true;
    const next = new Date(dueB.getTime() + 60_000);
    expect(await pressDueAutos(next)).toBe(0);
    expect((await payloadOf(b.id)).shown).toEqual({ draftId: b.id, at: next.toISOString() });
    const v = await verdictOf(b.id);
    expect(v).toMatchObject({ state: 'waiting', outcome: null });
    expect(v!.dueAt!.getTime()).toBe(next.getTime() + HOLD_MS);
    expect(await pressDueAutos(new Date(next.getTime() + HOLD_MS + 1_000))).toBe(1);
    expect(await outboxOf(b.id)).toMatchObject({ status: 'agent' });
  });
});

describe('fix pass A — no card counts down to a certain refusal (C8)', () => {
  it('the daily cap counts the replies still counting down: one a day — the second card is ordinary from its first second', async () => {
    await db.update(agentAutoConfig).set({ perDay: 1 }).where(eq(agentAutoConfig.id, 1));
    const first = await drafted();
    expect((await verdictOf(first.id))!.state).toBe('waiting');
    const second = await drafted({ peer: PEER2 });
    expect(await verdictOf(second.id)).toMatchObject({ eligible: false, reasons: ['daily_cap'] });
    expect((await payloadOf(second.id)).autoAt).toBeNull();
  });

  it('…never the chat’s own live reply — the new draft supersedes it, and counts in its place', async () => {
    await db.update(agentAutoConfig).set({ perDay: 1 }).where(eq(agentAutoConfig.id, 1));
    const first = await drafted();
    const again = await drafted({ now: new Date(T0.getTime() + 30_000) });
    expect(await draftStatus(first.id)).toBe('superseded');
    expect(await verdictOf(again.id)).toMatchObject({ eligible: true, state: 'waiting' });
  });

  it('the CRM’s send switch off: refused at the scheduling, in words', async () => {
    await setSetting('tg_sending_enabled', false, ownerId);
    try {
      const d = await drafted();
      expect(await verdictOf(d.id)).toMatchObject({ eligible: false, reasons: ['sending_disabled'] });
      expect((await payloadOf(d.id)).autoAt).toBeNull();
    } finally {
      await setSetting('tg_sending_enabled', true, ownerId);
    }
  });

  it('a listener still catching up: refused at the scheduling', async () => {
    await stampAgentPump(accountId, false);
    expect(await verdictOf((await drafted()).id)).toMatchObject({ eligible: false, reasons: ['listener_behind'] });
  });

  it('the agent’s day of sends: the replies counting down are spent from it', async () => {
    // Started an hour before T0, with no sends of his own before it: the first day's ceiling is ONE send.
    await db.update(agentConfig).set({ startedAt: new Date(T0.getTime() - 3_600_000) }).where(eq(agentConfig.id, 1));
    const first = await drafted();
    expect((await verdictOf(first.id))!.state).toBe('waiting');
    const second = await drafted({ peer: PEER2 });
    expect(await verdictOf(second.id)).toMatchObject({ eligible: false, reasons: ['budget_spent'] });
  });
});

/** The agent's account as the listener's pump names it — its alarms name the manager (crm account-alarm). */
const alarmAccount = () => ({ id: accountId, managerUserId: ownerId, managerName: `Auto egasi ${SUFFIX}` });

describe('fix pass B — what he sees and presses (C1 C6 C7 C9 C10)', () => {
  it('C1: the page’s ✏️ stops the countdown on the server BEFORE its box opens — nothing is pressed while he types', async () => {
    const d = await drafted();
    expect(await stopAutoForEdit(otherId, d.id)).toEqual({ ok: false, code: 'not_account_holder' });
    expect((await verdictOf(d.id))!.state).toBe('waiting');
    expect(await stopAutoForEdit(ownerId, d.id)).toEqual({ ok: true, stopped: true });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'owner_edit', stoppedBy: ownerId });
    // The card is his ordinary card again, at once — no timer, no ⏸.
    expect((await payloadOf(d.id)).autoAt).toBeNull();
    // He types for minutes; the sweep comes due and presses nothing; his «Saqlash» lands.
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await submitOwnText(actorOf(ownerId), d.id, 'Ha, olib kelamiz. Yukingiz nima?', { actorId: ownerId })).toMatchObject({ ok: true });
    expect(await outboxOf(d.id)).toBeNull();
  });

  it('C1: ✏️ once the machine pressed says «kech» — the box stays shut; a card that never counted down opens as always', async () => {
    const d = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    expect(await stopAutoForEdit(ownerId, d.id)).toEqual({ ok: false, code: 'pressed' });
    await db.update(agentOutbox).set({ status: 'sent', sentAt: new Date() }).where(eq(agentOutbox.draftId, d.id));
    expect(await stopAutoForEdit(ownerId, d.id)).toEqual({ ok: false, code: 'sent' });
    // Never counted down (a complaint): nothing to stop, nothing written, the box opens.
    const plain = await drafted({ peer: PEER2, steps: [compose('Tekshirib aytaman.', { category: 'complaint' })] });
    expect(await stopAutoForEdit(ownerId, plain.id)).toEqual({ ok: true, stopped: false });
    expect(await verdictOf(plain.id)).toMatchObject({ eligible: false, state: null });
  });

  it('C1: the page’s ✏️ button asks the server first and opens its box only on «ok» (agent-ui wire)', () => {
    const ui = readFileSync('src/app/(protected)/suhbatlar/ai/agent-ui.tsx', 'utf8');
    const edit = ui.slice(ui.indexOf('data-testid="agent-edit"'), ui.indexOf('data-testid="agent-reject"'));
    expect(edit).toMatch(/run\(\(\) => agentEditOpenAction\(draftId\), \(\) => setEditing\(true\)\)/u);
    expect(edit).not.toMatch(/setEditing\(\(was\) => !was\)/u);
    const actions = readFileSync('src/modules/wms/agent/web-actions.ts', 'utf8');
    const open = actions.slice(actions.indexOf('export async function agentEditOpenAction'));
    expect(open.slice(0, open.indexOf('\n}\n'))).toMatch(/stopAutoForEdit\(actor\.id, draftId\)/u);
  });

  it('C6: «o‘zi yubordi» counts and lists only what went; on its way, unknown and never-left are each said as they are', async () => {
    const a = await drafted();
    const b = await drafted({ peer: PEER2 });
    expect(await pressDueAutos(DUE)).toBe(2);
    await db.update(agentOutbox).set({ status: 'unknown', lastError: 'timeout' }).where(eq(agentOutbox.draftId, a.id));
    const { refreshAgentCard } = await import('@/modules/wms/agent/card-io');
    await refreshAgentCard(a.id);
    expect(String((await payloadOf(a.id)).text)).toContain('🤖 AI o‘zi tasdiqladi. ❓ Yuborildimi — noma’lum.');
    let panel = (await autoPanel(actorOf(ownerId), ownerId))!;
    expect(panel.today).toEqual({ sent: 0, going: 1, unclear: 1, paused: 0, waiting: 0, left: 0 });
    expect(Object.fromEntries(panel.sent.map((r) => [r.draftId, r.delivery]))).toEqual({ [a.id]: 'unclear', [b.id]: 'going' });
    // Telegram refuses b: never left — his, not listed, and the card never says «yuborildi».
    await db.update(agentOutbox).set({ status: 'failed', lastError: 'USER_PRIVACY_RESTRICTED' }).where(eq(agentOutbox.draftId, b.id));
    await refreshAgentCard(b.id);
    expect(String((await payloadOf(b.id)).text)).toMatch(/^.*🤖 AI o‘zi tasdiqlagan edi\. ⚠️ Yuborilmadi/mu);
    expect(String((await payloadOf(b.id)).text)).not.toContain('O‘zi yuborildi');
    panel = (await autoPanel(actorOf(ownerId), ownerId))!;
    expect(panel.today).toEqual({ sent: 0, going: 0, unclear: 1, paused: 0, waiting: 0, left: 1 });
    expect(panel.sent.map((r) => r.draftId)).toEqual([a.id]);
  });

  it('C7: a purged chat’s pressed card offers no 👎, and a stale 👎 says the reply is not found — never «o‘zi yuborilmagan»', async () => {
    const d = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    await db.update(agentOutbox).set({ status: 'sent', sentAt: new Date() }).where(eq(agentOutbox.draftId, d.id));
    const { refreshAgentCard } = await import('@/modules/wms/agent/card-io');
    await refreshAgentCard(d.id);
    expect(keys(await payloadOf(d.id))).toEqual([['👎 Xato edi']]);
    await purgeAgentChat(ownerId, PEER);
    const p = await payloadOf(d.id);
    expect(p).toMatchObject({ live: false, autoSent: false, autoBad: false, autoAt: null });
    expect(buttonsFor('AgentDraft', p)).toBeNull();
    // A keyboard Telegram did not take back (the edit failed): its press says what is true.
    expect(await agentPress(ownerId, 'f', d.id, undefined)).toEqual({ toast: 'Bu javob topilmadi.' });
  });

  it('C9: armed on a number that is not «Ish raqami» (another writer than the switch) — the panel and «/agent» say nothing can go', async () => {
    await db.update(tgAccounts).set({ workAccount: false }).where(eq(tgAccounts.id, accountId));
    const panel = (await autoPanel(actorOf(ownerId), ownerId))!;
    expect(panel).toMatchObject({ workAccount: false, config: { armed: true } });
    expect(await autoStatusLine(ownerId, DUE)).toBe(
      '🤖 O‘zi yuborish: yoqilgan (bugun 0/30) — ⚠ raqam «Ish raqami» emas, hech qaysi javob o‘zi ketmaydi. O‘chirish: /agent auto off',
    );
    // …and off on such a number, the status says what to do first — before «/agent auto on» refuses.
    await setAutoArmed(actorOf(ownerId), false, { actorId: ownerId });
    expect(await autoStatusLine(ownerId, DUE)).toBe(
      '🤖 O‘zi yuborish: o‘chiq — oxirgi marta: qo‘lda o‘chirildi. Yoqish uchun avval «Telegram ulash» sahifasida raqamni «Ish raqami» deb belgilang',
    );
    await db.update(tgAccounts).set({ workAccount: true }).where(eq(tgAccounts.id, accountId));
    expect(await autoStatusLine(ownerId, DUE)).toContain('. Yoqish: /agent auto on');
    expect((await autoPanel(actorOf(ownerId), ownerId))!.workAccount).toBe(true);
  });

  it('C9: the page says why it cannot arm BEFORE the press, and offers no button then (page + agent-ui wire)', () => {
    const page = readFileSync('src/app/(protected)/suhbatlar/ai/page.tsx', 'utf8');
    expect(page).toMatch(/\{c\.armed && !auto\.workAccount && \(/u);
    expect(page).toMatch(/tone=\{c\.armed \? \(auto\.workAccount \? 'text-good' : 'text-warn'\) : 'text-ink-700'\}/u);
    expect(page).toMatch(/\{!c\.armed && holder && !auto\.workAccount && \(/u);
    expect(page).toMatch(/armBlocked=\{!running \|\| !auto\.workAccount\}/u);
    const ui = readFileSync('src/app/(protected)/suhbatlar/ai/agent-ui.tsx', 'utf8');
    const arm = ui.slice(ui.indexOf('data-testid="agent-auto-arm"') - 200, ui.indexOf('data-testid="agent-auto-arm"') + 200);
    expect(arm).toMatch(/disabled=\{pending \|\| armBlocked\}/u);
    expect(arm).toMatch(/if \(armBlocked\) return;/u);
  });

  it('C10: each machine «off» stays said as its own reason — a block is never «Telegram akkaunti cheklandi»', async () => {
    const said: Record<string, string> = {};
    for (const reason of ['account_paused', 'flood_repeat', 'blocks', 'telegram_notice'] as const) {
      await agentOn();
      await armFresh();
      expect(await forceAgentOff(reason)).not.toBeNull();
      expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: `forced: ${reason}` });
      said[reason] = (await autoStatusLine(ownerId, DUE))!;
    }
    expect(said.account_paused).toContain('oxirgi marta: Telegram akkauntni chekladi');
    expect(said.flood_repeat).toContain('oxirgi marta: 24 soat ichida Telegram ikki marta kutishni buyurdi');
    expect(said.blocks).toContain('oxirgi marta: 7 kun ichida ikki mijoz akkauntni bloklagan');
    expect(said.telegram_notice).toContain('oxirgi marta: Telegramning xizmat akkaunti (777000) xabar yubordi');
    for (const r of ['flood_repeat', 'blocks', 'telegram_notice']) expect(said[r], r).not.toMatch(/chekla/u);
  });

  it('C10: the second block of the week — the agent’s own «off» lands first, and the record says customers blocked it', async () => {
    // A reply HE sent, refused by a customer who blocked us: one block, nothing the machine pressed.
    const his = await drafted({ peer: PEER2, steps: [compose('Tekshirib aytaman.', { category: 'complaint' })] });
    expect(await decideDraft(actorOf(ownerId), his.id, 'send', { digest: await cardDigestOf(his.id) }, { actorId: ownerId })).toMatchObject({ ok: true });
    const blocked = { kind: 'failed' as const, reason: 'USER_IS_BLOCKED', error: { kind: 'recipient_final' as const, code: 'USER_IS_BLOCKED' }, markUnread: false };
    await applyAgentOutcome((await agentRowById((await outboxOf(his.id))!.id))!, blocked, alarmAccount(), DUE);
    expect((await readAutoConfig())!.armed).toBe(true);
    // The machine's reply meets the second: `agentBlocked` switches the agent off before the step-down asks.
    const auto = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    await applyAgentOutcome((await agentRowById((await outboxOf(auto.id))!.id))!, blocked, alarmAccount(), DUE);
    expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: 'forced: blocks' });
    expect(await autoStatusLine(ownerId, DUE)).toContain('oxirgi marta: 7 kun ichida ikki mijoz akkauntni bloklagan — AI sotuvchi o‘zi o‘chdi');
  });
});

describe('fix pass B — the tests the review found missing (TESTS-1…6)', () => {
  describe('the streak, as production writes the chat (TESTS-1)', () => {
    const WORDS = ['birinchi', 'ikkinchi', 'uchinchi'];
    const tag = SUFFIX.split('').map((d) => 'abcdefghij'[Number(d)]).join('');
    /** Each reply its own words and each question its own line: the echo keeps every sent reply, and a repeat is refused. */
    function say(i: number) {
      while ((msgSeq + 1n) % BigInt(QUESTIONS.length) !== BigInt(i)) msgSeq += 1n;
      return [compose(`${WORDS[i]} javob: Xitoydan olib kelamiz. Qanday yuk ${tag}?`)];
    }
    /** The pump sends it — `applyAgentOutcome`'s own 'sent': the outbox row, then the thread's copy (`recordSent`). */
    async function pumpSends(draftId: string, at: Date) {
      msgSeq += 1n;
      await applyAgentOutcome((await agentRowById((await outboxOf(draftId))!.id))!, { kind: 'sent', tgMessageId: msgSeq }, alarmAccount(), at);
    }
    /** Two machine replies, each pressed and SENT; returns when the third arrives. */
    async function twoAutos(): Promise<Date> {
      let at = T0;
      for (let i = 0; i < 2; i++) {
        const d = await drafted({ now: at, steps: say(i) });
        expect(await pressDueAutos(new Date(at.getTime() + HOLD_MS + 1_000))).toBe(1);
        await pumpSends(d.id, new Date(at.getTime() + HOLD_MS + 30_000));
        expect(await outboxOf(d.id)).toMatchObject({ status: 'sent' });
        at = new Date(at.getTime() + 5 * 60_000);
      }
      return at;
    }

    it('two replies the pump SENT — each echoed into the chat — and the third waits for him', async () => {
      const at = await twoAutos();
      const echoes = await db.select().from(tgMessages).where(and(eq(tgMessages.peerId, PEER), eq(tgMessages.direction, 'out')));
      expect(echoes).toHaveLength(2);
      expect(await verdictOf((await drafted({ now: at, steps: say(2) })).id)).toMatchObject({ eligible: false, reasons: ['streak'] });
    });

    it('the account’s Business robot is not him: an auto_sent line resets nothing', async () => {
      const at = await twoAutos();
      msgSeq += 1n;
      const [robot] = await db
        .insert(tgMessages)
        .values({ clientId, managerUserId: ownerId, peerId: PEER, tgMessageId: msgSeq, direction: 'out', body: 'Ish vaqtimiz 9:00 dan', sentAt: new Date(at.getTime() - 120_000) })
        .returning({ id: tgMessages.id });
      await db.execute(sql`INSERT INTO tg_message_flags (message_id, auto_sent) VALUES (${robot!.id}::uuid, true)
                             ON CONFLICT (message_id) DO UPDATE SET auto_sent = true`);
      expect(await verdictOf((await drafted({ now: at, steps: say(2) })).id)).toMatchObject({ eligible: false, reasons: ['streak'] });
    });

    it('a line he wrote from his phone after them resets it', async () => {
      await db.update(agentConfig).set({ humanPauseMin: 1 }).where(eq(agentConfig.id, 1));
      const at = await twoAutos();
      msgSeq += 1n;
      // After both presses and both sends — never the AI's echo, never the robot.
      await db
        .insert(tgMessages)
        .values({ clientId, managerUserId: ownerId, peerId: PEER, tgMessageId: msgSeq, direction: 'out', body: 'Men o‘zim yozdim', sentAt: new Date(at.getTime() - 120_000) });
      const next = new Date(at.getTime() + 5 * 60_000);
      expect(await verdictOf((await drafted({ now: next, steps: say(2) })).id)).toMatchObject({ eligible: true, reasons: [], state: 'waiting' });
    });
  });

  describe('the gate’s facts read from the database (TESTS-2)', () => {
    it('a photo in the customer’s burst: refused «media» at the scheduling', async () => {
      msgSeq += 1n;
      await db
        .insert(tgMessages)
        .values({ clientId, managerUserId: ownerId, peerId: PEER, tgMessageId: msgSeq, direction: 'in', body: null, hasMedia: true, sentAt: new Date(T0.getTime() - 90_000) });
      expect(await verdictOf((await drafted()).id)).toMatchObject({ eligible: false, reasons: ['media'], state: null });
    });

    it('…and at the press: a photo that reached the chat late, inside the burst the reply answers', async () => {
      const d = await drafted();
      await db
        .insert(tgMessages)
        .values({ clientId, managerUserId: ownerId, peerId: PEER, tgMessageId: d.anchorTgMessageId - 1n, direction: 'in', body: null, hasMedia: true, sentAt: new Date(T0.getTime() - 90_000) });
      expect(await pressDueAutos(DUE)).toBe(0);
      expect(await verdictOf(d.id)).toMatchObject({ state: 'refused', reasons: ['media'] });
    });

    it('a chat on a lead the client-finding agent found: refused «prospect»', async () => {
      const peer = OTHERS[0]!;
      msgSeq += 1n;
      await db.insert(tgMessages).values({
        clientId: null,
        leadId: prospectLeadId,
        managerUserId: ownerId,
        peerId: peer,
        tgMessageId: msgSeq,
        direction: 'in',
        body: 'Assalomu alaykum, yuk olib kelasizmi?',
        sentAt: new Date(T0.getTime() - 60_000),
      });
      const out = await handleInbound(job(msgSeq, peer), { callModel: scripted([compose()]), now: () => T0 });
      expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
      expect(await verdictOf((out as { draftId: string }).draftId)).toMatchObject({ eligible: false, reasons: ['prospect'], state: null });
    });

    it('money the STORED policy carries — a money figure in its ledger, an estimate in its memory: refused «money» at the press', async () => {
      for (const policyPatch of [{ ledger: [{ kind: 'money', raw: '110 $' }] }, { memory: { hasEstimate: true } }]) {
        await clearChats();
        const d = await drafted();
        await db
          .update(agentDrafts)
          .set({ policy: { ...(d.policy as Record<string, unknown>), ...policyPatch } })
          .where(eq(agentDrafts.id, d.id));
        expect(await pressDueAutos(DUE), JSON.stringify(policyPatch)).toBe(0);
        expect(await verdictOf(d.id), JSON.stringify(policyPatch)).toMatchObject({ state: 'refused', reasons: ['money'] });
      }
    });

    it('the agent now speaks from another account than the draft’s: refused «agent_off» at the press', async () => {
      const d = await drafted();
      await db.update(agentConfig).set({ ownerUserId: otherId, sessionExclusiveBy: otherId }).where(eq(agentConfig.id, 1));
      expect(await pressDueAutos(DUE)).toBe(0);
      expect(await verdictOf(d.id)).toMatchObject({ state: 'refused', reasons: ['agent_off'] });
    });
  });

  describe('the Tashkent day (TESTS-3)', () => {
    const yday = (d: Date) => new Date(d.getTime() - 86_400_000);

    it('a press yesterday counts toward neither today’s cap nor «bugun» — and today’s does', async () => {
      await db.update(agentAutoConfig).set({ perDay: 1 }).where(eq(agentAutoConfig.id, 1));
      const y = await drafted();
      expect(await pressDueAutos(DUE)).toBe(1);
      // That press happened the day before — the row as production holds one.
      await db.update(agentAutoVerdicts).set({ pressedAt: yday(DUE), createdAt: yday(T0) }).where(eq(agentAutoVerdicts.draftId, y.id));
      expect(await autoStatusLine(ownerId, DUE)).toContain('(bugun 0/1)');
      const today = await drafted({ peer: PEER2, now: new Date(T0.getTime() + 60_000) });
      expect(await verdictOf(today.id)).toMatchObject({ eligible: true, state: 'waiting' });
      expect(await pressDueAutos(new Date(DUE.getTime() + 60_000))).toBe(1);
      expect(await autoStatusLine(ownerId, DUE)).toContain('(bugun 1/1)');
    });

    it('the panel’s «bugun» is today’s rows only', async () => {
      const y = await drafted();
      expect(await pressDueAutos(DUE)).toBe(1);
      await db.update(agentAutoVerdicts).set({ pressedAt: yday(DUE), createdAt: yday(T0) }).where(eq(agentAutoVerdicts.draftId, y.id));
      await drafted({ peer: PEER2 });
      expect((await autoPanel(actorOf(ownerId), ownerId, DUE))!.today).toEqual({ sent: 0, going: 0, unclear: 0, paused: 0, waiting: 1, left: 0 });
    });
  });

  describe('the step-downs’ seven days (TESTS-4)', () => {
    const DAY = 86_400_000;

    it('👎: one older than a week does not count — the second inside it does', async () => {
      const a = await drafted();
      const b = await drafted({ peer: PEER2 });
      expect(await pressDueAutos(DUE)).toBe(2);
      expect(await autoFeedback(ownerId, a.id, DUE)).toEqual({ ok: true, disarmed: false });
      await db.update(agentAutoVerdicts).set({ feedbackAt: new Date(DUE.getTime() - 8 * DAY) }).where(eq(agentAutoVerdicts.draftId, a.id));
      expect(await autoFeedback(ownerId, b.id, DUE)).toEqual({ ok: true, disarmed: false });
      expect((await readAutoConfig())!.armed).toBe(true);
    });

    it('👎: six days back is inside the week — two disarm', async () => {
      const a = await drafted();
      const b = await drafted({ peer: PEER2 });
      expect(await pressDueAutos(DUE)).toBe(2);
      expect(await autoFeedback(ownerId, a.id, DUE)).toEqual({ ok: true, disarmed: false });
      await db.update(agentAutoVerdicts).set({ feedbackAt: new Date(DUE.getTime() - 6 * DAY) }).where(eq(agentAutoVerdicts.draftId, a.id));
      expect(await autoFeedback(ownerId, b.id, DUE)).toEqual({ ok: true, disarmed: true });
    });

    it('a block eight days after the machine’s reply is not its doing; six days after, it is', async () => {
      await drafted();
      expect(await pressDueAutos(DUE)).toBe(1);
      expect(await autoStepDownOnBlock(ownerId, PEER, new Date(DUE.getTime() + 8 * DAY))).toBe(false);
      expect((await readAutoConfig())!.armed).toBe(true);
      expect(await autoStepDownOnBlock(ownerId, PEER, new Date(DUE.getTime() + 6 * DAY))).toBe(true);
      expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: 'blocked' });
    });

    it('«botmisiz?»: a chat sent off eight days ago is not this week’s — six days ago it is', async () => {
      await drafted();
      await drafted({ peer: PEER2 });
      expect(await pressDueAutos(DUE)).toBe(2);
      expect(await autoStepDownOnBotQuestion(ownerId, PEER, DUE)).toEqual({ chatOff: true, disarmed: false });
      const back = (days: number) =>
        db
          .update(agentAutoChats)
          .set({ updatedAt: new Date(DUE.getTime() - days * DAY) })
          .where(and(eq(agentAutoChats.managerUserId, ownerId), eq(agentAutoChats.peerId, PEER)));
      await back(8);
      expect(await autoStepDownOnBotQuestion(ownerId, PEER2, DUE)).toEqual({ chatOff: true, disarmed: false });
      expect((await readAutoConfig())!.armed).toBe(true);
      await back(6);
      expect(await autoStepDownOnBotQuestion(ownerId, PEER2, DUE)).toEqual({ chatOff: true, disarmed: true });
    });
  });

  describe('the block hook, through the pump’s own outcome (TESTS-5)', () => {
    const failed = (code: string) => ({ kind: 'failed' as const, reason: code, error: { kind: 'recipient_final' as const, code }, markUnread: false });

    it('a deactivated or private customer is not a block — the layer stays armed', async () => {
      for (const code of ['INPUT_USER_DEACTIVATED', 'USER_PRIVACY_RESTRICTED']) {
        await clearChats();
        const d = await drafted();
        expect(await pressDueAutos(DUE)).toBe(1);
        await applyAgentOutcome((await agentRowById((await outboxOf(d.id))!.id))!, failed(code), alarmAccount(), DUE);
        expect(await outboxOf(d.id), code).toMatchObject({ status: 'failed' });
        expect((await readAutoConfig())!.armed, code).toBe(true);
      }
    });

    it('USER_IS_BLOCKED on the machine’s reply disarms it — «blocked»', async () => {
      const d = await drafted();
      expect(await pressDueAutos(DUE)).toBe(1);
      await applyAgentOutcome((await agentRowById((await outboxOf(d.id))!.id))!, failed('USER_IS_BLOCKED'), alarmAccount(), DUE);
      expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: 'blocked' });
    });
  });

  describe('a dead sweep’s claim, and the verdict’s savepoint (TESTS-6)', () => {
    const pressing = (draftId: string, claimedAt: Date, extra: Record<string, unknown> = {}) =>
      db.update(agentAutoVerdicts).set({ state: 'pressing', claimedAt, ...extra }).where(eq(agentAutoVerdicts.draftId, draftId));

    it('a pending reply claimed and never pressed: left alone for five minutes, then waiting again — and pressed by that same sweep', async () => {
      const d = await drafted();
      const now = new Date(DUE.getTime() + 7 * 60_000);
      await pressing(d.id, new Date(now.getTime() - 6 * 60_000));
      expect(await pressDueAutos(new Date(now.getTime() - 3 * 60_000))).toBe(0);
      expect((await verdictOf(d.id))!.state).toBe('pressing');
      expect(await pressDueAutos(now)).toBe(1);
      expect((await verdictOf(d.id))!.state).toBe('pressed');
      expect(await outboxOf(d.id)).toMatchObject({ status: 'agent' });
    });

    it('a reply the machine approved before its sweep died: pressed, at the approval’s own time', async () => {
      const d = await drafted();
      expect(await pressDueAutos(DUE)).toBe(1);
      const decidedAt = (await db.select().from(agentDrafts).where(eq(agentDrafts.id, d.id)))[0]!.decidedAt!;
      await pressing(d.id, DUE, { pressedAt: null });
      expect(await pressDueAutos(new Date(DUE.getTime() + AUTO_RECLAIM_MS + 60_000))).toBe(0);
      const v = await verdictOf(d.id);
      expect(v).toMatchObject({ state: 'pressed' });
      expect(v!.pressedAt!.getTime()).toBe(decidedAt.getTime());
    });

    it('a reply HE approved while the row was claimed: stopped as his, never counted as the machine’s', async () => {
      const d = await drafted();
      expect(await decideDraft(actorOf(ownerId), d.id, 'send', { digest: await cardDigestOf(d.id) }, { actorId: ownerId })).toMatchObject({ ok: true });
      await pressing(d.id, DUE, { outcome: null, stoppedAt: null, stoppedBy: null });
      expect(await pressDueAutos(new Date(DUE.getTime() + AUTO_RECLAIM_MS + 60_000))).toBe(0);
      expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'owner_send', stoppedBy: ownerId });
    });

    it('a verdict the table refuses costs the plan, never the draft’s transaction', async () => {
      const d = await drafted();
      await db.delete(agentAutoVerdicts).where(eq(agentAutoVerdicts.draftId, d.id));
      await db.transaction(async (tx) => {
        const out = await recordAutoVerdictInTx(tx, d, { eligible: true, reasons: [], category: 'faq', confidence: 5, digest: 'x', dueAt: DUE, holdSec: HOLD_MS / 1000 });
        expect(out).toBeNull();
        // The transaction is still usable: a refused INSERT outside a savepoint would abort it here.
        const [row] = await tx.select({ id: agentDrafts.id }).from(agentDrafts).where(eq(agentDrafts.id, d.id));
        expect(row?.id).toBe(d.id);
      });
      expect(await verdictOf(d.id)).toBeNull();
    });
  });
});

/**
 * Fix pass C (the re-review of fix passes A and B): a person's press read the card BEFORE it stopped the machine,
 * so a machine ✅ committing in between was answered as if nothing had been pressed (FIX-SEND-2, FIX-REGRESS-1);
 * 🙋 on a card the machine had already pressed took the chat without the chat's NEXT reply, and dated no press
 * (FIX-SEND-1); and the panel's list was titled by what it does not hold (FIX-REGRESS-2). Each test was red on
 * 8959a9f8 before its fix.
 */
describe('fix pass C — a person against the machine’s press, and 🙋 after it', () => {
  /** How many sessions wait on a lock — asked through the POOL (#873), never inside a transaction. */
  async function lockWaiters(): Promise<number> {
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
    return Number(rows[0]?.n ?? 0);
  }
  async function waiting(n: number): Promise<boolean> {
    for (let i = 0; i < 300; i += 1) {
      if ((await lockWaiters()) >= n) return true;
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  /**
   * The machine's ✅ committing while a person's press stands between its read and its stop. Nothing is stood in
   * for: another connection holds the verdict row FOR UPDATE, so the machine's approval queues on it at its LAST
   * statement (`settleAutoPressInTx`) — the draft approved and its reply queued, uncommitted; the person's press
   * reads the card as it was committed, and queues behind the machine; then the holder lets go.
   */
  async function machineCommitsUnder<T>(draftId: string, person: () => Promise<T>): Promise<T> {
    await db.update(agentAutoVerdicts).set({ state: 'pressing', claimedAt: DUE }).where(eq(agentAutoVerdicts.draftId, draftId));
    const digest = await cardDigestOf(draftId);
    const helper = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const held = await helper.reserve();
    try {
      await held`BEGIN`;
      await held`SELECT 1 FROM agent_auto_verdicts WHERE draft_id = ${draftId}::uuid FOR UPDATE`;
      const machine = decideDraft(actorOf(ownerId), draftId, 'send', { digest, auto: true, autoAt: DUE }, { actorId: null });
      expect(await waiting(1), 'the machine’s approval never reached the verdict row').toBe(true);
      const pressed = person();
      expect(await waiting(2), 'the person’s press never had to wait on the machine').toBe(true);
      await held`COMMIT`;
      expect(await machine).toMatchObject({ ok: true, status: 'approved' });
      return await pressed;
    } finally {
      held.release();
      await helper.end();
    }
  }

  const TAKEN_BACK = '❌ Bekor qilindi — javob mijozga ketmaydi';

  describe('FIX-SEND-2 / FIX-REGRESS-1: the machine’s ✅ commits between his read and his stop', () => {
    it('❌ still takes the reply back', async () => {
      const d = await drafted();
      expect(await machineCommitsUnder(d.id, () => agentPress(ownerId, 'r', d.id, undefined))).toMatchObject({ toast: TAKEN_BACK });
      expect(await verdictOf(d.id)).toMatchObject({ state: 'pressed' });
      expect(await outboxOf(d.id)).toMatchObject({ status: 'cancelled', lastError: CANCELLED_BY_HOLDER });
    });

    it('🙋 still takes the chat — and the reply with it', async () => {
      const d = await drafted();
      const r = await machineCommitsUnder(d.id, () => agentPress(ownerId, 'h', d.id, undefined));
      expect(r.toast).toMatch(/^🙋 Suhbat 24 soat sizniki/u);
      expect((await humanUntilOf(PEER))!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
      expect(await outboxOf(d.id)).toMatchObject({ status: 'cancelled' });
    });

    it('✅, ✏️ and his typed words: «kech», naming «❌ Bekor qilish» — never «faol emas»', async () => {
      const a = await drafted();
      const digest = await cardDigestOf(a.id);
      expect(
        await machineCommitsUnder(a.id, () => decideDraft(actorOf(ownerId), a.id, 'send', { digest }, { actorId: ownerId })),
      ).toEqual({ ok: false, code: 'auto_pressed' });
      await clearChats();
      const b = await drafted();
      expect(await machineCommitsUnder(b.id, () => decideDraft(actorOf(ownerId), b.id, 'edit', {}, { actorId: ownerId }))).toEqual({
        ok: false,
        code: 'auto_pressed',
      });
      expect(await draftStatus(b.id)).toBe('approved');
      await clearChats();
      const c = await drafted();
      expect(
        await machineCommitsUnder(c.id, () => submitOwnText(actorOf(ownerId), c.id, 'Ha, olib kelamiz. Yukingiz nima?', { actorId: ownerId })),
      ).toEqual({ ok: false, code: 'auto_pressed' });
      const [row] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, c.id));
      expect(row).toMatchObject({ status: 'approved', finalBody: null });
      expect(await outboxOf(c.id)).toMatchObject({ status: 'agent', body: REPLY });
    });

    it('⏸: «Kech — AI javobni o‘zi tasdiqladi…», never «Bu javob endi o‘zi ketmaydi»', async () => {
      const d = await drafted();
      expect(await machineCommitsUnder(d.id, () => stopAuto(ownerId, d.id))).toEqual({ ok: false, code: 'pressed' });
      expect(await outboxOf(d.id)).toMatchObject({ status: 'agent' });
    });

    it('⏸ on a re-pointed card while the chat’s live reply is being pressed: «kech» about that reply', async () => {
      const a = await drafted();
      const b = await drafted({ now: new Date(T0.getTime() + 30_000), shown: null });
      expect(await draftStatus(a.id)).toBe('superseded');
      expect(await machineCommitsUnder(b.id, () => stopAuto(ownerId, a.id))).toEqual({ ok: false, code: 'pressed' });
      expect(await verdictOf(b.id)).toMatchObject({ state: 'pressed' });
    });
  });

  describe('FIX-SEND-1: 🙋 on the card the machine already pressed', () => {
    const stepCtx = () => ({ accountId, caughtUp: () => true, random: () => 0 });

    /** «💵 Narx yozaman»: the reply drafted from the figure he typed — HIS word, approved by him after the 🙋. */
    async function priceApprovedAfter(anchor: bigint) {
      const [p] = await db
        .insert(agentDrafts)
        .values({
          managerUserId: ownerId,
          peerId: PEER,
          anchorTgMessageId: anchor,
          clientId,
          kind: 'price',
          status: 'pending',
          proposedBody: 'Hisob tayyor: yo‘lkira narxi — 1 200 $.',
        })
        .returning({ id: agentDrafts.id });
      expect(await decideDraft(actorOf(ownerId), p!.id, 'send', {}, { actorId: ownerId })).toMatchObject({ ok: true, status: 'approved' });
      return (await agentRowById((await outboxOf(p!.id))!.id))!;
    }

    /** His ✅ after the press goes: the press is on record, dated before it — never «o‘zingiz javob berdingiz». */
    async function expectHisAfterPressGoes(row: Awaited<ReturnType<typeof priceApprovedAfter>>, pressedFrom: Date) {
      const now = new Date();
      const f = await sendFactsFor(row, now, stepCtx());
      expect(f.humanUntil!.getTime()).toBeGreaterThan(now.getTime());
      expect(f.humanPressedAt, 'the 🙋 left no press on record').not.toBeNull();
      expect(f.humanPressedAt!.getTime()).toBeGreaterThanOrEqual(pressedFrom.getTime() - 1_000);
      expect(f.humanPressedAt!.getTime()).toBeLessThan(row.queuedAt.getTime());
      const v = agentSendVerdict(row, f);
      // At the real minute a night can hold it (a wait); nothing FINAL may refuse it — least of all «he answered himself».
      expect(v.ok || !v.final, JSON.stringify(v)).toBe(true);
    }

    it('the chat’s next reply, counting down, is his too: retired as his 🙋, its countdown stopped, never pressed', async () => {
      // A 🙋 of three days ago is on record — the press the old code dated every later reply by.
      const old = await inbound('Rahmat, tushunarli.', PEER, new Date(T0.getTime() - 3 * 86_400_000));
      await db.insert(agentDrafts).values({
        managerUserId: ownerId,
        peerId: PEER,
        anchorTgMessageId: old,
        clientId,
        status: 'taken_over',
        proposedBody: 'Mayli.',
        decidedBy: ownerId,
        decidedAt: new Date(Date.now() - 3 * 86_400_000),
      });
      const d = await drafted();
      expect(await pressDueAutos(DUE)).toBe(1);
      const t1 = new Date(T0.getTime() + 10_000);
      const e = await drafted({ now: t1 });
      expect(await verdictOf(e.id)).toMatchObject({ state: 'waiting' });
      const before = new Date();
      expect((await agentPress(ownerId, 'h', d.id, undefined)).toast).toMatch(/^🙋 Suhbat 24 soat sizniki/u);
      expect(await outboxOf(d.id)).toMatchObject({ status: 'cancelled' });
      // E is retired exactly as 🙋 on its own card would retire it — and its countdown stopped as his.
      const [retired] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, e.id));
      expect(retired).toMatchObject({ status: 'taken_over', decidedBy: ownerId });
      expect(await verdictOf(e.id)).toMatchObject({ state: 'stopped', outcome: 'owner_human', stoppedBy: ownerId });
      expect(String((await payloadOf(e.id)).text)).toContain('🙋 Suhbatni o‘zingizga oldingiz');
      expect(await pressDueAutos(new Date(t1.getTime() + HOLD_MS + 1_000))).toBe(0);
      expect(await outboxOf(e.id)).toBeNull();
      // His own price, approved after the press, goes.
      await expectHisAfterPressGoes(await priceApprovedAfter(e.anchorTgMessageId), before);
    });

    it('no reply counting down and no 🙋 ever before: the press is dated all the same — his ✅ after it goes', async () => {
      const d = await drafted();
      expect(await pressDueAutos(DUE)).toBe(1);
      const before = new Date();
      expect((await agentPress(ownerId, 'h', d.id, undefined)).toast).toMatch(/^🙋 Suhbat 24 soat sizniki/u);
      expect(await outboxOf(d.id)).toMatchObject({ status: 'cancelled' });
      await expectHisAfterPressGoes(await priceApprovedAfter(d.anchorTgMessageId), before);
    });

    it('🙋 while the next reply is being pressed: that press loses — nothing of it is queued', async () => {
      const d = await drafted();
      expect(await pressDueAutos(DUE)).toBe(1);
      const t1 = new Date(T0.getTime() + 10_000);
      const e = await drafted({ now: t1 });
      let answer: { toast: string } | null = null;
      // The gate's facts ask the window first; the second ask is the machine's own ✅, after its claim and its gate.
      seam.hook = { skip: 1, run: async () => void (answer = await agentPress(ownerId, 'h', d.id, undefined)) };
      expect(await pressDueAutos(new Date(t1.getTime() + HOLD_MS + 1_000))).toBe(0);
      expect(answer!.toast).toMatch(/^🙋 Suhbat 24 soat sizniki/u);
      expect(await verdictOf(e.id)).toMatchObject({ state: 'stopped', outcome: 'owner_human' });
      expect(await draftStatus(e.id)).toBe('taken_over');
      expect(await outboxOf(e.id)).toBeNull();
    });

    it('the next reply’s approval commits while 🙋 waits on it: its reply is withdrawn with the rest', async () => {
      const d = await drafted();
      expect(await pressDueAutos(DUE)).toBe(1);
      const e = await drafted({ now: new Date(T0.getTime() + 10_000) });
      const r = await machineCommitsUnder(e.id, () => decideDraft(actorOf(ownerId), d.id, 'human', {}, { actorId: ownerId }));
      expect(r).toMatchObject({ ok: true, withdrawn: { total: 2, own: 0 } });
      expect(await verdictOf(e.id)).toMatchObject({ state: 'pressed' });
      expect(await outboxOf(e.id)).toMatchObject({ status: 'cancelled' });
      expect(await outboxOf(d.id)).toMatchObject({ status: 'cancelled' });
    });
  });

  it('FIX-REGRESS-2: a reply the machine pressed and he took back is not listed — and the list never says «not approved yet»', async () => {
    const d = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    expect(await agentPress(ownerId, 'r', d.id, undefined)).toMatchObject({ toast: TAKEN_BACK });
    const panel = (await autoPanel(actorOf(ownerId), ownerId))!;
    expect(panel.sent).toEqual([]);
    expect(panel.today).toEqual({ sent: 0, going: 0, unclear: 0, paused: 0, waiting: 0, left: 1 });
    // The day's count is of presses (the cap's) — one — while the list holds only what went or is going: its title
    // and its empty line say so in every bundle the page renders, never «AI approved nothing yet».
    expect(await autoStatusLine(ownerId, DUE)).toContain('bugun 1/30');
    const said: Record<string, RegExp> = { uz: /yubor/u, ru: /отправ/u, en: /\bsen[dt]/u, 'zh-CN': /发送/u };
    for (const [locale, sent] of Object.entries(said)) {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { agentAi: Record<string, unknown> };
      for (const key of ['autoSentTitle', 'autoSentEmpty']) {
        const words = String(bundle.agentAi[key]);
        expect(words, `${locale} ${key}`).toMatch(sent);
        expect(words, `${locale} ${key}`).not.toMatch(/tasdiqla|одобр|approv|批准/iu);
      }
    }
  });
});

/**
 * The final check of fix passes A-C: a 🙋 pressed while the chat's NEXT reply was being drafted (the run read the
 * takeover before its model call and nothing after it, so the reply was born counting down into the chat he had
 * just taken), and a countdown riding a silent in-place edit of an hours-old card (Telegram rings nothing for an
 * edit, so the ⏸ window was his for a message far up his bot chat). Each test was red on 54dc8082 before its fix.
 */
describe('the final check — the chat he took, and the card that never rang', () => {
  async function conversation(patch: { humanUntil?: Date; mutedAt?: Date; muteReason?: string }) {
    await db
      .insert(agentConversations)
      .values({ managerUserId: ownerId, peerId: PEER, ...patch })
      .onConflictDoUpdate({ target: [agentConversations.managerUserId, agentConversations.peerId], set: { ...patch, updatedAt: new Date() } });
  }

  it('🙋 pressed while the next reply is being drafted: that reply never counts down — an ordinary card, nothing pressed', async () => {
    const a = await drafted();
    expect(await verdictOf(a.id)).toMatchObject({ state: 'waiting' });
    const t1 = new Date(T0.getTime() + 10_000);
    const anchor = await inbound('Urumchidan ham olib kelasizmi?', PEER, t1);
    let toast = '';
    const inner = scripted([compose()]);
    // He presses 🙋 on A's card while the model writes the next reply — inside the model's own call.
    const model = (async (req: ModelRequest): Promise<ModelResponse> => {
      if (!toast) toast = (await agentPress(ownerId, 'h', a.id, undefined)).toast;
      return inner(req);
    }) as CallModel;
    const out = await handleInbound(job(anchor), { callModel: model, now: () => t1 });
    expect(toast).toMatch(/^🙋 Suhbat 24 soat sizniki/u);
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
    const c = (out as { draftId: string }).draftId;
    await shownAt(c, t1);
    // Refused at the scheduling: the chat is his — the card is ordinary from its first second.
    expect(await verdictOf(c)).toMatchObject({ eligible: false, state: null, dueAt: null, reasons: ['human_active'] });
    const p = await payloadOf(c);
    expect(p.autoAt ?? null).toBeNull();
    expect(keys(p).flat()).not.toContain('⏸ To‘xtat');
    expect(await pressDueAutos(new Date(t1.getTime() + HOLD_MS + 1_000))).toBe(0);
    expect(await outboxOf(c)).toBeNull();
    expect(await draftStatus(c)).toBe('pending');
  });

  it('a takeover or a mute written after the scheduling: the press is refused afresh, in words — nothing queued', async () => {
    const a = await drafted();
    await conversation({ humanUntil: new Date(Date.now() + 24 * 3_600_000) });
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await verdictOf(a.id)).toMatchObject({ state: 'refused', reasons: ['human_active'] });
    expect(String((await payloadOf(a.id)).text)).toContain('⏱ O‘zi ketmadi: suhbatni 🙋 bilan o‘zingiz oldingiz');
    expect(await outboxOf(a.id)).toBeNull();
    await clearChats();
    const b = await drafted();
    await conversation({ mutedAt: new Date(), muteReason: 'test' });
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await verdictOf(b.id)).toMatchObject({ state: 'refused', reasons: ['chat_muted'] });
    expect(await outboxOf(b.id)).toBeNull();
    expect(await draftStatus(b.id)).toBe('pending');
  });

  it('the approval re-reads the chat: a takeover committed under the press makes it lose — nothing queued', async () => {
    const d = await drafted();
    // Written by hand between the press's gate and its approval (no draft retired, no verdict stopped): the gate
    // read the chat as the machine's, the approval reads it now.
    seam.hook = { skip: 1, run: async () => void (await conversation({ humanUntil: new Date(Date.now() + 24 * 3_600_000) })) };
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await verdictOf(d.id)).toMatchObject({ state: 'refused', outcome: 'taken_over' });
    expect(await outboxOf(d.id)).toBeNull();
    expect(await draftStatus(d.id)).toBe('pending');
  });

  it('a reply that counts down never rides a silent edit of an old card: it gets its own card (a push), the old one is closed', async () => {
    // A: an ordinary card (a price question — never the machine's), sent to his Telegram five hours earlier and
    // left undecided.
    const early = new Date(T0.getTime() - 5 * 3_600_000);
    const a = await drafted({ now: early, steps: [compose('Narxni tekshirib aytaman.', { category: 'price' })] });
    expect(await verdictOf(a.id)).toMatchObject({ eligible: false });
    expect((await verdictOf(a.id))!.reasons).toContain('category');
    process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
    const calls: { method: string; body: string }[] = [];
    __setTelegramTransport(async (url, init) => {
      calls.push({ method: url.slice(url.lastIndexOf('/') + 1), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    });
    // C: the customer writes again; the reply counts down.
    const c = await drafted({ shown: null });
    expect(await verdictOf(c.id)).toMatchObject({ state: 'waiting' });
    expect(await draftStatus(a.id)).toBe('superseded');
    // C's card is a NEW row — queued for the drain, which rings — and A's old copy still names A, closed.
    const rows = await db
      .select({ payload: notifications.payload, status: notifications.status })
      .from(notifications)
      .where(and(eq(notifications.type, 'AgentDraft'), eq(notifications.userId, ownerId)));
    const ofC = rows.filter((r) => (r.payload as { draftId?: string }).draftId === c.id);
    const ofA = rows.filter((r) => (r.payload as { draftId?: string }).draftId === a.id);
    expect(ofC).toHaveLength(1);
    expect(ofC[0]!.status).toBe('pending');
    expect((ofC[0]!.payload as { tg?: unknown }).tg).toBeUndefined();
    expect(ofA).toHaveLength(1);
    expect(String((ofA[0]!.payload as { text: string }).text)).toContain('↪️ Mijoz yana yozdi');
    expect(keys(ofA[0]!.payload as Record<string, unknown>).flat().filter((t) => /^(✅|⏸|✏️)/u.test(t))).toEqual([]);
    // No edit carried C's words onto A's five-hour-old message.
    expect(calls.filter((x) => x.method === 'editMessageText' && x.body.includes('Qanday yuk'))).toEqual([]);
    // Due — and C's own card has not rung yet: nothing is pressed.
    const shownC = (await payloadOf(c.id)).shown as { draftId?: string } | undefined;
    expect(shownC?.draftId).not.toBe(c.id);
    expect(await pressDueAutos(DUE)).toBe(0);
    expect(await verdictOf(c.id)).toMatchObject({ state: 'waiting', outcome: 'unseen' });
    expect(await outboxOf(c.id)).toBeNull();
    // The drain sends C's card (a push): the hold runs from there.
    const rang = new Date(DUE.getTime() + 30_000);
    await shownAt(c.id, rang);
    expect(await pressDueAutos(new Date(rang.getTime() + HOLD_MS + 1_000))).toBe(1);
    expect(await outboxOf(c.id)).toMatchObject({ status: 'agent' });
  });

  it('a copy that rang within the hold is still edited in place — one card per customer (fit-9)', async () => {
    const a = await drafted({ steps: [compose('Narxni tekshirib aytaman.', { category: 'price' })] });
    const c = await drafted({ now: new Date(T0.getTime() + 30_000), shown: null });
    expect(await verdictOf(c.id)).toMatchObject({ state: 'waiting' });
    const rows = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.type, 'AgentDraft'), eq(notifications.userId, ownerId)));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as { draftId: string }).draftId).toBe(c.id);
    expect(await draftStatus(a.id)).toBe('superseded');
  });
});

/**
 * The second check of ea38306c: the staff drain sends an AI card SILENTLY in the quiet hour (22:00-07:59, decided by
 * its own clock at SEND time — notifications `sendsSilently`), while the gate judged the night only at the moment the
 * reply would go. So a reply written in the last hold before 08:00 counted down on a card that never rang, and a reply
 * written just after 08:00 rode an in-place edit of a copy that had gone silently at 07:59 — its ⏸ window ran on a
 * message his phone never announced. The REAL drain sends here, on a recorder, under a fake clock. Each test was red on
 * ea38306c before its fix.
 */
describe('the second check — a card that went silently in the night is no countdown', () => {
  type Call = { method: string; body: Record<string, unknown> };
  let calls: Call[] = [];
  let duringSend: (() => Promise<void>) | null = null;
  const parked = new Set<string>();
  /** 07:00 Tashkent of T0's own day, and a wall-clock time on it. */
  const morning = () => {
    const d = new Date(T0);
    d.setUTCHours(2, 0, 0, 0);
    return d;
  };
  const at = (h: number, m: number, s = 0) => new Date(morning().getTime() + ((h - 7) * 3600 + m * 60 + s) * 1000);

  /** The drain as the minute's job runs it — only this file's own cards claimable (staff-drain's parking, #713). */
  async function drain(now: Date) {
    const mine = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentDraft')));
    const others = await db
      .update(notifications)
      // The database's own clock, never the fake one: the drain's reclaim asks `now()` of postgres.
      .set({ status: 'sending', claimedAt: sql`now()` })
      .where(
        and(
          eq(notifications.channel, 'telegram'),
          eq(notifications.status, 'pending'),
          mine.length ? notInArray(notifications.id, mine.map((r) => r.id)) : undefined,
        ),
      )
      .returning({ id: notifications.id });
    for (const row of others) parked.add(row.id);
    vi.setSystemTime(now);
    await sendPendingTelegram(now);
  }

  const sends = () => calls.filter((c) => c.method === 'sendMessage');

  beforeAll(async () => {
    await db.insert(telegramLinks).values({ userId: ownerId, telegramChatId: BigInt(CARD_CHAT), status: 'linked', linkedAt: new Date() });
  });

  beforeEach(async () => {
    calls = [];
    duringSend = null;
    __resetTelegramPause();
    // Armed the day before: the layer was on all night.
    await db.update(agentAutoConfig).set({ armedAt: new Date(morning().getTime() - 86_400_000) }).where(eq(agentAutoConfig.id, 1));
    process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
    let messageId = 7000;
    __setTelegramTransport(async (url, init) => {
      const method = url.slice(url.lastIndexOf('/') + 1);
      calls.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      if (method === 'sendMessage' && duringSend) {
        const hook = duringSend;
        duringSend = null;
        await hook();
      }
      messageId += 1;
      const result = method === 'sendMessage' ? { message_id: messageId, chat: { id: CARD_CHAT } } : true;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    });
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await clearChats();
    await db.delete(telegramLinks).where(eq(telegramLinks.userId, ownerId));
    if (parked.size) {
      await db
        .update(notifications)
        .set({ status: 'pending', claimedAt: null })
        .where(and(inArray(notifications.id, [...parked]), eq(notifications.status, 'sending')));
    }
  });

  it('a reply written in the night’s last hold never counts down: its card goes silently, so it is refused «night» from its first second', async () => {
    // A ten-minute hold: written 07:51, the reply would go at 08:01 — daytime — but its card goes now, in the night.
    await db.update(agentAutoConfig).set({ holdSec: 600 }).where(eq(agentAutoConfig.id, 1));
    vi.setSystemTime(at(7, 51));
    const c = await drafted({ now: at(7, 51), shown: null });
    expect(await verdictOf(c.id)).toMatchObject({ eligible: false, state: null, dueAt: null, reasons: ['night'] });
    await drain(at(7, 51, 1));
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.body.disable_notification).toBe(true);
    expect(String(sends()[0]!.body.text)).not.toContain('o‘zi ketadi');
    vi.setSystemTime(at(8, 1, 2));
    expect(await pressDueAutos(at(8, 1, 2))).toBe(0);
    expect(await outboxOf(c.id)).toBeNull();
    expect(await draftStatus(c.id)).toBe('pending');
  });

  it('a countdown never rides a copy that went silently at 07:59: the reply gets its own card, which rings, and goes a hold after it', async () => {
    // A: a price question (never the machine's), written 07:59 — its card goes at once, silently.
    vi.setSystemTime(at(7, 59));
    const a = await drafted({ now: at(7, 59), shown: null, steps: [compose('Narxni tekshirib aytaman.', { category: 'price' })] });
    expect((await verdictOf(a.id))!.reasons).toContain('category');
    await drain(at(7, 59, 1));
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.body.disable_notification).toBe(true);
    calls = [];
    // C, written 08:00:30, counts down — within one hold of A's copy, which never rang.
    vi.setSystemTime(at(8, 0, 30));
    const c = await drafted({ now: at(8, 0, 30), shown: null });
    expect(await verdictOf(c.id)).toMatchObject({ state: 'waiting' });
    expect(await draftStatus(a.id)).toBe('superseded');
    // No edit carried C's words onto the silent copy — C's card is a row of its own, and the drain's send of it rings.
    expect(calls.filter((x) => x.method === 'editMessageText' && String(x.body.text).includes('Qanday yuk'))).toEqual([]);
    await drain(at(8, 0, 31));
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.body.disable_notification ?? false).toBe(false);
    expect(String(sends()[0]!.body.text)).toContain('o‘zi ketadi');
    // Pressed a hold after ITS card rang — not before.
    vi.setSystemTime(at(8, 2, 30));
    expect(await pressDueAutos(at(8, 2, 30))).toBe(0);
    vi.setSystemTime(at(8, 2, 32));
    expect(await pressDueAutos(at(8, 2, 32))).toBe(1);
    expect(await outboxOf(c.id)).toMatchObject({ status: 'agent' });
  });

  it('the press asks whether the card rang: a copy a drain run begun at 07:59:59 sent silently after 08:00 — refused «night», nothing queued', async () => {
    // A (a price question) is queued at 07:59:58; the drain run that claims it begins at 07:59:59 — its clock says the
    // quiet hour — and while its send is in flight, at 08:00:02, C is written and counts down on that very copy.
    vi.setSystemTime(at(7, 59, 58));
    const a = await drafted({ now: at(7, 59, 58), shown: null, steps: [compose('Narxni tekshirib aytaman.', { category: 'price' })] });
    let c: Awaited<ReturnType<typeof drafted>> | null = null;
    duringSend = async () => {
      vi.setSystemTime(at(8, 0, 2));
      c = await drafted({ now: at(8, 0, 2), shown: null });
    };
    await drain(at(7, 59, 59));
    expect(sends()).toHaveLength(1);
    expect(sends()[0]!.body.disable_notification).toBe(true);
    expect(await draftStatus(a.id)).toBe('superseded');
    expect(await verdictOf(c!.id)).toMatchObject({ state: 'waiting' });
    // The copy names C now (the drain's after-send correction put C's words on it) — and its send rang nothing,
    // though the row says it was sent after 08:00.
    const p = await payloadOf(c!.id);
    expect((p.shown as { draftId?: string }).draftId).toBe(c!.id);
    vi.setSystemTime(at(8, 2, 5));
    expect(await pressDueAutos(at(8, 2, 5))).toBe(0);
    expect(await verdictOf(c!.id)).toMatchObject({ state: 'refused', reasons: ['night'] });
    expect(await outboxOf(c!.id)).toBeNull();
    expect(await draftStatus(c!.id)).toBe('pending');
  });
});
