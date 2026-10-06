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
import { __resetDrafts, activeDraft } from '@/modules/platform/telegram/task-draft';
import {
  answerPendingText,
  BUSY_DRAFT,
  draftMedia,
  draftText,
  handleDraftCallback,
  handleForwardCallback,
  handleTaskPress,
  pickAssignee,
  startTaskDraft,
} from '@/modules/platform/telegram/task-handlers';
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

const message = (chat: bigint, id: number, extra: Record<string, unknown>) => ({
  message_id: id,
  date: 0,
  chat: { id: Number(chat), type: 'private' },
  ...extra,
});
const forwarded = { forward_origin: { type: 'hidden_user', sender_user_name: 'Mijoz', date: 0 } };
const photo = (n: number, size = 10) => [{ file_id: `AgACphoto${STAMP}${n}`, file_unique_id: `u${n}`, width: 1, height: 1, file_size: size }];

async function tasksBy(author: Person) {
  return db.select().from(tasks).where(eq(tasks.createdBy, author.id));
}

/** A draft with a picked colleague and one typed line, ready for a due. */
async function readyDraft(author: Person, doer: Person, line = `GS777 ni yukla ${STAMP}`): Promise<void> {
  await startTaskDraft(ctxFor(author.chat).ctx, author.chat);
  await pickAssignee(ctxFor(author.chat).ctx, author.chat, doer.id);
  const { ctx } = ctxFor(author.chat, { message: message(author.chat, (messageSeq += 1), { text: line }) });
  await draftText(ctx, author.chat, activeDraft(author.chat)!);
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


/** A press on Door B's «📌 Topshiriq qilish», under the forwarded message it replied to. */
async function pressDoorB(person: Person, original: Record<string, unknown>, step: 'task' | 'search' = 'task') {
  const { ctx, said } = ctxFor(person.chat, {
    callbackQuery: { data: `fb:${step}`, message: { message_id: (messageSeq += 1), reply_to_message: original } },
  });
  await handleForwardCallback(ctx, person.chat, step, async () => {});
  return said;
}

describe('Door B never replaces a live draft (review bot-2)', () => {
  it('an old «📌 Topshiriq qilish» pressed mid-draft is refused in words; the pick and the lines stand', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    await readyDraft(author, doer, 'Ertaga GS777 ni yukla, 40 karobka');
    const before = activeDraft(author.chat)!;
    const offer = message(author.chat, (messageSeq += 1), { ...forwarded, text: 'mijozning gapi' });
    const said = await pressDoorB(author, offer);
    expect(said.replies.map((r) => r.text)).toEqual([BUSY_DRAFT]);
    const after = activeDraft(author.chat)!;
    expect(after).toMatchObject({ assigneeId: doer.id, stage: before.stage, texts: ['Ertaga GS777 ni yukla, 40 karobka'] });
    expect(after.sources).toEqual(before.sources);
    // The offer's keyboard was left alone, so the same press works once this draft is done.
    expect(sent.filter((c) => c.method === 'editMessageReplyMarkup')).toHaveLength(0);
  });

  it('a SEEDED start over a live draft is refused too — no door into startTaskDraft may overwrite one', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    await readyDraft(author, doer, 'Birinchi topshiriq');
    const { ctx, said } = ctxFor(author.chat);
    await startTaskDraft(ctx, author.chat, { sources: [{ chatId: Number(author.chat), messageId: 1 }], firstForwarded: true });
    expect(said.replies[0]!.text).toBe('Sizda tugallanmagan topshiriq bor — davom eting yoki bekor qiling.');
    expect(activeDraft(author.chat)).toMatchObject({ assigneeId: doer.id, texts: ['Birinchi topshiriq'], sources: [] });
  });
});

describe('an album sent while «Kimga?» stands (review bot-3)', () => {
  const albumPart = async (person: Person, group: string, n: number) => {
    const { ctx, said } = ctxFor(person.chat, {
      message: message(person.chat, (messageSeq += 1), { media_group_id: group, photo: photo(n) }),
    });
    await draftMedia(ctx, person.chat);
    return said.replies.map((r) => r.text);
  };

  it('is acknowledged ONCE, not once per photo', async () => {
    const author = await mintStaff();
    await startTaskDraft(ctxFor(author.chat).ctx, author.chat);
    const replies: string[] = [];
    for (let i = 0; i < 5; i++) replies.push(...(await albumPart(author, `who-${STAMP}`, i)));
    expect(replies).toEqual(['📎 Qabul qilindi. Endi kimga ekanini tanlang.']);
  });

  it('a due pressed before it settles is HELD — and the settle timer then makes the task with every photo', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    await startTaskDraft(ctxFor(author.chat).ctx, author.chat);
    for (let i = 0; i < 3; i++) await albumPart(author, `held-${STAMP}`, 10 + i);
    const pick = ctxFor(author.chat);
    await pickAssignee(pick.ctx, author.chat, doer.id);
    // No due keyboard while the album is still arriving — the timer shows it.
    expect(pick.said.replies.map((r) => r.text).join('\n')).not.toContain('Muddat?');
    const due = ctxFor(author.chat);
    await handleDraftCallback(due.ctx, author.chat, 'due_e');
    expect(due.said.replies.map((r) => r.text)).toEqual(['⏳ Albom hali yuklanmoqda — tugashi bilan topshiriq beriladi.']);
    await vi.waitFor(async () => expect(await tasksBy(author)).toHaveLength(1), { timeout: 5_000, interval: 200 });
    const [task] = await tasksBy(author);
    expect(task!.sourceMessages).toHaveLength(3);
    expect(activeDraft(author.chat)).toBeNull();
  });
});

