import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * A reply to the AI answer IS the seller's addition (docs/SAKKIZ-R3.md §9.6,
 * regression-2, regression-5, regression-18, re-check p4-8) — driven through
 * the bot's own ladders, registered on a stand-in bot, with the person's real
 * notification row as the thing replied to. The collector's table-answer path
 * is P3's and stood in here: what this file proves is WHO gets the text.
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => null),
}));
vi.mock('@/modules/wms/calc/prefill-queue', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/prefill-queue')>()),
  ticketStanding: vi.fn(async () => 'none' as const),
  queueCalcPrefill: vi.fn(async () => true),
}));
vi.mock('@/modules/platform/telegram/calc-dialog', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/calc-dialog')>()),
  routeCollectorText: vi.fn(async () => {}),
  deliverNextStep: vi.fn(async () => {}),
}));
vi.mock('@/modules/platform/telegram/reply-door', async (original) => {
  const real = await original<typeof import('@/modules/platform/telegram/reply-door')>();
  return { ...real, replyVerdictFor: vi.fn(real.replyVerdictFor) };
});
vi.mock('@/modules/wms/calc/service', async (original) => {
  const real = await original<typeof import('@/modules/wms/calc/service')>();
  return { ...real, storedRequestFacts: vi.fn(real.storedRequestFacts) };
});
vi.mock('@/modules/platform/telegram/staff-bot', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/staff-bot')>()),
  // The staff tail's first step: never reached by a reply the door owns.
  lookupFromBot: vi.fn(async () => null),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  deals,
  dealStages,
  events,
  notifications,
  tasks,
  telegramLinks,
  users,
} from '@/modules/platform/db/schema';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { activeIntake, endIntake, startIntake } from '@/modules/platform/telegram/calc-store';
import { routeCollectorText } from '@/modules/platform/telegram/calc-dialog';
import { lookupFromBot, noteTaskPending, peekTaskPending, dropTaskPending } from '@/modules/platform/telegram/staff-bot';
import { registerStaffBot } from '@/modules/platform/telegram/staff-handlers';
import { BACKLOG_SENTENCE } from '@/modules/platform/telegram/backlog';
import { markBoot } from '@/modules/platform/telegram/lifecycle';
import { openCalcRequest, storedRequestFacts } from '@/modules/wms/calc/service';
import { replyVerdictFor } from '@/modules/platform/telegram/reply-door';
import { ADD_REFUSAL } from '@/modules/platform/telegram/calc-amend';

const STAMP = String(Date.now()).slice(-6);
const BOT_ID = 4_400_000_001;
let sellerId = '';
let chat = 0n;
let clientId = '';
let stageId = '';
const madeDeals: string[] = [];
const madeRequests: string[] = [];
const madeTasks: string[] = [];
/** Every message the bot sent by chat id (the add door speaks that way). */
const sent: string[] = [];

type Handler = (ctx: unknown, next: () => Promise<void>) => Promise<void>;
const handlers: { filter: unknown; fn: Handler }[] = [];
const handlerFor = (pick: (filter: unknown) => boolean) => {
  const found = handlers.find((h) => pick(h.filter));
  if (!found) throw new Error('re-anchor: a staff-bot handler moved');
  return found.fn;
};

beforeAll(async () => {
  const [seller] = await db
    .insert(users)
    .values({ phone: `+99894${STAMP}1`, fullName: `Bot qo‘shimcha ${STAMP}`, passwordHash: 'x', locale: 'uz', active: true })
    .returning({ id: users.id });
  sellerId = seller!.id;
  chat = BigInt(780_000_000 + Number(STAMP));
  await db.insert(telegramLinks).values({ userId: sellerId, telegramChatId: chat, status: 'linked', linkedAt: new Date() });
  const [client] = await db.insert(clients).values({ clientCode: `AB${STAMP}`, name: `Bot mijoz ${STAMP}` }).returning();
  clientId = client!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
  process.env.TELEGRAM_BOT_TOKEN = 'amend-bot-token';
  __setTelegramTransport(async (url, init) => {
    if (url.endsWith('/sendMessage') && typeof init.body === 'string') {
      sent.push(String((JSON.parse(init.body) as { text?: string }).text ?? ''));
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1 } } }), { status: 200 });
  });
  registerStaffBot({
    on: (filter: unknown, fn: Handler) => void handlers.push({ filter, fn }),
    command: () => undefined,
    callbackQuery: () => undefined,
    use: () => undefined,
    hears: () => undefined,
  } as never);
  markBoot(new Date(Date.now() - 60_000));
});

