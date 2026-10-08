import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Q5 a against a real database, through the bot the server runs (the owner,
 * 2026-10-07: «O'rnatish paytida botga Telegramda yozilgan javoblar — bot
 * qayta yoqilganda qayta ishlansin»).
 *
 * The bot keeps what Telegram held while no process polled, so every update
 * here is one of three shapes: LATE (handled after a deploy), REPEATED (the
 * same button tapped again into a bot that was not there — its own update)
 * or TWICE (a crash redelivers the batch it was in). Each case is driven
 * through `registerBotHandlers` — the server's own chain — by the harness,
 * with no network; the job queue is stood in for so a queued row is SEEN
 * and never drained.
 *
 * Everything is this file's own: users with run-unique phones and chat ids
 * starting `97<stamp>`, tasks, leads, clients and their links. Users are
 * DEACTIVATED in cleanup, never deleted (audit FK). The AI key is removed for
 * the file, so a red proof that reaches the tail meets «Topilmadi» and never
 * a real model call (judge T18).
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => {}),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  clients,
  clientTelegramLinks,
  crmActivities,
  leadIntakes,
  leadStages,
  leads,
  notifications,
  roles,
  tasks,
  telegramLinks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { createTask } from '@/modules/platform/tasks/service';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import {
  __forgetWaitMemory,
  __holdWaitWrites,
  flushWaitWrites,
  hydrateWaits,
  nowSec,
  setDurableWaits,
} from '@/modules/platform/telegram/waits';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { __resetBacklog, BACKLOG_SENTENCE, HANDLED_SENTENCE } from '@/modules/platform/telegram/backlog';
import { BUGUN, peekTaskPending, TASK_ANSWERS, TOPSHIRIQ } from '@/modules/platform/telegram/staff-bot';
import { pruneTelegramRedelivery } from '@/modules/platform/telegram/once';
import { activeIntake, endIntake } from '@/modules/platform/telegram/calc-intake';
import { __resetDrafts } from '@/modules/platform/telegram/task-draft';
import { beginClientLink } from '@/modules/platform/telegram/client-cabinet';
import { clientLabels } from '@/modules/platform/telegram/client-labels';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';

const STAMP = String(Date.now()).slice(-7);
/** Every chat id this file mints starts here — the cleanup's own prefix. */
const PREFIX = `97${STAMP}`;
let chatSeq = 0;
let phoneSeq = 0;
let msgSeq = 700_000;
const nextChat = () => Number(`${PREFIX}${String((chatSeq += 1)).padStart(2, '0')}`);
const nextMsg = () => (msgSeq += 1);
const ctx = (id: string) => ({ actorId: id, ip: null, userAgent: 'bot-redelivery.integration' });
const STALE = {
  error_code: 400,
  description: 'Bad Request: query is too old and response timeout expired or query ID is invalid',
};

const madeUsers: string[] = [];
const madeTasks: string[] = [];
const madeLeads: string[] = [];
const madeClients: string[] = [];
let openStage = '';
let savedAiKey: string | undefined;
let h: BotHarness;

interface Person {
  id: string;
  name: string;
  phone: string;
  chat: number;
}

/** A colleague the bot knows — or, with `linked: false`, one it has never met. */
async function person(
  role: string | null = 'sales_manager',
  opts: { linked?: boolean; active?: boolean; loginEnabled?: boolean } = {},
): Promise<Person> {
  phoneSeq += 1;
  const phone = `+99897${STAMP}${String(phoneSeq).padStart(2, '0')}`;
  const name = `Qayta ${STAMP}-${phoneSeq}`;
  const loginEnabled = opts.loginEnabled ?? true;
  const [u] = await db
    .insert(users)
    .values({
      phone,
      fullName: name,
      passwordHash: loginEnabled ? 'x' : null,
      active: opts.active ?? true,
      loginEnabled,
    })
    .returning({ id: users.id });
  madeUsers.push(u!.id);
  if (role) {
    const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
    await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  }
  const chat = nextChat();
  if (opts.linked !== false) {
    await db.insert(telegramLinks).values({ userId: u!.id, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  }
  return { id: u!.id, name, phone, chat };
}

/** A task's giver and its holder, both on Telegram. */
async function pair(): Promise<{ a: Person; s: Person }> {
  return { a: await person(), s: await person() };
}

async function handTask(assignee: Person, author: Person, title: string): Promise<string> {
  const task = await createTask(
    {
      title: `${title} ${STAMP}`,
      note: '',
      typeId: null,
      assigneeId: assignee.id,
      dueAt: '',
      priority: 2,
      entityType: null,
      entityId: null,
      repeatUnit: null,
      repeatEvery: 1,
    },
    ctx(author.id),
    { origin: 'hand' },
  );
  madeTasks.push(task.id);
  return task.id;
}

/** A copy the drain SENT to `who` — its `payload.tg` is what a swipe-reply names. */
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

async function lead(owner: Person): Promise<string> {
  const [row] = await db
    .insert(leads)
    .values({ name: `Qayta lid ${STAMP} ${nextMsg()}`, stageId: openStage, ownerId: owner.id })
    .returning({ id: leads.id });
  madeLeads.push(row!.id);
  return row!.id;
}

async function client(manager: Person | null, phones: string[] = []): Promise<{ id: string; code: string }> {
  const code = `QR${STAMP.slice(-4)}${(phoneSeq += 1)}`;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: code, name: `Qayta mijoz ${STAMP}`, phones, salesManagerId: manager?.id ?? null })
    .returning({ id: clients.id });
  madeClients.push(c!.id);
  return { id: c!.id, code };
}

