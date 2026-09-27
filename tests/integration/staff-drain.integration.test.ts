import 'dotenv/config';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { notifications, telegramLinks, users } from '@/modules/platform/db/schema';
import {
  __resetTelegramPause,
  sendPendingTelegram,
} from '@/modules/platform/notifications/service';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { htmlToPlain } from '@/modules/platform/telegram/format';

/**
 * The staff drain as Telegram sees it (round C).
 *
 * Nothing before this round showed what the drain POSTed — CI has no token
 * and this container no network — so the transport is swapped for a recorder
 * and every body is read back: the HTML, the buttons, the pause, the forward.
 *
 * The queue is SHARED with every other file's leftovers, and a claim takes the
 * oldest thirty — so before each run every foreign pending row is parked
 * (fresh claim, out of the reclaim window) and put back afterwards, exactly as
 * found (#713, #730). Every assertion is about this file's own rows.
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
let nextMessageId = 100;

const mine: string[] = [];
const parked = new Set<string>();
const people: string[] = [];

let staffId: string;
let ruStaffId: string;
const CHAT = 700_000_000 + Number(STAMP);
const RU_CHAT = CHAT + 1;

const savedEnv = { token: process.env.TELEGRAM_BOT_TOKEN, app: process.env.APP_URL };

async function mintStaff(locale: string, chat: number): Promise<string> {
  seq += 1;
  const [user] = await db
    .insert(users)
    .values({
      phone: `+99897${String(Number(STAMP) + seq).padStart(7, '0').slice(-7)}`,
      fullName: `Drain xodim ${STAMP}-${seq}`,
      passwordHash: 'x',
      locale,
      active: true,
    })
    .returning({ id: users.id });
  await db
    .insert(telegramLinks)
    .values({ userId: user!.id, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  people.push(user!.id);
  return user!.id;
}

async function queue(userId: string, type: string, payload: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(notifications)
    .values({ userId, channel: 'telegram', type, payload, status: 'pending' })
    .returning({ id: notifications.id });
  mine.push(row!.id);
  return row!.id;
}

/** Only this file's rows are claimable while the drain runs. */
async function drain(): Promise<void> {
  const others = await db
    .update(notifications)
    .set({ status: 'sending', claimedAt: new Date() })
    .where(
      and(
        eq(notifications.channel, 'telegram'),
        eq(notifications.status, 'pending'),
        mine.length ? notInArray(notifications.id, mine) : undefined,
      ),
    )
    .returning({ id: notifications.id });
  for (const row of others) parked.add(row.id);
  await sendPendingTelegram().catch(() => {});
}

async function rowOf(id: string) {
  const [row] = await db.select().from(notifications).where(eq(notifications.id, id));
  return row!;
}

const sends = () => calls.filter((c) => c.method === 'sendMessage');

beforeAll(async () => {
  staffId = await mintStaff('uz', CHAT);
  ruStaffId = await mintStaff('ru', RU_CHAT);
});