afterEach(() => {
  endIntake(chat);
  dropTaskPending(chat);
  sent.length = 0;
  vi.mocked(routeCollectorText).mockClear();
  vi.mocked(lookupFromBot).mockClear();
  vi.mocked(replyVerdictFor).mockClear();
  vi.mocked(storedRequestFacts).mockClear();
});

afterAll(async () => {
  __setTelegramTransport(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
  await db.delete(notifications).where(eq(notifications.userId, sellerId));
  if (madeTasks.length) {
    await db.delete(events).where(inArray(events.entityId, madeTasks));
    await db.delete(tasks).where(inArray(tasks.id, madeTasks));
  }
  if (madeRequests.length) {
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.execute(sql`DELETE FROM crm_activities WHERE calc_request_id IN (${sql.join(
      madeRequests.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`);
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const ids = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (ids.length) {
      await db.delete(events).where(inArray(events.entityId, ids));
      await db.delete(tasks).where(inArray(tasks.id, ids));
    }
  }
  if (madeDeals.length) await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeDeals));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(telegramLinks).set({ status: 'revoked' }).where(eq(telegramLinks.userId, sellerId));
  await db.update(users).set({ active: false }).where(eq(users.id, sellerId));
  await pgClient.end();
});

let messageSeq = 6_000;

/** A landed request of this seller's, and the AI answer that carries ➕ (its message id). */
async function answered(): Promise<{ requestId: string; answerId: number }> {
  const [deal] = await db
    .insert(deals)
    .values({ code: `AB-${STAMP}-${madeDeals.length}`, clientId, stageId, title: 'Bot', createdBy: sellerId })
    .returning();
  madeDeals.push(deal!.id);
  const r = await openCalcRequest(
    {
      intakeDoor: null,
      entityType: 'deal',
      entityId: deal!.id,
      section: 'rastamojka',
      items: [{ name: 'Sumka', quantity: 10 }, { name: 'Krossovka', weightKg: 300 }],
      source: 'card',
    },
    { actorId: sellerId },
  );
  madeRequests.push(r.id);
  const answerId = (messageSeq += 1);
  await db.insert(notifications).values({
    userId: sellerId,
    channel: 'telegram',
    type: 'CalcPrefilled',
    status: 'sent',
    payload: { add: true, requestId: r.id, tg: { chatId: chat.toString(), messageId: answerId } },
  });
  return { requestId: r.id, answerId };
}

/** An armed «✅ Bajarildi» wait on a real task of the seller's. */
async function armedTask(): Promise<string> {
  const [task] = await db
    .insert(tasks)
    .values({ title: `Bot vazifa ${STAMP}`, assigneeId: sellerId, createdBy: sellerId })
    .returning({ id: tasks.id });
  madeTasks.push(task!.id);
  noteTaskPending(chat, task!.id);
  return task!.id;
}

function ctxOf(message: Record<string, unknown>) {
  const replies: string[] = [];
  return {
    replies,
    ctx: {
      chat: { id: Number(chat), type: 'private' },
      from: { id: Number(chat) },
      me: { id: BOT_ID },
      message: { message_id: (messageSeq += 1), date: Math.floor(Date.now() / 1000), chat: { id: Number(chat) }, ...message },
      reply: async (text: string) => (replies.push(text), { message_id: (messageSeq += 1) }),
      api: { editMessageText: async () => true },
    },
  };
}

