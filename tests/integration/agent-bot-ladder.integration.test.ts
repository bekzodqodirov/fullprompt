import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The AI sotuvchi's ONE text slot, driven through the bot the server runs
 * (review I2, I4): whose text is it, when an agent wait is live and something
 * else is on the screen too? A swipe-reply names its own target, a newer task
 * wait wins over an older agent wait, a forward is Door B's — and «/agent»
 * from a chat that is not staff is passed on like any text that is not ours.
 *
 * Everything is this file's own: users with run-unique phones, chat ids
 * starting `96<stamp>`, one client, one draft per case. agent_config is
 * CONFIGURATION (#183) — snapshotted and put back. Users are DEACTIVATED in
 * cleanup, never deleted (audit FK).
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => {}),
}));

import { Bot } from 'grammy';
import { enqueue } from '@/modules/platform/jobs/boss';
import { JOB_AGENT_OWNER_ANSWER } from '@/modules/wms/agent/queues';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  agentAutoChats,
  agentAutoVerdicts,
  agentConfig,
  agentConversations,
  agentDrafts,
  agentLessons,
  agentSendCaps,
  clients,
  notifications,
  roles,
  tasks,
  telegramLinks,
  tgChatRules,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { createTask } from '@/modules/platform/tasks/service';
import { registerAgentCommand } from '@/modules/platform/telegram/agent-bot';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import { noteReplyPending, noteTaskPending } from '@/modules/platform/telegram/staff-bot';
import { __forgetWaitMemory, flushWaitWrites, nowSec, readWait } from '@/modules/platform/telegram/waits';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { __resetBacklog } from '@/modules/platform/telegram/backlog';
import { __resetDrafts } from '@/modules/platform/telegram/task-draft';
import { endIntake, HOLD_MS, startIntake, updateIntake } from '@/modules/platform/telegram/calc-store';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import { retireOnHumanReply } from '@/modules/wms/agent/jobs';
import { DEFAULT_SEND_CAPS, __restoreSendCaps, readSendCaps, type SendCaps } from '@/modules/wms/agent/send-caps';
import { currentTariffFingerprint } from '@/modules/wms/agent/tariff-watch';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';

const STAMP = String(Date.now()).slice(-7);
const PREFIX = `96${STAMP}`;
let chatSeq = 0;
let phoneSeq = 0;
let msgSeq = 800_000;
let peerSeq = 0;
const nextChat = () => Number(`${PREFIX}${String((chatSeq += 1)).padStart(2, '0')}`);
const nextMsg = () => (msgSeq += 1);

const madeUsers: string[] = [];
const madeTasks: string[] = [];
let clientId = '';
let snapshot: AgentConfig | null = null;
let h: BotHarness;

interface Person {
  id: string;
  chat: number;
}

async function person(role = 'super_admin', linked = true): Promise<Person> {
  phoneSeq += 1;
  const [u] = await db
    .insert(users)
    .values({ phone: `+99896${STAMP}${String(phoneSeq).padStart(2, '0')}`, fullName: `Zinapoya ${STAMP}-${phoneSeq}`, passwordHash: 'x' })
    .returning({ id: users.id });
  madeUsers.push(u!.id);
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  const chat = nextChat();
  if (linked) await db.insert(telegramLinks).values({ userId: u!.id, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  return { id: u!.id, chat };
}

/** The agent's owner, with one live draft on his account. */
async function owner(): Promise<{ me: Person; draftId: string }> {
  const me = await person();
  await db.update(agentConfig).set({ mode: 'shadow', ownerUserId: me.id, sessionExclusiveAt: new Date(), sessionExclusiveBy: me.id }).where(eq(agentConfig.id, 1));
  const [d] = await db
    .insert(agentDrafts)
    .values({
      managerUserId: me.id,
      peerId: BigInt(`${PREFIX}9${(peerSeq += 1)}`),
      clientId,
      anchorTgMessageId: 1n,
      proposedBody: 'Tekshirib aytaman.',
      status: 'pending',
    })
    .returning({ id: agentDrafts.id });
  return { me, draftId: d!.id };
}

async function handTask(assignee: Person, author: Person): Promise<string> {
  const task = await createTask(
    { title: `Zinapoya ${STAMP}`, note: '', typeId: null, assigneeId: assignee.id, dueAt: '', priority: 2, entityType: null, entityId: null, repeatUnit: null, repeatEvery: 1 },
    { actorId: author.id, ip: null, userAgent: 'agent-bot-ladder.integration' },
    { origin: 'hand' },
  );
  madeTasks.push(task.id);
  return task.id;
}

/** A copy the drain SENT to `who` — what a swipe-reply names. */
async function sentCopy(who: Person, type: string, payload: Record<string, unknown>): Promise<number> {
  const messageId = nextMsg();
  await db.insert(notifications).values({
    userId: who.id,
    channel: 'telegram',
    type,
    status: 'sent',
    sentAt: new Date(),
    payload: { text: 'x', ...payload, tg: { chatId: who.chat, messageId } },
  });
  return messageId;
}

async function draftOf(id: string) {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, id));
  return d!;
}

async function statusOf(taskId: string): Promise<string> {
  const [row] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
  return row!.status;
}

/** ✏️ on the draft's card; the prompt's own message id. */
async function pressEdit(me: Person, draftId: string): Promise<number> {
  const m = h.mark();
  await h.handle(tg.callback(me.chat, nextMsg(), `ag:e:${draftId}`));
  const prompt = h.since(m).api.find((c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('✏️'));
  expect(prompt?.messageId, 'the ✏️ prompt was sent').toBeDefined();
  return prompt!.messageId!;
}

beforeAll(async () => {
  snapshot = await readAgentConfig();
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `ZP${STAMP.slice(-5)}`, name: `Zinapoya mijoz ${STAMP}`, phones: [] })
    .returning({ id: clients.id });
  clientId = c!.id;
  h = botHarness();
});

beforeEach(async () => {
  __resetLifecycle();
  __forgetWaitMemory();
  __resetPresses();
  __resetBacklog();
  __resetDrafts();
  markBoot(new Date(0));
  // One live draft per account at a time: each case's owner is a new person.
  await db.delete(agentDrafts).where(eq(agentDrafts.clientId, clientId));
  // A lesson is in EVERY chat's prompt — configuration (#183): none of this file's outlives its case.
  if (madeUsers.length) await db.delete(agentLessons).where(inArray(agentLessons.createdBy, madeUsers));
});