/** A customer's chat, linked to a client whose manager will hear it. */
async function customer(): Promise<{ chat: number; manager: Person; clientId: string; code: string }> {
  const manager = await person();
  const c = await client(manager);
  const chat = nextChat();
  await db.insert(clientTelegramLinks).values({ clientId: c.id, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  return { chat, manager, clientId: c.id, code: c.code };
}

async function count(who: Person, type: string): Promise<number> {
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.userId, who.id), eq(notifications.type, type)));
  return rows.length;
}

async function textsOf(who: Person, type: string): Promise<string[]> {
  const rows = await db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.userId, who.id), eq(notifications.type, type)));
  return rows.map((r) => String((r.payload as Record<string, unknown>).text ?? ''));
}

async function audits(taskId: string, action: string): Promise<number> {
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'task'), eq(auditLog.entityId, taskId), eq(auditLog.action, action)));
  return rows.length;
}

async function statusOf(taskId: string): Promise<string> {
  const [row] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
  return row!.status;
}

async function waitRows(chat: number): Promise<{ kind: string; payload: unknown; armed_at: string; expires_at: string }[]> {
  return db.execute(sql`
    SELECT kind, payload, armed_at::text AS armed_at, expires_at::text AS expires_at
      FROM telegram_chat_waits WHERE chat_id = ${String(chat)}::bigint`);
}

async function aiQuestions(who: Person): Promise<number> {
  const rows = await db.execute(sql`SELECT 1 FROM ai_questions WHERE user_id = ${who.id}::uuid`);
  return rows.length;
}

/** The toasts of every press answered after `m`, in order. */
function toasts(m: { api: number; sent: number }): (string | undefined)[] {
  return h
    .since(m)
    .api.filter((c) => c.method === 'answerCallbackQuery')
    .map((c) => c.payload.text as string | undefined);
}

beforeAll(async () => {
  savedAiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  openStage = (await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'open')).limit(1))[0]!.id;
  setDurableWaits(true);
  h = botHarness();
});

beforeEach(() => {
  __resetLifecycle();
  __forgetWaitMemory();
  __resetPresses();
  __resetBacklog();
  __resetDrafts();
});

afterEach(async () => {
  // A failed assertion must not leave backlog mode on for the next case (judge T15).
  markBoot(new Date(0));
  h.setClock(null);
  await h.settle();
});

afterAll(async () => {
  await flushWaitWrites();
  setDurableWaits(false);
  h.restore();
  if (savedAiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAiKey;
  // The thread announces run off the poller — let them land before the sweep.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await db.execute(sql`DELETE FROM telegram_once WHERE key LIKE ${`m:${PREFIX}%`} OR key LIKE ${`q:${PREFIX}%`}`);
  await db.execute(sql`DELETE FROM telegram_chat_waits WHERE chat_id::text LIKE ${`${PREFIX}%`}`);
  const intakes = await db
    .select({ id: leadIntakes.id, leadId: leadIntakes.leadId })
    .from(leadIntakes)
    .where(and(eq(leadIntakes.channel, 'telegram'), sql`${leadIntakes.externalId} LIKE ${`tg:${PREFIX}%`}`));
  const inboundLeads = intakes.map((i) => i.leadId).filter((id): id is string => Boolean(id));
  const allLeads = [...madeLeads, ...inboundLeads];
  if (intakes.length) await db.delete(leadIntakes).where(inArray(leadIntakes.id, intakes.map((i) => i.id)));
  await db.execute(sql`DELETE FROM crm_activities WHERE tg_chat_id::text LIKE ${`${PREFIX}%`}`);
  if (allLeads.length) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, allLeads));
    await db.execute(
      sql`DELETE FROM notifications WHERE payload ->> 'leadId' IN (${sql.join(allLeads.map((id) => sql`${id}`), sql`, `)})`,
    );
  }
  await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
  await db.execute(sql`DELETE FROM thread_reads WHERE user_id IN (${sql.join(madeUsers.map((id) => sql`${id}::uuid`), sql`, `)})`);
  if (madeTasks.length) await db.delete(tasks).where(inArray(tasks.id, madeTasks));
  if (allLeads.length) await db.delete(leads).where(inArray(leads.id, allLeads));
  if (madeClients.length) {
    await db.delete(clientTelegramLinks).where(inArray(clientTelegramLinks.clientId, madeClients));
    await db.delete(clients).where(inArray(clients.id, madeClients));
  }
  await db.execute(sql`DELETE FROM client_telegram_links WHERE telegram_chat_id::text LIKE ${`${PREFIX}%`}`);
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, madeUsers));
  await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  await pgClient.end();
});

