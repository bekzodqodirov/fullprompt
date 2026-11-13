import 'dotenv/config';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «Bilmayman» → he answers the FACT in the bot → the AI writes the customer's reply (spec SPEC-P1-v2 §2), against a
 * real database: the ✍️ press and its compare-and-set, his answer stored and QUEUED, the worker's redraft with his
 * answer as its one extra source, the question superseded only by the redraft's own transaction, the auto plan the
 * redraft alone among owner-triggered drafts carries (`owner_figure`, `owner_personal`, `answer_stale`), every
 * failure said and the question handed back, the sweep that hands back a forgotten ✍️, and the «📌/👤» offer.
 *
 * The CLOCK: the machine's side (the runs, the plan, the press) runs on `T0`, a daytime instant at least twenty
 * minutes in the past (the gate refuses the night) — agent-auto's own rule. agent_config and agent_auto_config are
 * singleton CONFIGURATION rows (#183): snapshotted and put back. Fixture users are deactivated, never deleted.
 */
const queued = vi.hoisted(() => ({ jobs: [] as { name: string; data: unknown }[] }));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (name: string, data: unknown) => {
    queued.jobs.push({ name, data });
    return null;
  }),
}));

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
  clients,
  kbFacts,
  notifications,
  roles,
  tgAccountGuard,
  tgAccounts,
  tgMessages,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { ANSWER_TAKEN, ANSWER_WORDS, agentPress, agentText } from '@/modules/wms/agent/bot-door';
import { pressDueAutos, readAutoConfig, __restoreAutoConfig, type AutoConfig } from '@/modules/wms/agent/auto-send';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { decideDraft } from '@/modules/wms/agent/decide';
import { releaseForgottenAnswers } from '@/modules/wms/agent/jobs';
import { ANSWER_CONTACT_WORDS } from '@/modules/wms/agent/owner-answer';
import { QUESTION_DECIDED_WORDS, handleOwnerAnswer } from '@/modules/wms/agent/owner-answer-job';
import { JOB_AGENT_OWNER_ANSWER, type AgentOwnerAnswerJob } from '@/modules/wms/agent/queues';
import { handleInbound, runOwnerTriggered } from '@/modules/wms/agent/run';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

const SUFFIX = String(Date.now()).slice(-6);
const PEER = BigInt(`81${SUFFIX}`);
let ownerId = '';
let accountId = '';
let clientId = '';
let otherClientCode = '';
let agentSnapshot: AgentConfig | null = null;
let autoSnapshot: AutoConfig | null = null;
let sendingBefore = false;
let msgSeq = 9000n;
let botMsgSeq = 70_000;

/** A daytime Tashkent instant at least twenty minutes before now (agent-auto's clock). */
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
const T1 = new Date(T0.getTime() + 30_000);
const HOLD_MS = 120_000;
const DUE = new Date(T1.getTime() + HOLD_MS + 1_000);

/** Letters from the run's suffix — a text no other chat today shares (G10's fingerprint). */
const TAG = SUFFIX.split('')
  .map((d) => 'abcdefghij'[Number(d)])
  .join('');

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99892${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  return u!.id;
}

async function inbound(body: string, at: Date = T0): Promise<bigint> {
  msgSeq += 1n;
  await db.insert(tgMessages).values({
    clientId,
    managerUserId: ownerId,
    peerId: PEER,
    tgMessageId: msgSeq,
    direction: 'in',
    body,
    sentAt: new Date(at.getTime() - 60_000),
  });
  return msgSeq;
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

function compose(text: string, extra: Record<string, unknown> = {}) {
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

async function draftOf(id: string) {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, id));
  return d!;
}

async function verdictOf(draftId: string) {
  const [v] = await db.select().from(agentAutoVerdicts).where(eq(agentAutoVerdicts.draftId, draftId));
  return v ?? null;
}

async function cardRows(draftId: string) {
  return db
    .select({ id: notifications.id, payload: notifications.payload, status: notifications.status })
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
}

