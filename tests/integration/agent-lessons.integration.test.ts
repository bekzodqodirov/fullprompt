import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «📝 Tuzatish» — he tells the AI where it was wrong, the AI learns (spec SPEC-P1-v2 §3), against a real database:
 * the press and what it stops, the typed lesson stored UNCONFIRMED and echoed, «✅ Saqlash» and its one-time token,
 * every refusal, where a confirmed lesson sits in a run's request (the cached head, nowhere else), the rewrite of a
 * card still waiting for his ✅ (queued, keyed by the lesson, no «o'zi yuborish» plan), every outcome that is not a
 * draft said and the mark taken off, the sweep that hands back a rewrite that never came, the page's writer, the cap,
 * the purge, and a server one migration behind.
 *
 * A lesson is in EVERY chat's prompt — the loudest CONFIGURATION this suite can leave behind (#183): each test
 * starts with none of this file's, and `afterAll` deletes them all (by their authors). agent_config and
 * agent_auto_config are singleton rows, snapshotted and put back. Fixture users are deactivated, never deleted.
 *
 * The CLOCK is agent-auto's: the machine's side runs on `T0`, a daytime instant at least twenty minutes in the past.
 */
const queued = vi.hoisted(() => ({ jobs: [] as { name: string; data: unknown; opts?: unknown }[] }));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (name: string, data: unknown, opts?: unknown) => {
    queued.jobs.push({ name, data, opts });
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
  agentLessons,
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
import { buttonsFor } from '@/modules/platform/telegram/staff-bot';
import { AUTO_BAD_WHY, LESSON_DROPPED_TOAST, agentPress, agentText, lessonRefusalFor } from '@/modules/wms/agent/bot-door';
import { FROM_LESSON_LINE, LESSON_REDRAFT_LINE } from '@/modules/wms/agent/card-io';
import { STOP_AUTO_WORDS, pressDueAutos, readAutoConfig, __restoreAutoConfig, type AutoConfig } from '@/modules/wms/agent/auto-send';
import {
  readAgentConfig,
  __forgetAgentFullP1Ready,
  __pretendAgentFullP1Behind,
  __restoreAgentConfig,
  type AgentConfig,
} from '@/modules/wms/agent/config';
import { decideDraft, submitOwnText } from '@/modules/wms/agent/decide';
import { agentSweep } from '@/modules/wms/agent/jobs';
import { LESSONS_HEADING, LESSON_LIMITS } from '@/modules/wms/agent/lesson-rules';
import { LESSON_CARD_MOVED_WORDS, handleLessonRedraft } from '@/modules/wms/agent/lesson-job';
import {
  LESSON_PROMPT_LIVE,
  LESSON_PROMPT_SENT,
  LESSON_WORDS,
  confirmLesson,
  deleteLesson,
  editLesson,
  lessonEchoText,
  lessonFromPage,
  lessonSavedWords,
  openLesson,
  promptLessons,
  releaseStaleLessonRedrafts,
  setLessonActive,
  webLessons,
} from '@/modules/wms/agent/lessons';
import { purgeAgentChat } from '@/modules/wms/agent/purge';
import { JOB_AGENT_OWNER_ANSWER, type AgentOwnerAnswerJob } from '@/modules/wms/agent/queues';
import { handleInbound } from '@/modules/wms/agent/run';
import { webDrafts, webStats } from '@/modules/wms/agent/web-page';
import { stampAgentPump } from '@/modules/wms/crm/account-guard';

const SUFFIX = String(Date.now()).slice(-6);
/** The run's token in LETTERS — a name carries no figure (fix pass 7: every bare figure in a lesson is a price, so a
 * name made unique by digits was refused as money before it could be refused as a person). */
const NAME_TAG = SUFFIX.split('').map((d) => 'abcdefghij'[Number(d)]).join('');
const PEER = BigInt(`84${SUFFIX}`);
let ownerId = '';
/** A colleague — a super_admin the page admits, and neither the draft's account nor the agent's owner. */
let colleagueId = '';
/** A seller: no super_admin, not the owner — the page's door refuses him. */
let sellerId = '';
let accountId = '';
let clientId = '';
let otherClientCode = '';
let agentSnapshot: AgentConfig | null = null;
let autoSnapshot: AutoConfig | null = null;
let sendingBefore = false;
let msgSeq = 12_000n;
let botMsgSeq = 90_000;

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

/** A plain answer the gate admits: no figure, one question, a kind he chose. */
const REPLY = `Ha, Xitoydan olib kelamiz. Qanday yuk ${TAG}?`;
const REWRITE = `Assalomu alaykum! Ha, olib kelamiz ${TAG}. Yukingiz nima?`;
/** An ordinary rule — no name, no code, no phone, no price. */
const LESSON = `Salomga avval salom bilan javob ber, keyin bitta savol ber ${TAG}.`;

async function makeUser(name: string, role: string, tail: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99899${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
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

/** The model, scripted — every request it was sent kept in `seen`. */
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
const seller = () => ({ id: sellerId, roles: ['sales_manager'] });
const ctxOf = (id: string) => ({ actorId: id });

async function draftOf(id: string) {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, id));
  return d!;
}

async function verdictOf(draftId: string) {
  const [v] = await db.select().from(agentAutoVerdicts).where(eq(agentAutoVerdicts.draftId, draftId));
  return v ?? null;
}

async function cardOf(draftId: string) {
  const rows = await db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
  expect(rows, 'one card per draft').toHaveLength(1);
  return rows[0]!.payload as Record<string, unknown> & { text: string };
}

const keys = (payload: Record<string, unknown>) => (buttonsFor('AgentDraft', payload) ?? []).map((r) => r.map((b) => b.text));

/** What the staff drain writes when the card reaches his Telegram (agent-auto's `shownAt`). */
async function shownAt(draftId: string, at: Date) {
  botMsgSeq += 1;
  const merge = { tg: { chatId: 7_900_000_000 + Number(SUFFIX), messageId: botMsgSeq }, shown: { draftId, at: at.toISOString() } };
  await db
    .update(notifications)
    .set({ status: 'sent', sentAt: at, payload: sql`${notifications.payload} || ${JSON.stringify(merge)}::jsonb` })
    .where(and(eq(notifications.type, 'AgentDraft'), sql`${notifications.payload}->>'draftId' = ${draftId}`));
}

const QUESTIONS = ['Salom, Xitoydan yuk olib kelasizlarmi?', 'Assalomu alaykum, Guanchjoudan ham olasizmi?', 'Yiwudan ham yuk tashiysizmi?', 'Qaysi shaharlardan yuk olasizlar?'];

/** One inbound line and the run that drafts its reply, on the machine's clock; its card reached him at once. */
async function drafted(opts: { steps?: { name: string; input: Record<string, unknown> }[]; seen?: ModelRequest[]; now?: Date } = {}) {
  const now = opts.now ?? T0;
  const anchor = await inbound(`${QUESTIONS[Number(msgSeq % BigInt(QUESTIONS.length))]!} ${TAG}`, now);
  const out = await handleInbound(
    { managerUserId: ownerId, peerId: String(PEER), anchorTgMessageId: String(anchor), origin: 'live' },
    { callModel: scripted(opts.steps ?? [compose()], opts.seen), now: () => now },
  );
  expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
  const draftId = (out as { draftId: string }).draftId;
  await shownAt(draftId, now);
  return draftOf(draftId);
}

/** 📝 pressed and his lesson typed into the bot: the unconfirmed lesson and the token its «✅ Saqlash» carries. */
async function typed(draftId: string, text = LESSON): Promise<{ id: string; token: string }> {
  const press = await agentPress(ownerId, 'l', draftId, undefined);
  expect(press.arm, JSON.stringify(press)).toEqual({ kind: 'agent_lesson', payload: { draftId } });
  botMsgSeq += 1;
  const echo = await agentText(ownerId, { kind: 'agent_lesson', payload: { draftId } }, text, botMsgSeq);
  expect(echo?.text).toBe(lessonEchoText(text.trim()));
  const [yes] = echo!.buttons![0]!;
  const [, , id, token] = yes!.callback_data.split(':');
  return { id: id!, token: token! };
}

/** …and «✅ Saqlash» pressed: the lesson counts. The job its rewrite queued, when it queued one. */
async function taught(draftId: string, text = LESSON): Promise<{ id: string; job: AgentOwnerAnswerJob | null; reply: string }> {
  const { id, token } = await typed(draftId, text);
  queued.jobs.length = 0;
  const saved = await agentPress(ownerId, 'y', id, token);
  expect(saved.toast, JSON.stringify(saved)).toBe('✅ Saboq saqlandi');
  const job = queued.jobs.find((j) => j.name === JOB_AGENT_OWNER_ANSWER);
  return { id, job: (job?.data as AgentOwnerAnswerJob | undefined) ?? null, reply: saved.reply ?? '' };
}

/** The worker, with the model writing `reply`. */
async function rewrite(job: AgentOwnerAnswerJob, reply = REWRITE, extra: Record<string, unknown> = {}, seen: ModelRequest[] = []) {
  return handleLessonRedraft(job, { callModel: scripted([compose(reply, extra)], seen), now: () => T1 });
}

async function notices() {
  return db
    .select({ text: sql<string>`${notifications.payload}->>'text'`, peer: sql<string>`${notifications.payload}->>'peerId'` })
    .from(notifications)
    .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentNotice')));
}

const lessonRow = async (id: string) => (await db.select().from(agentLessons).where(eq(agentLessons.id, id)))[0] ?? null;
const myLessons = () => db.select().from(agentLessons).where(inArray(agentLessons.createdBy, [ownerId, colleagueId, sellerId])).orderBy(asc(agentLessons.createdAt));

async function audits(lessonId: string) {
  return db
    .select({ action: auditLog.action, actorId: auditLog.actorId, before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'agent_lesson'), eq(auditLog.entityId, lessonId)))
    .orderBy(asc(auditLog.id));
}

async function clearLessons() {
  await db.delete(agentLessons).where(inArray(agentLessons.createdBy, [ownerId, colleagueId, sellerId]));
}

async function clearChat() {
  await db.delete(agentOutbox).where(eq(agentOutbox.peerId, PEER));
  await db.delete(agentDrafts).where(eq(agentDrafts.peerId, PEER));
  await db.delete(agentRuns).where(eq(agentRuns.peerId, PEER));
  await db.delete(agentConversations).where(eq(agentConversations.peerId, PEER));
  await db.delete(agentAutoChats).where(eq(agentAutoChats.managerUserId, ownerId));
  await db.delete(tgMessages).where(eq(tgMessages.peerId, PEER));
  await db.delete(notifications).where(and(eq(notifications.userId, ownerId), like(notifications.type, 'Agent%')));
}

beforeAll(async () => {
  agentSnapshot = await readAgentConfig();
  autoSnapshot = await readAutoConfig();
  sendingBefore = (await getSetting('tg_sending_enabled')) === true;
  ownerId = await makeUser(`Tuzatish egasi ${SUFFIX}`, 'super_admin', '01');
  colleagueId = await makeUser(`Tuzatish hamkasbi ${SUFFIX}`, 'super_admin', '02');
  sellerId = await makeUser(`Tuzatish sotuvchisi ${SUFFIX}`, 'sales_manager', '03');
  const [acc] = await db
    .insert(tgAccounts)
    .values({ managerUserId: ownerId, tgPhone: `+99899${SUFFIX}91`, sessionEnc: 'v1.x.y.z', status: 'active', lastSeenAt: new Date(), workAccount: true })
    .returning({ id: tgAccounts.id });
  accountId = acc!.id;
  // A name no lesson below shares a word with: the chat's own names refuse a lesson by ANY word of them.
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `LS${SUFFIX}`, name: `Dilshodbek Qodirov ${SUFFIX}`, phones: [`+99899${SUFFIX}11`], salesManagerId: ownerId })
    .returning({ id: clients.id });
  clientId = c!.id;
  otherClientCode = `LT${SUFFIX}`;
  await db.insert(clients).values({ clientCode: otherClientCode, name: `Shohruhmirzo Valiyev ${NAME_TAG}`, phones: [`+99899${SUFFIX}22`] });
  await setSetting('tg_sending_enabled', true, ownerId);
});