describe('TWICE — a crash redelivers what already ran', () => {
  it('I1 a swipe-reply to a task copy asks its giver ONCE; the redelivery hears «already done»', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I1');
    const copy = await sentCopy(s, 'TaskAssigned', { taskId: T, origin: 'hand' });
    const update = tg.text(s.chat, `qachongacha? ${STAMP}`, { replyTo: copy });
    await h.handle(update);
    const m = h.mark();
    await h.handle(tg.again(update));
    expect(await audits(T, 'comment')).toBe(1);
    expect(await count(a, 'TaskQuestion')).toBe(1);
    expect(h.textsTo(s.chat, m)).toEqual([TASK_ANSWERS.already_done]);
  });

  it('I2 a swipe-reply to the giver’s TaskQuestion copy answers ONCE', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I2');
    const copy = await sentCopy(a, 'TaskQuestion', { taskId: T });
    const update = tg.text(a.chat, `ertaga ${STAMP}`, { replyTo: copy });
    await h.handle(update);
    await h.handle(tg.again(update));
    expect(await audits(T, 'comment')).toBe(1);
    expect(await count(s, 'TaskAnswer')).toBe(1);
  });

  it('I3 the in-transaction key on its own: a wait that answers twice asks once', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I3');
    await h.handle(tg.callback(s.chat, nextMsg(), `tq:${T}`));
    await flushWaitWrites();
    const [armed] = await waitRows(s.chat);
    expect(armed?.kind).toBe('task');
    const question = tg.text(s.chat, `qaysi mijoz? ${STAMP}`);
    await h.handle(question);
    await flushWaitWrites();
    expect(await count(a, 'TaskQuestion')).toBe(1);
    // A state the delete-before-effect order makes unreachable, kept so the
    // key is pinned by itself: the wait row back, a restart, the same text.
    await db.execute(sql`
      INSERT INTO telegram_chat_waits (chat_id, kind, payload, armed_at, expires_at)
      VALUES (${String(s.chat)}::bigint, 'task', ${JSON.stringify(armed!.payload)}::jsonb,
              ${armed!.armed_at}::timestamptz, ${armed!.expires_at}::timestamptz)`);
    __forgetWaitMemory();
    await hydrateWaits();
    const m = h.mark();
    await h.handle(tg.again(question));
    expect(await count(a, 'TaskQuestion')).toBe(1);
    expect(await audits(T, 'comment')).toBe(1);
    expect(h.textsTo(s.chat, m)).toEqual([TASK_ANSWERS.already_done]);
  });

  it('I3a crash AFTER the wait’s delete: the redelivered question is told it was answered, never «send it again»', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I3a');
    await h.handle(tg.callback(s.chat, nextMsg(), `tq:${T}`));
    const question = tg.text(s.chat, `necha kub? ${STAMP}`);
    await h.handle(question);
    await flushWaitWrites();
    __forgetWaitMemory();
    markBoot(new Date(Date.now() + 60_000));
    const m = h.mark();
    await h.handle(tg.again(question));
    expect(h.textsTo(s.chat, m)).toEqual([HANDLED_SENTENCE]);
    expect(await count(a, 'TaskQuestion')).toBe(1);
  });

  it('I3b the same for a RESULT: the task closes once, the redelivery hears «answered»', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I3b');
    await h.handle(tg.callback(s.chat, nextMsg(), `t:${T}`));
    const result = tg.text(s.chat, `tayyor ${STAMP}`);
    await h.handle(result);
    await flushWaitWrites();
    expect(await statusOf(T)).toBe('done');
    __forgetWaitMemory();
    markBoot(new Date(Date.now() + 60_000));
    const m = h.mark();
    await h.handle(tg.again(result));
    expect(h.textsTo(s.chat, m)).toEqual([HANDLED_SENTENCE]);
    expect(await statusOf(T)).toBe('done');
    expect(await count(a, 'TaskDone')).toBe(1);
  });

  it('I3c a consumed wait’s DELETE is awaited before its effect runs', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I3c');
    await h.handle(tg.callback(s.chat, nextMsg(), `tq:${T}`));
    await flushWaitWrites();
    const release = __holdWaitWrites();
    let settled = false;
    let handling: Promise<void> | null = null;
    try {
      handling = h.handle(tg.text(s.chat, `qachon? ${STAMP}`)).then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      expect(await count(a, 'TaskQuestion')).toBe(0);
    } finally {
      release();
    }
    await handling;
    await flushWaitWrites();
    expect(await count(a, 'TaskQuestion')).toBe(1);
    expect(await waitRows(s.chat)).toHaveLength(0);
  });

  it('I4 the same ⏰ press delivered twice moves the task once', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I4');
    const press = tg.callback(s.chat, nextMsg(), `tp:e:${T}`);
    await h.handle(press);
    const m = h.mark();
    await h.handle(tg.again(press));
    const moves = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, T), eq(auditLog.action, 'update'), sql`${auditLog.after} ->> 'via' = 'telegram'`));
    expect(moves).toHaveLength(1);
    expect(await count(a, 'TaskRescheduled')).toBe(1);
    expect(toasts(m)).toEqual([TASK_ANSWERS.already_done]);
  });

  it('I4b two taps on ONE ⏰ message — two callback ids, both answered — move the task once', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I4b');
    const asked = nextMsg();
    await h.handle(tg.callback(s.chat, asked, `tp:e:${T}`));
    const m = h.mark();
    await h.handle(tg.callback(s.chat, asked, `tp:w:${T}`));
    const moves = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.entityId, T), eq(auditLog.action, 'update'), sql`${auditLog.after} ->> 'via' = 'telegram'`));
    expect(moves).toHaveLength(1);
    expect(await count(a, 'TaskRescheduled')).toBe(1);
    expect(toasts(m)).toEqual([TASK_ANSWERS.already_done]);
  });

  it('I5 «📤» tapped twice on one copy forwards the sources once', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I5');
    await db.update(tasks).set({ sourceMessages: [{ chatId: a.chat, messageId: 11 }] }).where(eq(tasks.id, T));
    const copy = nextMsg();
    await h.handle(tg.callback(a.chat, copy, `tf:${T}`));
    await h.handle(tg.callback(a.chat, copy, `tf:${T}`));
    expect(await count(s, 'TaskSources')).toBe(1);
  });

  it('I5b «🔍 Qidirish» tapped twice on one offer searches once', async () => {
    const s = await person();
    const forward = tg.forward(s.chat, `bu nima ${STAMP}`);
    const m0 = h.mark();
    await h.handle(forward);
    const offer = h.since(m0).api.find((c) => c.method === 'sendMessage' && c.payload.text === '📌 Topshiriq qilamizmi?');
    expect(offer?.messageId, 'the «📌» offer').toBeDefined();
    const original = (forward as unknown as { message: Record<string, unknown> }).message;
    const search = () => tg.callback(s.chat, offer!.messageId!, 'fb:search', { message: { reply_to_message: original } });
    const m1 = h.mark();
    await h.handle(search());
    const first = h.textsTo(s.chat, m1);
    const m2 = h.mark();
    await h.handle(search());
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/^Topilmadi\./);
    expect(h.textsTo(s.chat, m2)).toEqual(['Bu qidiruv allaqachon bajarilgan.']);
    expect(await aiQuestions(s)).toBe(0);
  });

  it('I6 a customer’s message delivered twice reaches the manager once, acknowledged once', async () => {
    const c = await customer();
    const update = tg.text(c.chat, `Yukim qachon keladi? ${STAMP}`);
    await h.handle(update);
    await h.handle(tg.again(update));
    await h.settle();
    expect(await count(c.manager, 'ClientBotMessage')).toBe(1);
    // «✅ … yetkazildi: <manager>» — the ack names the manager.
    const acks = h.textsTo(c.chat).filter((t) => t.includes(c.manager.name));
    expect(acks).toHaveLength(1);
  });

  it('I6b eleven redeliveries of one message spend one slot — the NEXT message is not throttled', async () => {
    const c = await customer();
    const message = tg.text(c.chat, `M ${STAMP}`);
    for (let i = 0; i < 11; i += 1) await h.handle(tg.again(message));
    await h.handle(tg.text(c.chat, `N ${STAMP}`));
    await h.settle();
    const texts = await textsOf(c.manager, 'ClientBotMessage');
    expect(texts.filter((t) => t.includes(`«N ${STAMP}»`))).toHaveLength(1);
  });
});