afterAll(async () => {
  await flushWaitWrites();
  h.restore();
  await __restoreAgentConfig(snapshot);
  await db.delete(agentLessons).where(inArray(agentLessons.createdBy, madeUsers));
  await db.delete(agentDrafts).where(eq(agentDrafts.clientId, clientId));
  await db.delete(agentAutoChats).where(inArray(agentAutoChats.managerUserId, madeUsers));
  await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
  await db.delete(agentConversations).where(inArray(agentConversations.managerUserId, madeUsers));
  await db.delete(tgChatRules).where(inArray(tgChatRules.managerUserId, madeUsers));
  if (madeTasks.length) await db.delete(tasks).where(inArray(tasks.id, madeTasks));
  await db.execute(sql`DELETE FROM telegram_once WHERE key LIKE ${`m:${PREFIX}%`} OR key LIKE ${`q:${PREFIX}%`}`);
  await db.execute(sql`DELETE FROM telegram_chat_waits WHERE chat_id::text LIKE ${`${PREFIX}%`}`);
  await db.delete(clients).where(eq(clients.id, clientId));
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, madeUsers));
  await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  await pgClient.end();
});

describe('a reply names its own target (I2 a)', () => {
  it('a swipe-reply to a TASK copy is that task’s question — the live agent wait does not eat it', async () => {
    const { me, draftId } = await owner();
    const giver = await person('sales_manager');
    const T = await handTask(me, giver);
    await pressEdit(me, draftId);
    const copy = await sentCopy(me, 'TaskAssigned', { taskId: T, origin: 'hand' });
    await h.handle(tg.text(me.chat, `qachongacha? ${STAMP}`, { replyTo: copy }));
    expect((await draftOf(draftId)).finalBody).toBeNull();
    const asked = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.userId, giver.id), eq(notifications.type, 'TaskQuestion')));
    expect(asked).toHaveLength(1);
    // …and the wait is still his for the reply he was asked to write.
    await h.handle(tg.text(me.chat, `Ertaga yetib keladi ${STAMP}`));
    expect((await draftOf(draftId)).finalBody).toBe(`Ertaga yetib keladi ${STAMP}`);
  });

  it('a swipe-reply to the ✏️ prompt itself answers the wait', async () => {
    const { me, draftId } = await owner();
    const prompt = await pressEdit(me, draftId);
    await h.handle(tg.text(me.chat, `Yuk Yiwuda ${STAMP}`, { replyTo: prompt }));
    expect((await draftOf(draftId)).finalBody).toBe(`Yuk Yiwuda ${STAMP}`);
  });
});

describe('the newest question on the screen is the one a text answers (I2 b)', () => {
  it('«✅ Bajarildi» pressed after ✏️: the text closes the task, the NEXT text is the reply', async () => {
    const { me, draftId } = await owner();
    const giver = await person('sales_manager');
    const T = await handTask(me, giver);
    await pressEdit(me, draftId);
    await h.handle(tg.callback(me.chat, nextMsg(), `t:${T}`));
    await h.handle(tg.text(me.chat, `qildim ${STAMP}`));
    await flushWaitWrites();
    expect(await statusOf(T)).toBe('done');
    expect((await draftOf(draftId)).finalBody).toBeNull();
    await h.handle(tg.text(me.chat, `Javob ${STAMP}`));
    expect((await draftOf(draftId)).finalBody).toBe(`Javob ${STAMP}`);
  });

  it('…but a swipe-reply to the ✏️ prompt still names the prompt — the task’s question keeps waiting', async () => {
    const { me, draftId } = await owner();
    const giver = await person('sales_manager');
    const T = await handTask(me, giver);
    const prompt = await pressEdit(me, draftId);
    await h.handle(tg.callback(me.chat, nextMsg(), `t:${T}`));
    await h.handle(tg.text(me.chat, `Javob ${STAMP}`, { replyTo: prompt }));
    expect((await draftOf(draftId)).finalBody).toBe(`Javob ${STAMP}`);
    expect(await statusOf(T)).not.toBe('done');
  });

  it('«✅ Bajarildi» pressed AGAIN on the same task after ✏️ is still the newer question (the merged wait keeps its first time)', async () => {
    const { me, draftId } = await owner();
    const giver = await person('sales_manager');
    const T = await handTask(me, giver);
    // The first «Bajarildi», fifteen minutes ago — its wait run out by the clock, so ✏️ is free.
    noteTaskPending(BigInt(me.chat), T, null, 'result', { armedAt: nowSec() - 900, promptMessageId: nextMsg() });
    await pressEdit(me, draftId);
    // Pressed again: the same target, so waits.ts merges and keeps the FIRST prompt's time.
    await h.handle(tg.callback(me.chat, nextMsg(), `t:${T}`));
    await h.handle(tg.text(me.chat, `qildim ${STAMP}`));
    await flushWaitWrites();
    expect(await statusOf(T)).toBe('done');
    expect((await draftOf(draftId)).finalBody).toBeNull();
  });

  it('✏️ while a task’s answer is awaited is refused in words — nothing is armed', async () => {
    const { me, draftId } = await owner();
    const giver = await person('sales_manager');
    const T = await handTask(me, giver);
    await h.handle(tg.callback(me.chat, nextMsg(), `t:${T}`));
    const m = h.mark();
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:e:${draftId}`));
    expect(h.textsTo(me.chat, m).some((t) => t.startsWith("Avval topshiriq bo'yicha so'ralgan javobni yozing"))).toBe(true);
    expect(readWait(BigInt(me.chat), 'agent_edit')).toBeNull();
    expect((await draftOf(draftId)).status).toBe('pending');
  });

  it('a PARKED «Hisoblatish» collection is no reason to refuse ✏️; a HOLDING one is (review REG-1)', async () => {
    const { me, draftId } = await owner();
    const c = BigInt(me.chat);
    startIntake(c, 'rastamojka', { staffId: me.id });
    updateIntake(c, { stage: 'material', material: ['Kurtka 300 dona'] }, { quiet: true });
    const m = h.mark();
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:e:${draftId}`));
    expect(h.textsTo(me.chat, m)).toContain('Avval boshlangan ishni tugating (hisoblatish, zametka yoki topshiriq).');
    expect(readWait(c, 'agent_edit')).toBeNull();
    // Idle past the half hour: parked, it takes no text — ✏️ arms.
    updateIntake(c, { touchedAt: Date.now() - HOLD_MS - 60_000 }, { quiet: true });
    await pressEdit(me, draftId);
    expect(readWait(c, 'agent_edit')).not.toBeNull();
    endIntake(c);
  });

  it('…and while «💬 Javob yozish» awaits a reply, the words name THAT, not a task', async () => {
    const { me, draftId } = await owner();
    noteReplyPending(BigInt(me.chat), nextMsg(), { armedAt: nowSec() });
    const m = h.mark();
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:e:${draftId}`));
    expect(h.textsTo(me.chat, m).some((t) => t.startsWith('Avval «💬 Javob yozish»'))).toBe(true);
    expect(readWait(BigInt(me.chat), 'agent_edit')).toBeNull();
  });
});

describe('a reply to an EARLIER prompt, or to the stranger card itself (review I2)', () => {
  it('✏️ tapped twice: a swipe-reply to the FIRST prompt is still this draft’s text', async () => {
    const { me, draftId } = await owner();
    const first = await pressEdit(me, draftId);
    await pressEdit(me, draftId);
    await h.handle(tg.text(me.chat, `Birinchisiga ${STAMP}`, { replyTo: first }));
    expect((await draftOf(draftId)).finalBody).toBe(`Birinchisiga ${STAMP}`);
  });

  /** A pending stranger rule on the owner's account, with its card SENT to him. */
  async function strangerWithCard(me: Person): Promise<{ ruleId: string; card: number }> {
    const [rule] = await db
      .insert(tgChatRules)
      .values({ managerUserId: me.id, peerId: BigInt(`${PREFIX}8${(peerSeq += 1)}`), peerTitle: 'Notanish', peerPhone: '+998901112233' })
      .returning({ id: tgChatRules.id });
    const card = await sentCopy(me, 'AgentStranger', { ruleId: rule!.id });
    return { ruleId: rule!.id, card };
  }

  const echoes = async (me: Person) =>
    db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.userId, me.id), eq(notifications.type, 'AgentCodeEcho')));

  it('«👤 Mijoz — kod», then the code as a reply to the stranger card: the code is echoed', async () => {
    const { me } = await owner();
    const { ruleId, card } = await strangerWithCard(me);
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:k:${ruleId}`));
    await h.handle(tg.text(me.chat, `ZP${STAMP.slice(-5)}`, { replyTo: card }));
    expect(await echoes(me)).toHaveLength(1);
    expect(readWait(BigInt(me.chat), 'agent_code')).toBeNull();
  });

  it('…but a reply to the stranger card with no code asked for opens no echo', async () => {
    const { me } = await owner();
    const { card } = await strangerWithCard(me);
    await h.handle(tg.text(me.chat, `ZP${STAMP.slice(-5)}`, { replyTo: card }));
    expect(await echoes(me)).toHaveLength(0);
  });
});