beforeEach(() => {
  calls = [];
  answers = [];
  __resetTelegramPause();
  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  process.env.APP_URL = APP;
  __setTelegramTransport(async (url, init) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    calls.push({ method, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = answers.shift() ?? { status: 200, json: { ok: true, result: { message_id: (nextMessageId += 1) } } };
    return new Response(JSON.stringify(next.json), { status: next.status });
  });
});

afterEach(async () => {
  __setTelegramTransport(null);
  // Each case's rows go with it: a row one case left pending (the paused
  // run, the counted failure) would be the NEXT case's first send and eat
  // the answer that case queued for its own row.
  if (mine.length) await db.delete(notifications).where(inArray(notifications.id, mine));
  mine.length = 0;
});

afterAll(async () => {
  if (mine.length) await db.delete(notifications).where(inArray(notifications.id, mine));
  if (parked.size) {
    await db
      .update(notifications)
      .set({ status: 'pending', claimedAt: null })
      .where(and(inArray(notifications.id, [...parked]), eq(notifications.status, 'sending')));
  }
  if (people.length) {
    await db.delete(notifications).where(inArray(notifications.userId, people));
    await db.delete(telegramLinks).where(inArray(telegramLinks.userId, people));
    await db.delete(users).where(inArray(users.id, people));
  }
  if (savedEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedEnv.token;
  if (savedEnv.app === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedEnv.app;
  await pgClient.end();
});

const TASK_ID = '11111111-2222-4333-8444-555555555555';

describe('a staff message is HTML built from its stored plain text', () => {
  it('bolds the title, escapes what was typed, and turns our link into a button', async () => {
    const id = await queue(staffId, 'TaskAssigned', {
      taskId: TASK_ID,
      text: `🆕 Yangi vazifa: <b>Tekshir</b> & yubor\n📅 30.09\n🔗 ${APP}/bitimlar/abc`,
    });
    await drain();
    const [send] = sends();
    expect(send!.body).toMatchObject({
      chat_id: CHAT,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    expect(send!.body.text).toBe('<b>🆕 Yangi vazifa: &lt;b&gt;Tekshir&lt;/b&gt; &amp; yubor</b>\n📅 30.09');
    // The task's own button first, the link LAST — buttonsFor's rows untouched.
    expect(send!.body.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '✅ Bajarildi', callback_data: `t:${TASK_ID}` }],
        [{ text: '↗️ Ochish', url: `${APP}/bitimlar/abc` }],
      ],
    });
    const row = await rowOf(id);
    expect(row.status).toBe('sent');
    // Which message it became — what an edit of it later needs.
    expect((row.payload as { tg?: unknown }).tg).toEqual({ chatId: CHAT, messageId: nextMessageId });
    // The STORED text is untouched: it still carries its link for its other readers.
    expect((row.payload as { text: string }).text).toContain(`${APP}/bitimlar/abc`);
  });

  it('an event-rendered text gets its button in the READER\'s language', async () => {
    await queue(ruStaffId, 'DebtApprovalRequested', {
      approvalId: TASK_ID,
      clientCode: 'GS301',
      clientName: 'Aziz',
      warehouseCode: 'TAS1',
      blockingDebtUsd: 250,
      requestedByName: 'Operator',
    });
    await drain();
    const [send] = sends();
    expect(String(send!.body.text)).toMatch(/^<b>🔐 Запрос: выдать груз должнику<\/b>\n/);
    expect(String(send!.body.text)).not.toContain('/approvals');
    expect(send!.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Ruxsat', callback_data: `a:1:${TASK_ID}` },
          { text: '⛔ Yo‘q', callback_data: `a:0:${TASK_ID}` },
        ],
        [{ text: '↗️ Открыть', url: `${APP}/approvals` }],
      ],
    });
  });

  it('a foreign link stays in the sentence and makes no button', async () => {
    await queue(staffId, 'InternalNote', { text: '📝 Ali · GS1\nqarang:\nhttps://example.com/x' });
    await drain();
    const [send] = sends();
    expect(String(send!.body.text)).toContain('https://example.com/x');
    expect(send!.body.reply_markup).toBeUndefined();
  });

  it('an offer is never bolded — its first line is the customer, forwarded to the customer', async () => {
    await queue(staffId, 'CalcOffer', { text: 'Aziz aka\nNarx: $100' });
    await drain();
    expect(sends()[0]!.body.text).toBe('Aziz aka\nNarx: $100');
  });

  it('a text past Telegram\'s ceiling goes capped and SAYS so, instead of failing six times', async () => {
    const id = await queue(staffId, 'DailyDigest', { text: `📊 Hisobot\n${'x'.repeat(5000)}` });
    await drain();
    const plain = htmlToPlain(String(sends()[0]!.body.text));
    expect(plain.length).toBeLessThan(4096);
    expect(plain.endsWith('… (qisqartirildi)')).toBe(true);
    expect((await rowOf(id)).status).toBe('sent');
  });

  it('a refused BUTTON puts the link back into the text — never a message that lost it', async () => {
    answers.push({ status: 400, json: { ok: false, description: 'Bad Request: BUTTON_URL_INVALID' } });
    const id = await queue(staffId, 'TaskAssigned', {
      taskId: TASK_ID,
      text: `🆕 Yangi vazifa: A\n🔗 ${APP}/bugun`,
    });
    await drain();
    const [first, second] = sends();
    expect(first!.body.reply_markup).toBeDefined();
    expect(String(second!.body.text)).toContain(`${APP}/bugun`);
    expect(second!.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: '✅ Bajarildi', callback_data: `t:${TASK_ID}` }]],
    });
    expect((await rowOf(id)).status).toBe('sent');
  });
});

