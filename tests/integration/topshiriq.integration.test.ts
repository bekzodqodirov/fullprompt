import 'dotenv/config';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  calcRequests,
  clients,
  leads,
  leadStages,
  notifications,
  paymentPromises,
  tasks,
  telegramLinks,
  users,
} from '@/modules/platform/db/schema';
import {
  acceptTask,
  answerAboutTask,
  askAboutTask,
  byId,
  cancelTask,
  cancelTasksFor,
  completeTask,
  givenTasks,
  reassignTask,
  remindTask,
  rescheduleTask,
  TaskError,
  type TaskContext,
  type TaskErrorCode,
  updateTask,
} from '@/modules/platform/tasks/service';
import { composeMyDay } from '@/modules/platform/tasks/digest';
import { taskFiles, toTaskViews } from '@/modules/platform/tasks/view';
import { downloadTaskFiles, TASK_ENTITY_TYPE, taskFileName } from '@/modules/platform/tasks/files-job';
import { retireTaskCopies } from '@/modules/platform/notifications/retire-tasks';
import { __resetTelegramPause, sendPendingTelegram } from '@/modules/platform/notifications/service';
import { AttachmentDeleteError, deleteAttachment } from '@/modules/platform/files/service';
import { decideAttachmentRead } from '@/modules/wms/attachments/access';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import {
  completeTaskFromBot,
  createTaskFromDraft,
  givenFromBot,
  pressRefusalText,
  remindTaskFromBot,
  TASK_ANSWERS,
  taskPressCheck,
} from '@/modules/platform/telegram/staff-bot';

/**
 * The topshiriq round's services against a real database
 * (docs/TELEGRAM-TOPSHIRIQ.md, docs/TOPSHIRIQ-VED-REVIEW.md): the
 * compare-and-set doors, the bound gate on every door, «📤 Men bergan» and its
 * 🔔, the question/answer audit, retiring a task's Telegram copies, the
 * drain's send-time re-check and its forwards, the bot doors, the day list,
 * the reader-dependent task views and the task files' read/delete rules.
 *
 * The Telegram transport is a recorder; nothing reaches the network. Every
 * row this file makes is its own: fresh people, their own lead, and a drain
 * that parks every foreign pending row while it runs (#713, #730).
 */

const APP = 'https://test.gsrwms.uz';
const STAMP = String(Date.now()).slice(-7);
let seq = 0;

interface Call {
  method: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
let answers: { status: number; json: unknown }[] = [];
let nextMessageId = 500;

const people: string[] = [];
const taskIds: string[] = [];
const requests: string[] = [];
const promises: string[] = [];
const clientIds: string[] = [];
const leadIds: string[] = [];
const rowsMade: string[] = [];
const filesMade: string[] = [];
const parked = new Set<string>();
let stageId: string;
let leadId: string;

const savedEnv = { token: process.env.TELEGRAM_BOT_TOKEN, app: process.env.APP_URL };

interface Person {
  id: string;
  name: string;
  chat: bigint | null;
}

async function mintStaff(opts: { chat?: boolean } = {}): Promise<Person> {
  seq += 1;
  const name = `Topshiriq ${STAMP}-${seq}`;
  const [user] = await db
    .insert(users)
    .values({
      phone: `+99898${String(Number(STAMP) + seq).padStart(7, '0').slice(-7)}`,
      fullName: name,
      passwordHash: 'x',
      locale: 'uz',
      active: true,
    })
    .returning({ id: users.id });
  people.push(user!.id);
  let chat: bigint | null = null;
  if (opts.chat) {
    chat = BigInt(740_000_000 + Number(STAMP) * 10 + seq);
    await db.insert(telegramLinks).values({ userId: user!.id, telegramChatId: chat, status: 'linked', linkedAt: new Date() });
  }
  return { id: user!.id, name, chat };
}

/** A service context with exactly these permissions — the doors read nothing else. */
function ctxOf(person: Person | string, ...perms: string[]): TaskContext {
  const id = typeof person === 'string' ? person : person.id;
  return { actorId: id, ip: null, userAgent: null, actor: { id, permissions: new Set(perms) } };
}

/** A task row as a door or an old app left it — origin and binding chosen by the test. */
async function mintTask(
  author: Person,
  assignee: Person,
  over: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(tasks)
    .values({
      title: `Vazifa ${STAMP}-${taskIds.length}`,
      assigneeId: assignee.id,
      createdBy: author.id,
      origin: 'hand',
      ...over,
    })
    .returning({ id: tasks.id });
  taskIds.push(row!.id);
  return row!.id;
}

async function mintRequest(over: { open: boolean; taskId?: string | null }): Promise<string> {
  const [row] = await db
    .insert(calcRequests)
    .values({
      entityType: 'lead',
      entityId: leadId,
      requestedBy: people[0]!,
      itemCount: 1,
      taskId: over.taskId ?? null,
      dueAt: new Date(Date.now() + 3_600_000),
      completedAt: over.open ? null : new Date(),
      completedBy: over.open ? null : people[0]!,
      completedVia: over.open ? null : 'task',
    })
    .returning({ id: calcRequests.id });
  requests.push(row!.id);
  return row!.id;
}

async function mintPromise(over: { open: boolean; taskId?: string | null; by: string }): Promise<string> {
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `TQ${STAMP}${clientIds.length}`.slice(0, 10), name: `Va'da mijoz ${STAMP}` })
    .returning({ id: clients.id });
  clientIds.push(client!.id);
  const [row] = await db
    .insert(paymentPromises)
    .values({
      clientId: client!.id,
      amountUsd: '100.00',
      dueOn: '2027-01-15',
      balanceAtUsd: '100.00',
      status: over.open ? 'open' : 'kept',
      settledAt: over.open ? null : new Date(),
      taskId: over.taskId ?? null,
      createdBy: over.by,
    })
    .returning({ id: paymentPromises.id });
  promises.push(row!.id);
  return row!.id;
}

