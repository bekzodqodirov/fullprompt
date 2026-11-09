import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Where extra information arrives with nothing open (docs/SAKKIZ-R3.md §9.2,
 * product-fit-16): a forward gets Door B's «📌» AND «➕ {card} so‘roviga
 * qo‘shish»; a plain file, which today gets silence, gets one offer line; the
 * press files what the offer replied to. The real Door B and the real offer
 * query (it is the 7-day, own, open rule); the file store and the next step
 * are stood in.
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
  deliverNextStep: vi.fn(async () => {}),
}));
vi.mock('@/modules/platform/telegram/calc-files', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/calc-files')>()),
  saveIntakeFile: vi.fn(async () => ({ isPhoto: false, body: Buffer.from(''), attachmentId: randomUUID() })),
  readIntakeFile: vi.fn(async () => ({ patch: {}, say: null })),
}));
vi.mock('@/modules/platform/telegram/calc-store', async (original) => {
  const real = await original<typeof import('@/modules/platform/telegram/calc-store')>();
  return { ...real, holdingIntake: vi.fn(real.holdingIntake) };
});
vi.mock('@/modules/wms/calc/amend', async (original) => {
  const real = await original<typeof import('@/modules/wms/calc/amend')>();
  return { ...real, openRequestsToOffer: vi.fn(real.openRequestsToOffer) };
});

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  deals,
  dealStages,
  events,
  tasks,
  telegramLinks,
  users,
} from '@/modules/platform/db/schema';
import { __resetAddOffers, openAmendFromMedia, offerAddForMedia, pressAdd } from '@/modules/platform/telegram/calc-amend';
import { keptLastSettled } from '@/modules/platform/telegram/kept-last';
import { activeIntake, endIntake, holdingIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-store';
import { deliverNextStep, TABLE_SUPERSEDED, tableEditsSettled } from '@/modules/platform/telegram/calc-dialog';
import { saveIntakeFile } from '@/modules/platform/telegram/calc-files';
import { forwardKeyboard } from '@/modules/platform/telegram/staff-bot';
import { __resetDrafts } from '@/modules/platform/telegram/task-draft';
import { offerForwardTask } from '@/modules/platform/telegram/task-handlers';
import { openRequestsToOffer } from '@/modules/wms/calc/amend';
import { openCalcRequest } from '@/modules/wms/calc/service';

const STAMP = String(Date.now()).slice(-6);
let sellerId = '';
let colleagueId = '';
let chat = 0n;
let clientId = '';
let stageId = '';
const madeDeals: string[] = [];
const madeRequests: string[] = [];

beforeAll(async () => {
  const mint = async (n: number) =>
    (
      await db
        .insert(users)
        .values({ phone: `+99893${STAMP}${n}`, fullName: `Taklif ${STAMP}-${n}`, passwordHash: 'x', active: true })
        .returning({ id: users.id })
    )[0]!.id;
  sellerId = await mint(1);
  colleagueId = await mint(2);
  chat = BigInt(790_000_000 + Number(STAMP));
  await db.insert(telegramLinks).values({ userId: sellerId, telegramChatId: chat, status: 'linked', linkedAt: new Date() });
  const [client] = await db.insert(clients).values({ clientCode: `AO${STAMP}`, name: `Taklif mijoz ${STAMP}` }).returning();
  clientId = client!.id;
  stageId = (await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') }))!.id;
});

afterEach(async () => {
  endIntake(chat);
  __resetAddOffers();
  __resetDrafts();
  vi.mocked(saveIntakeFile).mockClear();
  if (madeRequests.length) {
    await db
      .update(calcRequests)
      .set({ completedAt: new Date(), completedVia: 'lines' })
      .where(and(inArray(calcRequests.id, madeRequests), sql`${calcRequests.completedAt} IS NULL`));
  }
});

afterAll(async () => {
  if (madeRequests.length) {
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
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
  await db.update(users).set({ active: false }).where(inArray(users.id, [sellerId, colleagueId]));
  await pgClient.end();
});

/** An open request of `who`'s, on a fresh deal; its card code. */
async function request(who = sellerId): Promise<{ id: string; card: string }> {
  const code = `AO-${STAMP}-${madeDeals.length}`;
  const [deal] = await db.insert(deals).values({ code, clientId, stageId, title: 'Taklif', createdBy: who }).returning();
  madeDeals.push(deal!.id);
  const r = await openCalcRequest(
    { intakeDoor: null, entityType: 'deal', entityId: deal!.id, section: 'rastamojka', items: [{ name: 'Sumka', quantity: 10 }], source: 'card' },
    { actorId: who },
  );
  madeRequests.push(r.id);
  return { id: r.id, card: code };
}

let messageSeq = 7_000;
/** The last offer press's replies. */
let pressReplies: string[] = [];
/** The collector's own «Bo‘ldi» prompt — what an unread file waits under. */
const PROMPT_TAIL = 'Yana yuboring yoki «Bo‘ldi» ni bosing.';
const now = () => Math.floor(Date.now() / 1000);
const forwarded = { forward_origin: { type: 'hidden_user', sender_user_name: 'Mijoz', date: 0 } };

function ctxOf(message: Record<string, unknown>) {
  const replies: { text: string; extra?: Record<string, unknown> }[] = [];
  const full = { message_id: (messageSeq += 1), date: now(), chat: { id: Number(chat), type: 'private' }, ...message };
  return {
    message: full,
    replies,
    ctx: {
      chat: { id: Number(chat), type: 'private' },
      from: { id: Number(chat) },
      message: full,
      reply: async (text: string, extra?: Record<string, unknown>) => (replies.push({ text, extra }), { message_id: (messageSeq += 1) }),
      api: { editMessageText: async () => true },
    },
  };
}

const rowsOf = (extra?: Record<string, unknown>) =>
  (extra?.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }).inline_keyboard;

/** The offer pressed: its message replies to `original`. */
async function pressOffer(requestId: string, original: Record<string, unknown>) {
  const replies: string[] = [];
  pressReplies = replies;
  const ctx = {
    reply: async (text: string) => (replies.push(text), { message_id: (messageSeq += 1) }),
    callbackQuery: { message: { message_id: (messageSeq += 1), reply_to_message: original } },
    answerCallbackQuery: async () => true,
    api: { editMessageText: async () => true },
  };
  await pressAdd(ctx as never, chat, requestId, 'replied', null);
  // The prompt is drawn kept-last, off the handler (docs/IKKI-ESHIK.md §1.4).
  await keptLastSettled();
  return replies;
}

const photo = (n: number) => [{ file_id: `AgAC${STAMP}${n}`, file_unique_id: `u${n}`, width: 1, height: 1, file_size: 10 }];

describe('a forward, with an open request of his (Door B)', () => {
  it('Door B carries its own two buttons AND «➕ {card} so‘roviga qo‘shish» (cf:); the press opens the add collection with the forward as material', async () => {
    const r = await request();
    const f = ctxOf({ text: 'Yana 20 karobka keldi', ...forwarded });
    await offerForwardTask(f.ctx as never, chat, null);
    expect(f.replies).toHaveLength(1);
    expect(f.replies[0]!.text).toBe('📌 Topshiriq qilamizmi?');
    expect(rowsOf(f.replies[0]!.extra)).toEqual([
      ...forwardKeyboard(),
      [{ text: `➕ ${r.card} so‘roviga qo‘shish`, callback_data: `cf:${r.id}` }],
    ]);
    await pressOffer(r.id, f.message);
    const live = activeIntake(chat)!;
    expect(live.amend?.requestId).toBe(r.id);
    expect(live.material).toEqual(['Yana 20 karobka keldi']);
    expect(live.repliedTaken).toEqual([f.message.message_id]);
    // What was taken is UNREAD: the collection waits for «Bo‘ldi», so the
    // table's «✅ Qo‘shish» cannot save the stored rows without it (spec-1).
    expect(live.stage).toBe('material');
    expect(pressReplies.at(-1)).toContain(PROMPT_TAIL);
    // A second press of the same offer takes nothing twice.
    await pressOffer(r.id, f.message);
    expect(activeIntake(chat)!.material).toEqual(['Yana 20 karobka keldi']);
  });

  it('a forwarded ALBUM: the press files every part the album memory holds, one attachment each (re-check p4-9)', async () => {
    const r = await request();
    const group = `fa${STAMP}`;
    const parts = [1, 2, 3].map((n) => ctxOf({ photo: photo(n), media_group_id: group, ...forwarded }));
    for (const p of parts) await offerForwardTask(p.ctx as never, chat, group);
    // One offer for the album, as a reply to its first part.
    expect(parts.map((p) => p.replies.length)).toEqual([1, 0, 0]);
    await pressOffer(r.id, parts[0]!.message);
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(3);
    const noteId = activeIntake(chat)!.noteId;
    expect(vi.mocked(saveIntakeFile).mock.calls.every((c) => c[1] === noteId)).toBe(true);
    expect(activeIntake(chat)!.fileCount).toBe(3);
  });
});

describe('a plain file, with an open request of his', () => {
  it('a document → one offer line as a reply to it; the press files that document', async () => {
    const r = await request();
    const d = ctxOf({ document: { file_id: `BQAC${STAMP}`, file_unique_id: 'd', file_name: 'packing.xlsx', mime_type: 'application/vnd.ms-excel', file_size: 100 } });
    expect(await offerAddForMedia(d.ctx as never, chat)).toBe(true);
    expect(d.replies).toHaveLength(1);
    expect(d.replies[0]!.text).toBe('➕ Bu faylni so‘rovga qo‘shamizmi?');
    expect(d.replies[0]!.extra?.reply_parameters).toMatchObject({ message_id: d.message.message_id });
    expect(rowsOf(d.replies[0]!.extra)).toEqual([[{ text: `➕ ${r.card} so‘roviga qo‘shish`, callback_data: `cf:${r.id}` }]]);
    await pressOffer(r.id, d.message);
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(1);
    expect(activeIntake(chat)!.fileCount).toBe(1);
    expect(activeIntake(chat)!.stage).toBe('material');
    expect(pressReplies.at(-1)).toContain(PROMPT_TAIL);
  });

  it('a document REPLIED to the AI answer is filed and waits for «Bo‘ldi» too (spec-1)', async () => {
    const r = await request();
    const d = ctxOf({ document: { file_id: `BQAR${STAMP}`, file_unique_id: 'r', file_name: 'b.pdf', mime_type: 'application/pdf', file_size: 10 } });
    await openAmendFromMedia(d.ctx as never, chat, r.id);
    await keptLastSettled();
    const live = activeIntake(chat)!;
    expect(live.amend?.requestId).toBe(r.id);
    expect(live.fileCount).toBe(1);
    expect(live.stage).toBe('material');
    expect(d.replies.at(-1)?.text).toContain(PROMPT_TAIL);
  });

  it('a file taken below the add table points the table down — its «✅ Qo‘shish» goes (§1.4, review PC-SPEC-4)', async () => {
    const r = await request();
    // The stood-in next step draws the add table as message 555.
    vi.mocked(deliverNextStep).mockImplementationOnce(async (_ctx, chatId) => {
      updateIntake(chatId, { tableMessageId: 555 }, { quiet: true });
    });
    const edits: { id: number; text: string; extra?: Record<string, unknown> }[] = [];
    const d = ctxOf({ document: { file_id: `BQAS${STAMP}`, file_unique_id: 's', file_name: 'c.pdf', mime_type: 'application/pdf', file_size: 10 } });
    const ctx = {
      ...d.ctx,
      api: {
        editMessageText: async (_c: string, id: number, text: string, extra?: Record<string, unknown>) => (edits.push({ id, text, extra }), true),
        deleteMessage: async () => true,
      },
    };
    await openAmendFromMedia(ctx as never, chat, r.id);
    await tableEditsSettled();
    await keptLastSettled();
    expect(activeIntake(chat)!.stage).toBe('material');
    const table = edits.filter((e) => e.id === 555).at(-1);
    expect(table?.text.split('\n').at(-1)).toBe(TABLE_SUPERSEDED);
    expect((table?.extra?.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([]);
  });

  it('a plain album of ten photos → ONE offer line, as a reply to its first part; the press files all ten', async () => {
    const r = await request();
    const group = `pa${STAMP}`;
    const parts = Array.from({ length: 10 }, (_, i) => ctxOf({ photo: photo(i + 10), media_group_id: group }));
    for (const p of parts) await offerAddForMedia(p.ctx as never, chat);
    expect(parts.map((p) => p.replies.length)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parts[0]!.replies[0]!.extra?.reply_parameters).toMatchObject({ message_id: parts[0]!.message.message_id });
    await pressOffer(r.id, parts[0]!.message);
    expect(vi.mocked(saveIntakeFile)).toHaveBeenCalledTimes(10);
  });
});

describe('nothing to offer', () => {
  async function nothingOffered(): Promise<void> {
    const f = ctxOf({ text: 'Mijozdan xabar', ...forwarded });
    await offerForwardTask(f.ctx as never, chat, null);
    expect(rowsOf(f.replies[0]!.extra)).toEqual(forwardKeyboard());
    __resetAddOffers();
    const d = ctxOf({ document: { file_id: `BQAD${STAMP}`, file_unique_id: 'e', file_name: 'x.pdf', mime_type: 'application/pdf', file_size: 10 } });
    // Today's silence: the handler goes on to the cabinet, which says nothing.
    expect(await offerAddForMedia(d.ctx as never, chat)).toBe(false);
    expect(d.replies).toEqual([]);
  }

  it('no open request', async () => {
    await nothingOffered();
  });

  it('one older than seven days', async () => {
    const r = await request();
    await db.update(calcRequests).set({ requestedAt: sql`now() - interval '30 days'` }).where(eq(calcRequests.id, r.id));
    await nothingOffered();
  });

  it('a closed one', async () => {
    const r = await request();
    await db.update(calcRequests).set({ completedAt: new Date(), completedVia: 'lines' }).where(eq(calcRequests.id, r.id));
    await nothingOffered();
  });

  it('a colleague’s', async () => {
    await request(colleagueId);
    await nothingOffered();
  });

  it('a live collection takes the file first — no offer beside it', async () => {
    await request();
    startIntake(chat, 'yolkira', { staffId: sellerId });
    const d = ctxOf({ document: { file_id: `BQAE${STAMP}`, file_unique_id: 'f', file_name: 'y.pdf', mime_type: 'application/pdf', file_size: 10 } });
    expect(await offerAddForMedia(d.ctx as never, chat)).toBe(false);
    const f = ctxOf({ text: 'x', ...forwarded });
    await offerForwardTask(f.ctx as never, chat, null);
    expect(rowsOf(f.replies[0]!.extra)).toEqual(forwardKeyboard());
  });

  it('a collection taken a minute after an offer: the cache never offers beside it (adv-13)', async () => {
    await request();
    const first = ctxOf({ text: 'x', ...forwarded });
    await offerForwardTask(first.ctx as never, chat, null);
    expect(rowsOf(first.replies[0]!.extra)).toHaveLength(forwardKeyboard().length + 1);
    startIntake(chat, 'yolkira', { staffId: sellerId });
    const second = ctxOf({ text: 'y', ...forwarded });
    await offerForwardTask(second.ctx as never, chat, null);
    expect(rowsOf(second.replies[0]!.extra)).toEqual(forwardKeyboard());
  });

  it('a PARKED collection takes nothing, so it silences no offer — the press asks the question instead (spec-5)', async () => {
    const r = await request();
    startIntake(chat, 'yolkira', { staffId: sellerId });
    // P1's park: the collection lives on, it no longer holds the chat (asked
    // twice — the media offer, then its rows).
    vi.mocked(holdingIntake).mockReturnValueOnce(null).mockReturnValueOnce(null);
    const d = ctxOf({ document: { file_id: `BQAP${STAMP}`, file_unique_id: 'q', file_name: 'z.pdf', mime_type: 'application/pdf', file_size: 10 } });
    expect(await offerAddForMedia(d.ctx as never, chat)).toBe(true);
    expect(rowsOf(d.replies[0]!.extra)).toEqual([[{ text: `➕ ${r.card} so‘roviga qo‘shish`, callback_data: `cf:${r.id}` }]]);
    expect(activeIntake(chat)).not.toBeNull();
  });

  it('the offer query throwing → Door B’s own two buttons still come (re-check p4-1)', async () => {
    await request();
    vi.mocked(openRequestsToOffer).mockRejectedValueOnce(new Error('db blip'));
    const f = ctxOf({ text: 'x', ...forwarded });
    await offerForwardTask(f.ctx as never, chat, null);
    expect(f.replies[0]!.text).toBe('📌 Topshiriq qilamizmi?');
    expect(rowsOf(f.replies[0]!.extra)).toEqual(forwardKeyboard());
  });
});

describe('the offer query', () => {
  it('his own open requests of the last seven days, newest first, at most two', async () => {
    const a = await request();
    const b = await request();
    const c = await request();
    const old = await request();
    await db.update(calcRequests).set({ requestedAt: sql`now() - interval '8 days'` }).where(eq(calcRequests.id, old.id));
    await db.update(calcRequests).set({ requestedAt: sql`now() - interval '2 minutes'` }).where(eq(calcRequests.id, a.id));
    await db.update(calcRequests).set({ requestedAt: sql`now() - interval '1 minute'` }).where(eq(calcRequests.id, b.id));
    const rows = await openRequestsToOffer(sellerId, 7);
    expect(rows.map((r) => r.id)).toEqual([c.id, b.id]);
    expect(rows[0]!.card).toBe(c.card);
  });
});