describe('a ✏️ wait whose draft is gone does not eat his next text (C8)', () => {
  it('✏️, then his own Telegram reply retires the draft: a plain text goes on down the ladder to the lookup', async () => {
    const { me, draftId } = await owner();
    await pressEdit(me, draftId);
    expect(await retireOnHumanReply(me.id, (await draftOf(draftId)).peerId, 2n)).toBe(1);
    const m = h.mark();
    await h.handle(tg.text(me.chat, `ZP${STAMP.slice(-5)}`));
    const texts = h.textsTo(me.chat, m);
    expect(texts.some((t) => t.includes('faol emas'))).toBe(false);
    // The staff tail answered the code: the client's own name came back.
    expect(texts.some((t) => t.includes(`Zinapoya mijoz ${STAMP}`))).toBe(true);
    expect((await draftOf(draftId)).finalBody).toBeNull();
    expect(readWait(BigInt(me.chat), 'agent_edit')).toBeNull();
  });

  it('…but a swipe-reply to the dead card still names the draft and is told its text went nowhere', async () => {
    const { me, draftId } = await owner();
    await pressEdit(me, draftId);
    await retireOnHumanReply(me.id, (await draftOf(draftId)).peerId, 2n);
    const card = await sentCopy(me, 'AgentDraft', { draftId });
    const m = h.mark();
    await h.handle(tg.text(me.chat, `Javob ${STAMP}`, { replyTo: card }));
    expect(h.textsTo(me.chat, m)).toContain('Bu qoralama endi faol emas — matningiz hech qayerga yozilmadi.');
  });

  it('a LIVE draft’s wait still takes the plain text (the check asks the draft, not the clock)', async () => {
    const { me, draftId } = await owner();
    await pressEdit(me, draftId);
    await h.handle(tg.text(me.chat, `Yuk yo‘lda ${STAMP}`));
    expect((await draftOf(draftId)).finalBody).toBe(`Yuk yo‘lda ${STAMP}`);
  });
});

/** A question the AI put to him on `me`'s account (`needs_owner`, raised by the model — the card offers ✍️). */
async function askOn(draftId: string): Promise<void> {
  await db.update(agentDrafts).set({ needsOwner: true, ownerQuestion: 'Suyuqlik olamizmi?' }).where(eq(agentDrafts.id, draftId));
}

