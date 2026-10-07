import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  calcRequests,
  crmActivities,
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
import {
  completeTaskFromBot,
  noteReplyPending,
  noteTaskPending,
  peekTaskPending,
  askFromBot,
  takeTaskPending,
  dropTaskPending,
} from '@/modules/platform/telegram/staff-bot';
import { REPLY_SENTENCES, replyVerdictFor, threadReplyFromBot } from '@/modules/platform/telegram/reply-door';
import { calcThreadMessages } from '@/modules/wms/crm/thread';

/**
 * The Telegram reply door against a real database (0127, the owner's E2 a,
 * E3 a, E4 a): a reply resolves to the person's OWN ping by the message id
 * the drain stored, with no age window; the armed wait gets its own reply;
 * the VED's bound calc task copy lands in that calculation's Q&A and never
 * through `askAboutTask`; an ordinary task copy asks its giver.
 *
 * The bot is not running: the rows the drain would have written are
 * inserted as `sent` with their `payload.tg`, and the door is called the way
 * the ladder calls it. Everything here is this file's own; users DEACTIVATED
 * in cleanup (audit FK).
 */
const SFX = randomUUID().replace(/-/g, '').slice(0, 6);
let seq = 0;
let chatSeq = 8_800_000_000 + Math.floor(Math.random() * 1_000_000);
let msgSeq = 10_000;
const phone = () => `+99898${String(Date.now()).slice(-5)}${(seq += 1).toString().padStart(2, '0')}`;
const ctx = (id: string) => ({ actorId: id, ip: null, userAgent: 'thread-reply.integration' });

const madeUsers: string[] = [];
const madeLeads: string[] = [];
const madeRequests: string[] = [];
const madeTasks: string[] = [];
let openLeadStage = '';
const P: Record<'S' | 'C' | 'V' | 'M' | 'U' | 'X', string> = { S: '', C: '', V: '', M: '', U: '', X: '' };
const CHAT: Record<string, bigint> = {};

async function person(key: keyof typeof P, role: string, name: string): Promise<void> {
  const [u] = await db
    .insert(users)
    .values({ phone: phone(), fullName: `${name} ${SFX}`, passwordHash: 'x', active: true })
    .returning({ id: users.id });
  const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
  await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  const chat = BigInt((chatSeq += 1));
  await db.insert(telegramLinks).values({ userId: u!.id, telegramChatId: chat, status: 'linked', linkedAt: new Date() });
  madeUsers.push(u!.id);
  P[key] = u!.id;
  CHAT[u!.id] = chat;
}

async function lead(ownerId: string): Promise<string> {
  const [row] = await db
    .insert(leads)
    .values({ name: `Reply lid ${SFX} ${(seq += 1)}`, stageId: openLeadStage, ownerId })
    .returning({ id: leads.id });
  madeLeads.push(row!.id);
  return row!.id;
}

async function request(leadId: string): Promise<string> {
  const [row] = await db
    .insert(calcRequests)
    .values({
      entityType: 'lead',
      entityId: leadId,
      requestedBy: P.S,
      assigneeId: P.V,
      itemCount: 1,
      section: 'rastamojka',
      dueAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: calcRequests.id });
  madeRequests.push(row!.id);
  return row!.id;
}

/** A ping the drain SENT to `userId` — its `payload.tg` is what a reply names. */
async function sentPing(
  userId: string,
  type: string,
  payload: Record<string, unknown>,
  opts: { chatOf?: string; daysAgo?: number } = {},
): Promise<number> {
  const messageId = (msgSeq += 1);
  await db.insert(notifications).values({
    userId,
    channel: 'telegram',
    type,
    status: 'sent',
    sentAt: new Date(),
    payload: { text: 'x', ...payload, tg: { chatId: Number(CHAT[opts.chatOf ?? userId]), messageId } },
    ...(opts.daysAgo ? { createdAt: new Date(Date.now() - opts.daysAgo * 86_400_000) } : {}),
  });
  return messageId;
}

async function handTask(assigneeId: string, authorId: string, title: string): Promise<string> {
  const task = await createTask(
    {
      title: `${title} ${SFX}`,
      note: '',
      typeId: null,
      assigneeId,
      dueAt: '',
      priority: 2,
      entityType: null,
      entityId: null,
      repeatUnit: null,
      repeatEvery: 1,
    },
    ctx(authorId),
    { origin: 'hand' },
  );
  madeTasks.push(task.id);
  return task.id;
}

const reply = (who: string, replyTo: number, text: string, extra: { forwarded?: boolean } = {}) =>
  threadReplyFromBot(CHAT[who]!, {
    replyToMessageId: replyTo,
    replyToForwarded: extra.forwarded ?? false,
    text,
    incomingMessageId: (msgSeq += 1),
  });

async function questionsAbout(taskId: string) {
  return db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(eq(notifications.type, 'TaskQuestion'), sql`${notifications.payload} ->> 'taskId' = ${taskId}`));
}