async function refusal(run: Promise<unknown>): Promise<TaskErrorCode | 'resolved'> {
  try {
    await run;
    return 'resolved';
  } catch (err) {
    if (err instanceof TaskError) return err.code;
    throw err;
  }
}

async function queued(userId: string, type: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, type)));
}

async function taskRow(id: string) {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
  return row!;
}

async function sentCopy(userId: string, type: string, payload: Record<string, unknown>, tg: { chatId: number; messageId: number }) {
  const [row] = await db
    .insert(notifications)
    .values({ userId, channel: 'telegram', type, status: 'sent', sentAt: new Date(), payload: { ...payload, tg } })
    .returning({ id: notifications.id });
  rowsMade.push(row!.id);
  return row!.id;
}

async function pendingCopy(userId: string, type: string, payload: Record<string, unknown>, createdAt?: Date) {
  const [row] = await db
    .insert(notifications)
    .values({ userId, channel: 'telegram', type, status: 'pending', payload, ...(createdAt ? { createdAt } : {}) })
    .returning({ id: notifications.id });
  rowsMade.push(row!.id);
  return row!.id;
}

async function notificationRow(id: string) {
  const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
  return row!;
}

/** Only these rows are claimable while the drain runs (the rest are parked and put back). */
async function drainOnly(ids: string[]): Promise<void> {
  const others = await db
    .update(notifications)
    .set({ status: 'sending', claimedAt: new Date() })
    .where(and(eq(notifications.channel, 'telegram'), eq(notifications.status, 'pending'), notInArray(notifications.id, ids)))
    .returning({ id: notifications.id });
  for (const row of others) parked.add(row.id);
  await sendPendingTelegram().catch(() => {});
}

const method = (name: string) => calls.filter((c) => c.method === name);

beforeAll(async () => {
  stageId = (await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'open')))[0]!.id;
  const first = await mintStaff();
  const [lead] = await db
    .insert(leads)
    .values({ name: `Topshiriq lid ${STAMP}`, stageId, createdBy: first.id })
    .returning({ id: leads.id });
  leadId = lead!.id;
  leadIds.push(leadId);
});

beforeEach(() => {
  calls = [];
  answers = [];
  __resetTelegramPause();
  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  process.env.APP_URL = APP;
  __setTelegramTransport(async (url, init) => {
    const name = url.slice(url.lastIndexOf('/') + 1);
    calls.push({ method: name, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = answers.shift() ?? { status: 200, json: { ok: true, result: { message_id: (nextMessageId += 1) } } };
    return new Response(JSON.stringify(next.json), { status: next.status });
  });
});

afterEach(() => {
  __setTelegramTransport(null);
  vi.unstubAllGlobals();
});

afterAll(async () => {
  // The void retires a door dispatched may still be finishing.
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (parked.size) {
    await db
      .update(notifications)
      .set({ status: 'pending', claimedAt: null })
      .where(and(inArray(notifications.id, [...parked]), eq(notifications.status, 'sending')));
  }
  if (rowsMade.length) await db.delete(notifications).where(inArray(notifications.id, rowsMade));
  if (people.length) await db.delete(notifications).where(inArray(notifications.userId, people));
  if (filesMade.length) await db.delete(attachments).where(inArray(attachments.id, filesMade));
  if (taskIds.length) await db.delete(attachments).where(and(eq(attachments.entityType, TASK_ENTITY_TYPE), inArray(attachments.entityId, taskIds)));
  if (requests.length) await db.delete(calcRequests).where(inArray(calcRequests.id, requests));
  if (promises.length) await db.delete(paymentPromises).where(inArray(paymentPromises.id, promises));
  if (people.length) {
    // Every task these people touched — the spawned repeats included.
    await db.delete(tasks).where(sql`${tasks.createdBy} IN (${sql.join(people.map((p) => sql`${p}`), sql`, `)})`);
  }
  if (taskIds.length) await db.delete(tasks).where(inArray(tasks.id, taskIds));
  if (clientIds.length) await db.delete(clients).where(inArray(clients.id, clientIds));
  if (leadIds.length) await db.delete(leads).where(inArray(leads.id, leadIds));
  if (people.length) {
    await db.delete(telegramLinks).where(inArray(telegramLinks.userId, people));
    // Audited actors stay (audit_log FK) — they leave the company instead.
    await db.update(users).set({ active: false }).where(inArray(users.id, people));
  }
  if (savedEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedEnv.token;
  if (savedEnv.app === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedEnv.app;
  await pgClient.end();
});

describe('the doors are compare-and-set (telegram-mechanics-16, access-money-13)', () => {
  it('two 👀 at once: ONE wins, the other hears «already accepted», the author hears once', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(author, doer);
    const results = await Promise.all([refusal(acceptTask(id, ctxOf(doer))), refusal(acceptTask(id, ctxOf(doer)))]);
    expect(results.sort()).toEqual(['already_accepted', 'resolved']);
    expect((await taskRow(id)).acceptedAt).not.toBeNull();
    expect(await queued(author.id, 'TaskAccepted')).toHaveLength(1);
  });

  it('👀 names the PRESSER: a previous holder, or the author, cannot accept on the assignee’s behalf', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(author, doer);
    expect(await refusal(acceptTask(id, ctxOf(author, 'crm.leads.view_all')))).toBe('not_assignee');
    expect((await taskRow(id)).acceptedAt).toBeNull();
  });

  it('a RULE’s task tells nobody about a ⏰ — its author wrote a rule, not this task (telegram-mechanics-20)', async () => {
    const ruleAuthor = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(ruleAuthor, doer, { origin: 'automation', dueAt: new Date('2027-01-04T18:59:59Z') });
    await rescheduleTask(id, { dueAt: new Date('2027-01-05T18:59:59Z'), allDay: true }, ctxOf(doer));
    await completeTask(id, '', ctxOf(doer));
    expect(await queued(ruleAuthor.id, 'TaskRescheduled')).toHaveLength(0);
    // ✅ still tells: «done» is the one press a rule's author asked to hear.
    expect(await queued(ruleAuthor.id, 'TaskDone')).toHaveLength(1);
  });

  it('two ✅ at once close the task ONCE and tell the author once', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(author, doer);
    const results = await Promise.all([
      refusal(completeTask(id, 'birinchi', ctxOf(doer))),
      refusal(completeTask(id, '', ctxOf(doer))),
    ]);
    expect(results.sort()).toEqual(['already_closed', 'resolved']);
    expect(await queued(author.id, 'TaskDone')).toHaveLength(1);
    const statusRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'task'), eq(auditLog.entityId, id), eq(auditLog.action, 'status_change')));
    expect(statusRows).toHaveLength(1);
  });

  it('cancel tells the ASSIGNEE the work went away, and a second cancel is refused', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(author, doer);
    await cancelTask(id, 'xato yozdim', ctxOf(author));
    expect(await refusal(cancelTask(id, '', ctxOf(author)))).toBe('already_closed');
    const told = await queued(doer.id, 'TaskCancelled');
    expect(told).toHaveLength(1);
    expect((told[0]!.payload as { text: string }).text).toContain('🗑 Vazifa bekor qilindi');
  });
});