describe('«not now» is not a failed attempt', () => {
  it('a 429 hands the WHOLE run back untouched and pauses every later kick', async () => {
    const a = await queue(staffId, 'InternalNote', { text: 'birinchi' });
    const b = await queue(staffId, 'InternalNote', { text: 'ikkinchi' });
    answers.push({
      status: 429,
      json: { ok: false, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } },
    });
    await drain();
    expect(sends()).toHaveLength(1);
    for (const id of [a, b]) {
      const row = await rowOf(id);
      expect(row.status, 'back in the queue').toBe('pending');
      expect(row.claimedAt, 'the claim released').toBeNull();
      expect(row.attempts, 'no attempt spent on a moment').toBe(0);
    }
    // A kick during the pause does not even claim.
    await drain();
    expect(sends()).toHaveLength(1);
    // After it, both go.
    __resetTelegramPause();
    await drain();
    expect(sends()).toHaveLength(3);
    expect((await rowOf(a)).status).toBe('sent');
    expect((await rowOf(b)).status).toBe('sent');
  });

  it('a refused TOKEN (401) waits too — a rotated token must not write the queue off', async () => {
    const a = await queue(staffId, 'InternalNote', { text: 'token' });
    answers.push({ status: 401, json: { ok: false, description: 'Unauthorized' } });
    await drain();
    const row = await rowOf(a);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
    await drain();
    expect(sends()).toHaveLength(1);
  });

  it('a real failure still counts an attempt, as before', async () => {
    const a = await queue(staffId, 'InternalNote', { text: 'server' });
    answers.push({ status: 502, json: { ok: false, description: 'Bad Gateway' } });
    await drain();
    const row = await rowOf(a);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
  });
});

describe('a customer\'s own message rides ahead of the sentence (contract 2)', () => {
  it('forwards the original first, then sends the text, and remembers it did', async () => {
    const id = await queue(staffId, 'ClientBotMessage', {
      text: '📎 GS777 (Aziz) botga fayl yubordi',
      forwardFrom: { chatId: 555_000, messageId: 9 },
    });
    await drain();
    expect(calls.map((c) => c.method)).toEqual(['forwardMessage', 'sendMessage']);
    expect(calls[0]!.body).toEqual({ chat_id: CHAT, from_chat_id: 555_000, message_id: 9 });
    const payload = (await rowOf(id)).payload as { forwarded?: boolean; tg?: unknown };
    expect(payload.forwarded).toBe(true);
    expect(payload.tg).toBeDefined();
  });

  it('a forward Telegram refuses does not stop the sentence', async () => {
    answers.push({ status: 400, json: { ok: false, description: 'Bad Request: message to forward not found' } });
    const id = await queue(staffId, 'ClientBotMessage', {
      text: '📎 GS777 (Aziz) botga fayl yubordi',
      forwardFrom: { chatId: 555_000, messageId: 10 },
    });
    await drain();
    expect(calls.map((c) => c.method)).toEqual(['forwardMessage', 'sendMessage']);
    const row = await rowOf(id);
    expect(row.status).toBe('sent');
    expect((row.payload as { forwarded?: boolean }).forwarded).toBeUndefined();
  });

  it('a forward that fails for a MOMENT keeps the row — the file exists nowhere else (CONV-4)', async () => {
    answers.push({ status: 502, json: { ok: false, description: 'Bad Gateway' } });
    const id = await queue(staffId, 'ClientBotMessage', {
      text: '📎 GS777 (Aziz) botga fayl yubordi',
      forwardFrom: { chatId: 555_000, messageId: 11 },
    });
    await drain();
    // No sentence without the file: the customer's photo lives only in their
    // private chat with the bot, which no person can open.
    expect(calls.map((c) => c.method)).toEqual(['forwardMessage']);
    const held = await rowOf(id);
    expect(held.status).toBe('pending');
    expect(held.attempts).toBe(1);

    calls.length = 0;
    await drain();
    expect(calls.map((c) => c.method)).toEqual(['forwardMessage', 'sendMessage']);
    const done = await rowOf(id);
    expect(done.status).toBe('sent');
    expect((done.payload as { forwarded?: boolean }).forwarded).toBe(true);
  });
});