beforeAll(async () => {
  const [ls] = await db.select().from(leadStages).where(eq(leadStages.kind, 'open')).limit(1);
  openLeadStage = ls!.id;
  await person('S', 'sales_manager', 'Reply Sotuvchi');
  await person('C', 'logist', 'Reply Logist');
  await person('V', 'ved_manager', 'Reply VED');
  await person('M', 'warehouse_operator', 'Reply Skladchi');
  await person('U', 'sales_manager', 'Reply U');
  await person('X', 'sales_manager', 'Reply X');
});

afterAll(async () => {
  const notes = await db.select({ id: crmActivities.id }).from(crmActivities).where(inArray(crmActivities.entityId, madeLeads));
  await db.delete(notifications).where(inArray(notifications.userId, madeUsers));
  await db.execute(sql`DELETE FROM thread_reads WHERE user_id IN (${sql.join(madeUsers.map((id) => sql`${id}::uuid`), sql`, `)})`);
  if (madeTasks.length) {
    await db.update(calcRequests).set({ taskId: null }).where(inArray(calcRequests.id, madeRequests));
    await db.delete(tasks).where(inArray(tasks.id, madeTasks));
  }
  await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
  if (notes.length) await db.delete(crmActivities).where(inArray(crmActivities.id, notes.map((n) => n.id)));
  await db.delete(leads).where(inArray(leads.id, madeLeads));
  await db.delete(telegramLinks).where(inArray(telegramLinks.userId, madeUsers));
  await db.update(users).set({ active: false }).where(inArray(users.id, madeUsers));
  await pgClient.end();
});

describe('8. the resolver reads the person’s OWN ping and nobody else’s', () => {
  it('a row of another user, naming this chat and message, is no row at all', async () => {
    const L = await lead(P.X);
    const messageId = await sentPing(P.X, 'InternalNote', { thread: { kind: 'lead', id: L, activityId: randomUUID() } }, { chatOf: P.U });
    expect(await replyVerdictFor(CHAT[P.U]!, messageId)).toBeNull();
    expect(await replyVerdictFor(CHAT[P.X]!, messageId)).toBeNull();
  });
});

describe('10. E2 a — a mention lets the named person reply without the card', () => {
  it('the mention lands; the same person on a plain InternalNote copy is refused', async () => {
    const L = await lead(P.S);
    const mention = await sentPing(P.M, 'MentionedInNote', { thread: { kind: 'lead', id: L, activityId: randomUUID() } });
    const landed = await reply(P.M, mention, `skladdan javob ${SFX}`);
    expect(landed?.text).toMatch(/^✅ Javob kartaga yozildi/);
    const plain = await sentPing(P.M, 'InternalNote', { thread: { kind: 'lead', id: L, activityId: randomUUID() } });
    expect((await reply(P.M, plain, 'yana'))?.text).toBe('Bu kartani endi ocha olmaysiz — javob yozilmadi.');
  });
});

describe('11. E3 a — the VED’s reply to his own «Hisoblash: …» task copy', () => {
  it('lands under that calculation, reaches the seller, and leaves the task open with no TaskQuestion', async () => {
    const L = await lead(P.S);
    const R = await request(L);
    const task = await createTask(
      {
        title: `Hisoblash: reply ${SFX}`,
        note: '',
        typeId: null,
        assigneeId: P.V,
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
        priority: 1,
        entityType: 'lead',
        entityId: L,
        repeatUnit: null,
        repeatEvery: 1,
      },
      ctx(P.S),
      { origin: 'calc', boundId: R },
    );
    madeTasks.push(task.id);
    const copy = await sentPing(P.V, 'TaskAssigned', { taskId: task.id, origin: 'calc', bound: true });
    expect(await replyVerdictFor(CHAT[P.V]!, copy)).toEqual({ kind: 'calc_task', requestId: R, taskId: task.id });
    const out = await reply(P.V, copy, `Necha dona? ${SFX}`);
    expect(out?.text).toMatch(/^✅ Hisob ostiga yozildi/);
    const messages = await calcThreadMessages(R);
    expect(messages.map((m) => m.body)).toEqual([`Necha dona? ${SFX}`]);
    expect((await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, task.id)))[0]!.status).toBe('open');
    expect(await questionsAbout(task.id)).toHaveLength(0);
    // The seller hears it (the announce runs off the poller).
    let toSeller: unknown[] = [];
    for (let i = 0; i < 50 && toSeller.length === 0; i += 1) {
      toSeller = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.userId, P.S), eq(notifications.type, 'CalcThread'), sql`${notifications.payload} -> 'thread' ->> 'activityId' = ${messages[0]!.id}`));
      if (toSeller.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(toSeller).toHaveLength(1);
  });
});