describe('a reassign starts the new holder clean (data-migration-8, access-money-12)', () => {
  it('accepted_at and reminded_at describe the CURRENT assignee and are cleared', async () => {
    const author = await mintStaff();
    const first = await mintStaff();
    const next = await mintStaff();
    const id = await mintTask(author, first, { acceptedAt: new Date(), remindedAt: new Date() });
    await reassignTask(id, next.id, ctxOf(author));
    const row = await taskRow(id);
    expect(row).toMatchObject({ assigneeId: next.id, acceptedAt: null, remindedAt: null });
    // …so the author's first 🔔 to the new holder is not shut by the old half-hour.
    await remindTask(id, ctxOf(author));
  });

  it('the AUTHOR’s reassign forwards the sources; a colleague’s does not, and the author is offered them', async () => {
    const author = await mintStaff();
    const first = await mintStaff();
    const second = await mintStaff();
    const third = await mintStaff();
    const viewer = await mintStaff();
    const sources = [{ chatId: 9001, messageId: 7 }];
    const id = await mintTask(author, first, { sourceMessages: sources });

    await reassignTask(id, second.id, ctxOf(author));
    const toSecond = await queued(second.id, 'TaskAssigned');
    expect((toSecond[0]!.payload as { forwards?: unknown }).forwards).toEqual(sources);
    expect(await queued(author.id, 'TaskReassigned')).toHaveLength(0);

    await reassignTask(id, third.id, ctxOf(viewer, 'crm.leads.view_all'));
    const toThird = await queued(third.id, 'TaskAssigned');
    expect((toThird[0]!.payload as { forwards?: unknown }).forwards).toBeUndefined();
    const toAuthor = await queued(author.id, 'TaskReassigned');
    expect(toAuthor).toHaveLength(1);
    expect(toAuthor[0]!.payload).toMatchObject({ taskId: id, offerSources: true });
  });
});

describe('«📤 Men bergan» and its 🔔 ask ONE predicate (telegram-mechanics-25)', () => {
  it('lists the author’s open hand work only — never a machine’s, never a pointed pre-0124 row', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const hand = await mintTask(author, doer, { title: `Qo'l ${STAMP}` });
    const legacy = await mintTask(author, doer, { origin: null, title: `Eski ${STAMP}` });
    await mintTask(author, doer, { origin: 'calc' });
    await mintTask(author, doer, { origin: 'automation' });
    await mintTask(author, author);
    await mintTask(author, doer, { status: 'done', doneAt: new Date() });
    const pointed = await mintTask(author, doer, { origin: null });
    await mintRequest({ open: true, taskId: pointed });
    const promised = await mintTask(author, doer, { origin: null });
    await mintPromise({ open: true, taskId: promised, by: author.id });

    const list = await givenTasks(author.id);
    expect(list.total).toBe(2);
    expect(list.rows.map((r) => r.id).sort()).toEqual([hand, legacy].sort());
    expect(list.rows[0]!.dueAt === null || list.rows[0]!.dueAt instanceof Date).toBe(true);
  });

  it('🔔 at most once per half hour, by the author only, and not on what the list does not show', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(author, doer);
    const calc = await mintTask(author, doer, { origin: 'calc' });
    expect((await remindTask(id, ctxOf(author))).reach).toBe('no_chat');
    expect(await refusal(remindTask(id, ctxOf(author)))).toBe('remind_too_soon');
    expect(await refusal(remindTask(id, ctxOf(doer, 'crm.leads.view_all')))).toBe('not_author');
    expect(await refusal(remindTask(calc, ctxOf(author)))).toBe('not_remindable');
    expect(await queued(doer.id, 'TaskReminder')).toHaveLength(1);
    // Half an hour later the CAS opens again.
    await db.update(tasks).set({ remindedAt: new Date(Date.now() - 31 * 60_000) }).where(eq(tasks.id, id));
    await remindTask(id, ctxOf(author));
    expect(await queued(doer.id, 'TaskReminder')).toHaveLength(2);
  });

  it('two 🔔 at once send ONE reminder', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(author, doer);
    const results = await Promise.all([refusal(remindTask(id, ctxOf(author))), refusal(remindTask(id, ctxOf(author)))]);
    expect(results.sort()).toEqual(['remind_too_soon', 'resolved']);
    expect(await queued(doer.id, 'TaskReminder')).toHaveLength(1);
  });
});