beforeEach(async () => {
  __forgetAgentFullP1Ready();
  queued.jobs.length = 0;
  await clearChat();
  await clearLessons();
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
  __forgetAgentFullP1Ready();
  await clearChat();
  await clearLessons();
  await db.delete(tgAccountGuard).where(eq(tgAccountGuard.accountId, accountId));
  await db.delete(tgAccounts).where(eq(tgAccounts.id, accountId));
  await db.delete(clients).where(inArray(clients.clientCode, [`LS${SUFFIX}`, otherClientCode]));
  await __restoreAgentConfig(agentSnapshot);
  await __restoreAutoConfig(autoSnapshot);
  await setSetting('tg_sending_enabled', sendingBefore, ownerId);
  await db.update(users).set({ active: false }).where(inArray(users.id, [ownerId, colleagueId, sellerId]));
});

describe('the press (spec §3.1)', () => {
  it('a reply waiting for his ✅ carries «📝 Tuzatish»; the press asks WHERE to write and arms the lesson’s own wait', async () => {
    const d = await drafted();
    const card = await cardOf(d.id);
    expect(card.teach).toBe(true);
    expect(keys(card)).toContainEqual(['📝 Tuzatish']);
    const press = await agentPress(ownerId, 'l', d.id, undefined);
    expect(press).toMatchObject({ toast: '📝', reply: LESSON_PROMPT_LIVE, arm: { kind: 'agent_lesson', payload: { draftId: d.id } } });
    // The press decides nothing about the draft: it is still his to send, edit or drop.
    expect(await draftOf(d.id)).toMatchObject({ status: 'pending', finalBody: null });
  });

  it('only the holder in the bot: a colleague’s forged press, and the account’s own once it is no longer the agent’s, hear «Topilmadi»', async () => {
    const d = await drafted();
    const forged = await agentPress(colleagueId, 'l', d.id, undefined);
    expect(forged.toast).toBe('Topilmadi');
    expect(forged.arm).toBeUndefined();
    await db.update(agentConfig).set({ ownerUserId: colleagueId }).where(eq(agentConfig.id, 1));
    for (const who of [ownerId, colleagueId]) {
      const moved = await agentPress(who, 'l', d.id, undefined);
      expect(moved.toast, who).toBe('Topilmadi');
      expect(moved.arm).toBeUndefined();
    }
    // …and a text for a wait nobody armed writes nothing either: the writer asks the same question.
    const text = await agentText(colleagueId, { kind: 'agent_lesson', payload: { draftId: d.id } }, LESSON, 7);
    expect(text?.text).toBe(LESSON_WORDS.not_found);
    expect(await myLessons()).toHaveLength(0);
  });

  it('never on a 💵 price reply or on his own ✏️ words — refused in words, nothing armed; the card draws no button', async () => {
    const d = await drafted();
    await db.update(agentDrafts).set({ finalBody: 'O‘zim yozdim' }).where(eq(agentDrafts.id, d.id));
    const own = await agentPress(ownerId, 'l', d.id, undefined);
    expect(own).toMatchObject({ toast: LESSON_WORDS.not_teachable.slice(0, 190), reply: LESSON_WORDS.not_teachable });
    expect(own.arm).toBeUndefined();
    await db.update(agentDrafts).set({ finalBody: null, kind: 'price' }).where(eq(agentDrafts.id, d.id));
    const price = await agentPress(ownerId, 'l', d.id, undefined);
    expect(price.toast).toBe(LESSON_WORDS.not_teachable.slice(0, 190));
    expect(price.arm).toBeUndefined();
    expect(await openLesson(actorOf(ownerId), d.id, 'web')).toEqual({ ok: false, code: 'not_teachable' });
  });

  it('the press stops the card’s countdown FIRST — a reply he is calling wrong never goes by itself while he types why', async () => {
    const d = await drafted();
    expect(await verdictOf(d.id), 'the fixture counts down').toMatchObject({ state: 'waiting', eligible: true });
    await agentPress(ownerId, 'l', d.id, undefined);
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'owner_lesson', stoppedBy: ownerId });
    expect(await pressDueAutos(DUE)).toBe(0);
    expect((await draftOf(d.id)).status).toBe('pending');
    const card = await cardOf(d.id);
    expect(card.autoAt ?? null).toBeNull();
  });

  it('«kech»: the machine’s ✅ beat the press — the prompt says so in ⏸’s own words, and the lesson only teaches', async () => {
    const d = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    expect((await draftOf(d.id)).status).toBe('approved');
    const press = await agentPress(ownerId, 'l', d.id, undefined);
    expect(press.reply).toBe(`${STOP_AUTO_WORDS.pressed}\n\n${LESSON_PROMPT_SENT}`);
    expect(press.arm).toEqual({ kind: 'agent_lesson', payload: { draftId: d.id } });
    const { job, reply } = await taught(d.id);
    expect(job, 'a sent reply is never rewritten').toBeNull();
    expect(reply).toBe(lessonSavedWords({ redraft: 'not_pending', dropped: [], fits: true }));
    // The reply the machine approved is untouched: still on its way, still his to take back with ❌.
    expect((await draftOf(d.id)).status).toBe('approved');
    const [o] = await db.select({ status: agentOutbox.status }).from(agentOutbox).where(eq(agentOutbox.draftId, d.id));
    expect(o?.status).toBe('agent');
  });

  it('a card he approved himself still teaches: its keyboard is «📝 Tuzatish» alone, the prompt promises no rewrite', async () => {
    const d = await drafted();
    const card = await cardOf(d.id);
    expect(await decideDraft(actorOf(ownerId), d.id, 'send', { digest: String(card.digest) }, ctxOf(ownerId))).toMatchObject({ ok: true });
    const sent = await cardOf(d.id);
    expect(sent).toMatchObject({ live: false, teach: true });
    expect(keys(sent)).toEqual([['📝 Tuzatish']]);
    const press = await agentPress(ownerId, 'l', d.id, undefined);
    expect(press.reply).toBe(LESSON_PROMPT_SENT);
    const { job } = await taught(d.id);
    expect(job).toBeNull();
  });

  it('an ✏️ he had opened on the same draft is over: the card is pending again and says why — his next text is a lesson', async () => {
    const d = await drafted();
    const edit = await agentPress(ownerId, 'e', d.id, undefined);
    expect(edit.arm).toMatchObject({ kind: 'agent_edit' });
    expect((await draftOf(d.id)).status).toBe('editing');
    const press = await agentPress(ownerId, 'l', d.id, undefined);
    expect(press).toMatchObject({ reply: LESSON_PROMPT_LIVE, arm: { kind: 'agent_lesson' } });
    expect((await draftOf(d.id)).status).toBe('pending');
    expect((await cardOf(d.id)).text).toContain('✏️ Tahrir bekor — tuzatish yozyapsiz.');
  });

  it('👎 arms NOTHING: the answer is a sentence and one button, and only THAT button’s press arms the lesson', async () => {
    const d = await drafted();
    expect(await pressDueAutos(DUE)).toBe(1);
    await db.update(agentOutbox).set({ status: 'sent', sentAt: new Date() }).where(eq(agentOutbox.draftId, d.id));
    const bad = await agentPress(ownerId, 'f', d.id, undefined);
    expect(bad.arm).toBeUndefined();
    expect(bad.reply).toContain(AUTO_BAD_WHY);
    expect(bad.buttons).toEqual([[{ text: '📝 Sababini yozish', callback_data: `ag:l:${d.id}` }]]);
    const why = await agentPress(ownerId, 'l', d.id, undefined);
    expect(why.arm).toEqual({ kind: 'agent_lesson', payload: { draftId: d.id } });
    expect(why.reply).toBe(LESSON_PROMPT_SENT);
  });
});