/** ✍️ on the question's card; the prompt's own message id. */
async function pressAnswer(me: Person, draftId: string): Promise<number> {
  const m = h.mark();
  await h.handle(tg.callback(me.chat, nextMsg(), `ag:j:${draftId}`));
  const prompt = h.since(m).api.find((c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('✍️'));
  expect(prompt?.messageId, 'the ✍️ prompt was sent').toBeDefined();
  return prompt!.messageId!;
}

const answerOf = async (draftId: string) => ((await draftOf(draftId)).policy as { ownerAnswer?: { text: string } } | null)?.ownerAnswer?.text ?? null;
const answerJobs = () => vi.mocked(enqueue).mock.calls.filter((c) => c[0] === JOB_AGENT_OWNER_ANSWER);

describe('«✍️ Savolga javob» — his answer to the AI’s question, never his verbatim reply (spec SPEC-P1-v2 §2.2)', () => {
  beforeEach(() => vi.mocked(enqueue).mockClear());

  it('✍️ armed: a plain text is his ANSWER — stored on the question and queued, never the card’s body', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    await pressAnswer(me, draftId);
    await h.handle(tg.text(me.chat, `Ha, suyuqlik olmaymiz ${STAMP}`));
    expect(await answerOf(draftId)).toBe(`Ha, suyuqlik olmaymiz ${STAMP}`);
    expect((await draftOf(draftId)).finalBody).toBeNull();
    expect(answerJobs()).toHaveLength(1);
    // The job names the very bot message his answer was — the run's key, so a second answer is a second run.
    const stored = ((await draftOf(draftId)).policy as { ownerAnswer: { messageId: number } }).ownerAnswer.messageId;
    expect(stored).toBeGreaterThan(0);
    expect(answerJobs()[0]![1]).toMatchObject({ draftId, messageId: stored });
  });

  it('✍️ armed + a swipe-reply to the CARD is the answer', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    await pressAnswer(me, draftId);
    const card = await sentCopy(me, 'AgentDraft', { draftId });
    await h.handle(tg.text(me.chat, `Olmaymiz ${STAMP}`, { replyTo: card }));
    expect(await answerOf(draftId)).toBe(`Olmaymiz ${STAMP}`);
    expect((await draftOf(draftId)).finalBody).toBeNull();
  });

  it('✍️ armed + a swipe-reply to its PROMPT is the answer', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    const prompt = await pressAnswer(me, draftId);
    await h.handle(tg.text(me.chat, `Yo‘q, olmaymiz ${STAMP}`, { replyTo: prompt }));
    expect(await answerOf(draftId)).toBe(`Yo‘q, olmaymiz ${STAMP}`);
  });

  it('✏️ armed + a swipe-reply to the card stays his verbatim text — the ✏️ prompt’s promise', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    await pressEdit(me, draftId);
    const card = await sentCopy(me, 'AgentDraft', { draftId });
    await h.handle(tg.text(me.chat, `Kechirasiz, suyuq yuk olmaymiz ${STAMP}`, { replyTo: card }));
    expect((await draftOf(draftId)).finalBody).toBe(`Kechirasiz, suyuq yuk olmaymiz ${STAMP}`);
    expect(await answerOf(draftId)).toBeNull();
  });

  it('a phone in the answer is refused in words and the wait is KEPT — the next text is still the answer', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    await pressAnswer(me, draftId);
    const m = h.mark();
    await h.handle(tg.text(me.chat, 'Shu raqamga qo‘ng‘iroq qilsin: +998 90 123 45 67'));
    const [words] = h.textsTo(me.chat, m).filter((t) => t.startsWith('Manzil yoki telefonni ✏️ bilan yozing'));
    // …and the words name the very digits that were read as the phone.
    expect(words).toContain('«+998 90 123 45 67»');
    expect(await answerOf(draftId)).toBeNull();
    expect(readWait(BigInt(me.chat), 'agent_answer')).not.toBeNull();
    await h.handle(tg.text(me.chat, `Olmaymiz ${STAMP}`));
    expect(await answerOf(draftId)).toBe(`Olmaymiz ${STAMP}`);
  });

  /**
   * The review of 0148 as built (bot lens), through the handlers the server runs: §2.2 expects him to answer with
   * MONEY and DAYS, and each of these was refused «Manzil yoki telefonni ✏️ bilan yozing…» — nothing stored, nothing
   * queued, the wait kept, so every retry of the same shape heard the same sentence about a phone he never wrote.
   */
  it('a price range, a sum in so‘m, a date: each is his ANSWER — stored and queued, never «manzil yoki telefon»', async () => {
    const facts = [
      "Rastamojka taxminan 10000-12000 dollar bo'ladi",
      "Yetkazib berish 100 000 - 150 000 so'm",
      '9000-10000 dollar',
      "120 000 000 so'm",
      'Yuk 20.11.2026-25.11.2026 orasida keladi',
      'Yuk 15.11.2026 10:00 da keladi',
    ];
    for (const fact of facts) {
      vi.mocked(enqueue).mockClear();
      const { me, draftId } = await owner();
      await askOn(draftId);
      await pressAnswer(me, draftId);
      const m = h.mark();
      await h.handle(tg.text(me.chat, fact));
      expect(h.textsTo(me.chat, m).filter((t) => t.startsWith('Manzil yoki telefonni')), fact).toEqual([]);
      expect(h.textsTo(me.chat, m).some((t) => t.startsWith('✅ Javobingiz olindi')), fact).toBe(true);
      expect(await answerOf(draftId), fact).toBe(fact);
      expect(answerJobs(), fact).toHaveLength(1);
      expect(readWait(BigInt(me.chat), 'agent_answer'), fact).toBeNull();
    }
  });

  it('digits with no unit beside them are a phone’s shape: the words NAME what was read and how to say it — and the same fact with its unit is taken', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    await pressAnswer(me, draftId);
    const m = h.mark();
    await h.handle(tg.text(me.chat, 'Narxi 9000-10000'));
    const [words] = h.textsTo(me.chat, m).filter((t) => t.startsWith('Manzil yoki telefonni ✏️ bilan yozing'));
    expect(words).toContain('«9000-10000» telefon raqamiga o‘xshaydi');
    expect(words).toContain('birligi bilan yozing');
    expect(await answerOf(draftId)).toBeNull();
    expect(answerJobs()).toHaveLength(0);
    expect(readWait(BigInt(me.chat), 'agent_answer')).not.toBeNull();
    await h.handle(tg.text(me.chat, 'Narxi 9000-10000 dollar'));
    expect(await answerOf(draftId)).toBe('Narxi 9000-10000 dollar');
    expect(answerJobs()).toHaveLength(1);
  });

  it('a dead ✍️ wait (his own Telegram reply retired the question) lets a plain text through to the ladder', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    await pressAnswer(me, draftId);
    expect(await retireOnHumanReply(me.id, (await draftOf(draftId)).peerId, 2n)).toBe(1);
    const m = h.mark();
    await h.handle(tg.text(me.chat, `ZP${STAMP.slice(-5)}`));
    const texts = h.textsTo(me.chat, m);
    expect(texts.some((t) => t.includes(`Zinapoya mijoz ${STAMP}`))).toBe(true);
    expect(await answerOf(draftId)).toBeNull();
    expect(readWait(BigInt(me.chat), 'agent_answer')).toBeNull();
  });

  it('…and so does a ✍️ whose half hour ran out on the question while the bot still held the wait', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    await pressAnswer(me, draftId);
    await db
      .update(agentDrafts)
      .set({ policy: sql`jsonb_set(${agentDrafts.policy}, '{answering,until}', to_jsonb(${new Date(Date.now() - 1000).toISOString()}::text))` })
      .where(eq(agentDrafts.id, draftId));
    const m = h.mark();
    await h.handle(tg.text(me.chat, `ZP${STAMP.slice(-5)}`));
    expect(h.textsTo(me.chat, m).some((t) => t.includes(`Zinapoya mijoz ${STAMP}`))).toBe(true);
    expect(await answerOf(draftId)).toBeNull();
    expect(readWait(BigInt(me.chat), 'agent_answer')).toBeNull();
  });

  it('…and a swipe-reply to its prompt is told the answer was not taken', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    const prompt = await pressAnswer(me, draftId);
    await retireOnHumanReply(me.id, (await draftOf(draftId)).peerId, 2n);
    const m = h.mark();
    await h.handle(tg.text(me.chat, `Olmaymiz ${STAMP}`, { replyTo: prompt }));
    expect(h.textsTo(me.chat, m)).toContain('Savol endi faol emas — javobingiz yozilmadi.');
  });

  it('one agent wait at a time: ✍️ while ✏️ is armed on ANOTHER draft releases it, in words', async () => {
    const { me, draftId: edited } = await owner();
    const [other] = await db
      .insert(agentDrafts)
      .values({ managerUserId: me.id, peerId: BigInt(`${PREFIX}7${(peerSeq += 1)}`), clientId, anchorTgMessageId: 1n, proposedBody: 'Bilmayman.', status: 'pending', needsOwner: true, ownerQuestion: 'Suyuqlik?' })
      .returning({ id: agentDrafts.id });
    await pressEdit(me, edited);
    const m = h.mark();
    await pressAnswer(me, other!.id);
    expect((await draftOf(edited)).status).toBe('pending');
    expect(h.textsTo(me.chat, m).some((t) => t.startsWith('↩️ Oldingi kutish yopildi (✏️ javob matni)'))).toBe(true);
    expect(readWait(BigInt(me.chat), 'agent_edit')).toBeNull();
    expect(readWait(BigInt(me.chat), 'agent_answer')).not.toBeNull();
  });
});