describe('the bound gate on every door (VED-TARIX §8, ved-correctness-11, telegram-mechanics-9/12)', () => {
  it('a task carrying an OPEN calc job is refused by every task door, in one code', async () => {
    const author = await mintStaff();
    const ved = await mintStaff();
    const other = await mintStaff();
    const requestId = await mintRequest({ open: true });
    const id = await mintTask(author, ved, { origin: 'calc', boundId: requestId, dueAt: new Date('2027-01-01T10:00:00Z') });
    const ctx = ctxOf(ved);
    expect(await refusal(completeTask(id, '', ctx))).toBe('calc_use_screen');
    expect(await refusal(acceptTask(id, ctx))).toBe('calc_use_screen');
    expect(await refusal(reassignTask(id, other.id, ctx))).toBe('calc_use_screen');
    expect(await refusal(rescheduleTask(id, { dueAt: new Date('2027-02-01T00:00:00Z'), allDay: true }, ctx))).toBe('calc_use_screen');
    expect(await refusal(askAboutTask(id, 'qachon?', ctx))).toBe('calc_use_screen');
    expect(
      await refusal(updateTask(id, { title: 'x', note: '', typeId: null, dueAt: '2027-03-01', priority: 2, tzOffsetMin: null }, ctx)),
    ).toBe('calc_use_screen');
    const row = await taskRow(id);
    expect(row).toMatchObject({ status: 'open', assigneeId: ved.id });
    expect(row.dueAt!.toISOString()).toBe('2027-01-01T10:00:00.000Z');
  });

  it('the ✏️ form may still fix the TITLE of a bound task — only its date is another record’s', async () => {
    const author = await mintStaff();
    const ved = await mintStaff();
    const requestId = await mintRequest({ open: true });
    const due = new Date('2027-01-01T10:00:00Z');
    const id = await mintTask(author, ved, { origin: 'calc', boundId: requestId, dueAt: due, allDay: false });
    // The form posts the date back as the typist's wall clock: 15:00 Tashkent.
    await updateTask(id, { title: 'Yangi nom', note: '', typeId: null, dueAt: '2027-01-01T15:00', priority: 1, tzOffsetMin: -300 }, ctxOf(ved));
    expect(await taskRow(id)).toMatchObject({ title: 'Yangi nom', dueAt: due });
  });

  it('a pre-0124 NULL-origin task a request POINTS at is just as bound (data-migration-3)', async () => {
    const author = await mintStaff();
    const ved = await mintStaff();
    const id = await mintTask(author, ved, { origin: null });
    await mintRequest({ open: true, taskId: id });
    expect(await refusal(completeTask(id, '', ctxOf(ved)))).toBe('calc_use_screen');
  });

  it('a release ghost (calc, no bound id) and a task whose request CLOSED keep their ordinary ✅', async () => {
    const author = await mintStaff();
    const ved = await mintStaff();
    const ghost = await mintTask(author, ved, { origin: 'calc' });
    const closedRequest = await mintRequest({ open: false });
    const stale = await mintTask(author, ved, { origin: 'calc', boundId: closedRequest });
    await completeTask(ghost, '', ctxOf(ved));
    await completeTask(stale, '', ctxOf(ved));
    expect((await taskRow(ghost)).status).toBe('done');
    expect((await taskRow(stale)).status).toBe('done');
  });

  it('a payment promise’s call: its DATE is the client’s promise while it stands, the call itself closes', async () => {
    const author = await mintStaff();
    const seller = await mintStaff();
    const promiseId = await mintPromise({ open: true, by: author.id });
    const id = await mintTask(author, seller, { origin: 'promise', boundId: promiseId, dueAt: new Date('2027-01-15T18:59:59Z') });
    const ctx = ctxOf(seller);
    expect(await refusal(rescheduleTask(id, { dueAt: new Date('2027-01-20T00:00:00Z'), allDay: true }, ctx))).toBe('bound_clock');
    expect(
      await refusal(updateTask(id, { title: 'x', note: '', typeId: null, dueAt: '2027-01-20', priority: 2, tzOffsetMin: null }, ctx)),
    ).toBe('bound_clock');
    const legacy = await mintTask(author, seller, { origin: null, dueAt: new Date('2027-01-15T18:59:59Z') });
    await mintPromise({ open: true, taskId: legacy, by: author.id });
    expect(await refusal(rescheduleTask(legacy, { dueAt: new Date('2027-01-20T00:00:00Z'), allDay: true }, ctx))).toBe('bound_clock');
    // The promise kept: an ordinary task again.
    await db.update(paymentPromises).set({ status: 'kept', settledAt: new Date() }).where(eq(paymentPromises.id, promiseId));
    await rescheduleTask(id, { dueAt: new Date('2027-01-20T18:59:59Z'), allDay: true }, ctx);
    await completeTask(id, '', ctx);
    expect((await taskRow(id)).status).toBe('done');
  });

  it('⏰ on a repeating task is refused — it would move the whole series (telegram-mechanics-15)', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(author, doer, { repeatUnit: 'week', dueAt: new Date('2027-01-04T18:59:59Z') });
    expect(await refusal(rescheduleTask(id, { dueAt: new Date('2027-01-05T18:59:59Z'), allDay: true }, ctxOf(doer)))).toBe(
      'repeat_series',
    );
  });

  it('⏰ moves the date and nothing else, and tells the author', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(author, doer, { title: `Muddat ${STAMP}`, dueAt: new Date('2027-01-04T18:59:59Z') });
    await rescheduleTask(id, { dueAt: new Date('2027-01-05T18:59:59Z'), allDay: true }, ctxOf(doer));
    expect(await taskRow(id)).toMatchObject({ title: `Muddat ${STAMP}`, dueAt: new Date('2027-01-05T18:59:59Z') });
    expect(await queued(author.id, 'TaskRescheduled')).toHaveLength(1);
  });
});

