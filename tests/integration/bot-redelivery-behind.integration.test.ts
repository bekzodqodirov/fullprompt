import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A server one migration behind (Q5 a, judge T2): on deploy morning the code
 * is up before 0130 lands (#472). The readiness probe is its own module so
 * ONE mock turns both the keys and the waits into «not yet» — the test
 * database HAS the tables, only the probe says no — and the bot must then do
 * exactly what it did before this round: answer, ask, forward, with no key
 * written, no wait written, and never a 42P01 on the poller. Its own file,
 * because the mock is file-wide.
 */
vi.mock('@/modules/platform/telegram/redelivery-ready', () => ({ redeliveryReady: async () => false }));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => {}),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import { clients, clientTelegramLinks, notifications, roles, tasks, telegramLinks, userRoles, users } from '@/modules/platform/db/schema';
import { createTask } from '@/modules/platform/tasks/service';
import { __resetLifecycle } from '@/modules/platform/telegram/lifecycle';
import { __forgetWaitMemory, __waitWriteCount, flushWaitWrites, setDurableWaits } from '@/modules/platform/telegram/waits';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { peekTaskPending } from '@/modules/platform/telegram/staff-bot';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';

const STAMP = String(Date.now()).slice(-7);
const PREFIX = `96${STAMP}`;
let chatSeq = 0;
let phoneSeq = 0;
let msgSeq = 800_000;
const nextChat = () => Number(`${PREFIX}${String((chatSeq += 1)).padStart(2, '0')}`);
const madeUsers: string[] = [];
const madeTasks: string[] = [];
const madeClients: string[] = [];
let h: BotHarness;

async function person(): Promise<{ id: string; chat: number }> {
  phoneSeq += 1;
  const [u] = await db
    .insert(users)
    .values({ phone: `+99896${STAMP}${String(phoneSeq).padStart(2, '0')}`, fullName: `Orqada ${STAMP}-${phoneSeq}`, passwordHash: 'x', active: true })
    .returning({ id: users.id });
  madeUsers.push(u!.id);
  const r = await db.query.roles.findFirst({ where: eq(roles.code, 'sales_manager') });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  const chat = nextChat();
  await db.insert(telegramLinks).values({ userId: u!.id, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  return { id: u!.id, chat };
}

async function count(userId: string, type: string): Promise<number> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, type)));
  return rows.length;
}

beforeAll(() => {
  __resetLifecycle();
  __resetPresses();
  __forgetWaitMemory();
  setDurableWaits(true);
  h = botHarness();
});

afterAll(async () => {
  await flushWaitWrites();
  setDurableWaits(false);
  h.restore();
  await db.execute(sql`DELETE FROM telegram_once WHERE key LIKE ${`m:${PREFIX}%`} OR key LIKE ${`q:${PREFIX}%`}`);
  await db.execute(sql`DELETE FROM telegram_chat_waits WHERE chat_id::text LIKE ${`${PREFIX}%`}`);
  await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
  if (madeTasks.length) await db.delete(tasks).where(inArray(tasks.id, madeTasks));
  if (madeClients.length) {
    await db.delete(clientTelegramLinks).where(inArray(clientTelegramLinks.clientId, madeClients));
    await db.delete(clients).where(inArray(clients.id, madeClients));
  }
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, madeUsers));
  await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  await pgClient.end();
});

describe('I25 — 0130 not in yet: the bot behaves exactly as before the round', () => {
  it('a swipe-reply, a customer message and a «💬 Savol» wait all work, and nothing is keyed or written', async () => {
    const author = await person();
    const holder = await person();
    const task = await createTask(
      { title: `Orqada ${STAMP}`, note: '', typeId: null, assigneeId: holder.id, dueAt: '', priority: 2, entityType: null, entityId: null, repeatUnit: null, repeatEvery: 1 },
      { actorId: author.id, ip: null, userAgent: 'bot-redelivery-behind' },
      { origin: 'hand' },
    );
    madeTasks.push(task.id);

    // I1's swipe-reply, once.
    const copy = (msgSeq += 1);
    await db.insert(notifications).values({
      userId: holder.id,
      channel: 'telegram',
      type: 'TaskAssigned',
      status: 'sent',
      sentAt: new Date(),
      payload: { text: 'x', taskId: task.id, origin: 'hand', tg: { chatId: holder.chat, messageId: copy } },
    });
    await h.handle(tg.text(holder.chat, `qachongacha? ${STAMP}`, { replyTo: copy }));

    // I6's customer text, once.
    const [c] = await db
      .insert(clients)
      .values({ clientCode: `OR${STAMP.slice(-4)}${(phoneSeq += 1)}`, name: `Orqada mijoz ${STAMP}`, phones: [], salesManagerId: author.id })
      .returning({ id: clients.id });
    madeClients.push(c!.id);
    const customerChat = nextChat();
    await db.insert(clientTelegramLinks).values({ clientId: c!.id, telegramChatId: BigInt(customerChat), status: 'linked', linkedAt: new Date() });
    await h.handle(tg.text(customerChat, `Yukim qayerda? ${STAMP}`));

    // A «💬 Savol» press and its question — the wait from memory alone.
    await h.handle(tg.callback(holder.chat, (msgSeq += 1), `tq:${task.id}`));
    expect(peekTaskPending(BigInt(holder.chat))).toMatchObject({ kind: 'question', taskId: task.id });
    await h.handle(tg.text(holder.chat, `qaysi mijoz? ${STAMP}`));
    await h.settle();

    expect(await count(author.id, 'TaskQuestion')).toBe(2);
    expect(await count(author.id, 'ClientBotMessage')).toBe(1);
    const keys = await db.execute(sql`SELECT 1 FROM telegram_once WHERE key LIKE ${`m:${PREFIX}%`} OR key LIKE ${`q:${PREFIX}%`}`);
    expect(keys).toHaveLength(0);
    expect(__waitWriteCount()).toBe(0);
    const waits = await db.execute(sql`SELECT 1 FROM telegram_chat_waits WHERE chat_id::text LIKE ${`${PREFIX}%`}`);
    expect(waits).toHaveLength(0);
  });
});