describe('the lesson: typed, echoed, confirmed (spec §3.2)', () => {
  it('his text is stored UNCONFIRMED and echoed — in no prompt — until «✅ Saqlash»; the yes carries a one-time token', async () => {
    const d = await drafted();
    await db.update(agentDrafts).set({ status: 'approved', decidedBy: ownerId, decidedAt: new Date() }).where(eq(agentDrafts.id, d.id));
    const { id, token } = await typed(d.id);
    expect(token).toMatch(/^[0-9a-f]{8}$/u);
    expect(await lessonRow(id)).toMatchObject({ text: LESSON, draftId: d.id, createdBy: ownerId, active: true, confirmedAt: null, confirmToken: token });
    expect((await promptLessons()).lessons.map((l) => l.id)).not.toContain(id);
    // A wrong token is a forged press: nothing confirmed.
    const forged = await agentPress(ownerId, 'y', id, token === 'deadbeef' ? 'feedbeef' : 'deadbeef');
    expect(forged.toast).toBe('Topilmadi');
    expect((await lessonRow(id))!.confirmedAt).toBeNull();
    // …and a colleague's press with the RIGHT token is no confirmation either.
    expect((await agentPress(colleagueId, 'y', id, token)).toast).toBe('Topilmadi');
    expect((await lessonRow(id))!.confirmedAt).toBeNull();
    const saved = await agentPress(ownerId, 'y', id, token);
    expect(saved).toMatchObject({ toast: '✅ Saboq saqlandi', closeButtons: true });
    expect(await lessonRow(id)).toMatchObject({ confirmToken: null });
    expect((await lessonRow(id))!.confirmedAt).not.toBeNull();
    expect((await promptLessons()).lessons).toContainEqual({ id, text: LESSON });
  });

  it('«✅ Saqlash» delivered twice confirms once: «Allaqachon saqlangan», the buttons close, and ONE rewrite is queued', async () => {
    const d = await drafted();
    const { id, token } = await typed(d.id);
    queued.jobs.length = 0;
    expect((await agentPress(ownerId, 'y', id, token)).toast).toBe('✅ Saboq saqlandi');
    const again = await agentPress(ownerId, 'y', id, token);
    expect(again).toMatchObject({ toast: LESSON_WORDS.already, closeButtons: true });
    expect(again.reply).toBeUndefined();
    expect(queued.jobs.filter((j) => j.name === JOB_AGENT_OWNER_ANSWER)).toHaveLength(1);
  });

  it('«✅ Saqlash» is the agent’s HOLDER’s: a lesson he typed while he was, pressed after the agent got another holder, counts for nothing', async () => {
    // The creator alone is not enough (review of 0148 as built, tests lens): a lesson reaches every chat of the
    // agent's account, and that account is no longer his.
    const d = await drafted();
    const { id, token } = await typed(d.id);
    await db.update(agentConfig).set({ ownerUserId: colleagueId, sessionExclusiveBy: colleagueId }).where(eq(agentConfig.id, 1));
    try {
      const press = await agentPress(ownerId, 'y', id, token);
      expect(press.toast).toBe(LESSON_WORDS.not_found);
      expect((await lessonRow(id))!.confirmedAt).toBeNull();
      expect((await promptLessons()).lessons.map((l) => l.id)).not.toContain(id);
    } finally {
      await db.update(agentConfig).set({ ownerUserId: ownerId, sessionExclusiveBy: ownerId }).where(eq(agentConfig.id, 1));
    }
    // His again, the same press confirms.
    expect((await agentPress(ownerId, 'y', id, token)).toast).toBe('✅ Saboq saqlandi');
  });

  it('«✖ Bekor» drops the unconfirmed lesson; on a confirmed one it says where a lesson is changed', async () => {
    const d = await drafted();
    const { id } = await typed(d.id);
    // Never a colleague's to drop.
    expect((await agentPress(colleagueId, 'v', id, undefined)).toast).toBe('Topilmadi');
    expect(await lessonRow(id)).not.toBeNull();
    expect(await agentPress(ownerId, 'v', id, undefined)).toMatchObject({ toast: LESSON_DROPPED_TOAST, closeButtons: true });
    expect(await lessonRow(id)).toBeNull();
    expect((await agentPress(ownerId, 'v', id, undefined)).toast).toBe('Topilmadi');
    const kept = await taught(d.id);
    const late = await agentPress(ownerId, 'v', kept.id, undefined);
    expect(late).toMatchObject({ toast: LESSON_WORDS.confirmed.slice(0, 190), reply: LESSON_WORDS.confirmed, closeButtons: true });
    expect((await lessonRow(kept.id))!.confirmedAt).not.toBeNull();
  });

  it('money is refused — «narx saboq bo‘lmaydi» — and so is anything personal: a code, a phone, this chat’s name, another client’s', async () => {
    const d = await drafted();
    await agentPress(ownerId, 'l', d.id, undefined);
    const target = { kind: 'agent_lesson' as const, payload: { draftId: d.id } };
    const refused = async (text: string) => {
      const words = (await agentText(ownerId, target, text, (botMsgSeq += 1)))?.text ?? '';
      // The slot's own question, asked BEFORE it consumes the wait, says the same words.
      expect(await lessonRefusalFor(ownerId, d.id, text), text).toBe(words);
      return words;
    };
    expect(await refused('Avia narxini 17 $ deb ayt')).toBe(`«17» — ${LESSON_WORDS.money}`);
    // Fix pass 3: a price stated the usual way — the price word anywhere in the sentence, a per-unit around the figure
    // — was echoed «Saqlaymi?» and saved; refused at the bot's door and the page's alike.
    for (const [price, figure] of [
      ['Narx: avia 17, avto 160', '17'],
      ['Цена на авиа — 17 за кг', '17'],
      ['Price for air is 17 per kg', '17'],
    ] as const) {
      expect(await refused(price)).toBe(`«${figure}» — ${LESSON_WORDS.money}`);
      expect(await lessonFromPage(actorOf(ownerId), { draftId: d.id, text: price }, ctxOf(ownerId))).toMatchObject({ ok: false, code: 'money' });
    }
    // …while a count beside the price word is no price, at either door.
    expect(await lessonRefusalFor(ownerId, d.id, 'Narx haqida 1 marta ayt, takrorlama')).toBeNull();
    expect(await refused(`${otherClientCode} ga doim rus tilida yoz`)).toBe(`«${otherClientCode}» — ${LESSON_WORDS.personal}`);
    expect(await refused('Savol bo‘lsa +998 90 123 45 67 ga yo‘naltir')).toContain(LESSON_WORDS.personal);
    // The chat's own customer, by ONE word of the name.
    expect(await refused('Dilshodbek bilan doim rus tilida gaplash')).toContain(LESSON_WORDS.personal);
    // Another client, by the whole name the book holds.
    expect(await refused(`Shohruhmirzo Valiyev ${NAME_TAG} kabi mijozlarga qisqa yoz`)).toContain(LESSON_WORDS.personal);
    expect(await refused('x'.repeat(LESSON_LIMITS.maxChars + 1))).toBe(LESSON_WORDS.too_long);
    expect(await refused('   ')).toBe(LESSON_WORDS.empty);
    expect(await myLessons()).toHaveLength(0);
    // An ordinary rule is refused nothing.
    expect(await lessonRefusalFor(ownerId, d.id, LESSON)).toBeNull();
  });

  it('every write is audited: the typed lesson, its confirmation, an edit, a switch, the delete', async () => {
    const d = await drafted();
    await db.update(agentDrafts).set({ status: 'approved', decidedBy: ownerId, decidedAt: new Date() }).where(eq(agentDrafts.id, d.id));
    const { id } = await taught(d.id);
    const edited = `${LESSON} Qisqa yoz.`;
    expect(await editLesson(actorOf(ownerId), id, edited, ctxOf(ownerId))).toMatchObject({ ok: true, text: edited, redraft: 'no_card' });
    expect(await setLessonActive(actorOf(colleagueId), id, false, ctxOf(colleagueId))).toMatchObject({ ok: true });
    expect(await deleteLesson(actorOf(ownerId), id, ctxOf(ownerId))).toEqual({ ok: true });
    const log = await audits(id);
    expect(log.map((a) => a.action)).toEqual(['create', 'update', 'update', 'update', 'delete']);
    expect(log[0]).toMatchObject({ actorId: ownerId, after: { text: LESSON, confirmed: false, draftId: d.id } });
    expect(log[1]).toMatchObject({ actorId: ownerId, before: { confirmed: false }, after: { confirmed: true } });
    expect(log[2]).toMatchObject({ before: { text: LESSON }, after: { text: edited } });
    expect(log[3]).toMatchObject({ actorId: colleagueId, before: { active: true }, after: { active: false } });
    expect(log[4]).toMatchObject({ actorId: ownerId, before: { text: edited, active: false, confirmed: true } });
    expect(await lessonRow(id)).toBeNull();
  });
});