describe('a question and its answer are the task’s own history (telegram-mechanics-27)', () => {
  it('«💬 Savol» writes a `comment` row and reaches the author; the answer comes back with the buttons', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(author, doer);
    await askAboutTask(id, '  Qaysi skladdan?  ', ctxOf(doer));
    await answerAboutTask(id, 'Toshkentdan', ctxOf(author));
    const comments = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'task'), eq(auditLog.entityId, id), eq(auditLog.action, 'comment')));
    expect(comments.map((c) => c.after)).toEqual(
      expect.arrayContaining([
        { kind: 'question', text: 'Qaysi skladdan?', via: 'telegram' },
        { kind: 'answer', text: 'Toshkentdan', via: 'telegram' },
      ]),
    );
    expect((await queued(author.id, 'TaskQuestion'))[0]!.payload).toMatchObject({ taskId: id });
    expect((await queued(doer.id, 'TaskAnswer'))[0]!.payload).toMatchObject({ taskId: id, origin: 'hand', bound: false });
  });

  it('refuses a rule’s task, the wrong side, an empty text and a closed task', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const rule = await mintTask(author, doer, { origin: 'automation' });
    const id = await mintTask(author, doer);
    expect(await refusal(askAboutTask(rule, 'nima?', ctxOf(doer)))).toBe('not_askable');
    expect(await refusal(askAboutTask(id, 'nima?', ctxOf(author)))).toBe('not_assignee');
    expect(await refusal(answerAboutTask(id, 'shu', ctxOf(doer)))).toBe('not_author');
    expect(await refusal(askAboutTask(id, '   ', ctxOf(doer)))).toBe('empty_text');
    await db.update(tasks).set({ status: 'done', doneAt: new Date() }).where(eq(tasks.id, id));
    expect(await refusal(answerAboutTask(id, 'kech', ctxOf(author)))).toBe('already_closed');
  });
});

describe('the bulk closers hand back what they closed (telegram-mechanics-7)', () => {
  it('cancelTasksFor returns the ids its UPDATE closed, and only those', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const [lead] = await db
      .insert(leads)
      .values({ name: `Yopiladigan lid ${STAMP}`, stageId, createdBy: author.id })
      .returning({ id: leads.id });
    leadIds.push(lead!.id);
    const open = await mintTask(author, doer, { entityType: 'lead', entityId: lead!.id });
    await mintTask(author, doer, { entityType: 'lead', entityId: lead!.id, status: 'done', doneAt: new Date() });
    expect(await cancelTasksFor(db, 'lead', [lead!.id])).toEqual([open]);
    expect(await cancelTasksFor(db, 'lead', [])).toEqual([]);
  });
});

describe('retiring a task’s Telegram copies (telegram-mechanics-2/5/6)', () => {
  it('the digest keeps its text and loses ONE row per closed task, down to no keyboard at all', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const [a, b, c] = [await mintTask(author, doer), await mintTask(author, doer), await mintTask(author, doer)];
    const tg = { chatId: 990001, messageId: 41 };
    await sentCopy(doer.id, 'TasksDue', {
      text: '✅ Sizning vazifalaringiz\n\n🟡 Bugunga (3)',
      tasks: [
        { id: a, title: 'A' },
        { id: b, title: 'B' },
        { id: c, title: 'C' },
      ],
    }, tg);
    const marks = () => method('editMessageReplyMarkup').filter((call) => call.body.message_id === tg.messageId);

    await completeTask(a, '', ctxOf(doer));
    await vi.waitFor(() => expect(marks()).toHaveLength(1), { timeout: 5_000 });
    expect(marks()[0]!.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: '✅ B', callback_data: `tb:${b}` }], [{ text: '✅ C', callback_data: `tb:${c}` }]],
    });
    // The digest is never stamped «✅ Bajarildi» — that would be the other two tasks' copy too.
    expect(method('editMessageText').filter((call) => call.body.message_id === tg.messageId)).toHaveLength(0);

    await cancelTask(b, '', ctxOf(author));
    await vi.waitFor(() => expect(marks()).toHaveLength(2), { timeout: 5_000 });
    expect(marks()[1]!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: '✅ C', callback_data: `tb:${c}` }]] });

    await completeTask(c, '', ctxOf(doer));
    await vi.waitFor(() => expect(marks()).toHaveLength(3), { timeout: 5_000 });
    // Nothing left open: no markup, which Telegram reads as «remove the keyboard».
    expect(marks()[2]!.body).not.toHaveProperty('reply_markup');
  });

  it('a sent single copy gains the outcome line and keeps only its link; a pending one is muted', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(author, doer);
    const tg = { chatId: 990002, messageId: 42 };
    await sentCopy(doer.id, 'TaskAssigned', { taskId: id, origin: 'hand', text: `🆕 Yangi vazifa: X\n🔗 ${APP}/bugun` }, tg);
    const waiting = await pendingCopy(doer.id, 'TaskReminder', { taskId: id, text: '🔔 Eslatma: X' });
    await retireTaskCopies({ taskIds: [id], outcome: 'done' });
    const [edit] = method('editMessageText');
    expect(edit!.body).toMatchObject({ chat_id: tg.chatId, message_id: tg.messageId });
    expect(String(edit!.body.text)).toMatch(/\n\n✅ Bajarildi$/);
    expect(edit!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: '↗️ Ochish', url: `${APP}/bugun` }]] });
    expect(await notificationRow(waiting)).toMatchObject({ status: 'muted', error: 'closed before it was sent' });
  });

  it('a reassign spares the NEW holder, anything made after the move, and the pressed message itself', async () => {
    const author = await mintStaff();
    const oldHolder = await mintStaff();
    const newHolder = await mintStaff();
    const id = await mintTask(author, oldHolder);
    const before = new Date(Date.now() - 60_000);
    const at = new Date();
    const after = new Date(Date.now() + 60_000);
    const oldCopy = await pendingCopy(oldHolder.id, 'TaskAssigned', { taskId: id, text: 'eski' }, before);
    const newCopy = await pendingCopy(newHolder.id, 'TaskAssigned', { taskId: id, text: 'yangi' }, before);
    // The author's «boshqaga o‘tdi», queued by the move itself: A→B→A must not stamp it.
    const authorsNews = await pendingCopy(author.id, 'TaskReassigned', { taskId: id, text: 'o‘tdi' }, after);
    await sentCopy(oldHolder.id, 'TaskAssigned', { taskId: id, text: 'eski 1' }, { chatId: 990003, messageId: 1 });
    await sentCopy(oldHolder.id, 'TaskAssigned', { taskId: id, text: 'eski 2' }, { chatId: 990003, messageId: 2 });
    await db.update(notifications).set({ createdAt: before }).where(inArray(notifications.id, rowsMade.slice(-2)));

    await retireTaskCopies({
      taskIds: [id],
      outcome: 'reassigned',
      since: new Date(Date.now() - 3_600_000),
      until: at,
      exceptUserIds: [newHolder.id],
      exceptMessages: [{ chatId: 990003, messageId: 2 }],
    });
    expect((await notificationRow(oldCopy)).status).toBe('muted');
    expect((await notificationRow(newCopy)).status).toBe('pending');
    expect((await notificationRow(authorsNews)).status).toBe('pending');
    const edits = method('editMessageText');
    expect(edits.map((e) => e.body.message_id)).toEqual([1]);
    expect(String(edits[0]!.body.text)).toMatch(/👤 Boshqaga berildi$/);
  });
});