describe('«✍️ Savolga javob» beside the other waits and presses (spec SPEC-P1-v2 §2.2)', () => {
  beforeEach(() => vi.mocked(enqueue).mockClear());

  it('✍️ while a task’s answer is awaited is refused in words like ✏️ — nothing armed, the question untouched', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    const giver = await person('sales_manager');
    const T = await handTask(me, giver);
    await h.handle(tg.callback(me.chat, nextMsg(), `t:${T}`));
    const m = h.mark();
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:j:${draftId}`));
    expect(h.textsTo(me.chat, m).some((t) => t.startsWith("Avval topshiriq bo'yicha so'ralgan javobni yozing"))).toBe(true);
    expect(readWait(BigInt(me.chat), 'agent_answer')).toBeNull();
    const d = await draftOf(draftId);
    expect(d.status).toBe('pending');
    expect(d.policy ?? {}).not.toHaveProperty('answering');
  });

  it('…and by a «Hisoblatish» collection that holds the chat', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    const c = BigInt(me.chat);
    startIntake(c, 'rastamojka', { staffId: me.id });
    updateIntake(c, { stage: 'material', material: ['Kurtka 300 dona'] }, { quiet: true });
    const m = h.mark();
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:j:${draftId}`));
    expect(h.textsTo(me.chat, m)).toContain('Avval boshlangan ishni tugating (hisoblatish, zametka yoki topshiriq).');
    expect(readWait(c, 'agent_answer')).toBeNull();
    expect((await draftOf(draftId)).status).toBe('pending');
    endIntake(c);
  });

  it('❌ on the question ends the ✍️ armed for it: his next plain text is no answer — it goes on down the ladder', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    await pressAnswer(me, draftId);
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:r:${draftId}`));
    expect((await draftOf(draftId)).status).toBe('rejected');
    expect(readWait(BigInt(me.chat), 'agent_answer')).toBeNull();
    const m = h.mark();
    await h.handle(tg.text(me.chat, `ZP${STAMP.slice(-5)}`));
    expect(h.textsTo(me.chat, m).some((t) => t.includes(`Zinapoya mijoz ${STAMP}`))).toBe(true);
    expect(await answerOf(draftId)).toBeNull();
    expect(answerJobs()).toHaveLength(0);
  });

  it('🙋 on the question ends it too', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    await pressAnswer(me, draftId);
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:h:${draftId}`));
    expect((await draftOf(draftId)).status).toBe('taken_over');
    expect(readWait(BigInt(me.chat), 'agent_answer')).toBeNull();
  });

  it('✏️ on the SAME question after ✍️: the wait changes hands in words, and his next text is his verbatim reply', async () => {
    const { me, draftId } = await owner();
    await askOn(draftId);
    await pressAnswer(me, draftId);
    expect((await draftOf(draftId)).policy).toHaveProperty('answering');
    const m = h.mark();
    await pressEdit(me, draftId);
    expect(h.textsTo(me.chat, m).some((t) => t.startsWith('↩️ Oldingi kutish yopildi (✍️ savolga javob)'))).toBe(true);
    expect((await draftOf(draftId)).policy).not.toHaveProperty('answering');
    expect(readWait(BigInt(me.chat), 'agent_answer')).toBeNull();
    await h.handle(tg.text(me.chat, `Kechirasiz, olmaymiz ${STAMP}`));
    expect((await draftOf(draftId)).finalBody).toBe(`Kechirasiz, olmaymiz ${STAMP}`);
    expect(await answerOf(draftId)).toBeNull();
    expect(answerJobs()).toHaveLength(0);
  });

  it('✏️ on ANOTHER draft while ✍️ waits: that question is handed back to him (pending), in words', async () => {
    const { me, draftId: asked } = await owner();
    await askOn(asked);
    const [other] = await db
      .insert(agentDrafts)
      .values({ managerUserId: me.id, peerId: BigInt(`${PREFIX}6${(peerSeq += 1)}`), clientId, anchorTgMessageId: 1n, proposedBody: 'Tekshirib aytaman.', status: 'pending' })
      .returning({ id: agentDrafts.id });
    await pressAnswer(me, asked);
    expect((await draftOf(asked)).status).toBe('editing');
    const m = h.mark();
    await pressEdit(me, other!.id);
    const back = await draftOf(asked);
    expect(back.status).toBe('pending');
    expect(back.policy).not.toHaveProperty('answering');
    expect(h.textsTo(me.chat, m).some((t) => t.startsWith('↩️ Oldingi kutish yopildi (✍️ savolga javob)'))).toBe(true);
    expect(readWait(BigInt(me.chat), 'agent_answer')).toBeNull();
  });

  it('a swipe-reply to ANOTHER draft’s card while ✍️ waits is that draft’s verbatim text — never this question’s answer', async () => {
    const { me, draftId: asked } = await owner();
    await askOn(asked);
    const [other] = await db
      .insert(agentDrafts)
      .values({ managerUserId: me.id, peerId: BigInt(`${PREFIX}5${(peerSeq += 1)}`), clientId, anchorTgMessageId: 1n, proposedBody: 'Tekshirib aytaman.', status: 'pending' })
      .returning({ id: agentDrafts.id });
    await pressAnswer(me, asked);
    const card = await sentCopy(me, 'AgentDraft', { draftId: other!.id });
    await h.handle(tg.text(me.chat, `Yuk yo‘lda ${STAMP}`, { replyTo: card }));
    expect((await draftOf(other!.id)).finalBody).toBe(`Yuk yo‘lda ${STAMP}`);
    expect(await answerOf(asked)).toBeNull();
    // …and the ✍️ still waits for its own answer.
    expect(readWait(BigInt(me.chat), 'agent_answer')).not.toBeNull();
  });

  it('a press from a chat that is not the question’s account answers «Topilmadi» — a callback can be forged', async () => {
    const { draftId } = await owner();
    await askOn(draftId);
    const stranger = await person('super_admin');
    const m = h.mark();
    await h.handle(tg.callback(stranger.chat, nextMsg(), `ag:j:${draftId}`));
    expect(h.since(m).api.some((c) => c.method === 'answerCallbackQuery' && String(c.payload.text) === 'Topilmadi')).toBe(true);
    expect(readWait(BigInt(stranger.chat), 'agent_answer')).toBeNull();
    expect((await draftOf(draftId)).status).toBe('pending');
  });
});