/** What the staff drain writes when the card reaches his Telegram (agent-auto's `shownAt`). */
async function shownAt(draftId: string, at: Date) {
  botMsgSeq += 1;
  const merge = { tg: { chatId: 7_800_000_000 + Number(SUFFIX), messageId: botMsgSeq }, shown: { draftId, at: at.toISOString() } };
  await db
    .update(notifications)
    .set({ status: 'sent', sentAt: at, payload: sql`${notifications.payload} || ${JSON.stringify(merge)}::jsonb` })
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
}

/** The AI's question to him: the customer asked, the model did not know and asked HIM (`needs_owner`). */
async function question(ask = `Salom, suyuq atir ham olib kelasizlarmi ${TAG}?`) {
  const anchor = await inbound(ask);
  const out = await handleInbound(
    { managerUserId: ownerId, peerId: String(PEER), anchorTgMessageId: String(anchor), origin: 'live' },
    {
      callModel: scripted([compose('Aniqlab aytaman.', { needs_owner: true, owner_question: 'Suyuqlik olamizmi?', category: 'other' })]),
      now: () => T0,
    },
  );
  expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
  return draftOf((out as { draftId: string }).draftId);
}

/** ✍️ pressed and his answer typed into the bot: the job it queued. */
async function answered(draftId: string, text: string): Promise<AgentOwnerAnswerJob> {
  const press = await agentPress(ownerId, 'j', draftId, undefined);
  expect(press.arm).toEqual({ kind: 'agent_answer', payload: { draftId } });
  botMsgSeq += 1;
  queued.jobs.length = 0;
  const reply = await agentText(ownerId, { kind: 'agent_answer', payload: { draftId } }, text, botMsgSeq);
  expect(reply?.text).toBe(ANSWER_TAKEN);
  const job = queued.jobs.find((j) => j.name === JOB_AGENT_OWNER_ANSWER);
  expect(job, 'his answer is queued for the worker').toBeDefined();
  return job!.data as AgentOwnerAnswerJob;
}

/** The worker, with the model writing `reply`. */
async function redraft(job: AgentOwnerAnswerJob, reply: string, extra: Record<string, unknown> = {}) {
  return handleOwnerAnswer(job, { callModel: scripted([compose(reply, extra)]), now: () => T1 });
}

async function notices() {
  return db
    .select({ text: sql<string>`${notifications.payload}->>'text'`, peer: sql<string>`${notifications.payload}->>'peerId'` })
    .from(notifications)
    .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentNotice')));
}

async function clearChat() {
  await db.delete(agentOutbox).where(eq(agentOutbox.peerId, PEER));
  await db.delete(agentDrafts).where(eq(agentDrafts.peerId, PEER));
  await db.delete(agentRuns).where(eq(agentRuns.peerId, PEER));
  await db.delete(agentConversations).where(eq(agentConversations.peerId, PEER));
  await db.delete(agentAutoChats).where(eq(agentAutoChats.managerUserId, ownerId));
  await db.delete(tgMessages).where(eq(tgMessages.peerId, PEER));
  await db.delete(notifications).where(and(eq(notifications.userId, ownerId), like(notifications.type, 'Agent%')));
  await db.delete(kbFacts).where(eq(kbFacts.clientId, clientId));
}

beforeAll(async () => {
  agentSnapshot = await readAgentConfig();
  autoSnapshot = await readAutoConfig();
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  ownerId = await makeUser(`Javob egasi ${SUFFIX}`, 'super_admin', '01');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: ownerId, tgPhone: `+99894${SUFFIX}02`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date(), workAccount: true })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `OA${SUFFIX}`, name: `Javob Mijoz ${SUFFIX}`, phones: [`+99895${SUFFIX}11`], salesManagerId: ownerId })
    .returning({ id: clients.id });
  clientId = c!.id;
  otherClientCode = `OB${SUFFIX}`;
  await db.insert(clients).values({ clientCode: otherClientCode, name: `Boshqa Mijoz ${SUFFIX}`, phones: [`+99895${SUFFIX}22`] });
  await setSetting('tg_sending_enabled', true, ownerId);
});

