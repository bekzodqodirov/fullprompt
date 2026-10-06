import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The staff bot's topshiriq HANDLERS against a real database (review bot-2..12):
 * the grammy shell is driven with a stand-in context that records what the
 * bot says, the Telegram transport is a recorder, and the job queue is stood
 * in for so a draft's files are SEEN queued and never downloaded. Every
 * person and task here is this file's own.
 */
const queuedJobs = vi.hoisted(() => [] as { name: string; data: unknown }[]);
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (name: string, data: unknown) => {
    queuedJobs.push({ name, data });
  }),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import { calcRequests, leads, leadStages, notifications, tasks, telegramLinks, users } from '@/modules/platform/db/schema';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { __resetDrafts } from '@/modules/platform/telegram/task-draft';
import { answerPendingText, handleTaskPress } from '@/modules/platform/telegram/task-handlers';
import { parseCallback } from '@/modules/platform/telegram/staff-bot';

const APP = 'https://test.gsrwms.uz';
const STAMP = String(Date.now()).slice(-7);
let seq = 0;
const people: string[] = [];
const requests: string[] = [];
const leadIds: string[] = [];
let stageId: string;
const savedEnv = { token: process.env.TELEGRAM_BOT_TOKEN, app: process.env.APP_URL };
let sent: { method: string; body: Record<string, unknown> }[] = [];

interface Person {
  id: string;
  name: string;
  chat: bigint;
}

async function mintStaff(): Promise<Person> {
  seq += 1;
  const name = `Bot topshiriq ${STAMP}-${seq}`;
  const [user] = await db
    .insert(users)
    .values({ phone: `+99895${String(Number(STAMP) + seq).padStart(7, '0').slice(-7)}`, fullName: name, passwordHash: 'x', locale: 'uz', active: true })
    .returning({ id: users.id });
  people.push(user!.id);
  const chat = BigInt(760_000_000 + Number(STAMP) * 10 + seq);
  await db.insert(telegramLinks).values({ userId: user!.id, telegramChatId: chat, status: 'linked', linkedAt: new Date() });
  return { id: user!.id, name, chat };
}

/** What the bot said back, in order — the reply, and the toast of a press. */
interface Said {
  replies: { text: string; extra?: Record<string, unknown> }[];
  toasts: (string | undefined)[];
}

let messageSeq = 5_000;
function ctxFor(chat: bigint, extra: Record<string, unknown> = {}): { ctx: never; said: Said } {
  const said: Said = { replies: [], toasts: [] };
  const ctx = {
    chat: { id: Number(chat), type: 'private' },
    from: { id: Number(chat) },
    reply: async (text: string, e?: Record<string, unknown>) => {
      said.replies.push({ text, extra: e });
      return { message_id: (messageSeq += 1) };
    },
    answerCallbackQuery: async (e?: { text?: string }) => {
      said.toasts.push(e?.text);
      return true;
    },
    api: {},
    ...extra,
  };
  return { ctx: ctx as never, said };
}

beforeAll(async () => {
  stageId = (await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'open')))[0]!.id;
});

beforeEach(() => {
  __resetDrafts();
  sent = [];
  queuedJobs.length = 0;
  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  process.env.APP_URL = APP;
  __setTelegramTransport(async (url, init) => {
    sent.push({ method: url.slice(url.lastIndexOf('/') + 1), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: { message_id: (messageSeq += 1) } }), { status: 200 });
  });
});

afterEach(() => {
  __setTelegramTransport(null);
});

afterAll(async () => {
  // A settle timer a test armed may still be finishing.
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (people.length) {
    await db.delete(notifications).where(inArray(notifications.userId, people));
    await db.execute(sql`UPDATE calc_requests SET task_id = NULL WHERE requested_by IN (${sql.join(people.map((p) => sql`${p}`), sql`, `)})`);
    await db.delete(tasks).where(inArray(tasks.createdBy, people));
  }
  if (requests.length) await db.delete(calcRequests).where(inArray(calcRequests.id, requests));
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

describe('an open calc job’s refusal names the job’s page on every door (review bot-12)', () => {
  async function openCalcTask(author: Person, ved: Person): Promise<{ taskId: string; requestId: string }> {
    const [lead] = await db
      .insert(leads)
      .values({ name: `Bot lid ${STAMP}-${leadIds.length}`, stageId, createdBy: author.id })
      .returning({ id: leads.id });
    leadIds.push(lead!.id);
    const [request] = await db
      .insert(calcRequests)
      .values({ entityType: 'lead', entityId: lead!.id, requestedBy: author.id, itemCount: 1, dueAt: new Date(Date.now() + 3_600_000) })
      .returning({ id: calcRequests.id });
    requests.push(request!.id);
    const [task] = await db
      .insert(tasks)
      .values({ title: `Hisob ${STAMP}`, assigneeId: ved.id, createdBy: author.id, origin: 'calc', boundId: request!.id, entityType: 'lead', entityId: lead!.id })
      .returning({ id: tasks.id });
    await db.update(calcRequests).set({ taskId: task!.id }).where(eq(calcRequests.id, request!.id));
    return { taskId: task!.id, requestId: request!.id };
  }
  const press = async (person: Person, data: string) => {
    const parsed = parseCallback(data)!;
    const { ctx, said } = ctxFor(person.chat, {
      callbackQuery: { data, message: { message_id: 77, text: '🆕 Yangi vazifa: X' } },
    });
    await handleTaskPress(ctx, person.chat, parsed as never);
    return said;
  };

  it('👀, ⏰ «Ertaga», 🗑 and a typed ⏰ date all say «use the screen» WITH the page', async () => {
    const author = await mintStaff();
    const ved = await mintStaff();
    const { taskId, requestId } = await openCalcTask(author, ved);
    const page = `${APP}/hisoblash/${requestId}`;
    // A copy queued before 0124 still draws 👀 and ⏰ on a calc task.
    for (const [who, data] of [
      [ved, `tk:${taskId}`],
      [ved, `tp:e:${taskId}`],
      [author, `tc:${taskId}`],
    ] as const) {
      const said = await press(who, data);
      expect(said.replies.at(-1)?.text, data).toContain(page);
    }
    const { ctx, said } = ctxFor(ved.chat);
    await answerPendingText(ctx, ved.chat, { kind: 'reschedule', taskId, pressed: null }, '12.10');
    expect(said.replies.at(-1)!.text).toContain(page);
  });
});