describe('LATE — counted and dated by when it was WRITTEN', () => {
  it('I7 twelve messages over three hours are twelve windows; eleven in one minute hit the cap', async () => {
    const outage = await customer();
    const now = nowSec();
    for (let i = 0; i < 12; i += 1) {
      await h.handle(tg.text(outage.chat, `soat ${i} ${STAMP}`, { date: now - 3 * 3600 + i * 15 * 60 }));
    }
    const burst = await customer();
    for (let i = 0; i < 11; i += 1) {
      await h.handle(tg.text(burst.chat, `daqiqa ${i} ${STAMP}`, { date: now - 30 }));
    }
    await h.settle();
    expect(await count(outage.manager, 'ClientBotMessage')).toBe(12);
    expect(await count(burst.manager, 'ClientBotMessage')).toBe(10);
  });

  it('I8 a customer message written two hours ago says when; one written a minute ago does not', async () => {
    const c = await customer();
    await h.handle(tg.text(c.chat, `eski ${STAMP}`, { date: nowSec() - 2 * 3600 }));
    await h.handle(tg.text(c.chat, `yangi ${STAMP}`, { date: nowSec() - 60 }));
    const texts = await textsOf(c.manager, 'ClientBotMessage');
    expect(texts.find((t) => t.includes(`eski ${STAMP}`))).toContain('🕒 Yozilgan:');
    expect(texts.find((t) => t.includes(`yangi ${STAMP}`))).not.toContain('🕒 Yozilgan:');
  });

  it('I23 a late Telegram reply is filed at the time WRITTEN, and a late E4 question says when', async () => {
    const { a, s } = await pair();
    const L = await lead(s);
    const ping = await sentCopy(s, 'InternalNote', { thread: { kind: 'lead', id: L, activityId: randomUUID() } });
    const written = nowSec() - 2 * 3600;
    const reply = tg.text(s.chat, `kech javob ${STAMP}`, { replyTo: ping, date: written });
    await h.handle(reply);
    const incoming = (reply as unknown as { message: { message_id: number } }).message.message_id;
    const [note] = await db.execute<{ at: string }>(sql`
      SELECT extract(epoch FROM happened_at)::bigint::text AS at FROM crm_activities
       WHERE tg_chat_id = ${String(s.chat)}::bigint AND tg_message_id = ${incoming}`);
    expect(note, 'the reply landed').toBeDefined();
    expect(Math.abs(Number(note!.at) - written)).toBeLessThanOrEqual(1);

    const T = await handTask(s, a, 'I23');
    const copy = await sentCopy(s, 'TaskAssigned', { taskId: T, origin: 'hand' });
    await h.handle(tg.text(s.chat, `kech savol ${STAMP}`, { replyTo: copy, date: written }));
    const [asked] = await textsOf(a, 'TaskQuestion');
    expect(asked).toContain('🕒 Yozilgan:');
  });

  it('I9 an advert visit survives a restart, and a redelivered contact lands one enquiry', async () => {
    const chat = nextChat();
    await h.handle(tg.command(chat, 'start', 'ad_tiktok'));
    await flushWaitWrites();
    __forgetWaitMemory();
    await hydrateWaits();
    const phone = `+99833${STAMP}${String((phoneSeq += 1)).padStart(2, '0')}`;
    const contact = tg.contact(chat, phone);
    const m = h.mark();
    await h.handle(contact);
    await h.handle(tg.again(contact));
    await h.settle();
    const t = clientLabels(null);
    const said = h.textsTo(chat, m);
    expect(said).toEqual([t.adThanks, t.adThanks]);
    const messageId = (contact as unknown as { message: { message_id: number } }).message.message_id;
    const intakes = await db
      .select({ id: leadIntakes.id, leadId: leadIntakes.leadId })
      .from(leadIntakes)
      .where(and(eq(leadIntakes.channel, 'telegram'), eq(leadIntakes.externalId, `tg:${chat}:${messageId}`)));
    expect(intakes).toHaveLength(1);
    expect(intakes[0]!.leadId).not.toBeNull();
  });

  it('I9b a contact pressed before the late prompt still answers its visit (expiry only)', async () => {
    const chat = nextChat();
    const t0 = nowSec();
    h.setClock(t0 + 30);
    await h.handle(tg.command(chat, 'start', 'ad_tiktok'));
    const m = h.mark();
    await h.handle(tg.contact(chat, `+99833${STAMP}${String((phoneSeq += 1)).padStart(2, '0')}`, { date: t0 + 10 }));
    expect(h.textsTo(chat, m)).toEqual([clientLabels(null).adThanks]);
  });

  it('I9c a press handled twice keeps the EARLIEST prompt’s time — the answer to the first is never «early»', async () => {
    const { s } = await pair();
    const a = await person();
    const T = await handTask(s, a, 'I9c');
    const t0 = nowSec();
    h.setClock(t0);
    const press = tg.callback(s.chat, nextMsg(), `t:${T}`);
    await h.handle(press);
    await flushWaitWrites();
    __forgetWaitMemory();
    await hydrateWaits();
    markBoot(new Date((t0 + 20) * 1000));
    h.setClock(t0 + 30);
    await h.handle(tg.again(press));
    await h.handle(tg.text(s.chat, `tayyor ${STAMP}`, { date: t0 + 10 }));
    expect(await statusOf(T)).toBe('done');
  });
});