beforeEach(async () => {
  queued.jobs.length = 0;
  await clearChat();
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
  await stampAgentPump(accountId, true);
});

afterAll(async () => {
  await clearChat();
  await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(clients).where(inArray(clients.clientCode, [`OA${SUFFIX}`, otherClientCode]));
  await __restoreAgentConfig(agentSnapshot);
  await __restoreAutoConfig(autoSnapshot);
  await setSetting('tg_sending_enabled', sendingBefore, ownerId);
  await db.update(users).set({ active: false }).where(eq(users.id, ownerId));
});

describe('the question, the ✍️ press, his answer (spec §2.2)', () => {
  it('the card of a question the model raised offers ✍️; the press moves it to «editing» with the wait’s mark', async () => {
    const q = await question();
    const [card] = await cardRows(q.id);
    expect((card!.payload as { ask?: unknown }).ask).toBe(true);
    await agentPress(ownerId, 'j', q.id, undefined);
    const d = await draftOf(q.id);
    expect(d.status).toBe('editing');
    expect((d.policy as { answering?: unknown }).answering).toMatchObject({ since: expect.any(String), until: expect.any(String) });
  });

  it('a question a forcing rule put to him (rail) draws no ✍️, and the press is refused in words', async () => {
    const anchor = await inbound(`Temir yo'l bilan Toshkentgacha qancha bo'ladi ${TAG}?`);
    const out = await handleInbound(
      { managerUserId: ownerId, peerId: String(PEER), anchorTgMessageId: String(anchor), origin: 'live' },
      { callModel: scripted([compose('Aniqlab aytaman.', { category: 'other' })]), now: () => T0 },
    );
    const q = await draftOf((out as { draftId: string }).draftId);
    expect(q.needsOwner).toBe(true);
    expect((q.policy as { forcedQuestion?: unknown }).forcedQuestion).toBe('rail');
    const [card] = await cardRows(q.id);
    expect((card!.payload as { ask?: unknown }).ask).toBe(false);
    const press = await agentPress(ownerId, 'j', q.id, undefined);
    expect(press.toast).toBe(ANSWER_WORDS.not_question.slice(0, 190));
    expect(press.arm).toBeUndefined();
    expect((await draftOf(q.id)).status).toBe('pending');
  });

  it('a phone in his answer is refused in words — nothing stored, nothing queued', async () => {
    const q = await question();
    await agentPress(ownerId, 'j', q.id, undefined);
    queued.jobs.length = 0;
    const reply = await agentText(ownerId, { kind: 'agent_answer', payload: { draftId: q.id } }, 'Shu raqamga qo‘ng‘iroq qilsin: +998 90 123 45 67', 1);
    expect(reply?.text).toBe(ANSWER_CONTACT_WORDS);
    expect((await draftOf(q.id)).policy).not.toHaveProperty('ownerAnswer');
    expect(queued.jobs).toHaveLength(0);
  });
});