const replyTo = (messageId: number) => ({ reply_to_message: { message_id: messageId, from: { id: BOT_ID }, date: 0, chat: { id: 1 } } });
const onText = () => handlerFor((f) => f === 'message:text');
const onVoice = () => handlerFor((f) => Array.isArray(f) && f.includes('message:voice'));
const onPhoto = () => handlerFor((f) => Array.isArray(f) && f.includes('message:photo'));

describe('a text reply to the AI answer opens the add door and STOPS the ladder (regression-2)', () => {
  it('«2: 40 juft» → the add collection on that request takes it; an armed task stays open; no lookup, no assistant', async () => {
    const { requestId, answerId } = await answered();
    const taskId = await armedTask();
    const { ctx, replies } = ctxOf({ text: '2: 40 juft', ...replyTo(answerId) });
    let passed = false;
    await onText()(ctx, async () => {
      passed = true;
    });
    const live = activeIntake(chat)!;
    expect(live.amend?.requestId).toBe(requestId);
    expect(live.stage).toBe('review');
    // The OPENING takes nothing (merged review dur-1): only the answer's own
    // write takes the reply, in the same patch — stood in here, so nothing
    // is taken yet. Marked by the open, a flush in the table's send and a
    // restart made the redelivery `seen` with its answer never written
    // (calc-r3-review-bot.integration drives that through, unmocked).
    expect(live.takenUpTo).toBe(0);
    expect(vi.mocked(routeCollectorText)).toHaveBeenCalledTimes(1);
    const [, onChat, state, text, meta] = vi.mocked(routeCollectorText).mock.calls[0]!;
    expect(onChat).toBe(chat);
    expect((state as { amend: { requestId: string } }).amend.requestId).toBe(requestId);
    expect(text).toBe('2: 40 juft');
    expect(meta).toMatchObject({ replyTo: null, messageId: ctx.message.message_id });
    // Nothing more said by the ladder, nothing handed on.
    expect(replies).toEqual([]);
    expect(passed).toBe(false);
    expect(peekTaskPending(chat)?.taskId).toBe(taskId);
    const [task] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
    expect(task!.status).toBe('open');
    expect(vi.mocked(lookupFromBot)).not.toHaveBeenCalled();
  });

  it('a reply to an AI answer WITHOUT ➕ stays not replyable', async () => {
    const { answerId } = await answered();
    await db
      .update(notifications)
      .set({ payload: sql`${notifications.payload} - 'add'` })
      .where(sql`${notifications.payload} -> 'tg' ->> 'messageId' = ${String(answerId)}`);
    const { ctx, replies } = ctxOf({ text: '2: 40 juft', ...replyTo(answerId) });
    await onText()(ctx, async () => {});
    expect(replies).toEqual(['Bu xabarga javob tizimga tushmaydi. Savolni kartada yozing yoki «➕ Topshiriq» bering.']);
    expect(activeIntake(chat)).toBeNull();
  });
});