describe('where a lesson sits in a run’s request (spec §3.3)', () => {
  it('a confirmed lesson is in the CACHED head — under its heading, after the rules — and in neither the per-run tail nor the chat’s turn', async () => {
    const first = await drafted();
    await db.update(agentDrafts).set({ status: 'approved', decidedBy: ownerId, decidedAt: new Date() }).where(eq(agentDrafts.id, first.id));
    const before: ModelRequest[] = [];
    // Unconfirmed: in no request at all.
    const { id, token } = await typed(first.id);
    await db.update(agentDrafts).set({ status: 'rejected' }).where(eq(agentDrafts.id, first.id));
    const plain = await drafted({ seen: before });
    expect(before).toHaveLength(1);
    expect(JSON.stringify(before[0])).not.toContain(LESSON);
    expect(plain.policy).not.toHaveProperty('lessons');
    await db.update(agentDrafts).set({ status: 'rejected' }).where(eq(agentDrafts.id, plain.id));
    expect((await agentPress(ownerId, 'y', id, token)).toast).toBe('✅ Saboq saqlandi');
    const seen: ModelRequest[] = [];
    const d = await drafted({ seen });
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.systemCached).toContain(`${LESSONS_HEADING}\n- ${LESSON}`);
    expect(req.systemCached!.indexOf(LESSONS_HEADING)).toBeGreaterThan(req.systemCached!.indexOf('16. Har run compose_reply bilan tugaydi.'));
    expect(req.system).not.toContain(LESSON);
    expect(JSON.stringify(req.messages)).not.toContain(LESSON);
    // …and the draft keeps which lessons its run read (§3.7).
    expect((d.policy as { lessons?: unknown }).lessons).toEqual({ digest: expect.stringMatching(/^[0-9a-f]{12}$/u), newest: id, count: 1 });
    expect((d.policy as { lessons?: unknown }).lessons).toEqual((await promptLessons()).mark);
  });

  it('a lesson switched off, or deleted, leaves the head; switched on again it is back', async () => {
    const d = await drafted();
    await db.update(agentDrafts).set({ status: 'approved', decidedBy: ownerId, decidedAt: new Date() }).where(eq(agentDrafts.id, d.id));
    const { id } = await taught(d.id);
    const inHead = async () => (await promptLessons()).lessons.some((l) => l.id === id);
    expect(await inHead()).toBe(true);
    expect(await setLessonActive(actorOf(ownerId), id, false, ctxOf(ownerId))).toMatchObject({ ok: true });
    expect(await inHead()).toBe(false);
    expect((await webLessons())!.lessons.find((l) => l.id === id)).toMatchObject({ active: false, confirmed: true, inPrompt: false });
    expect(await setLessonActive(actorOf(ownerId), id, true, ctxOf(ownerId))).toMatchObject({ ok: true, fits: true });
    expect(await inHead()).toBe(true);
    expect(await deleteLesson(actorOf(ownerId), id, ctxOf(ownerId))).toEqual({ ok: true });
    expect(await inHead()).toBe(false);
  });

  it('the cap: the forty-first lesson pushes the OLDEST out — said to him by its words, and marked «sig‘madi» on the page', async () => {
    const d = await drafted();
    const base = Date.now() - 3_600_000;
    await db.insert(agentLessons).values(
      Array.from({ length: LESSON_LIMITS.promptCount }, (_, i) => ({
        text: `Eski saboq ${i + 1} ${TAG}`,
        createdBy: ownerId,
        confirmedAt: new Date(base + i * 1000),
        createdAt: new Date(base + i * 1000),
      })),
    );
    expect((await promptLessons()).lessons).toHaveLength(LESSON_LIMITS.promptCount);
    const saved = await lessonFromPage(actorOf(colleagueId), { draftId: d.id, text: LESSON }, ctxOf(colleagueId));
    expect(saved).toMatchObject({ ok: true, fits: true, dropped: [`Eski saboq 1 ${TAG}`] });
    expect(lessonSavedWords(saved as never)).toContain(`⚠️ Promptga sig‘may qolgan eski saboq: «Eski saboq 1 ${TAG}»`);
    const set = await promptLessons();
    expect(set.lessons).toHaveLength(LESSON_LIMITS.promptCount);
    expect(set.lessons[0]!.text).toBe(LESSON);
    expect(set.lessons.map((l) => l.text)).not.toContain(`Eski saboq 1 ${TAG}`);
    expect(set.mark).toMatchObject({ count: LESSON_LIMITS.promptCount });
    const page = (await webLessons())!;
    expect(page.inPrompt).toBe(LESSON_LIMITS.promptCount);
    expect(page.lessons.find((l) => l.text === `Eski saboq 1 ${TAG}`)).toMatchObject({ active: true, confirmed: true, inPrompt: false });
    expect(page.lessons.find((l) => l.text === `Eski saboq 2 ${TAG}`)).toMatchObject({ inPrompt: true });
    // Switching a lesson back ON pushes one out too, and names it: the newest off lets the oldest back in…
    const newest = (saved as { id: string }).id;
    expect(await setLessonActive(actorOf(ownerId), newest, false, ctxOf(ownerId))).toMatchObject({ ok: true, dropped: [] });
    expect((await promptLessons()).lessons.map((l) => l.text)).toContain(`Eski saboq 1 ${TAG}`);
    // …and on again, the oldest falls out once more — said by its words.
    const back = await setLessonActive(actorOf(ownerId), newest, true, ctxOf(ownerId));
    expect(back).toMatchObject({ ok: true, fits: true, dropped: [`Eski saboq 1 ${TAG}`] });
    // The run's head carries exactly the forty.
    const seen: ModelRequest[] = [];
    await db.update(agentDrafts).set({ status: 'rejected' }).where(eq(agentDrafts.id, d.id));
    await drafted({ seen });
    expect(seen[0]!.systemCached!.split('\n').filter((l) => l.startsWith('- ') && l.endsWith(TAG) && l.includes('Eski saboq'))).toHaveLength(LESSON_LIMITS.promptCount - 1);
    expect(seen[0]!.systemCached).not.toContain(`- Eski saboq 1 ${TAG}\n`);
  });
});