describe('the redraft from his answer (spec §2.2)', () => {
  it('a figure-free answer: the AI writes the reply, the question is superseded as HIS, a fresh card — and it goes by itself', async () => {
    const q = await question();
    const job = await answered(q.id, 'Ha, suyuqlik olmaymiz');
    const reply = `Afsuski, suyuq yuk olmaymiz ${TAG}.`;
    const out = await redraft(job, reply);
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft', blocked: false });
    const r = await draftOf((out as { draftId: string }).draftId);
    expect(r.proposedBody).toBe(reply);
    expect((r.policy as { fromAnswer?: unknown }).fromAnswer).toEqual({ questionDraftId: q.id, questionAnchor: String(q.anchorTgMessageId), personal: [] });
    // The question: superseded by HIS answer — decided by him, its own line, the wait's mark gone.
    const closed = await draftOf(q.id);
    expect(closed.status).toBe('superseded');
    expect(closed.decidedBy).toBe(ownerId);
    expect(closed.policy).toMatchObject({ stale: 'owner_answered', ownerAnswer: { text: 'Ha, suyuqlik olmaymiz' } });
    expect(closed.policy).not.toHaveProperty('answering');
    // A card of its own (a push) — the question's row still names the question.
    expect(await cardRows(q.id)).toHaveLength(1);
    expect(await cardRows(r.id)).toHaveLength(1);
    // The plan an owner-triggered draft carries only here, and the machine's press sends it.
    const v = await verdictOf(r.id);
    expect(v, JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x))).toMatchObject({ eligible: true, state: 'waiting' });
    await shownAt(r.id, T1);
    expect(await pressDueAutos(DUE)).toBe(1);
    expect((await verdictOf(r.id))!.state).toBe('pressed');
    const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, r.id));
    expect(o!.body).toBe(reply);
  });

  it('an answer with money: the reply carries his figure, sourced to HIM — a card with ✅, never pressed (`owner_figure`)', async () => {
    const q = await question();
    const job = await answered(q.id, 'VED 1200$ hisobladi, shuni ayting');
    const out = await redraft(job, `Narxi taxminan 1200 $ bo‘ladi ${TAG}.`);
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft', blocked: false });
    const r = await draftOf((out as { draftId: string }).draftId);
    expect((r.policy as { ledger: unknown[] }).ledger).toEqual([expect.objectContaining({ kind: 'money', origin: 'owner', source: 'sizning javobingiz' })]);
    const v = await verdictOf(r.id);
    expect(v!.eligible).toBe(false);
    expect(v!.reasons).toContain('owner_figure');
  });

  it('an answer with a day count: a card, never pressed', async () => {
    const q = await question();
    const job = await answered(q.id, 'VED 3 kunda hisoblaydi');
    const out = await redraft(job, `Hisob taxminan 3 kunda tayyor bo‘ladi ${TAG}.`);
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft', blocked: false });
    const r = await draftOf((out as { draftId: string }).draftId);
    expect((r.policy as { ledger: unknown[] }).ledger).toEqual([expect.objectContaining({ kind: 'duration', origin: 'owner' })]);
    expect((await verdictOf(r.id))!.reasons).toContain('owner_figure');
  });

  it('a figure NOT in his answer is blocked (G1) — his answer vouches for its own figures only', async () => {
    const q = await question();
    const job = await answered(q.id, 'Ha, olamiz');
    const out = await redraft(job, `Narxi 1500 $ bo‘ladi ${TAG}.`);
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft', blocked: true });
    const r = await draftOf((out as { draftId: string }).draftId);
    expect((r.policy as { blocks: { code: string }[] }).blocks.map((b) => b.code)).toContain('number_unsourced');
  });

  it('another customer’s code in his answer: the redraft is his to look at (`owner_personal`)', async () => {
    const q = await question();
    const job = await answered(q.id, `${otherClientCode} da ham shunday edi, olmaymiz`);
    const out = await redraft(job, `Afsuski, suyuq yuk olmaymiz ${TAG}.`);
    const r = await draftOf((out as { draftId: string }).draftId);
    expect((r.policy as { fromAnswer: { personal: string[] } }).fromAnswer.personal).toContain(otherClientCode);
    expect((await verdictOf(r.id))!.reasons).toContain('owner_personal');
  });

  it('the customer wrote again between the question and his answer: `answer_stale`', async () => {
    const q = await question();
    await agentPress(ownerId, 'j', q.id, undefined);
    await inbound(`Yana 2 kub kiyim ham bor ${TAG}`);
    botMsgSeq += 1;
    queued.jobs.length = 0;
    await agentText(ownerId, { kind: 'agent_answer', payload: { draftId: q.id } }, 'Ha, suyuqlik olmaymiz', botMsgSeq);
    const job = queued.jobs.find((j) => j.name === JOB_AGENT_OWNER_ANSWER)!.data as AgentOwnerAnswerJob;
    const out = await redraft(job, `Afsuski, suyuq yuk olmaymiz ${TAG}.`);
    const r = await draftOf((out as { draftId: string }).draftId);
    expect((await verdictOf(r.id))!.reasons).toContain('answer_stale');
  });

  it('a run that makes no reply: the question goes back to him (pending) and the notice quotes his answer', async () => {
    const q = await question();
    const job = await answered(q.id, 'Ha, suyuqlik olmaymiz');
    const failing = (async () => {
      throw new Error('model down');
    }) as CallModel;
    const out = await handleOwnerAnswer(job, { callModel: failing, now: () => T1 });
    expect(out).toMatchObject({ outcome: 'error' });
    const back = await draftOf(q.id);
    expect(back.status).toBe('pending');
    expect(back.policy).not.toHaveProperty('answering');
    const said = await notices();
    expect(said.some((n) => n.text.includes('AI xato qildi') && n.text.includes('«Ha, suyuqlik olmaymiz»') && n.peer === String(PEER))).toBe(true);
  });

  it('a ✅ on the answered card sends the card’s words, never his answer — and the worker then writes nothing', async () => {
    const q = await question();
    const job = await answered(q.id, 'Ha, suyuqlik olmaymiz');
    const [card] = await cardRows(q.id);
    const sent = await decideDraft(actorOf(ownerId), q.id, 'send', { digest: (card!.payload as { digest: string }).digest }, { actorId: ownerId });
    expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true, status: 'approved' });
    const [o] = await db.select().from(agentOutbox).where(eq(agentOutbox.draftId, q.id));
    expect(o!.body).toBe('Aniqlab aytaman.');
    expect(o!.body).not.toContain('suyuqlik olmaymiz');
    expect(await redraft(job, `Afsuski, suyuq yuk olmaymiz ${TAG}.`)).toBeNull();
    const drafts = await db.select({ id: agentDrafts.id }).from(agentDrafts).where(eq(agentDrafts.peerId, PEER));
    expect(drafts).toHaveLength(1);
    expect((await notices()).some((n) => n.text.includes(QUESTION_DECIDED_WORDS))).toBe(true);
  });

  it('his ✏️ after his answer ends it: the worker writes nothing over his own words, and says so', async () => {
    const q = await question();
    const job = await answered(q.id, 'Ha, suyuqlik olmaymiz');
    await agentPress(ownerId, 'e', q.id, undefined);
    expect((await draftOf(q.id)).policy).not.toHaveProperty('answering');
    expect(await redraft(job, `Afsuski, suyuq yuk olmaymiz ${TAG}.`)).toBeNull();
    expect(await db.select({ id: agentDrafts.id }).from(agentDrafts).where(eq(agentDrafts.peerId, PEER))).toHaveLength(1);
    expect((await notices()).some((n) => n.text.includes(QUESTION_DECIDED_WORDS))).toBe(true);
  });

  it('his ✏️ landing WHILE the redraft is written: the redraft’s own transaction writes nothing (`question_gone`)', async () => {
    const q = await question();
    const job = await answered(q.id, 'Ha, suyuqlik olmaymiz');
    // The model's call is the run's long middle: his ✏️ lands there, after the worker's own look at the question.
    const during = (async () => {
      await agentPress(ownerId, 'e', q.id, undefined);
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'compose_reply', input: compose(`Afsuski, suyuq yuk olmaymiz ${TAG}.`).input }],
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      } as ModelResponse;
    }) as CallModel;
    const out = await handleOwnerAnswer(job, { callModel: during, now: () => T1 });
    expect(out).toMatchObject({ outcome: 'stood_down', reason: 'question_gone' });
    const still = await draftOf(q.id);
    expect(still.status).toBe('editing');
    expect(await db.select({ id: agentDrafts.id }).from(agentDrafts).where(eq(agentDrafts.peerId, PEER))).toHaveLength(1);
  });

  it('his answer is a person in the chat: two machine presses before it do not refuse the redraft as a streak', async () => {
    // Two replies the machine pressed in this chat earlier (the layer's «at most 2 in a row»).
    for (const n of [1, 2]) {
      const [d] = await db
        .insert(agentDrafts)
        .values({ managerUserId: ownerId, peerId: PEER, clientId, anchorTgMessageId: BigInt(n), proposedBody: `Oldingi ${n}`, status: 'approved' })
        .returning({ id: agentDrafts.id });
      await db.insert(agentAutoVerdicts).values({
        draftId: d!.id,
        managerUserId: ownerId,
        peerId: PEER,
        eligible: true,
        reasons: [],
        digest: 'a1b2c3d4',
        state: 'pressed',
        dueAt: new Date(T0.getTime() - 12 * 60_000),
        pressedAt: new Date(T0.getTime() - 10 * 60_000),
      });
    }
    const q = await question();
    const job = await answered(q.id, 'Ha, suyuqlik olmaymiz');
    const out = await redraft(job, `Afsuski, suyuq yuk olmaymiz ${TAG}.`);
    const v = await verdictOf((out as { draftId: string }).draftId);
    expect(v!.reasons).not.toContain('streak');
    expect(v!.eligible).toBe(true);
  });

  it('a hand-back run (owner-triggered, no answer) still writes no auto plan', async () => {
    await inbound(`Kiyim ${TAG}, 5 kub`);
    const out = await runOwnerTriggered(
      { trigger: 'hand_back', managerUserId: ownerId, peerId: PEER, sourceKey: `hb-${SUFFIX}`, instruction: 'VED qaytardi' },
      { callModel: scripted([compose(`Yana bir narsa kerak ${TAG}.`)]), now: () => T1 },
    );
    expect(out).toMatchObject({ outcome: 'draft' });
    expect(await verdictOf((out as { draftId: string }).draftId)).toBeNull();
  });
});