describe('a reply to ANOTHER request’s answer while a collection is live (regression-5)', () => {
  it('A’s add collection live, a reply to B’s answer → the two-card words, nothing written into A', async () => {
    const a = await answered();
    const b = await answered();
    const storedA = (await storedRequestFacts(a.requestId))!;
    startIntake(chat, 'rastamojka', { ai: true, staffId: sellerId, amend: storedA.base });
    const before = activeIntake(chat)!;
    const { ctx, replies } = ctxOf({ text: '1: 50 dona', ...replyTo(b.answerId) });
    await onText()(ctx, async () => {});
    const storedB = (await storedRequestFacts(b.requestId))!;
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(storedB.base.cardLabel);
    expect(replies[0]).toContain('hech narsa yozilmadi');
    expect(vi.mocked(routeCollectorText)).not.toHaveBeenCalled();
    expect(activeIntake(chat)!.noteId).toBe(before.noteId);
    expect(activeIntake(chat)!.material).toEqual(before.material);
  });

  it('fails CLOSED: a reply that could not be checked is written nowhere, in words (adv-3)', async () => {
    const a = await answered();
    const b = await answered();
    const storedA = (await storedRequestFacts(a.requestId))!;
    startIntake(chat, 'rastamojka', { ai: true, staffId: sellerId, amend: storedA.base });
    const before = activeIntake(chat)!;
    vi.mocked(replyVerdictFor).mockRejectedValueOnce(new Error('connection reset'));
    const { ctx, replies } = ctxOf({ text: '1: 50 dona', ...replyTo(b.answerId) });
    await onText()(ctx, async () => {});
    expect(replies).toEqual([ADD_REFUSAL.replyUnchecked]);
    expect(vi.mocked(routeCollectorText)).not.toHaveBeenCalled();
    expect(activeIntake(chat)!.material).toEqual(before.material);
  });

  it('fails CLOSED: known to be B’s, B’s card unreadable → the two-card words with «boshqa», nothing written (adv-3)', async () => {
    const a = await answered();
    const b = await answered();
    const storedA = (await storedRequestFacts(a.requestId))!;
    startIntake(chat, 'rastamojka', { ai: true, staffId: sellerId, amend: storedA.base });
    vi.mocked(storedRequestFacts).mockRejectedValueOnce(new Error('statement timeout'));
    const { ctx, replies } = ctxOf({ text: '1: 50 dona', ...replyTo(b.answerId) });
    await onText()(ctx, async () => {});
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('bu javob boshqa so‘roviga tegishli, hech narsa yozilmadi');
    expect(vi.mocked(routeCollectorText)).not.toHaveBeenCalled();
  });

  it('B’s own add collection takes a reply to B’s answer as a table answer', async () => {
    const b = await answered();
    const storedB = (await storedRequestFacts(b.requestId))!;
    startIntake(chat, 'rastamojka', { ai: true, staffId: sellerId, amend: storedB.base });
    const { ctx, replies } = ctxOf({ text: '1: 50 dona', ...replyTo(b.answerId) });
    await onText()(ctx, async () => {});
    expect(replies).toEqual([]);
    expect(vi.mocked(routeCollectorText)).toHaveBeenCalledTimes(1);
  });
});

describe('a reply to the answer of a request since RETURNED (adv-10)', () => {
  it('opens the NEW seeded collection and applies nothing — its rows are numbered afresh', async () => {
    const { requestId, answerId } = await answered();
    await db
      .update(calcRequests)
      .set({ completedAt: new Date(), completedVia: 'returned', returnReason: 'kod yo‘q' })
      .where(eq(calcRequests.id, requestId));
    const { ctx } = ctxOf({ text: '2: 40 juft', ...replyTo(answerId) });
    await onText()(ctx, async () => {});
    const live = activeIntake(chat)!;
    expect(live.amend).toBeNull();
    expect(live.seed).not.toBeNull();
    expect(vi.mocked(routeCollectorText)).not.toHaveBeenCalled();
    expect(sent).toContain(ADD_REFUSAL.seededReply);
  });
});

describe('media replied to the AI answer', () => {
  it('a VOICE note → «🎤 …», no collection opened (regression-18)', async () => {
    const { answerId } = await answered();
    const { ctx, replies } = ctxOf({ voice: { file_id: `v${STAMP}`, file_unique_id: 'v', duration: 3 }, ...replyTo(answerId) });
    let passed = false;
    await onVoice()(ctx, async () => {
      passed = true;
    });
    expect(replies).toEqual(['🎤 Ovozli xabar o‘qilmaydi — yozib yuboring.']);
    expect(activeIntake(chat)).toBeNull();
    expect(passed).toBe(false);
  });

  it('a BACKLOG photo → no collection; the backlog sentence answers (re-check p4-8)', async () => {
    const { answerId } = await answered();
    const { ctx, replies } = ctxOf({
      photo: [{ file_id: `p${STAMP}`, file_unique_id: 'p', width: 1, height: 1, file_size: 10 }],
      ...replyTo(answerId),
    });
    // Written while the bot was down: before this boot.
    ctx.message.date = Math.floor(Date.now() / 1000) - 3_600;
    await onPhoto()(ctx, async () => {});
    expect(activeIntake(chat)).toBeNull();
    expect(replies).toEqual([BACKLOG_SENTENCE]);
  });
});
