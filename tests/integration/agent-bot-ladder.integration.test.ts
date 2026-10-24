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
import { db, pgClient } from '@/modules/platform/db/client';
import {
  agentConfig,
  agentDrafts,
  clients,
  notifications,
  roles,
  tasks,
  telegramLinks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { createTask } from '@/modules/platform/tasks/service';
import { registerAgentCommand } from '@/modules/platform/telegram/agent-bot';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import { __forgetWaitMemory, flushWaitWrites, readWait } from '@/modules/platform/telegram/waits';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { __resetBacklog } from '@/modules/platform/telegram/backlog';
import { __resetDrafts } from '@/modules/platform/telegram/task-draft';
import { readAgentConfig, __restoreAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
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
});

afterAll(async () => {
  await flushWaitWrites();
  h.restore();
  await __restoreAgentConfig(snapshot);
  await db.delete(agentDrafts).where(eq(agentDrafts.clientId, clientId));
  await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
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
});

describe('a forward is never the typed answer (I2 c)', () => {
  it('a forwarded customer message with ✏️ live is offered as a task, the draft untouched', async () => {
    const { me, draftId } = await owner();
    await pressEdit(me, draftId);
    const m = h.mark();
    await h.handle(tg.forward(me.chat, `mijoz yozdi ${STAMP}`));
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