describe('the sweep hands back a ✍️ nothing will come of (spec §2.2)', () => {
  it('pressed and forgotten: the wait ran out with no answer — back to pending', async () => {
    const q = await question();
    await agentPress(ownerId, 'j', q.id, undefined);
    expect(await releaseForgottenAnswers(new Date(Date.now() + 31 * 60_000))).toBe(1);
    const back = await draftOf(q.id);
    expect(back.status).toBe('pending');
    expect(back.policy).not.toHaveProperty('answering');
  });

  it('answered and the worker died with it: back to pending, and said', async () => {
    const q = await question();
    await answered(q.id, 'Ha, suyuqlik olmaymiz');
    // Not yet stale: the worker may still be on it.
    expect(await releaseForgottenAnswers(new Date(Date.now() + 60_000))).toBe(0);
    expect(await releaseForgottenAnswers(new Date(Date.now() + 16 * 60_000))).toBe(1);
    expect((await draftOf(q.id)).status).toBe('pending');
    expect((await notices()).some((n) => n.text.includes('ish to‘xtab qoldi') && n.text.includes('«Ha, suyuqlik olmaymiz»'))).toBe(true);
  });
});

describe('the «📌/👤» offer under his acknowledgement (spec §2.3)', () => {
  it('«👤 Shu mijoz uchun» saves HIS answer — whatever became of the question', async () => {
    const q = await question();
    const job = await answered(q.id, 'Ha, suyuqlik olmaymiz');
    await redraft(job, `Afsuski, suyuq yuk olmaymiz ${TAG}.`);
    expect((await draftOf(q.id)).status).toBe('superseded');
    const press = await agentPress(ownerId, 'u', q.id, undefined);
    expect(press.toast).toBe('👤 Shu mijoz uchun saqlandi');
    const facts = await db.select().from(kbFacts).where(eq(kbFacts.clientId, clientId));
    expect(facts).toEqual([expect.objectContaining({ scope: 'client', answer: 'Ha, suyuqlik olmaymiz', source: 'owner' })]);
  });

  it('his money is used once and never saved', async () => {
    const q = await question();
    await answered(q.id, 'VED 1200$ hisobladi');
    const press = await agentPress(ownerId, 'u', q.id, undefined);
    expect(press.reply).toContain('Narx bilimga yozilmaydi');
    expect(await db.select().from(kbFacts).where(eq(kbFacts.clientId, clientId))).toHaveLength(0);
  });
});