describe('B5 and B8 — the link doors', () => {
  it('I10 a /start for a client with no phone, delivered twice, warns the minter once', async () => {
    const minter = await person();
    const c = await client(null, []);
    const code = `c-q5-${STAMP}-${nextMsg()}`;
    await db.insert(clientTelegramLinks).values({ clientId: c.id, linkCode: code, status: 'pending', createdBy: minter.id });
    const chat = nextChat();
    const start = tg.command(chat, 'start', code);
    await h.handle(start);
    await h.handle(tg.again(start));
    await h.settle();
    expect(await count(minter, 'CabinetLinkAlert')).toBe(1);
  });

  it('I12 /start <staff code> for somebody who cannot log in links nothing and says why', async () => {
    for (const who of [await person(null, { linked: false, active: false }), await person(null, { linked: false, loginEnabled: false })]) {
      const code = `q5-${STAMP}-${nextMsg()}`;
      await db.insert(telegramLinks).values({ userId: who.id, linkCode: code, status: 'pending' });
      const auditBefore = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, who.id));
      const chat = nextChat();
      const m = h.mark();
      await h.handle(tg.command(chat, 'start', code));
      expect(h.textsTo(chat, m)).toEqual(['Bu hodim akkaunti faol emas — Telegram ulanmadi. Adminga ayting.']);
      const [row] = await db.select().from(telegramLinks).where(eq(telegramLinks.userId, who.id));
      expect(row).toMatchObject({ status: 'pending', telegramChatId: null, linkCode: code });
      const auditAfter = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, who.id));
      expect(auditAfter).toHaveLength(auditBefore.length);
    }
  });

  it('I13 a redelivered «Hodim» contact says «Ulandi» again and never reaches the cabinet', async () => {
    const who = await person(null, { linked: false });
    const chat = who.chat;
    await h.handle(tg.callback(chat, nextMsg(), 'e:s'));
    const contact = tg.contact(chat, who.phone);
    await h.handle(contact);
    const [link] = await db.select().from(telegramLinks).where(eq(telegramLinks.userId, who.id));
    expect(link).toMatchObject({ status: 'linked', telegramChatId: BigInt(chat) });
    markBoot(new Date(Date.now() + 60_000));
    const m = h.mark();
    await h.handle(tg.again(contact));
    await h.settle();
    expect(h.textsTo(chat, m)).toEqual([`✅ Ulandi: ${who.name}. Xabarnomalar shu yerga keladi.`]);
    const cabinet = await db
      .select({ id: clientTelegramLinks.id })
      .from(clientTelegramLinks)
      .where(eq(clientTelegramLinks.telegramChatId, BigInt(chat)));
    expect(cabinet).toHaveLength(0);
    const since = h.since(m);
    expect(JSON.stringify(since.api)).not.toContain('remove_keyboard');
    expect(JSON.stringify(since.sent)).not.toContain('remove_keyboard');
  });

  it('I13b a staff chat’s backlog contact for a pending CABINET link still links the client', async () => {
    const who = await person();
    const c = await client(null, [who.phone]);
    const code = `c-q5b-${STAMP}-${nextMsg()}`;
    await db.insert(clientTelegramLinks).values({ clientId: c.id, linkCode: code, status: 'pending', createdBy: who.id });
    expect(await beginClientLink(code, who.chat)).toBe('ask_phone');
    await flushWaitWrites();
    __forgetWaitMemory();
    await hydrateWaits();
    markBoot(new Date(Date.now() + 60_000));
    const m = h.mark();
    await h.handle(tg.contact(who.chat, who.phone));
    await h.settle();
    const [linked] = await db
      .select({ status: clientTelegramLinks.status })
      .from(clientTelegramLinks)
      .where(and(eq(clientTelegramLinks.clientId, c.id), eq(clientTelegramLinks.telegramChatId, BigInt(who.chat))));
    expect(linked?.status).toBe('linked');
    expect(h.textsTo(who.chat, m).some((t) => t.startsWith('✅ Ulandi:'))).toBe(false);
  });
});