describe('the drain re-checks a task copy at SEND time (telegram-mechanics-5)', () => {
  it('a copy of a task that closed meanwhile is muted, never sent with live buttons', async () => {
    const author = await mintStaff();
    const doer = await mintStaff({ chat: true });
    const id = await mintTask(author, doer, { status: 'done', doneAt: new Date() });
    const row = await pendingCopy(doer.id, 'TaskAssigned', { taskId: id, origin: 'hand', text: '🆕 Yangi vazifa: X' });
    await drainOnly([row]);
    expect(method('sendMessage')).toHaveLength(0);
    expect(await notificationRow(row)).toMatchObject({ status: 'muted', error: 'closed before it was sent' });
  });

  it('the assignee’s copy of a task handed on meanwhile is muted; the author’s question copy still goes', async () => {
    const author = await mintStaff({ chat: true });
    const was = await mintStaff({ chat: true });
    const now = await mintStaff();
    const id = await mintTask(author, now);
    const stale = await pendingCopy(was.id, 'TaskReminder', { taskId: id, origin: 'hand', text: '🔔 Eslatma: X' });
    const question = await pendingCopy(author.id, 'TaskQuestion', { taskId: id, text: '❓ Savol: X\nqachon?' });
    await drainOnly([stale, question]);
    expect(await notificationRow(stale)).toMatchObject({ status: 'muted', error: 'handed on before it was sent' });
    expect((await notificationRow(question)).status).toBe('sent');
    const [send] = method('sendMessage');
    expect(send!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: '💬 Javob berish', callback_data: `tr:${id}` }]] });
  });

  it('a 👀 pressed on an earlier copy is not drawn again', async () => {
    const author = await mintStaff();
    const doer = await mintStaff({ chat: true });
    const id = await mintTask(author, doer, { acceptedAt: new Date() });
    const row = await pendingCopy(doer.id, 'TaskAnswer', { taskId: id, origin: 'hand', accepted: false, text: '💬 Javob: X\nshu' });
    await drainOnly([row]);
    const keyboard = (method('sendMessage')[0]!.body.reply_markup as { inline_keyboard: { callback_data?: string }[][] }).inline_keyboard;
    expect(keyboard.flat().map((b) => b.callback_data)).not.toContain(`tk:${id}`);
    expect(keyboard.flat().map((b) => b.callback_data)).toContain(`t:${id}`);
  });

  it('a queued digest goes out with buttons for the tasks still open only', async () => {
    const author = await mintStaff();
    const doer = await mintStaff({ chat: true });
    const open = await mintTask(author, doer);
    const closed = await mintTask(author, doer, { status: 'done', doneAt: new Date() });
    const row = await pendingCopy(doer.id, 'TasksDue', {
      text: '✅ Sizning vazifalaringiz',
      tasks: [
        { id: closed, title: 'Yopiq' },
        { id: open, title: 'Ochiq' },
      ],
    });
    await drainOnly([row]);
    expect(method('sendMessage')[0]!.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: '✅ Ochiq', callback_data: `tb:${open}` }]],
    });
  });

  it('the author’s messages are forwarded BEFORE the text, in order, once — a moment’s refusal sends nothing', async () => {
    const author = await mintStaff();
    const doer = await mintStaff({ chat: true });
    const id = await mintTask(author, doer);
    const row = await pendingCopy(doer.id, 'TaskAssigned', {
      taskId: id,
      origin: 'hand',
      forwards: [
        { chatId: 4242, messageId: 9 },
        { chatId: 4242, messageId: 7 },
      ],
      text: '🆕 Yangi vazifa: Ovozli',
    });
    // Telegram blinks on the forward: the text must not go without them.
    answers = [{ status: 502, json: { ok: false, description: 'Bad Gateway' } }];
    await drainOnly([row]);
    expect(calls.map((c) => c.method)).toEqual(['forwardMessages']);
    expect(await notificationRow(row)).toMatchObject({ status: 'pending' });
    expect((await notificationRow(row)).payload).not.toHaveProperty('forwarded');

    calls = [];
    __resetTelegramPause();
    await drainOnly([row]);
    expect(calls.map((c) => c.method)).toEqual(['forwardMessages', 'sendMessage']);
    expect(calls[0]!.body).toMatchObject({ from_chat_id: 4242, message_ids: [7, 9] });
    const sent = await notificationRow(row);
    expect(sent.status).toBe('sent');
    expect(sent.payload).toMatchObject({ forwarded: true });
  });

  it('a forward refused for GOOD lets the text go alone, marked forwarded so a retry does not try again', async () => {
    const author = await mintStaff();
    const doer = await mintStaff({ chat: true });
    const id = await mintTask(author, doer);
    const row = await pendingCopy(doer.id, 'TaskAssigned', {
      taskId: id,
      origin: 'hand',
      forwards: [{ chatId: 4242, messageId: 3 }],
      text: '🆕 Yangi vazifa: Yo‘qolgan xabar',
    });
    answers = [{ status: 400, json: { ok: false, description: 'Bad Request: message to forward not found' } }];
    await drainOnly([row]);
    expect(calls.map((c) => c.method)).toEqual(['forwardMessages', 'sendMessage']);
    expect(await notificationRow(row)).toMatchObject({ status: 'sent', payload: expect.objectContaining({ forwarded: true }) });
  });
});