describe('the rewrite of a card still waiting for his ✅ (spec §3.4)', () => {
  it('a confirmed lesson queues the rewrite on the answer’s queue, named by the lesson; the card says so and offers no second 📝', async () => {
    const d = await drafted();
    const { id, job, reply } = await taught(d.id);
    expect(reply).toBe(lessonSavedWords({ redraft: 'queued', dropped: [], fits: true }));
    expect(job).toEqual({ managerUserId: ownerId, peerId: String(PEER), draftId: d.id, messageId: 0, lessonId: id });
    expect(queued.jobs.find((j) => j.name === JOB_AGENT_OWNER_ANSWER)!.opts).toEqual({ retryLimit: 0 });
    const now = await draftOf(d.id);
    // Nothing is retired yet: the reply is still his to send, edit or drop while the worker writes.
    expect(now.status).toBe('pending');
    expect((now.policy as { lessonRedraft?: unknown }).lessonRedraft).toMatchObject({ lessonId: id, at: expect.any(String) });
    const card = await cardOf(d.id);
    expect(card.text).toContain(LESSON_REDRAFT_LINE);
    expect(card).toMatchObject({ live: true, teach: false });
    expect(keys(card)).not.toContainEqual(['📝 Tuzatish']);
  });

  it('the worker writes the reply again from the lesson: a NEW pending card, the old one superseded as decided by him — and no countdown', async () => {
    const d = await drafted();
    const before = (await webStats()).ownerTriggered;
    const { id, job } = await taught(d.id);
    const seen: ModelRequest[] = [];
    const out = await rewrite(job!, REWRITE, {}, seen);
    expect(out, JSON.stringify(out)).toMatchObject({ outcome: 'draft' });
    const fresh = await draftOf((out as { draftId: string }).draftId);
    expect(fresh.id).not.toBe(d.id);
    expect(fresh).toMatchObject({ status: 'pending', kind: 'reply', proposedBody: REWRITE, finalBody: null, managerUserId: ownerId });
    expect((fresh.policy as { fromLesson?: unknown }).fromLesson).toEqual({ lessonId: id, draftId: d.id });
    // The lesson is the run's INSTRUCTION, in its own turn — and the reply he judged wrong beside it.
    expect(JSON.stringify(seen[0]!.messages)).toContain(LESSON);
    expect(JSON.stringify(seen[0]!.messages)).toContain(REPLY);
    // …and it is in the cached head too: confirmed, it is every run's.
    expect(seen[0]!.systemCached).toContain(`- ${LESSON}`);
    const old = await draftOf(d.id);
    expect(old).toMatchObject({ status: 'superseded', decidedBy: ownerId });
    expect(old.decidedAt).not.toBeNull();
    expect(old.policy).toMatchObject({ stale: 'owner_lesson' });
    expect(old.policy).not.toHaveProperty('lessonRedraft');
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, fresh.runId!));
    expect(run).toMatchObject({ trigger: 'owner_edit', sourceKey: `lesson:${id}` });
    // The cards: a fresh one that says where it came from, the old one closed in words that are true.
    const card = await cardOf(fresh.id);
    expect(card).toMatchObject({ live: true, teach: true });
    expect(card.text).toContain(FROM_LESSON_LINE);
    expect(card.autoAt ?? null).toBeNull();
    const closed = await cardOf(d.id);
    expect(closed).toMatchObject({ live: false, teach: false });
    expect(closed.text).toContain('📝 Saboq bo‘yicha AI qayta yozdi (yangi kartada).');
    expect(closed.text).not.toContain('Mijoz yana yozdi');
    // No «o'zi yuborish» for a reply he has just judged wrong — though the layer is armed and the reply is one it admits.
    const v = await verdictOf(fresh.id);
    expect(v === null || v.state !== 'waiting', JSON.stringify(v)).toBe(true);
    await shownAt(fresh.id, T1);
    expect(await pressDueAutos(DUE)).toBe(0);
    expect((await draftOf(fresh.id)).status).toBe('pending');
    // It is counted apart from the record the «80 %» is read off (§3.7).
    expect((await webStats()).ownerTriggered).toBe(before + 1);
    // He was told nothing more: the card is the news.
    expect(await notices()).toHaveLength(0);
  });

  it('the job delivered twice writes ONE rewrite: the second delivery stands down in silence', async () => {
    const d = await drafted();
    const { job } = await taught(d.id);
    const out = await rewrite(job!);
    expect(out).toMatchObject({ outcome: 'draft' });
    expect(await rewrite(job!, `Boshqa matn ${TAG}`)).toBeNull();
    const live = await db.select({ id: agentDrafts.id }).from(agentDrafts).where(and(eq(agentDrafts.peerId, PEER), eq(agentDrafts.status, 'pending')));
    expect(live.map((r) => r.id)).toEqual([(out as { draftId: string }).draftId]);
    expect(await notices()).toHaveLength(0);
  });

  it('the lesson’s key already taken by a run still writing it: this delivery stands down in silence and takes nothing from under it', async () => {
    // The answer job's twin (review of 0148 as built, tests lens): without the early return this delivery cleared
    // the mark from under the run that is rewriting the card, and told him «AI javobni qayta yozmadi».
    const d = await drafted();
    const { id, job } = await taught(d.id);
    await db.insert(agentRuns).values({
      managerUserId: ownerId,
      peerId: PEER,
      trigger: 'owner_edit',
      anchorTgMessageId: d.anchorTgMessageId,
      sourceKey: `lesson:${id}`,
    });
    expect(await rewrite(job!)).toEqual({ outcome: 'stood_down', reason: 'duplicate' });
    const now = await draftOf(d.id);
    expect(now.status).toBe('pending');
    expect((now.policy as { lessonRedraft?: { lessonId: string } }).lessonRedraft?.lessonId).toBe(id);
    expect(await notices()).toHaveLength(0);
  });

  it('a lesson is an INSTRUCTION, never a source: a figure it carries, repeated in the rewrite, is still blocked', async () => {
    const d = await drafted();
    const { job } = await taught(d.id, `Yetkazish muddatini doim 45 kun deb ayt ${TAG}.`);
    const out = await rewrite(job!, `Yuk 45 kunda yetib keladi ${TAG}.`);
    expect(out).toMatchObject({ outcome: 'draft' });
    const fresh = await draftOf((out as { draftId: string }).draftId);
    expect(fresh.blocked).toBe(true);
    // The figure is in the run's own instruction turn AND in its cached head — and vouches for nothing in the reply.
    expect((fresh.policy as { blocks: { code: string }[] }).blocks.map((b) => b.code)).toContain('number_unsourced');
    expect(keys(await cardOf(fresh.id)).flat()).not.toContain('✅ Yuborish');
  });

  it('while the rewrite is queued the old reply never goes by itself — the countdown stood down at the save', async () => {
    const d = await drafted();
    // The page's save has no press before it: the writer itself stops the countdown.
    expect(await verdictOf(d.id)).toMatchObject({ state: 'waiting' });
    const saved = await lessonFromPage(actorOf(ownerId), { draftId: d.id, text: LESSON }, ctxOf(ownerId));
    expect(saved).toMatchObject({ ok: true, redraft: 'queued' });
    expect(await verdictOf(d.id)).toMatchObject({ state: 'stopped', outcome: 'owner_lesson', stoppedBy: ownerId });
    expect(await pressDueAutos(DUE)).toBe(0);
    expect((await draftOf(d.id)).status).toBe('pending');
  });

  it('only the HOLDER’s lesson rewrites: a super_admin’s teaches, queues nothing and stops no countdown', async () => {
    const d = await drafted();
    expect(await openLesson(actorOf(colleagueId), d.id, 'web')).toEqual({ ok: true, live: false, after: null, holder: false });
    const saved = await lessonFromPage(actorOf(colleagueId), { draftId: d.id, text: LESSON }, ctxOf(colleagueId));
    expect(saved).toMatchObject({ ok: true, redraft: 'not_holder' });
    expect(lessonSavedWords(saved as never)).toContain('faqat akkaunt egasining tuzatishi');
    expect(queued.jobs.filter((j) => j.name === JOB_AGENT_OWNER_ANSWER)).toHaveLength(0);
    expect(await verdictOf(d.id)).toMatchObject({ state: 'waiting' });
    expect(await draftOf(d.id)).toMatchObject({ status: 'pending' });
    expect((await draftOf(d.id)).policy).not.toHaveProperty('lessonRedraft');
    // …and it is in the prompt all the same: the page's save is itself the confirmation.
    expect((await promptLessons()).lessons.map((l) => l.text)).toContain(LESSON);
    // The page's door: a seller who is neither a super_admin nor the agent's owner writes no lesson.
    expect(await openLesson(seller(), d.id, 'web')).toEqual({ ok: false, code: 'forbidden' });
    expect(await lessonFromPage(seller(), { draftId: d.id, text: `Boshqa saboq ${TAG}` }, ctxOf(sellerId))).toEqual({ ok: false, code: 'forbidden' });
  });

  it('with the agent switched off the lesson is kept and nothing is rewritten — said in words', async () => {
    const d = await drafted();
    const { id, token } = await typed(d.id);
    await db.update(agentConfig).set({ mode: 'off' }).where(eq(agentConfig.id, 1));
    queued.jobs.length = 0;
    const saved = await agentPress(ownerId, 'y', id, token);
    expect(saved.reply).toBe(lessonSavedWords({ redraft: 'agent_off', dropped: [], fits: true }));
    expect(queued.jobs).toHaveLength(0);
    expect((await draftOf(d.id)).policy).not.toHaveProperty('lessonRedraft');
    expect((await lessonRow(id))!.confirmedAt).not.toBeNull();
  });

  it('the model finds nothing to say: the mark comes off, the card is his again and a notice names the reason and that the lesson is kept', async () => {
    const d = await drafted();
    const { id, job } = await taught(d.id);
    const out = await handleLessonRedraft(job!, { callModel: scripted([compose('', { reply_needed: false })]), now: () => T1 });
    expect(out).toMatchObject({ outcome: 'no_reply' });
    const now = await draftOf(d.id);
    expect(now.status).toBe('pending');
    expect(now.policy).not.toHaveProperty('lessonRedraft');
    const card = await cardOf(d.id);
    expect(card).toMatchObject({ live: true, teach: true });
    expect(card.text).toContain('📝 AI javobni qayta yozmadi: AI mijozga javob kerak emas deb topdi.');
    expect(card.text).not.toContain(LESSON_REDRAFT_LINE);
    const told = await notices();
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain('📝 AI javobni qayta yozmadi');
    expect(told[0]!.text).toContain('AI mijozga javob kerak emas deb topdi');
    expect(told[0]!.text).toContain(`Saboq saqlangan: «${LESSON}»`);
    // The purge finds a notice that names a customer by its chat.
    expect(told[0]!.peer).toBe(String(PEER));
    expect((await lessonRow(id))!.confirmedAt).not.toBeNull();
  });

  it('the model fails: the same — said, the card handed back, the lesson kept', async () => {
    const d = await drafted();
    const { job } = await taught(d.id);
    const failing = (async () => {
      throw new Error('upstream 529');
    }) as unknown as CallModel;
    const out = await handleLessonRedraft(job!, { callModel: failing, now: () => T1 });
    expect(out?.outcome).not.toBe('draft');
    expect((await draftOf(d.id)).policy).not.toHaveProperty('lessonRedraft');
    expect((await draftOf(d.id)).status).toBe('pending');
    const told = await notices();
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain('📝 AI javobni qayta yozmadi');
    expect((await cardOf(d.id)).teach).toBe(true);
  });

  it('he sent the old reply himself before the worker came: nothing is rewritten and he is told the card moved', async () => {
    const d = await drafted();
    const { job } = await taught(d.id);
    const card = await cardOf(d.id);
    expect(await decideDraft(actorOf(ownerId), d.id, 'send', { digest: String(card.digest) }, ctxOf(ownerId))).toMatchObject({ ok: true });
    const seen: ModelRequest[] = [];
    expect(await rewrite(job!, REWRITE, {}, seen)).toBeNull();
    // No model call for a card that is no longer there to rewrite.
    expect(seen).toHaveLength(0);
    expect((await draftOf(d.id)).status).toBe('approved');
    const told = await notices();
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain(LESSON_CARD_MOVED_WORDS);
  });

  it('…and his ✅ landing WHILE the model writes: the rewrite’s own transaction finds the mark gone and writes nothing', async () => {
    const d = await drafted();
    const { job } = await taught(d.id);
    const card = await cardOf(d.id);
    const during = (async (): Promise<ModelResponse> => {
      expect(await decideDraft(actorOf(ownerId), d.id, 'send', { digest: String(card.digest) }, ctxOf(ownerId))).toMatchObject({ ok: true });
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'compose_reply', input: compose(REWRITE).input }],
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    }) as unknown as CallModel;
    const out = await handleLessonRedraft(job!, { callModel: during, now: () => T1 });
    expect(out).toMatchObject({ outcome: 'stood_down', reason: 'question_gone' });
    const drafts = await db.select({ id: agentDrafts.id, status: agentDrafts.status }).from(agentDrafts).where(eq(agentDrafts.peerId, PEER));
    expect(drafts).toEqual([{ id: d.id, status: 'approved' }]);
    const told = await notices();
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain(LESSON_CARD_MOVED_WORDS);
  });

  it('the customer wrote again first: the newer reply stands, the lesson rewrites nothing', async () => {
    const d = await drafted();
    const { job } = await taught(d.id);
    const newer = await drafted({ steps: [compose(`Ha, albatta ${TAG}. Yuk qayerda?`)], now: T1 });
    expect((await draftOf(d.id)).status).toBe('superseded');
    expect(await rewrite(job!)).toBeNull();
    expect((await draftOf(newer.id)).status).toBe('pending');
    const live = await db.select({ id: agentDrafts.id }).from(agentDrafts).where(and(eq(agentDrafts.peerId, PEER), eq(agentDrafts.status, 'pending')));
    expect(live.map((r) => r.id)).toEqual([newer.id]);
    expect((await notices()).some((n) => n.text.includes(LESSON_CARD_MOVED_WORDS))).toBe(true);
  });

  it('a NEWER lesson on the same card takes it: the older lesson’s job is silent, the newer one’s writes the reply', async () => {
    const d = await drafted();
    const first = await taught(d.id);
    const second = await lessonFromPage(actorOf(ownerId), { draftId: d.id, text: `Javobni ikki jumladan oshirma ${TAG}.` }, ctxOf(ownerId));
    expect(second).toMatchObject({ ok: true, redraft: 'queued' });
    const secondId = (second as { id: string }).id;
    expect(((await draftOf(d.id)).policy as { lessonRedraft: { lessonId: string } }).lessonRedraft.lessonId).toBe(secondId);
    const seen: ModelRequest[] = [];
    expect(await rewrite(first.job!, REWRITE, {}, seen)).toBeNull();
    expect(seen).toHaveLength(0);
    expect(await notices()).toHaveLength(0);
    expect((await draftOf(d.id)).status).toBe('pending');
    const job2 = queued.jobs.filter((j) => j.name === JOB_AGENT_OWNER_ANSWER).at(-1)!.data as AgentOwnerAnswerJob;
    expect(job2.lessonId).toBe(secondId);
    const out = await rewrite(job2);
    expect(out).toMatchObject({ outcome: 'draft' });
    expect(((await draftOf((out as { draftId: string }).draftId)).policy as { fromLesson: { lessonId: string } }).fromLesson.lessonId).toBe(secondId);
  });

  it('…and a newer lesson saved WHILE the older one’s model writes: the older rewrite writes nothing, in silence — the card is the newer lesson’s', async () => {
    const d = await drafted();
    const first = await taught(d.id);
    let secondId = '';
    const during = (async (): Promise<ModelResponse> => {
      const second = await lessonFromPage(actorOf(ownerId), { draftId: d.id, text: `Javobni ikki jumladan oshirma ${TAG}.` }, ctxOf(ownerId));
      expect(second).toMatchObject({ ok: true, redraft: 'queued' });
      secondId = (second as { id: string }).id;
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'compose_reply', input: compose(REWRITE).input }],
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    }) as unknown as CallModel;
    const out = await handleLessonRedraft(first.job!, { callModel: during, now: () => T1 });
    expect(out).toMatchObject({ outcome: 'stood_down', reason: 'question_gone' });
    // The reply is still the one card, still pending, and still marked — by the NEWER lesson.
    const drafts = await db.select({ id: agentDrafts.id, status: agentDrafts.status }).from(agentDrafts).where(eq(agentDrafts.peerId, PEER));
    expect(drafts).toEqual([{ id: d.id, status: 'pending' }]);
    expect(((await draftOf(d.id)).policy as { lessonRedraft: { lessonId: string } }).lessonRedraft.lessonId).toBe(secondId);
    expect((await cardOf(d.id)).text).toContain(LESSON_REDRAFT_LINE);
    expect(await notices()).toHaveLength(0);
  });

  it('his own words typed on the card (the page’s ✏️ box) while the rewrite is queued: the mark is gone and the worker is silent', async () => {
    const d = await drafted();
    const { job } = await taught(d.id);
    expect(await submitOwnText(actorOf(ownerId), d.id, `Ha, olib kelamiz. Yukingiz nima ${TAG}?`, ctxOf(ownerId))).toMatchObject({ ok: true });
    const mine = await draftOf(d.id);
    expect(mine.finalBody).toBe(`Ha, olib kelamiz. Yukingiz nima ${TAG}?`);
    expect(mine.policy).not.toHaveProperty('lessonRedraft');
    const seen: ModelRequest[] = [];
    expect(await rewrite(job!, REWRITE, {}, seen)).toBeNull();
    expect(seen).toHaveLength(0);
    expect((await draftOf(d.id)).finalBody).toBe(`Ha, olib kelamiz. Yukingiz nima ${TAG}?`);
    expect((await cardOf(d.id)).text).not.toContain(LESSON_REDRAFT_LINE);
    // In SILENCE: he took the card himself — «the card moved» would be news about his own press.
    expect(await notices()).toHaveLength(0);
  });

  it('the lesson taken back on the page before the worker came (switched off, deleted): nothing is rewritten, the mark comes off in silence', async () => {
    for (const takeBack of ['off', 'delete'] as const) {
      await clearChat();
      await clearLessons();
      const d = await drafted();
      const { id, job } = await taught(d.id);
      if (takeBack === 'off') expect(await setLessonActive(actorOf(ownerId), id, false, ctxOf(ownerId))).toMatchObject({ ok: true });
      else expect(await deleteLesson(actorOf(ownerId), id, ctxOf(ownerId))).toEqual({ ok: true });
      const seen: ModelRequest[] = [];
      expect(await rewrite(job!, REWRITE, {}, seen), takeBack).toBeNull();
      expect(seen, takeBack).toHaveLength(0);
      const now = await draftOf(d.id);
      expect(now.status).toBe('pending');
      expect(now.policy, takeBack).not.toHaveProperty('lessonRedraft');
      const card = await cardOf(d.id);
      expect(card.text).not.toContain(LESSON_REDRAFT_LINE);
      expect(card).toMatchObject({ live: true, teach: true });
      expect(await notices(), takeBack).toHaveLength(0);
    }
  });

  it('✏️ on the card while the rewrite is queued takes it back: his own words are never rewritten', async () => {
    const d = await drafted();
    const { job } = await taught(d.id);
    const edit = await agentPress(ownerId, 'e', d.id, undefined);
    expect(edit.arm).toMatchObject({ kind: 'agent_edit' });
    expect((await draftOf(d.id)).policy).not.toHaveProperty('lessonRedraft');
    const seen: ModelRequest[] = [];
    expect(await rewrite(job!, REWRITE, {}, seen)).toBeNull();
    expect(seen).toHaveLength(0);
    expect((await draftOf(d.id)).status).toBe('editing');
  });

  it('a rewrite that never came (the worker died): the sweep takes the mark off after fifteen minutes and says so', async () => {
    const d = await drafted();
    const { id } = await taught(d.id);
    // Still inside the window: left alone.
    expect(await releaseStaleLessonRedrafts(new Date())).toBe(0);
    expect((await draftOf(d.id)).policy).toHaveProperty('lessonRedraft');
    const old = JSON.stringify({ lessonRedraft: { lessonId: id, at: new Date(Date.now() - 16 * 60_000).toISOString() } });
    await db.update(agentDrafts).set({ policy: sql`${agentDrafts.policy} || ${old}::jsonb` }).where(eq(agentDrafts.id, d.id));
    await agentSweep(new Date());
    const now = await draftOf(d.id);
    expect(now.status).toBe('pending');
    expect(now.policy).not.toHaveProperty('lessonRedraft');
    const card = await cardOf(d.id);
    expect(card.text).toContain('📝 AI javobni qayta yozmadi (ishchi javob bermadi) — saboq saqlangan.');
    expect(card.teach).toBe(true);
    const told = await notices();
    expect(told.filter((n) => n.text.includes('AI ishchisi javob bermadi'))).toHaveLength(1);
    // Once: a second sweep finds nothing.
    expect(await releaseStaleLessonRedrafts(new Date())).toBe(0);
  });
});

