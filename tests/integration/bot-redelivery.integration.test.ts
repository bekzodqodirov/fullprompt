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
  attachments,
  auditLog,
  clients,
  clientTelegramLinks,
  crmActivities,
  leadIntakes,
  leadStages,
  leads,
  notifications,
  receiptLots,
  receipts,
  roles,
  tasks,
  telegramLinks,
  userRoles,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { createTask } from '@/modules/platform/tasks/service';
import {
  __resetLifecycle,
  bootedAtSec,
  lastDoneUpdateId,
  markBoot,
  stoppingGuard,
  stopTelegramBot,
} from '@/modules/platform/telegram/lifecycle';
import {
  __forgetWaitMemory,
  __holdWaitWrites,
  flushWaitWrites,
  hydrateWaits,
  nowSec,
  readWait,
  setDurableWaits,
} from '@/modules/platform/telegram/waits';
import { __resetPresses } from '@/modules/platform/telegram/press';
import {
  __resetBacklog,
  BACKLOG_SENTENCE,
  BACKLOG_SENTENCE_KEPT,
  HANDLED_SENTENCE,
} from '@/modules/platform/telegram/backlog';
import { BUGUN, peekTaskPending, TASK_ANSWERS, TOPSHIRIQ } from '@/modules/platform/telegram/staff-bot';
import { pruneTelegramRedelivery } from '@/modules/platform/telegram/once';
import { activeIntake, endIntake } from '@/modules/platform/telegram/calc-intake';
import {
  __forgetIntakeMemory,
  __intakeWriteCount,
  __setIntakeWriteHook,
  flushBeforeConfirm,
  hydrateIntakes,
  INTAKE_CONFIRM_FLUSH_MS,
  markIntakesHydrated,
  oldestUnwrittenUpdate,
  setDurableIntakes,
  updateIntake,
} from '@/modules/platform/telegram/calc-store';
import { PAUSE_LINE, orphanAnswerSentence } from '@/modules/platform/telegram/calc-dialog';
import { botStopDeps } from '@/modules/platform/telegram/bot';
import { logger } from '@/modules/platform/logger';
import { __resetDrafts, activeDraft } from '@/modules/platform/telegram/task-draft';
import { __setCabinetPhotoReadMs, beginClientLink } from '@/modules/platform/telegram/client-cabinet';
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
const madeReceipts: string[] = [];
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
  await db.execute(sql`DELETE FROM attachments WHERE storage_key LIKE ${`q5-stall/${PREFIX}%`}`);
  if (madeReceipts.length) {
    await db.delete(receiptLots).where(inArray(receiptLots.receiptId, madeReceipts));
    await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  }
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

  it('I9d the first wait ran out by the clock before the restart’s re-tap: its answer, dated inside it, still closes the task (Q5-2)', async () => {
    const { s } = await pair();
    const a = await person();
    const T = await handTask(s, a, 'I9d');
    const now = nowSec();
    const t0 = now - 1_200; // the first prompt; its wait expired at t0 + 600 = now − 600
    h.setClock(t0);
    const press = tg.callback(s.chat, nextMsg(), `t:${T}`);
    await h.handle(press);
    await flushWaitWrites();
    __forgetWaitMemory();
    await hydrateWaits();
    markBoot(new Date(now * 1000));
    h.setClock(now);
    await h.handle(tg.again(press));
    await h.handle(tg.text(s.chat, `tayyor ${STAMP}`, { date: t0 + 180 }));
    await flushWaitWrites();
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
    const [row] = await db
      .insert(clientTelegramLinks)
      .values({ clientId: c.id, linkCode: code, status: 'pending', createdBy: who.id })
      .returning({ id: clientTelegramLinks.id });
    expect(await beginClientLink(code, who.chat)).toBe('ask_phone');
    await flushWaitWrites();
    __forgetWaitMemory();
    await hydrateWaits();
    markBoot(new Date(Date.now() + 60_000));
    const m = h.mark();
    await h.handle(tg.contact(who.chat, who.phone));
    await h.settle();
    // THE MINTED ROW is the one linked, through the hydrated cabinet_link wait
    // (Q5-4): the self-service phone door would also leave «a linked row for
    // this client and chat» — but as a SECOND row, beside the code still pending.
    const rows = await db
      .select({
        id: clientTelegramLinks.id,
        status: clientTelegramLinks.status,
        chat: clientTelegramLinks.telegramChatId,
        code: clientTelegramLinks.linkCode,
      })
      .from(clientTelegramLinks)
      .where(eq(clientTelegramLinks.clientId, c.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: row!.id, status: 'linked', chat: BigInt(who.chat), code: null });
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

  it('I17c a wait the clock expired during the deploy is hydrated and answered by a backlog text dated inside its window (Q5-5)', async () => {
    const { a, s } = await pair();
    const T = await handTask(s, a, 'I17c');
    const now = nowSec();
    h.setClock(now - 700); // the prompt at now−700, TTL 600: expired at now−100
    await h.handle(tg.callback(s.chat, nextMsg(), `t:${T}`));
    await flushWaitWrites();
    __forgetWaitMemory();
    markBoot(new Date(now * 1000));
    await hydrateWaits();
    await h.handle(tg.text(s.chat, `tayyor ${STAMP}`, { date: now - 200 }));
    await flushWaitWrites();
    expect(await statusOf(T)).toBe('done');
  });

  it('I17d …and a wait that expired past the reach (a day) is not hydrated at all', async () => {
    const chat = nextChat();
    await db.execute(sql`
      INSERT INTO telegram_chat_waits (chat_id, kind, payload, armed_at, expires_at) VALUES
        (${String(chat)}::bigint, 'task', '{}'::jsonb, now() - interval '25 hours 10 minutes', now() - interval '25 hours')`);
    __forgetWaitMemory();
    await hydrateWaits();
    expect(readWait(chat, 'task')).toBeNull();
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

describe('a stalled photo read — the chat’s queue moves on (Q5-1)', () => {
  it('I26 a «📷» whose storage never answers costs the photos, once, and the «📦» asked after it is answered', async () => {
    const c = await customer();
    const [wh] = await db.select({ id: warehouses.id }).from(warehouses).limit(1);
    const [receipt] = await db
      .insert(receipts)
      .values({
        warehouseId: wh!.id,
        clientId: c.clientId,
        status: 'confirmed',
        createdBy: c.manager.id,
        confirmedAt: new Date(),
        confirmedBy: c.manager.id,
      })
      .returning({ id: receipts.id });
    madeReceipts.push(receipt!.id);
    const [lot] = await db
      .insert(receiptLots)
      .values({ receiptId: receipt!.id, seq: 1, productNameZh: '测试', boxCount: 1, totalWeightKg: '1.000', totalVolumeM3: '0.0100' })
      .returning({ id: receiptLots.id });
    // Two photographs: the second must never be waited for once the first was late.
    const keys = [1, 2].map((i) => `q5-stall/${PREFIX}-${i}.jpg`);
    await db.insert(attachments).values(
      keys.map((storageKey) => ({
        entityType: 'receipt_lot',
        entityId: lot!.id,
        kind: 'photo',
        storageKey,
        fileName: 'p.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1_000,
        uploadedBy: c.manager.id,
      })),
    );
    // A MinIO that keeps the connection open and sends nothing.
    const storage = getStorage();
    const realGet = storage.get.bind(storage);
    const asked: string[] = [];
    storage.get = (key: string) => {
      if (!keys.includes(key)) return realGet(key);
      asked.push(key);
      return new Promise<Buffer>(() => {});
    };
    __setCabinetPhotoReadMs(50);
    try {
      const t = clientLabels(null);
      const m = h.mark();
      await h.handle(tg.callback(c.chat, nextMsg(), `ph:${lot!.id}`));
      await h.handle(tg.text(c.chat, t.btnCargo));
      await h.settle();
      const said = h.textsTo(c.chat, m);
      expect(said[0]).toBe(t.photoError);
      // …and the «📦» asked AFTER the 📷 was answered — the queue moved on.
      expect(said.length).toBeGreaterThan(1);
      expect(asked).toEqual([keys[0]]);
    } finally {
      storage.get = realGet;
      __setCabinetPhotoReadMs(null);
    }
  }, 10_000);
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

describe('the durable «Hisoblatish» collection (docs/SAKKIZ-R3.md §6, his 1.8 c)', () => {
  /** The collection's note ids this block made — their attachments go in cleanup. */
  const notesMade: string[] = [];
  /** Hangs every grammy send into one chat while `on` — an update kept IN FLIGHT. */
  const hang = { on: false, chat: 0, gate: new Promise<void>(() => {}) };

  beforeAll(() => {
    setDurableIntakes(true);
    h.bot.api.config.use(async (prev, method, payload, signal) => {
      const chat = Number((payload as { chat_id?: unknown } | undefined)?.chat_id ?? 0);
      if (hang.on && chat === hang.chat && (method === 'editMessageText' || method === 'sendMessage')) {
        hang.on = false;
        await hang.gate;
      }
      return prev(method, payload, signal);
    });
  });
  afterEach(async () => {
    __setIntakeWriteHook(null);
    hang.on = false;
    for (const id of [...(await db.execute<{ chat_id: string }>(sql`
      SELECT chat_id::text AS chat_id FROM telegram_calc_intakes WHERE chat_id::text LIKE ${`${PREFIX}%`}`))]) {
      endIntake(BigInt(id.chat_id));
    }
    __forgetIntakeMemory();
    await db.execute(sql`DELETE FROM telegram_calc_intakes WHERE chat_id::text LIKE ${`${PREFIX}%`}`);
  });
  afterAll(async () => {
    setDurableIntakes(false);
    if (notesMade.length) await db.delete(attachments).where(inArray(attachments.entityId, notesMade));
  });

  /** A colleague's collection, opened by the press and past the customer question: stage material. */
  async function collecting(): Promise<{ s: Person; chat: bigint; prompt: number }> {
    const s = await person();
    await h.handle(tg.callback(s.chat, nextMsg(), 'c:rastamojka'));
    const m = h.mark();
    await h.handle(tg.text(s.chat, `Ali ${STAMP} +99890${STAMP}`));
    const chat = BigInt(s.chat);
    const state = activeIntake(chat)!;
    expect(state.stage).toBe('material');
    notesMade.push(state.noteId);
    const prompt = h
      .since(m)
      .api.filter((c) => c.method === 'sendMessage' && JSON.stringify(c.payload.reply_markup ?? '').includes('c:done'))
      .at(-1)!.messageId!;
    return { s, chat, prompt };
  }

  /** A restart, as far as the collections are concerned: memory gone, a later boot, the table restored. */
  async function restart(bootAt = new Date(Date.now() + 2_000)): Promise<number> {
    await h.settle();
    __forgetIntakeMemory();
    __resetLifecycle();
    __resetPresses();
    __resetBacklog();
    markBoot(bootAt);
    await hydrateIntakes();
    markIntakesHydrated();
    return bootedAtSec();
  }

  const attachmentsOf = async (noteId: string) =>
    (await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.entityId, noteId))).length;
  const asksSecondInvoice = (m: ReturnType<BotHarness['mark']>) =>
    h.since(m).api.some((c) => JSON.stringify(c.payload.reply_markup ?? '').includes('c:inv_add'));

  it('a collection survives a restart: a backlog text written into it is its material, never the backlog sentence', async () => {
    const { chat, s } = await collecting();
    await h.handle(tg.text(s.chat, `Kurtka 300 dona ${STAMP}`));
    const boot = await restart();
    expect(activeIntake(chat)?.material).toContain(`Kurtka 300 dona ${STAMP}`);
    const m = h.mark();
    await h.handle(tg.text(s.chat, `Shim 200 dona ${STAMP}`, { date: boot - 1 }));
    expect(activeIntake(chat)?.material).toEqual([`Kurtka 300 dona ${STAMP}`, `Shim 200 dona ${STAMP}`]);
    expect(h.textsTo(s.chat, m)).not.toContain(BACKLOG_SENTENCE);
    expect(h.textsTo(s.chat, m)).not.toContain(BACKLOG_SENTENCE_KEPT);
  });

  it('a redelivered update is applied once — one line, one file, one attachment, no «second invoice» (durability-1, regression-6)', async () => {
    const { chat, s } = await collecting();
    const fileId = `doc-${STAMP}-a`;
    h.serveFile(fileId, Buffer.from('Tovar,Soni,Vazni kg\nKurtka,300,150\n'));
    const text = tg.text(s.chat, `Shim 200 dona ${STAMP}`);
    const doc = tg.document(s.chat, fileId, { fileName: 'invoice.csv', mime: 'text/csv' });
    await h.handle(text);
    await h.handle(doc);
    const noteId = activeIntake(chat)!.noteId;
    expect(activeIntake(chat)!.fileCount).toBe(1);
    await restart();
    const m = h.mark();
    await h.handle(tg.again(text));
    await h.handle(tg.again(doc));
    const state = activeIntake(chat)!;
    expect(state.material.filter((t) => t === `Shim 200 dona ${STAMP}`)).toHaveLength(1);
    expect(state.fileCount).toBe(1);
    expect(await attachmentsOf(noteId)).toBe(1);
    expect(asksSecondInvoice(m)).toBe(false);
  });

  it('a crash-lost write is redone, and the redone file finds its attachment — no second row', async () => {
    const { chat, s } = await collecting();
    await h.settle();
    const fileId = `doc-${STAMP}-b`;
    h.serveFile(fileId, Buffer.from('Tovar,Soni\nKurtka,300\n'));
    const doc = tg.document(s.chat, fileId, { fileName: 'invoice.csv', mime: 'text/csv' });
    await h.handle(doc);
    const noteId = activeIntake(chat)!.noteId;
    // The crash comes before the write's second of quiet: the row is the state before the file.
    __forgetIntakeMemory();
    __resetLifecycle();
    markBoot(new Date(Date.now() + 2_000));
    await hydrateIntakes();
    markIntakesHydrated();
    expect(activeIntake(chat)!.fileCount).toBe(0);
    await h.handle(tg.again(doc));
    expect(activeIntake(chat)!.fileCount).toBe(1);
    expect(await attachmentsOf(noteId)).toBe(1);
  });

  it('a parked collection does not swallow the chat; a reply to its own message brings it back (regression-1)', async () => {
    const { chat, s, prompt } = await collecting();
    const park = () => updateIntake(chat, { touchedAt: Date.now() - 31 * 60_000 }, { quiet: true });
    park();
    const touched = activeIntake(chat)!.touchedAt;
    const material = activeIntake(chat)!.material;
    let m = h.mark();
    await h.handle(tg.text(s.chat, 'GS777'));
    expect(h.textsTo(s.chat, m).length).toBeGreaterThan(0);
    expect(activeIntake(chat)!.material).toEqual(material);
    expect(activeIntake(chat)!.touchedAt).toBe(touched);
    // «➕ Topshiriq» opens its draft: a parked collection refuses no door.
    await h.handle(tg.text(s.chat, TOPSHIRIQ));
    expect(activeDraft(chat)).not.toBeNull();
    __resetDrafts();
    // A reply to the collection's own prompt is the collection's, parked or not.
    await h.handle(tg.text(s.chat, `Kurtka 300 dona ${STAMP}`, { replyTo: prompt }));
    expect(activeIntake(chat)!.material).toContain(`Kurtka 300 dona ${STAMP}`);
    // A table-shaped figure typed into a parked chat: one sentence, never the paid assistant.
    park();
    const expected = await orphanAnswerSentence('3500 kg', activeIntake(chat));
    m = h.mark();
    await h.handle(tg.text(s.chat, '3500 kg'));
    expect(expected).not.toBeNull();
    expect(h.textsTo(s.chat, m)).toEqual([expected!.text]);
    // …and that sentence is P3's pause line with «▶️» / «✖️» under it (§2.8,
    // the parked half of the orphan guard — asserted here, on the real handler
    // chain, at the merge: P3's tree could not reach this file).
    expect(expected!.text).toBe(PAUSE_LINE);
    const paused = h.api.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(JSON.stringify(paused.payload.reply_markup ?? '')).toContain('c:resume');
    expect(JSON.stringify(paused.payload.reply_markup ?? '')).toContain('c:cancel');
    expect(await aiQuestions(s)).toBe(0);
    expect(activeIntake(chat)!.material).not.toContain('3500 kg');
  });

  it('a redelivered «✖️» of an older collection ends nothing it does not own (durability-2)', async () => {
    const { chat, s, prompt } = await collecting();
    // «🔄 Ha, boshqatdan»: B replaces A.
    await h.handle(tg.callback(s.chat, nextMsg(), 'c:rastamojka'));
    const question = h.api.filter((c) => c.method === 'sendMessage' && JSON.stringify(c.payload.reply_markup ?? '').includes('c:go_rastamojka')).at(-1)!.messageId!;
    await h.handle(tg.callback(s.chat, question, 'c:go_rastamojka'));
    const b = activeIntake(chat)!.noteId;
    notesMade.push(b);
    const m = h.mark();
    await h.handle(tg.callback(s.chat, prompt, 'c:cancel'));
    expect(h.textsTo(s.chat, m)).toEqual(['Bu tugma eskirgan.']);
    expect(activeIntake(chat)?.noteId).toBe(b);
  });

  it('an unwritten change keeps its update unconfirmed while its batch is handled; the next process applies it once (durability-10)', async () => {
    const { chat, s } = await collecting();
    await h.settle();
    // U is applied and finished, but its change cannot be written…
    __setIntakeWriteHook(async (k) => {
      if (k === String(chat)) throw new Error('database blip');
    });
    const U = tg.text(s.chat, `Shim 200 dona ${STAMP}`);
    await h.handle(U);
    // …and the batch's next update V is still in flight when the signal comes.
    hang.chat = s.chat;
    hang.on = true;
    const V = tg.text(s.chat, `Kepka 50 dona ${STAMP}`);
    void h.handle(V).catch(() => {});
    await vi.waitFor(() => expect(hang.on).toBe(false));
    const getUpdates = vi.fn(async () => []);
    const outcome = await stopTelegramBot(
      botStopDeps({ isRunning: () => true, stop: vi.fn(async () => {}), api: { getUpdates } } as never),
    );
    const u = (U as { update_id: number }).update_id;
    expect(outcome.via).toBe('confirm');
    expect(outcome.confirmedThrough).toBe(u - 1);
    expect(getUpdates).toHaveBeenCalledWith(expect.objectContaining({ offset: u }), expect.anything());
    // The next process: the row as last written, then U and V delivered again.
    __setIntakeWriteHook(null);
    await restart();
    expect(activeIntake(chat)!.material).toEqual([]);
    await h.handle(tg.again(U));
    await h.handle(tg.again(V));
    expect(activeIntake(chat)!.material).toEqual([`Shim 200 dona ${STAMP}`, `Kepka 50 dona ${STAMP}`]);
  }, 20_000);

  it('every dirty chat is written before grammy confirms its batch — bounded, and never a stopped poll (the lead’s ruling L1)', async () => {
    const { chat, s } = await collecting();
    await h.settle();
    const writes = __intakeWriteCount();
    await h.handle(tg.text(s.chat, `Shim 200 dona ${STAMP}`));
    const rowMaterial = async () =>
      ((await db.execute<{ m: unknown }>(sql`
        SELECT state -> 'material' AS m FROM telegram_calc_intakes WHERE chat_id = ${String(chat)}::bigint`))[0]?.m ?? null) as
        | string[]
        | null;
    expect(await rowMaterial()).toEqual([]);
    expect(__intakeWriteCount()).toBe(writes);
    const confirm = flushBeforeConfirm();
    let seenAtPrev: string[] | null = null;
    await confirm(
      (async () => {
        seenAtPrev = await rowMaterial();
        return { ok: true, result: [] };
      }) as never,
      'getUpdates',
      { offset: 1 } as never,
    );
    expect(seenAtPrev).toEqual([`Shim 200 dona ${STAMP}`]);
    // A write that fails: the poll goes on, the failure is said once.
    const warn = vi.spyOn(logger, 'warn');
    try {
      __setIntakeWriteHook(async () => {
        throw new Error('database blip');
      });
      updateIntake(chat, { material: ['a'] });
      const prev = vi.fn(async () => ({ ok: true, result: [] }));
      await confirm(prev as never, 'getUpdates', {} as never);
      updateIntake(chat, { material: ['b'] });
      await confirm(prev as never, 'getUpdates', {} as never);
      expect(prev).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.filter((c) => String(c[1]).includes('confirmed before its collection was written'))).toHaveLength(1);
      // A write that hangs: the poll goes on after the bound, the chat still dirty.
      __forgetIntakeMemory();
      await hydrateIntakes();
      __setIntakeWriteHook(async () => new Promise(() => {}));
      // An update still being handled (above every one this process finished).
      const u = lastDoneUpdateId() + 10;
      await stoppingGuard()({ update: { update_id: u } } as never, async () => {
        updateIntake(chat, { material: ['c'] });
      });
      expect(oldestUnwrittenUpdate()).toBe(u);
      const hung = vi.fn(async () => ({ ok: true, result: [] }));
      const started = Date.now();
      // grammy's next call carries the offset past it, as it always does.
      await confirm(hung as never, 'getUpdates', { offset: u + 1 } as never);
      expect(hung).toHaveBeenCalledTimes(1);
      expect(Date.now() - started).toBeGreaterThanOrEqual(INTAKE_CONFIRM_FLUSH_MS - 50);
      // Re-anchored (the P1 review's ADV-1): Telegram has dropped that update,
      // so the store no longer names it for the stop to hold back — the change
      // is still unwritten, memory keeps it, and the seal says it was lost.
      expect(oldestUnwrittenUpdate()).toBeNull();
      // Every other method passes straight through, at once.
      const other = vi.fn(async () => ({ ok: true, result: true }));
      await confirm(other as never, 'sendMessage', { chat_id: 1, text: 'x' } as never);
      expect(other).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  }, 15_000);

  it('a stop mid-batch after a failed confirm-flush confirms through lastDone — the batch handled here is never handed over again (ADV-1)', async () => {
    const { chat, s } = await collecting();
    await h.settle();
    // Batch 1: U's change cannot be written…
    __setIntakeWriteHook(async (k) => {
      if (k === String(chat)) throw new Error('database blip');
    });
    const U = tg.text(s.chat, `Shim 200 dona ${STAMP}`);
    await h.handle(U);
    const u = (U as { update_id: number }).update_id;
    expect(oldestUnwrittenUpdate()).toBe(u);
    // …and grammy's next getUpdates goes ahead all the same (the flush failed), dropping U at Telegram.
    await flushBeforeConfirm()((async () => ({ ok: true, result: [] })) as never, 'getUpdates', { offset: u + 1 } as never);
    // Batch 2: one update handled, the next still in flight when the signal comes.
    const guard = stoppingGuard();
    await guard({ update: { update_id: u + 5 } } as never, async () => {});
    let release: () => void = () => {};
    void guard({ update: { update_id: u + 6 } } as never, () => new Promise<void>((resolve) => (release = resolve)));
    const warn = vi.spyOn(logger, 'warn');
    try {
      const getUpdates = vi.fn(async () => []);
      const outcome = await stopTelegramBot({
        ...botStopDeps({ isRunning: () => true, stop: vi.fn(async () => {}), api: { getUpdates } } as never),
        deadlineMs: 2_000,
      });
      expect(outcome.via).toBe('confirm');
      // Through the update handled — not «the one before U», which Telegram no
      // longer holds and which would hand u+5 to the next process a second time.
      expect(outcome.confirmedThrough).toBe(u + 5);
      expect(getUpdates).toHaveBeenCalledWith(expect.objectContaining({ offset: u + 6 }), expect.anything());
      expect(warn.mock.calls.some((c) => String(c[1]).includes('already confirmed was never written') && (c[0] as { update?: number }).update === u)).toBe(true);
    } finally {
      warn.mockRestore();
      release();
      await new Promise((resolve) => setImmediate(resolve));
      __resetLifecycle();
    }
  }, 15_000);

  it('the backlog sentence keeps «Hisoblatish» only where nothing survived (regression-24)', async () => {
    // A collection opened before this boot, holding: its chat is told the shorter sentence.
    const kept = await collecting();
    updateIntake(kept.chat, { openedAt: Date.now() - 10 * 60_000 }, { quiet: true });
    const boot = await restart(new Date());
    let m = h.mark();
    await h.handle(tg.text(kept.s.chat, `qwe ${STAMP}`, { date: boot - 20 * 60 }));
    expect(h.textsTo(kept.s.chat, m)).toEqual([BACKLOG_SENTENCE_KEPT]);
    // A chat with none keeps today's sentence.
    const none = await person();
    m = h.mark();
    await h.handle(tg.text(none.chat, `qwe ${STAMP}`, { date: boot - 60 }));
    expect(h.textsTo(none.chat, m)).toEqual([BACKLOG_SENTENCE]);
    // …and so does a chat whose collection a LATE press opened after boot (I20b).
    const late = await person();
    await h.handle(tg.callback(late.chat, nextMsg(), 'c:rastamojka'));
    m = h.mark();
    await h.handle(tg.text(late.chat, `mijoz qwe ${STAMP}`, { date: boot - 60 }));
    expect(h.textsTo(late.chat, m)).toEqual([BACKLOG_SENTENCE]);
  });
});