describe('the bot doors (telegram-mechanics-1/4/13/14)', () => {
  it('a press on an open calc job is refused AT THE PRESS, naming the job’s screen', async () => {
    const author = await mintStaff();
    const ved = await mintStaff({ chat: true });
    const requestId = await mintRequest({ open: true });
    const id = await mintTask(author, ved, { origin: 'calc', boundId: requestId });
    const check = await taskPressCheck(ved.chat!, id, 'act');
    expect(check).toEqual({ ok: false, result: 'calc_use_screen', requestId });
    if (check.ok) throw new Error('unreachable');
    expect(pressRefusalText(check, APP)).toBe(`${TASK_ANSWERS.calc_use_screen}\n${APP}/hisoblash/${requestId}`);
    // …and the typed-result door says the same in words, never a rethrow.
    expect(await completeTaskFromBot(ved.chat!, id, 'tayyor')).toBe('calc_use_screen');
    expect(await completeTaskFromBot(123n, id, 'tayyor')).toBe('not_linked');
    expect(await taskPressCheck(ved.chat!, id, 'author')).toEqual({ ok: false, result: 'not_author' });
  });

  it('the draft becomes a hand task under the chat’s person, with its sources and the via', async () => {
    const author = await mintStaff({ chat: true });
    const doer = await mintStaff({ chat: true });
    const sources = [{ chatId: Number(author.chat), messageId: 11 }];
    const made = await createTaskFromDraft(
      author.chat!,
      { assigneeId: doer.id, title: `Telegramdan ${STAMP}`, note: 'GS777 ni tekshir', sources, files: [] },
      { dueAt: '2027-01-02', tzOffsetMin: null },
    );
    if (!made.ok) throw new Error(made.result);
    taskIds.push(made.taskId);
    expect(made).toMatchObject({ self: false, reach: 'ok', assigneeName: doer.name });
    const row = await taskRow(made.taskId);
    expect(row).toMatchObject({ origin: 'hand', createdBy: author.id, entityType: null, sourceMessages: sources });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'task'), eq(auditLog.entityId, made.taskId), eq(auditLog.action, 'create')));
    expect(audit!.after).toMatchObject({ origin: 'hand', via: 'telegram' });
    const [copy] = await queued(doer.id, 'TaskAssigned');
    expect(copy!.payload).toMatchObject({ taskId: made.taskId, origin: 'hand', bound: false, accepted: false, forwards: sources });
    expect((copy!.payload as { text: string }).text).toContain('📝 GS777 ni tekshir');
  });

  it('a pick with no linked chat is told; a task to yourself is not news', async () => {
    const author = await mintStaff({ chat: true });
    const offline = await mintStaff();
    const toThem = await createTaskFromDraft(
      author.chat!,
      { assigneeId: offline.id, title: 'Saytda ko‘radi', note: '', sources: [], files: [] },
      { dueAt: '', tzOffsetMin: null },
    );
    if (!toThem.ok) throw new Error(toThem.result);
    taskIds.push(toThem.taskId);
    expect(toThem.reach).toBe('no_chat');
    const self = await createTaskFromDraft(
      author.chat!,
      { assigneeId: author.id, title: 'O‘zimga', note: '', sources: [], files: [] },
      { dueAt: '', tzOffsetMin: null },
    );
    if (!self.ok) throw new Error(self.result);
    taskIds.push(self.taskId);
    expect(self.self).toBe(true);
    expect(await queued(author.id, 'TaskAssigned')).toHaveLength(0);
    expect(
      await createTaskFromDraft(123n, { assigneeId: author.id, title: 'x', note: '', sources: [], files: [] }, { dueAt: '', tzOffsetMin: null }),
    ).toEqual({ ok: false, result: 'not_linked' });
  });

  it('«📤 Men bergan» from the bot, and a 🔔 that says who will not hear it', async () => {
    const author = await mintStaff({ chat: true });
    const doer = await mintStaff();
    const id = await mintTask(author, doer, { title: `Bergan ${STAMP}` });
    const given = await givenFromBot(author.chat!);
    expect(given!.text).toContain('Siz bergan ochiq vazifalar (1)');
    expect(given!.text).toContain(`Bergan ${STAMP}`);
    expect(given!.buttons).toEqual([[{ text: `🔔 Bergan ${STAMP}`, callback_data: `te:${id}` }]]);
    expect(await remindTaskFromBot(author.chat!, id)).toEqual({ result: 'done', reach: 'no_chat', name: doer.name });
    expect((await remindTaskFromBot(author.chat!, id)).result).toBe('remind_too_soon');
  });
});

describe('the day list and the web lists draw a calc job for its reader (telegram-mechanics-3, VED-TARIX §8)', () => {
  it('the day message links an open calc job instead of a ✅, and counts the undated pile', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const requestId = await mintRequest({ open: true });
    const today = new Date();
    today.setUTCHours(23, 59, 59, 999);
    const calc = await mintTask(author, doer, { origin: 'calc', boundId: requestId, dueAt: today });
    const hand = await mintTask(author, doer, { dueAt: today });
    await mintTask(author, doer);
    await mintTask(author, doer);
    const day = await composeMyDay(doer.id);
    expect(day!.tasks).toEqual(
      expect.arrayContaining([
        { id: calc, title: expect.any(String), calc: requestId },
        { id: hand, title: expect.any(String) },
      ]),
    );
    expect(day!.text.endsWith('\n\n+ 2 ta muddatsiz')).toBe(true);
  });

  it('the VED reads «🧮» to the job; anybody else a chip; nobody a ✅ or a reassign select', async () => {
    const author = await mintStaff();
    const ved = await mintStaff();
    const requestId = await mintRequest({ open: true });
    const calc = await mintTask(author, ved, { origin: 'calc', boundId: requestId, entityType: 'lead', entityId: leadId });
    const hand = await mintTask(author, ved);
    const rows = [(await byId(calc))!, (await byId(hand))!];
    const forVed = await toTaskViews(rows, { id: ved.id, permissions: new Set(['ved.docs']) });
    const forSeller = await toTaskViews(rows, { id: author.id, permissions: new Set(['crm.leads']) });
    expect(forVed[0]).toMatchObject({
      calc: { href: `/hisoblash/${requestId}`, mayOpen: true },
      aboutHref: `/hisoblash/${requestId}`,
      canReassign: false,
    });
    expect(forSeller[0]).toMatchObject({
      calc: { href: `/hisoblash/${requestId}`, mayOpen: false },
      aboutHref: `/crm/leads/${leadId}`,
      canReassign: false,
    });
    expect(forVed[1]).toMatchObject({ calc: null, canReassign: true });
  });
});