describe('Door B takes what was forwarded WHOLE (review bot-4, bot-7)', () => {
  it('a forwarded four-photo album becomes a task with four sources AND four files for the web', async () => {
    const author = await mintStaff();
    const group = `fwd-${STAMP}`;
    const parts: Record<string, unknown>[] = [];
    const offers: string[] = [];
    for (let i = 0; i < 4; i++) {
      const part = message(author.chat, (messageSeq += 1), { ...forwarded, media_group_id: group, photo: photo(20 + i) });
      parts.push(part);
      const { ctx, said } = ctxFor(author.chat, { message: part });
      expect(await draftMedia(ctx, author.chat)).toBe(true);
      offers.push(...said.replies.map((r) => r.text));
    }
    expect(offers).toEqual(['📌 Topshiriq qilamizmi?']);
    const said = await pressDoorB(author, parts[0]!);
    const draft = activeDraft(author.chat)!;
    expect(draft.sources).toHaveLength(4);
    expect(draft.files.map((f) => f.fileId).sort()).toEqual([20, 21, 22, 23].map((n) => `AgACphoto${STAMP}${n}`).sort());
    // Nothing to tell: every part's file is in hand.
    expect(said.replies.map((r) => r.text).join('\n')).not.toContain('⚠');
  });

  it('a forwarded video over 20 MB is told at the end — «Telegramda yuborildi», not silence', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    const video = message(author.chat, (messageSeq += 1), {
      ...forwarded,
      video: { file_id: `BAAvideo${STAMP}`, file_unique_id: 'v', width: 1, height: 1, duration: 1, file_name: 'sklad.mp4', file_size: 50 * 1024 * 1024 },
    });
    await pressDoorB(author, video);
    expect(activeDraft(author.chat)).toMatchObject({ files: [], tooBig: ['sklad.mp4'] });
    await pickAssignee(ctxFor(author.chat).ctx, author.chat, doer.id);
    const due = ctxFor(author.chat);
    await handleDraftCallback(due.ctx, author.chat, 'due_n');
    expect(due.said.replies.at(-1)!.text).toContain('⚠ Saytga yuklanmadi — 20 MB dan katta; Telegramda yuborildi: sklad.mp4');
  });
});

describe('a refused task comes back ASKING (review bot-5)', () => {
  it('the person left between the pick and the press: told why, «Kimga?» asked again, every line kept', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    await readyDraft(author, doer, 'Ertaga GS777 ni yukla');
    await db.update(users).set({ active: false }).where(eq(users.id, doer.id));
    const due = ctxFor(author.chat);
    await handleDraftCallback(due.ctx, author.chat, 'due_e');
    const replies = due.said.replies.map((r) => r.text);
    expect(replies[0]).toBe('⚠ Bu hodim ishdan ketgan.');
    // …and the question is asked, with the people to pick from.
    expect(replies[1]).toMatch(/^👤 Kimga\?/);
    expect(due.said.replies[1]!.extra).toHaveProperty('reply_markup.inline_keyboard');
    expect(activeDraft(author.chat)).toMatchObject({ stage: 'who', assigneeId: null, texts: ['Ertaga GS777 ni yukla'] });
    expect(await tasksBy(author)).toHaveLength(0);
  });
});

describe('parts the task cannot take are said, never swallowed (review bot-11)', () => {
  it('past the ten-source cap the author is told ONCE', async () => {
    const author = await mintStaff();
    const doer = await mintStaff();
    await readyDraft(author, doer);
    const replies: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { ctx, said } = ctxFor(author.chat, { message: message(author.chat, (messageSeq += 1), { ...forwarded, text: `xabar ${i}` }) });
      await draftText(ctx, author.chat, activeDraft(author.chat)!);
      replies.push(...said.replies.map((r) => r.text));
    }
    expect(replies.filter((text) => text.startsWith('⚠ Bitta topshiriqqa ko‘pi bilan 10 ta xabar'))).toHaveLength(1);
    expect(activeDraft(author.chat)!.sources).toHaveLength(10);
  });
});