describe('the page (spec §3.6) and the edges', () => {
  it('the page’s lists carry `teach` and how a lesson would act: a waiting reply is rewritten, a sent one only teaches', async () => {
    const d = await drafted();
    const viewer = { id: ownerId, roles: ['super_admin'], permissions: new Set<string>(['crm.leads.view_all']) };
    const live = (await webDrafts(viewer)).pending.find((w) => w.id === d.id);
    expect(live).toMatchObject({ teach: true, lessonRewrites: true });
    // The colleague reads the same card and may teach on it; «rewrites» is the DRAFT's fact — the page promises the
    // rewrite only to the draft's own account (`d.managerUserId === viewerId`), which he is not.
    const theirs = (await webDrafts({ ...viewer, id: colleagueId })).pending.find((w) => w.id === d.id);
    expect(theirs).toMatchObject({ teach: true, lessonRewrites: true, managerUserId: ownerId });
    const page = readFileSync('src/app/(protected)/suhbatlar/ai/page.tsx', 'utf8');
    expect(page).toContain('rewrites={d.lessonRewrites && d.managerUserId === viewerId}');
    const saved = await lessonFromPage(actorOf(ownerId), { draftId: d.id, text: LESSON }, ctxOf(ownerId));
    expect(saved).toMatchObject({ ok: true, redraft: 'queued' });
    // While the rewrite is on its way the row offers no second 📝.
    const marked = (await webDrafts(viewer)).pending.find((w) => w.id === d.id);
    expect(marked).toMatchObject({ teach: false });
    // A reply that left teaches and is never rewritten.
    expect(await decideDraft(actorOf(ownerId), d.id, 'send', { digest: String((await cardOf(d.id)).digest) }, ctxOf(ownerId))).toMatchObject({ ok: true });
    const waiting = (await webDrafts(viewer)).waiting.find((w) => w.id === d.id);
    expect(waiting).toMatchObject({ teach: true, lessonRewrites: false });
  });

  /**
   * The review of 0148 as built (bot lens), reproduced in a browser on a built server: the HOLDER saves a lesson on a
   * reply still waiting, with the prompt at its cap. The save answers «✅ Saboq saqlandi… ⚠️ Promptga sig‘may qolgan
   * eski saboq: «…»» and revalidates the page — the draft now carries the rewrite's mark, so `teach` is false, and
   * `{d.teach && <LessonButton/>}` UNMOUNTED the component that holds the answer: the ⚠️ line was on screen for a
   * fifth of a second (spec §3.3, binding: a lesson that pushes another out names which one drops). The row says it
   * is being rewritten (`lessonRewriting`), and the page keeps the 📝's place mounted for it — the opener gone, the
   * answer not.
   */
  it('the holder’s lesson on a waiting reply at the cap: the answer names the lesson that fell out, and the row keeps the place it is said in', async () => {
    const d = await drafted();
    const base = Date.now() - 3_600_000;
    await db.insert(agentLessons).values(
      Array.from({ length: LESSON_LIMITS.promptCount }, (_, i) => ({
        text: `Eski saboq ${i + 1} ${TAG}`,
        createdBy: ownerId,
        confirmedAt: new Date(base + i * 1000),
        createdAt: new Date(base + i * 1000),
      })),
    );
    const viewer = { id: ownerId, roles: ['super_admin'], permissions: new Set<string>(['crm.leads.view_all']) };
    expect((await webDrafts(viewer)).pending.find((w) => w.id === d.id)).toMatchObject({ teach: true, lessonRewriting: false });
    const saved = await lessonFromPage(actorOf(ownerId), { draftId: d.id, text: LESSON }, ctxOf(ownerId));
    expect(saved).toMatchObject({ ok: true, redraft: 'queued', dropped: [`Eski saboq 1 ${TAG}`] });
    expect(lessonSavedWords(saved as never)).toContain(`⚠️ Promptga sig‘may qolgan eski saboq: «Eski saboq 1 ${TAG}»`);
    // The row after the save's own revalidation: no second 📝 — and still the lesson's place.
    const marked = (await webDrafts(viewer)).pending.find((w) => w.id === d.id);
    expect(marked).toMatchObject({ teach: false, lessonRewriting: true });
    // ONE expression mounts the component before and after the save (the same element at the same place keeps its
    // state — the note), and inside it only the OPENER and the box hang on `teach`: the answer is always drawn.
    const page = readFileSync('src/app/(protected)/suhbatlar/ai/page.tsx', 'utf8');
    // The waiting reply's own card (the lists of sent replies are never rewritten — nothing unmounts theirs).
    const card = page.slice(page.indexOf('function DraftCard('), page.indexOf('function Empty('));
    expect(card).toMatch(/\{\(d\.teach \|\| d\.lessonRewriting\) && \(\s*<LessonButton draftId=\{d\.id\} teach=\{d\.teach\} rewrites=\{d\.lessonRewrites && d\.managerUserId === viewerId\} \/>\s*\)\}/u);
    expect(card).not.toMatch(/\{d\.teach && <LessonButton/u);
    const ui = readFileSync('src/app/(protected)/suhbatlar/ai/agent-ui.tsx', 'utf8');
    const button = ui.slice(ui.indexOf('export function LessonButton'), ui.indexOf('export function LessonEditor'));
    expect(button).toMatch(/\{teach && \(\s*<button[^>]*?data-testid="agent-lesson-open"/su);
    expect(button).toMatch(/\{teach && open && \(/u);
    // The answer, outside both: the last thing the component draws, under no condition.
    expect(button).toMatch(/\n      <Feedback error=\{error\} note=\{note\} \/>\n    <\/div>\n  \);\n\}/u);
    // His own words typed since (✏️) end the rewrite: the row is an ordinary one again — nothing left to keep a place for.
    expect(await submitOwnText(actorOf(ownerId), d.id, `O‘zim yozaman ${TAG}`, ctxOf(ownerId))).toMatchObject({ ok: true });
    const own = (await webDrafts(viewer)).pending.find((w) => w.id === d.id);
    expect(own).toMatchObject({ teach: false, lessonRewriting: false });
  });

  it('the page’s edit takes the same refusals, and saving an UNCONFIRMED lesson there confirms it', async () => {
    const d = await drafted();
    await db.update(agentDrafts).set({ status: 'approved', decidedBy: ownerId, decidedAt: new Date() }).where(eq(agentDrafts.id, d.id));
    const { id } = await typed(d.id);
    expect((await webLessons())!.lessons.find((l) => l.id === id)).toMatchObject({ confirmed: false, inPrompt: false, createdByName: `Tuzatish egasi ${SUFFIX}` });
    expect(await editLesson(actorOf(ownerId), id, 'Narxni 20 dollar deb ayt', ctxOf(ownerId))).toMatchObject({ ok: false, code: 'money' });
    expect(await editLesson(actorOf(ownerId), id, `${otherClientCode} ga rus tilida yoz`, ctxOf(ownerId))).toMatchObject({ ok: false, code: 'personal' });
    expect(await editLesson(seller(), id, LESSON, ctxOf(sellerId))).toEqual({ ok: false, code: 'forbidden' });
    expect((await lessonRow(id))!.confirmedAt).toBeNull();
    const edited = `${LESSON} Qisqa yoz.`;
    expect(await editLesson(actorOf(colleagueId), id, edited, ctxOf(colleagueId))).toMatchObject({ ok: true, text: edited, fits: true });
    expect(await lessonRow(id)).toMatchObject({ text: edited, confirmToken: null });
    expect((await lessonRow(id))!.confirmedAt).not.toBeNull();
    expect((await webLessons())!.lessons.find((l) => l.id === id)).toMatchObject({ confirmed: true, inPrompt: true });
    // The echo's «✅ Saqlash» pressed after that has nothing left to confirm.
    expect(await confirmLesson(actorOf(ownerId), id, 'deadbeef', ctxOf(ownerId))).toEqual({ ok: false, code: 'already' });
  });

  it('a lesson SURVIVES the chat’s purge — its draft is gone, the rule he believes the AI follows is not', async () => {
    const d = await drafted();
    await db.update(agentDrafts).set({ status: 'approved', decidedBy: ownerId, decidedAt: new Date() }).where(eq(agentDrafts.id, d.id));
    const { id } = await taught(d.id);
    expect((await lessonRow(id))!.draftId).toBe(d.id);
    await purgeAgentChat(ownerId, PEER);
    expect(await db.select({ id: agentDrafts.id }).from(agentDrafts).where(eq(agentDrafts.peerId, PEER))).toHaveLength(0);
    expect(await lessonRow(id)).toMatchObject({ text: LESSON, draftId: null, active: true });
    expect((await promptLessons()).lessons.map((l) => l.id)).toContain(id);
    // …and the purged card offers nothing to teach on.
    const cards = await db
      .select({ payload: notifications.payload })
      .from(notifications)
      .where(and(eq(notifications.userId, ownerId), eq(notifications.type, 'AgentDraft')));
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(c.payload).toMatchObject({ teach: false, live: false });
  });

  it('one migration behind 0148: no lessons block, every door refuses in words, the tab says so', async () => {
    const d = await drafted();
    await db.update(agentDrafts).set({ status: 'approved', decidedBy: ownerId, decidedAt: new Date() }).where(eq(agentDrafts.id, d.id));
    const { id } = await taught(d.id);
    expect((await promptLessons()).lessons.map((l) => l.id)).toContain(id);
    __pretendAgentFullP1Behind();
    try {
      expect(await promptLessons()).toEqual({ lessons: [], mark: null });
      expect(await webLessons()).toBeNull();
      expect((await agentPress(ownerId, 'l', d.id, undefined)).toast).toBe(LESSON_WORDS.not_ready);
      expect(await openLesson(actorOf(ownerId), d.id, 'web')).toEqual({ ok: false, code: 'not_ready' });
      expect(await lessonFromPage(actorOf(ownerId), { draftId: d.id, text: LESSON }, ctxOf(ownerId))).toEqual({ ok: false, code: 'not_ready' });
      expect(await setLessonActive(actorOf(ownerId), id, false, ctxOf(ownerId))).toEqual({ ok: false, code: 'not_ready' });
      expect(await releaseStaleLessonRedrafts(new Date())).toBe(0);
      // A run writes its draft as before — with no lessons in its head.
      await db.update(agentDrafts).set({ status: 'rejected' }).where(eq(agentDrafts.id, d.id));
      const seen: ModelRequest[] = [];
      const plain = await drafted({ seen });
      expect(seen[0]!.systemCached).not.toContain(LESSONS_HEADING);
      expect(plain.policy).not.toHaveProperty('lessons');
    } finally {
      __forgetAgentFullP1Ready();
    }
    expect((await lessonRow(id))!.active).toBe(true);
  });
});