/** 📝 on the draft's card; the prompt's own message id. */
async function pressLesson(me: Person, draftId: string): Promise<number> {
  const m = h.mark();
  await h.handle(tg.callback(me.chat, nextMsg(), `ag:l:${draftId}`));
  const prompt = h.since(m).api.find((c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('📝'));
  expect(prompt?.messageId, 'the 📝 prompt was sent').toBeDefined();
  return prompt!.messageId!;
}

const lessonsOf = (me: Person) => db.select().from(agentLessons).where(eq(agentLessons.createdBy, me.id));
/** A rule with none of the chat's own words in it — the client here is «Zinapoya mijoz <stamp>», and a lesson naming any word of that is personal. */
const RULE = 'Salomga avval salom bilan javob ber, keyin bitta savol ber.';

type EchoButton = { text: string; callback_data: string };
/** The echo under a typed lesson, as the bot sent it since `m`: its message id and its two buttons. */
function echoSince(m: ReturnType<BotHarness['mark']>): { messageId: number; yes: EchoButton; no: EchoButton } {
  const echo = h.since(m).api.find((c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('📝 Saboq:'));
  expect(echo?.messageId, 'the lesson was echoed').toBeDefined();
  const [row] = (echo!.payload.reply_markup as { inline_keyboard: EchoButton[][] }).inline_keyboard;
  return { messageId: echo!.messageId!, yes: row![0]!, no: row![1]! };
}

describe('«📝 Tuzatish» — his lesson for the AI, never the customer’s words (spec SPEC-P1-v2 §3.1, §3.2)', () => {
  beforeEach(() => vi.mocked(enqueue).mockClear());

  it('📝 armed: a plain text is the LESSON — stored unconfirmed and echoed, never the card’s body; «✅ Saqlash» makes it count', async () => {
    const { me, draftId } = await owner();
    await pressLesson(me, draftId);
    expect(readWait(BigInt(me.chat), 'agent_lesson')).toMatchObject({ payload: { draftId } });
    const m = h.mark();
    await h.handle(tg.text(me.chat, RULE));
    expect((await draftOf(draftId)).finalBody).toBeNull();
    const [stored] = await lessonsOf(me);
    expect(stored).toMatchObject({ text: RULE, draftId, confirmedAt: null });
    expect(readWait(BigInt(me.chat), 'agent_lesson')).toBeNull();
    const echo = echoSince(m);
    expect(echo.yes).toEqual({ text: '✅ Saqlash', callback_data: `ag:y:${stored!.id}:${stored!.confirmToken}` });
    expect(echo.no).toEqual({ text: '✖ Bekor', callback_data: `ag:v:${stored!.id}` });
    // The yes: saved, said, and the echo's buttons close — nothing left to press there.
    const pressed = h.mark();
    await h.handle(tg.callback(me.chat, echo.messageId, echo.yes.callback_data));
    expect((await lessonsOf(me))[0]!.confirmedAt).not.toBeNull();
    expect(h.since(pressed).api.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
    expect(h.textsTo(me.chat, pressed).some((t) => t.startsWith('✅ Saboq saqlandi'))).toBe(true);
    // The draft was still waiting for his ✅: its rewrite is queued, named by the lesson.
    expect(answerJobs()).toHaveLength(1);
    expect(answerJobs()[0]![1]).toMatchObject({ draftId, lessonId: stored!.id });
    // A second tap on a button Telegram had not yet removed: said, never a second lesson or a second rewrite.
    const again = h.mark();
    await h.handle(tg.callback(me.chat, echo.messageId, echo.yes.callback_data));
    expect(h.since(again).api.some((c) => c.method === 'answerCallbackQuery' && String(c.payload.text) === 'Allaqachon saqlangan.')).toBe(true);
    expect(answerJobs()).toHaveLength(1);
    expect(await lessonsOf(me)).toHaveLength(1);
  });

  it('📝 armed + a swipe-reply to the CARD is the lesson — never his verbatim reply, one ✅ from the customer', async () => {
    const { me, draftId } = await owner();
    await pressLesson(me, draftId);
    const card = await sentCopy(me, 'AgentDraft', { draftId });
    await h.handle(tg.text(me.chat, RULE, { replyTo: card }));
    expect((await draftOf(draftId)).finalBody).toBeNull();
    expect(await lessonsOf(me)).toHaveLength(1);
  });

  it('📝 armed + a swipe-reply to its PROMPT is the lesson', async () => {
    const { me, draftId } = await owner();
    const prompt = await pressLesson(me, draftId);
    await h.handle(tg.text(me.chat, RULE, { replyTo: prompt }));
    expect((await draftOf(draftId)).finalBody).toBeNull();
    expect((await lessonsOf(me)).map((l) => l.text)).toEqual([RULE]);
  });

  it('…but a swipe-reply to ANOTHER draft’s card is that draft’s verbatim text — the lesson keeps waiting', async () => {
    const { me, draftId } = await owner();
    const [other] = await db
      .insert(agentDrafts)
      .values({ managerUserId: me.id, peerId: BigInt(`${PREFIX}9${(peerSeq += 1)}`), clientId, anchorTgMessageId: 1n, proposedBody: 'Boshqa javob.', status: 'pending' })
      .returning({ id: agentDrafts.id });
    await pressLesson(me, draftId);
    const card = await sentCopy(me, 'AgentDraft', { draftId: other!.id });
    await h.handle(tg.text(me.chat, `Ertaga aytaman ${STAMP}`, { replyTo: card }));
    expect((await draftOf(other!.id)).finalBody).toBe(`Ertaga aytaman ${STAMP}`);
    expect(await lessonsOf(me)).toHaveLength(0);
    expect(readWait(BigInt(me.chat), 'agent_lesson')).not.toBeNull();
  });

  it('a refused lesson (a price) is said in words and the wait is KEPT — the next text is still the lesson', async () => {
    const { me, draftId } = await owner();
    await pressLesson(me, draftId);
    const m = h.mark();
    await h.handle(tg.text(me.chat, 'Avia narxini 17 $ deb ayt'));
    // The words name the figure read as the price, and the way out for a number that is none (0148 fix).
    expect(h.textsTo(me.chat, m)).toContain(
      '«17» — Narx saboq bo‘lmaydi — narx vositalar va sozlamalardan keladi. Bu son narx bo‘lmasa — uni so‘z bilan yozing (masalan: «bir marta»).',
    );
    expect(await lessonsOf(me)).toHaveLength(0);
    expect(readWait(BigInt(me.chat), 'agent_lesson')).not.toBeNull();
    // A lesson ABOUT the price with a count in it is no price: echoed like any other (and dropped — one lesson below).
    const about = h.mark();
    await h.handle(tg.text(me.chat, 'Narx haqida 1 marta ayt, takrorlama'));
    expect(h.textsTo(me.chat, about).some((t) => t.startsWith('📝 Saboq: «Narx haqida 1 marta ayt, takrorlama»'))).toBe(true);
    await db.delete(agentLessons).where(eq(agentLessons.createdBy, me.id));
    await pressLesson(me, draftId);
    // …and so is the chat's own customer by ONE word of the name.
    const named = h.mark();
    await h.handle(tg.text(me.chat, 'Zinapoya bilan doim rus tilida gaplash'));
    expect(h.textsTo(me.chat, named).some((t) => t.includes('Matnda mijoz ma’lumoti bor'))).toBe(true);
    expect(readWait(BigInt(me.chat), 'agent_lesson')).not.toBeNull();
    await h.handle(tg.text(me.chat, RULE));
    expect((await lessonsOf(me)).map((l) => l.text)).toEqual([RULE]);
    expect((await draftOf(draftId)).finalBody).toBeNull();
  });

  it('«✖ Bekor» under the echo drops the lesson and closes the buttons', async () => {
    const { me, draftId } = await owner();
    await pressLesson(me, draftId);
    const m = h.mark();
    await h.handle(tg.text(me.chat, RULE));
    const echo = echoSince(m);
    const pressed = h.mark();
    await h.handle(tg.callback(me.chat, echo.messageId, echo.no.callback_data));
    expect(await lessonsOf(me)).toHaveLength(0);
    expect(h.since(pressed).api.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
    expect(h.since(pressed).api.some((c) => c.method === 'answerCallbackQuery' && String(c.payload.text) === '✖ Saboq saqlanmadi')).toBe(true);
    expect(answerJobs()).toHaveLength(0);
  });

  it('📝 while a task’s answer is awaited is refused in words like ✏️ — nothing armed; and by a collection that holds the chat', async () => {
    const { me, draftId } = await owner();
    const giver = await person('sales_manager');
    const T = await handTask(me, giver);
    await h.handle(tg.callback(me.chat, nextMsg(), `t:${T}`));
    const m = h.mark();
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:l:${draftId}`));
    expect(h.textsTo(me.chat, m).some((t) => t.startsWith("Avval topshiriq bo'yicha so'ralgan javobni yozing"))).toBe(true);
    expect(readWait(BigInt(me.chat), 'agent_lesson')).toBeNull();
    // The task's own answer still closes the task.
    await h.handle(tg.text(me.chat, `Bajarildi ${STAMP}`));
    expect(await statusOf(T)).toBe('done');
    const c = BigInt(me.chat);
    startIntake(c, 'rastamojka', { staffId: me.id });
    updateIntake(c, { stage: 'material', material: ['Kurtka 300 dona'] }, { quiet: true });
    const held = h.mark();
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:l:${draftId}`));
    expect(h.textsTo(me.chat, held)).toContain('Avval boshlangan ishni tugating (hisoblatish, zametka yoki topshiriq).');
    expect(readWait(c, 'agent_lesson')).toBeNull();
    endIntake(c);
    expect(await lessonsOf(me)).toHaveLength(0);
  });

  it('one agent wait at a time: 📝 while ✏️ is armed on ANOTHER draft closes it in words — his next text is the lesson', async () => {
    const { me, draftId } = await owner();
    const [other] = await db
      .insert(agentDrafts)
      .values({ managerUserId: me.id, peerId: BigInt(`${PREFIX}9${(peerSeq += 1)}`), clientId, anchorTgMessageId: 1n, proposedBody: 'Boshqa javob.', status: 'pending' })
      .returning({ id: agentDrafts.id });
    await pressEdit(me, other!.id);
    const m = h.mark();
    await pressLesson(me, draftId);
    expect(h.textsTo(me.chat, m).some((t) => t.startsWith('↩️ Oldingi kutish yopildi'))).toBe(true);
    expect(readWait(BigInt(me.chat), 'agent_edit')).toBeNull();
    expect(readWait(BigInt(me.chat), 'agent_lesson')).not.toBeNull();
    await h.handle(tg.text(me.chat, RULE));
    expect((await draftOf(other!.id)).finalBody).toBeNull();
    expect((await lessonsOf(me)).map((l) => l.text)).toEqual([RULE]);
  });

  it('a press from a chat that is not the draft’s account answers «Topilmadi» — a callback can be forged', async () => {
    const { draftId } = await owner();
    const stranger = await person('super_admin');
    const m = h.mark();
    await h.handle(tg.callback(stranger.chat, nextMsg(), `ag:l:${draftId}`));
    expect(h.since(m).api.some((c) => c.method === 'answerCallbackQuery' && String(c.payload.text) === 'Topilmadi')).toBe(true);
    expect(readWait(BigInt(stranger.chat), 'agent_lesson')).toBeNull();
  });

  it('👎 arms NOTHING: a plain «code» after it is the lookup’s — no lesson, no wait; «📝 Sababini yozish» is what arms', async () => {
    const { me, draftId } = await owner();
    const d = await draftOf(draftId);
    // A reply the machine pressed and sent — the only card 👎 is drawn on.
    await db.update(agentDrafts).set({ status: 'approved', decidedBy: me.id, decidedAt: new Date() }).where(eq(agentDrafts.id, draftId));
    await db.insert(agentAutoVerdicts).values({
      draftId,
      managerUserId: me.id,
      peerId: d.peerId,
      eligible: true,
      state: 'pressed',
      dueAt: new Date(Date.now() - 60_000),
      pressedAt: new Date(Date.now() - 30_000),
    });
    const m = h.mark();
    await h.handle(tg.callback(me.chat, nextMsg(), `ag:f:${draftId}`));
    const said = h.since(m).api.find((c) => c.method === 'sendMessage' && String(c.payload.text).includes('«📝 Sababini yozish»'));
    expect(said, '👎 answers with a sentence and a button').toBeDefined();
    const why = (said!.payload.reply_markup as { inline_keyboard: EchoButton[][] }).inline_keyboard[0]![0]!;
    expect(why).toEqual({ text: '📝 Sababini yozish', callback_data: `ag:l:${draftId}` });
    for (const kind of ['agent_lesson', 'agent_edit', 'agent_answer'] as const) expect(readWait(BigInt(me.chat), kind), kind).toBeNull();
    // His next, unrelated text: the client's code — answered by the staff lookup, and a rule in no prompt.
    const asked = h.mark();
    await h.handle(tg.text(me.chat, `ZP${STAMP.slice(-5)}`));
    expect(h.textsTo(me.chat, asked).some((t) => t.includes(`Zinapoya mijoz ${STAMP}`))).toBe(true);
    expect(h.textsTo(me.chat, asked).some((t) => t.startsWith('📝 Saboq:'))).toBe(false);
    expect(await lessonsOf(me)).toHaveLength(0);
    // The button is the same press as the card's 📝: only now is his next text a lesson.
    await h.handle(tg.callback(me.chat, said!.messageId!, why.callback_data));
    expect(readWait(BigInt(me.chat), 'agent_lesson')).toMatchObject({ payload: { draftId } });
    await h.handle(tg.text(me.chat, RULE));
    expect((await lessonsOf(me)).map((l) => l.text)).toEqual([RULE]);
  });
});

/**
 * «✅ Tarif to'g'ri» on the 14-day notice, through the handlers the server runs (review of 0148 as built, bot lens):
 * every outcome was a toast alone — gone in seconds — so nothing in the chat recorded that the China column was
 * vouched for, the notice kept its button, and «tarif o'zgardi»'s two-step instruction vanished with the toast.
 */
describe('«✅ Tarif to‘g‘ri» is answered where it stays (spec SPEC-P1-v2 §1.6)', () => {
  let caps: SendCaps = DEFAULT_SEND_CAPS;
  /** How many «✅ Tarif to‘g‘ri» confirmations the audit holds. */
  const tariffAudits = async () =>
    Number(
      (
        await db.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM audit_log WHERE entity_type = 'agent_send_caps' AND after->>'via' = 'tarif_togri'`,
        )
      )[0]!.n,
    );
  beforeAll(async () => {
    caps = await readSendCaps();
  });
  afterAll(async () => {
    await __restoreSendCaps(caps);
  });

  it('the holder’s press: a MESSAGE says the column is confirmed, the notice’s button goes, and the column is vouched for', async () => {
    const { me } = await owner();
    await db.update(agentSendCaps).set({ tariffConfirmedAt: null }).where(eq(agentSendCaps.id, 1));
    const stamp = await currentTariffFingerprint();
    const notice = await sentCopy(me, 'AgentTariffNotice', { holderId: me.id, fingerprint: stamp });
    const m = h.mark();
    await h.handle(tg.callback(me.chat, notice, `ag:t:${me.id}:${stamp}`));
    expect(h.textsTo(me.chat, m).some((t) => t.startsWith('✅ Xitoy tarifi tasdiqlandi'))).toBe(true);
    expect(h.since(m).api.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
    expect((await readSendCaps()).tariffConfirmedAt).not.toBeNull();
  });

  // Fix pass 3 (the check's nit): the confirmation became a MESSAGE and nothing kept it once — the same update
  // delivered again, or another tap on the same notice, said «tasdiqlandi» again and wrote another audit row for one
  // decision. A column already vouched for since its last change answers the toast alone.
  it('a repeated press — the update delivered again, or another tap — says it once and writes one audit row', async () => {
    const { me } = await owner();
    await db.update(agentSendCaps).set({ tariffConfirmedAt: null }).where(eq(agentSendCaps.id, 1));
    const stamp = await currentTariffFingerprint();
    const notice = await sentCopy(me, 'AgentTariffNotice', { holderId: me.id, fingerprint: stamp });
    const auditsBefore = await tariffAudits();
    const m = h.mark();
    const press = tg.callback(me.chat, notice, `ag:t:${me.id}:${stamp}`);
    await h.handle(press);
    const first = (await readSendCaps()).tariffConfirmedAt;
    await h.handle(tg.again(press));
    await h.handle(tg.callback(me.chat, notice, `ag:t:${me.id}:${stamp}`));
    expect(h.textsTo(me.chat, m).filter((t) => t.startsWith('✅ Xitoy tarifi tasdiqlandi'))).toHaveLength(1);
    expect((await readSendCaps()).tariffConfirmedAt).toEqual(first);
    expect((await tariffAudits()) - auditsBefore).toBe(1);
  });

  it('a column written since the notice: the instruction is a MESSAGE too, nothing is confirmed and the button stays', async () => {
    const { me } = await owner();
    await db.update(agentSendCaps).set({ tariffConfirmedAt: null }).where(eq(agentSendCaps.id, 1));
    const notice = await sentCopy(me, 'AgentTariffNotice', { holderId: me.id, fingerprint: '00000000' });
    const m = h.mark();
    await h.handle(tg.callback(me.chat, notice, `ag:t:${me.id}:00000000`));
    expect(h.textsTo(me.chat, m)).toContain('Tarif xabardan keyin o‘zgardi — «/admin/tarif»ni qayta ko‘rib, «Suhbatlar → AI sotuvchi» sahifasida tasdiqlang.');
    expect(h.since(m).api.some((c) => c.method === 'editMessageReplyMarkup')).toBe(false);
    expect((await readSendCaps()).tariffConfirmedAt).toBeNull();
  });
});

describe('a forward is never the typed answer (I2 c)', () => {
  it('a forwarded customer message with ✏️ live is offered as a task, the draft untouched', async () => {
    const { me, draftId } = await owner();
    await pressEdit(me, draftId);
    const m = h.mark();
    await h.handle(tg.forward(me.chat, `mijoz yozdi ${STAMP}`));
    // The burst's ONE offer is drawn once its debounce settles (docs/IKKI-ESHIK.md §4.1).
    await h.settle();
    expect((await draftOf(draftId)).finalBody).toBeNull();
    expect(h.textsTo(me.chat, m)).toContain('📌 Topshiriq qilamizmi?');
    expect(readWait(BigInt(me.chat), 'agent_edit')).not.toBeNull();
  });
});

describe('«/agent» from a chat that is not staff (I4)', () => {
  /** The command alone, with one handler after it standing for whatever comes next (the cabinet). */
  function commandOnly(): { bot: Bot; reached: number[] } {
    const bot = new Bot('7000002:TEST', { botInfo: { id: 7_000_002, is_bot: true, first_name: 'GSR', username: 'gsr_cmd_bot' } as never });
    bot.api.config.use(async () => ({ ok: true, result: { message_id: 1, date: 0, chat: { id: 0, type: 'private' } } }) as never);
    const reached: number[] = [];
    registerAgentCommand(bot);
    bot.on('message:text', (ctx) => {
      reached.push(ctx.chat.id);
    });
    return { bot, reached };
  }

  it('is passed on to the next handler — a customer’s chat is the cabinet’s, never a dead end', async () => {
    const { bot, reached } = commandOnly();
    const chat = nextChat();
    await bot.handleUpdate(tg.command(chat, 'agent', 'off'));
    expect(reached).toEqual([chat]);
  });

  it('a staff chat is answered by the command and goes no further', async () => {
    const { bot, reached } = commandOnly();
    const me = await person('sales_manager');
    await bot.handleUpdate(tg.command(me.chat, 'agent'));
    expect(reached).toEqual([]);
  });
});