describe('A LATE PRESS — Telegram refuses its answer, the work still runs', () => {
  it('I14a answer-first: a late «💬 Savol» still sends its prompt and arms its wait', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I14a');
    h.failNext('answerCallbackQuery', STALE);
    const m = h.mark();
    await h.handle(tg.callback(s.chat, nextMsg(), `tq:${T}`));
    expect(h.textsTo(s.chat, m)).toEqual(['💬 Savolingizni yozing:']);
    expect(peekTaskPending(BigInt(s.chat))).toMatchObject({ kind: 'question', taskId: T });
  });

  it('I14b act-first: a late «✅ Natijasiz» closes the task and SAYS the toast Telegram refused', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I14b');
    h.failNext('answerCallbackQuery', STALE);
    const m = h.mark();
    await h.handle(tg.callback(s.chat, nextMsg(), `tn:${T}`));
    expect(await statusOf(T)).toBe('done');
    expect(h.textsTo(s.chat, m)).toEqual(['✅ Vazifa yopildi']);
  });
});

describe('the BACKLOG — what nobody this process asked for', () => {
  it('I15 a backlog text the lookups cannot answer gets the sentence once, and never the AI', async () => {
    const s = await person();
    markBoot();
    const boot = nowSec();
    const m = h.mark();
    await h.handle(tg.text(s.chat, 'bu nima edi', { date: boot - 60 }));
    await h.handle(tg.text(s.chat, 'yana bir narsa', { date: boot - 50 }));
    expect(h.textsTo(s.chat, m)).toEqual([BACKLOG_SENTENCE]);
    expect(await aiQuestions(s)).toBe(0);
  });

  it('I16 a backlog staff photo with no collector is told the sentence, not silence', async () => {
    const s = await person();
    markBoot();
    const m = h.mark();
    await h.handle(tg.photo(s.chat, { date: nowSec() - 60 }));
    expect(h.textsTo(s.chat, m)).toEqual([BACKLOG_SENTENCE]);
  });

  it('I17 a backlog text written before a durable wait’s prompt does not answer it; a later one does', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I17');
    const B = nowSec();
    markBoot(new Date(B * 1000));
    h.setClock(B + 30);
    await h.handle(tg.callback(s.chat, nextMsg(), `t:${T}`));
    await flushWaitWrites();
    __forgetWaitMemory();
    await hydrateWaits();
    const m = h.mark();
    await h.handle(tg.text(s.chat, `hali emas ${STAMP}`, { date: B - 60 }));
    expect(h.textsTo(s.chat, m)).toEqual([BACKLOG_SENTENCE]);
    expect(await statusOf(T)).toBe('open');
    await flushWaitWrites();
    expect(await waitRows(s.chat)).toHaveLength(1);
    await h.handle(tg.text(s.chat, `tayyor ${STAMP}`, { date: B + 40 }));
    await flushWaitWrites();
    expect(await statusOf(T)).toBe('done');
    expect(await waitRows(s.chat)).toHaveLength(0);
  });

  it('I17b a LIVE text processed after a late press answers it, though it predates the prompt', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I17b');
    const B = nowSec() - 120;
    markBoot(new Date(B * 1000));
    h.setClock(B + 60);
    await h.handle(tg.callback(s.chat, nextMsg(), `t:${T}`));
    const m = h.mark();
    await h.handle(tg.text(s.chat, `bo‘ldi ${STAMP}`, { date: B + 40 }));
    expect(await statusOf(T)).toBe('done');
    expect(h.textsTo(s.chat, m)).not.toContain(BACKLOG_SENTENCE);
    expect(await aiQuestions(s)).toBe(0);
  });

  it('I18a two backlog «📋 Bugun» are answered once', async () => {
    const s = await person();
    markBoot();
    const m = h.mark();
    await h.handle(tg.text(s.chat, BUGUN, { date: nowSec() - 60 }));
    await h.handle(tg.text(s.chat, BUGUN, { date: nowSec() - 50 }));
    const sent = h.since(m).sent.filter((c) => c.method === 'sendMessage' && Number(c.body.chat_id) === s.chat);
    expect(sent).toHaveLength(1);
  });

  it('I18b a customer’s two backlog /start are one greeting', async () => {
    const c = await customer();
    markBoot();
    const m = h.mark();
    await h.handle(tg.command(c.chat, 'start', '', { date: nowSec() - 60 }));
    await h.handle(tg.command(c.chat, 'start', '', { date: nowSec() - 50 }));
    await h.settle();
    expect(h.textsTo(c.chat, m).filter((t) => t.includes(c.code))).toHaveLength(1);
  });

  it('I18c two «📷» taps on one message, the first answered late: one photo send, no «yuborilmoqda» message', async () => {
    const c = await customer();
    const lot = randomUUID();
    const pressed = nextMsg();
    const m = h.mark();
    h.failNext('answerCallbackQuery', STALE);
    await h.handle(tg.callback(c.chat, pressed, `ph:${lot}`));
    await h.settle();
    await h.handle(tg.callback(c.chat, pressed, `ph:${lot}`));
    await h.settle();
    const t = clientLabels(null);
    const said = h.textsTo(c.chat, m);
    expect(said.filter((text) => text === t.noPhotos)).toHaveLength(1);
    expect(said.filter((text) => text === t.photoSending)).toHaveLength(0);
  });

  it('I18d two «👨‍💼 Menejer» taps on one message, the first answered late: one manager card', async () => {
    const c = await customer();
    const pressed = nextMsg();
    h.failNext('answerCallbackQuery', STALE);
    const m = h.mark();
    await h.handle(tg.callback(c.chat, pressed, 'mg'));
    await h.settle();
    await h.handle(tg.callback(c.chat, pressed, 'mg'));
    await h.settle();
    expect(h.textsTo(c.chat, m)).toHaveLength(1);
  });

  it('I19 a backlog swipe-reply to the copy whose ✅ was pressed late is no question to the giver', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I19');
    const copy = await sentCopy(s, 'TaskAssigned', { taskId: T, origin: 'hand' });
    const B = nowSec();
    markBoot(new Date(B * 1000));
    h.setClock(B + 30);
    await h.handle(tg.callback(s.chat, copy, `t:${T}`));
    const m = h.mark();
    await h.handle(tg.text(s.chat, `Bajarildi, yuk ketdi ${STAMP}`, { replyTo: copy, date: B - 30 }));
    expect(await count(a, 'TaskQuestion')).toBe(0);
    expect(await statusOf(T)).toBe('open');
    expect(peekTaskPending(BigInt(s.chat), B + 40)).toMatchObject({ kind: 'result', taskId: T });
    expect(h.textsTo(s.chat, m)).toEqual([BACKLOG_SENTENCE]);
  });

  it('I20 a backlog swipe-reply lands on its card whatever collector a late press opened', async () => {
    const s = await person();
    const L = await lead(s);
    const ping = await sentCopy(s, 'InternalNote', { thread: { kind: 'lead', id: L, activityId: randomUUID() } });
    markBoot();
    const B = nowSec();
    await h.handle(tg.text(s.chat, TOPSHIRIQ, { date: B - 60 }));
    const reply = tg.text(s.chat, `klient rozi ${STAMP}`, { replyTo: ping, date: B - 50 });
    const m = h.mark();
    await h.handle(reply);
    const incoming = (reply as unknown as { message: { message_id: number } }).message.message_id;
    const notes = await db.execute(sql`
      SELECT 1 FROM crm_activities WHERE tg_chat_id = ${String(s.chat)}::bigint AND tg_message_id = ${incoming}`);
    expect(notes).toHaveLength(1);
    expect(h.textsTo(s.chat, m).some((t) => t.includes('topilmadi'))).toBe(false);
  });

  it('I20b a calc intake a late press opened takes no backlog text', async () => {
    const s = await person();
    markBoot();
    const B = nowSec();
    try {
      await h.handle(tg.callback(s.chat, nextMsg(), 'c:rastamojka'));
      expect(activeIntake(BigInt(s.chat))).toMatchObject({ stage: 'client', clientHintRaw: '' });
      const m = h.mark();
      await h.handle(tg.text(s.chat, `mijoz qwe ${STAMP}`, { date: B - 60 }));
      // Still asking for the client: the backlog text was not filed as one.
      expect(activeIntake(BigInt(s.chat))).toMatchObject({ stage: 'client', clientHintRaw: '' });
      expect(h.textsTo(s.chat, m)).toEqual([BACKLOG_SENTENCE]);
    } finally {
      endIntake(BigInt(s.chat));
    }
  });

  it('I21 three backlog forwards are one sentence and no «📌» offer', async () => {
    const s = await person();
    markBoot();
    const B = nowSec();
    const m = h.mark();
    for (let i = 0; i < 3; i += 1) await h.handle(tg.forward(s.chat, `mijoz xabari ${i} ${STAMP}`, { date: B - 60 + i }));
    const said = h.textsTo(s.chat, m);
    expect(said).toEqual([BACKLOG_SENTENCE]);
    expect(said.filter((t) => t === '📌 Topshiriq qilamizmi?')).toHaveLength(0);
  });
});

describe('the prune', () => {
  it('I24 drops a key past three days and a wait expired past a day — nothing younger', async () => {
    const young = `m:${PREFIX}91:1:ask`;
    const old = `m:${PREFIX}92:1:ask`;
    await db.execute(sql`
      INSERT INTO telegram_once (key, created_at) VALUES
        (${young}, now() - interval '2 days'), (${old}, now() - interval '4 days')`);
    const fresh = nextChat();
    const stale = nextChat();
    await db.execute(sql`
      INSERT INTO telegram_chat_waits (chat_id, kind, payload, armed_at, expires_at) VALUES
        (${String(fresh)}::bigint, 'task', '{}'::jsonb, now() - interval '23 hours 10 minutes', now() - interval '23 hours'),
        (${String(stale)}::bigint, 'task', '{}'::jsonb, now() - interval '25 hours 10 minutes', now() - interval '25 hours')`);
    await pruneTelegramRedelivery();
    const keys = await db.execute<{ key: string }>(sql`SELECT key FROM telegram_once WHERE key IN (${young}, ${old})`);
    expect(keys.map((k) => k.key)).toEqual([young]);
    expect(await waitRows(fresh)).toHaveLength(1);
    expect(await waitRows(stale)).toHaveLength(0);
  });
});