describe('12. E4 a — a reply to an ordinary task copy is a question to its giver', () => {
  it('a TaskQuestion to the author, the task still open, an audit «comment»', async () => {
    const T = await handTask(P.S, P.C, 'Oddiy topshiriq');
    const copy = await sentPing(P.S, 'TaskAssigned', { taskId: T, origin: 'hand' });
    const out = await reply(P.S, copy, 'qachongacha?');
    expect(out?.text).toMatch(/^✅ Savol yuborildi\./);
    expect(await questionsAbout(T)).toHaveLength(1);
    expect((await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, T)))[0]!.status).toBe('open');
    const comments = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'task'), eq(auditLog.entityId, T), eq(auditLog.action, 'comment')));
    expect(comments).toHaveLength(1);
  });
});

describe('13. the armed wait gets its own reply (the judge’s blocker)', () => {
  it('a. «✅ Bajarildi» pressed, then a swipe-reply to the same copy: the door steps aside and the result closes the task', async () => {
    const T = await handTask(P.S, P.C, 'Natija kutadi');
    const copy = await sentPing(P.S, 'TaskAssigned', { taskId: T, origin: 'hand' });
    noteTaskPending(CHAT[P.S]!, T, { messageId: copy, text: 'x', markup: undefined, kind: 'single' });
    expect(await reply(P.S, copy, 'tayyor')).toBeNull();
    const pending = takeTaskPending(CHAT[P.S]!);
    expect(pending?.kind).toBe('result');
    expect(await completeTaskFromBot(CHAT[P.S]!, pending!.taskId, 'tayyor', pending!.pressed)).toBe('done');
    expect((await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, T)))[0]!.status).toBe('done');
    expect(await questionsAbout(T)).toHaveLength(0);
  });

  it('b. «💬 Savol» pressed, then a swipe-reply to the copy: asked exactly once, and the wait is spent', async () => {
    const T = await handTask(P.S, P.C, 'Savol kutadi');
    const copy = await sentPing(P.S, 'TaskAssigned', { taskId: T, origin: 'hand' });
    noteTaskPending(CHAT[P.S]!, T, null, 'question');
    expect(await reply(P.S, copy, 'qaysi mijoz?')).toBeNull();
    const pending = takeTaskPending(CHAT[P.S]!);
    expect(pending?.kind).toBe('question');
    expect((await askFromBot(CHAT[P.S]!, pending!.taskId, 'qaysi mijoz?')).result).toBe('done');
    expect(await questionsAbout(T)).toHaveLength(1);
    expect(peekTaskPending(CHAT[P.S]!)).toBeNull();
  });

  it('c. «✅» on the morning digest, then a reply to the digest itself: the result closes the task', async () => {
    const T = await handTask(P.S, P.C, 'Ro‘yxatdan');
    const digest = (msgSeq += 1);
    noteTaskPending(CHAT[P.S]!, T, { messageId: digest, text: 'x', markup: undefined, kind: 'list' });
    expect(await reply(P.S, digest, 'bo‘ldi')).toBeNull();
    const pending = takeTaskPending(CHAT[P.S]!);
    expect(await completeTaskFromBot(CHAT[P.S]!, pending!.taskId, 'bo‘ldi', pending!.pressed)).toBe('done');
  });

  it('a «💬 Javob yozish» wait is dropped by a swipe-reply that lands — one gesture, one landing', async () => {
    const L = await lead(P.S);
    const ping = await sentPing(P.S, 'InternalNote', { thread: { kind: 'lead', id: L, activityId: randomUUID() } });
    noteReplyPending(CHAT[P.S]!, ping);
    expect((await reply(P.S, ping, 'javob'))?.text).toMatch(/^✅ Javob kartaga yozildi/);
    expect(peekTaskPending(CHAT[P.S]!)).toBeNull();
    dropTaskPending(CHAT[P.S]!);
  });
});

describe('14. no age window on the resolver', () => {
  it('a ping sent 61 days ago still resolves to its thread and the reply lands', async () => {
    const L = await lead(P.S);
    const old = await sentPing(P.S, 'InternalNote', { thread: { kind: 'lead', id: L, activityId: randomUUID() } }, { daysAgo: 61 });
    expect((await replyVerdictFor(CHAT[P.S]!, old))?.kind).toBe('thread');
    expect((await reply(P.S, old, 'eski xabarga'))?.text).toMatch(/^✅ Javob kartaga yozildi/);
  });
});

describe('15. what does not land says so — never the paid AI', () => {
  it('an old ping, a forwarded message and a customer’s own message each answer in words', async () => {
    const before = await sentPing(P.S, 'InternalNote', {});
    expect((await reply(P.S, before, 'x'))?.text).toBe(REPLY_SENTENCES.old_ping);
    // A forwarded original: the drain keeps no id for it — no row, the forward flag.
    expect((await reply(P.S, (msgSeq += 1), 'x', { forwarded: true }))?.text).toBe(REPLY_SENTENCES.forwarded);
    // A bot prompt with no row and no forward: not this door's — falls through.
    expect(await reply(P.S, (msgSeq += 1), 'GS777')).toBeNull();
    const customer = await sentPing(P.S, 'ClientBotMessage', {});
    expect((await reply(P.S, customer, 'x'))?.text).toBe(REPLY_SENTENCES.customer);
  });
});