describe('a task’s files (his 3a; access-money-11, telegram-mechanics-26)', () => {
  async function attach(taskId: string, uploadedBy: string, name: string, contentType: string): Promise<string> {
    const [row] = await db
      .insert(attachments)
      .values({
        entityType: TASK_ENTITY_TYPE,
        entityId: taskId,
        storageKey: `itest/topshiriq/${STAMP}/${filesMade.length}-${name}`,
        fileName: name,
        contentType,
        sizeBytes: 3,
        uploadedBy,
      })
      .returning({ id: attachments.id });
    filesMade.push(row!.id);
    return row!.id;
  }
  const reader = (person: Person, ...perms: string[]) => ({
    id: person.id,
    permissions: new Set(perms),
    warehouseScoped: true,
    warehouseIds: [] as string[],
  });

  it('every list reads the files in ONE grouped query, by kind', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const a = await mintTask(author, doer);
    const b = await mintTask(author, doer);
    const voice = await attach(a, author.id, 'voice_1.ogg', 'audio/ogg');
    const photo = await attach(a, author.id, 'rasm.jpg', 'image/jpeg');
    const pdf = await attach(b, author.id, 'hisob.pdf', 'application/pdf');
    const files = await taskFiles([a, b]);
    expect(files.get(a)).toEqual([
      { id: voice, name: 'voice_1.ogg', kind: 'audio' },
      { id: photo, name: 'rasm.jpg', kind: 'image' },
    ]);
    expect(files.get(b)).toEqual([{ id: pdf, name: 'hisob.pdf', kind: 'file' }]);
  });

  it('the task’s people read them; a stranger does not — and the refusal is ENFORCED', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const stranger = await mintStaff();
    const id = await mintTask(author, doer);
    const file = await attach(id, author.id, 'ovoz.ogg', 'audio/ogg');
    const row = { id: file, entityType: TASK_ENTITY_TYPE, entityId: id, uploadedBy: author.id };
    expect((await decideAttachmentRead(reader(doer), row)).allow).toBe(true);
    expect((await decideAttachmentRead(reader(stranger, 'crm.leads.view_all'), row)).allow).toBe(true);
    const refused = await decideAttachmentRead(reader(stranger, 'receipts.edit'), row);
    expect(refused).toMatchObject({ allow: false, rule: 'task-not-yours', enforce: true });
  });

  it('only the AUTHOR deletes one — `receipts.edit` is a receipt-era rule — and a note part never through here', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(author, doer);
    const file = await attach(id, author.id, 'ochiriladi.ogg', 'audio/ogg');
    const code = async (run: Promise<void>) => {
      try {
        await run;
        return 'deleted';
      } catch (err) {
        if (err instanceof AttachmentDeleteError) return err.code;
        throw err;
      }
    };
    expect(await code(deleteAttachment(file, { id: doer.id, permissions: new Set(['receipts.edit']) }))).toBe('forbidden');
    expect(await code(deleteAttachment(file, { id: author.id, permissions: new Set() }))).toBe('deleted');
    const [note] = await db
      .insert(attachments)
      .values({
        entityType: 'staff_note',
        entityId: id,
        storageKey: `itest/topshiriq/${STAMP}/note-part`,
        fileName: 'manzil.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 3,
        uploadedBy: author.id,
      })
      .returning({ id: attachments.id });
    filesMade.push(note!.id);
    expect(await code(deleteAttachment(note!.id, { id: author.id, permissions: new Set(['receipts.edit']) }))).toBe('forbidden');
  });

  it('the download job stores each file once, skips what Telegram refuses, and retries a moment’s failure', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const id = await mintTask(author, doer);
    const voice = { fileId: 'AwACAgIAAxkBAAIBvoice', name: null, mime: 'audio/ogg', size: 3, kind: 'voice' as const };
    const gone = { fileId: 'BQACAgIAAxkBAAIBgone', name: 'katta.zip', mime: 'application/zip', size: 3, kind: 'document' as const };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(Buffer.from('ogg'), { status: 200 })),
    );
    answers = [
      { status: 200, json: { ok: true, result: { file_path: 'voice/file_1.oga' } } },
      { status: 400, json: { ok: false, description: 'Bad Request: file is too big' } },
    ];
    expect(await downloadTaskFiles({ taskId: id, uploadedBy: author.id, files: [voice, gone] })).toEqual({ stored: 1, skipped: 1 });
    const stored = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.entityType, TASK_ENTITY_TYPE), eq(attachments.entityId, id)));
    expect(stored.map((r) => [r.fileName, r.contentType, r.uploadedBy])).toEqual([[taskFileName(voice), 'audio/ogg', author.id]]);
    // A re-delivered job: the stored one is skipped by its name, nothing lands twice.
    answers = [{ status: 400, json: { ok: false, description: 'Bad Request: file is too big' } }];
    expect(await downloadTaskFiles({ taskId: id, uploadedBy: author.id, files: [voice, gone] })).toEqual({ stored: 0, skipped: 2 });
    // A 5xx is a moment: the job throws so pg-boss runs it again.
    answers = [{ status: 502, json: { ok: false, description: 'Bad Gateway' } }];
    const fresh = { ...voice, fileId: 'AwACAgIAAxkBAAIBnext' };
    await expect(downloadTaskFiles({ taskId: id, uploadedBy: author.id, files: [fresh] })).rejects.toThrow(/not downloaded yet/);
  });
});
