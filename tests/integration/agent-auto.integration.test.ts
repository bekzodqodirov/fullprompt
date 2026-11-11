import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  notifications,
  roles,
  tgAccountGuard,
  tgAccounts,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import {
  autoFeedback,
  autoStepDownOnBlock,
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
import { purgeAgentChat } from '@/modules/wms/agent/purge';
import { handleInbound } from '@/modules/wms/agent/run';
import { webStats } from '@/modules/wms/agent/web-page';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

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

/** One inbound line and the run that drafts it, on the machine's clock. */
async function drafted(opts: { peer?: bigint; steps?: { name: string; input: Record<string, unknown> }[]; now?: Date } = {}) {
  const peer = opts.peer ?? PEER;
  const now = opts.now ?? T0;
  // A different question each time: the same line again is the run's own «repeat» refusal.
  const anchor = await inbound(QUESTIONS[Number(msgSeq % BigInt(QUESTIONS.length))]!, peer, now);
  const out = await handleInbound(job(anchor, peer), { callModel: scripted(opts.steps ?? [compose()]), now: () => now });
  expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
  const draftId = (out as { draftId: string }).draftId;
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
  await setSetting('tg_sending_enabled', true, ownerId);
});

beforeEach(async () => {
  __forgetAgentAutoReady();
  await clearChats();
  await agentOn();
  await armFresh();
  await db.update(tgAccounts).set({ workAccount: true }).where(eq(tgAccounts.id, accountId));
  await stampAgentPump(accountId, true);
});

afterAll(async () => {
  __forgetAgentAutoReady();
  await clearChats();
  await db
    .delete(notifications)
    .where(and(eq(notifications.type, 'AgentForcedOff'), sql`${notifications.payload}->>'text' LIKE '%o‘zi yuborishi o‘chirildi%'`));
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
    expect(await forceAgentOff('test')).not.toBeNull();
    expect(await readAutoConfig()).toMatchObject({ armed: false, disarmReason: 'forced: test' });
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

  it('a purged chat takes its verdicts and its «off» with it', async () => {
    const d = await drafted();
    await db.insert(agentAutoChats).values({ managerUserId: ownerId, peerId: PEER, offUntil: new Date(Date.now() + 86_400_000), reason: 'feedback' });
    await purgeAgentChat(ownerId, PEER);
    expect(await verdictOf(d.id)).toBeNull();
    expect(await db.select().from(agentAutoChats).where(eq(agentAutoChats.managerUserId, ownerId))).toHaveLength(0);
  });
});

describe('one migration behind — today’s behaviour', () => {
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
