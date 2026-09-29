import 'dotenv/config';
import { and, eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  boxMovements,
  clientNotices,
  clients,
  clientTelegramLinks,
  batches,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { clientLabels, formatDay } from '@/modules/platform/telegram/client-labels';
import { groupDigits, htmlToPlain } from '@/modules/platform/telegram/format';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { cargoOverview, issuedHandovers } from '@/modules/wms/client-cabinet/service';
import { acceptFoundBox } from '@/modules/wms/inventory/service';
import { issueBoxes } from '@/modules/wms/issue/service';
import { MAX_NOTICE_ATTEMPTS, NOTICE_ARRIVED } from '@/modules/wms/notices/arrival';
import { sendDueArrivalNotices } from '@/modules/wms/notices/arrival-jobs';
import { NOTICE_ISSUED, NOTICE_RECEIVED } from '@/modules/wms/notices/client-claims';
import { recordVerdict, submitPlan } from '@/modules/wms/planning/service';
import { assignReceiptClient } from '@/modules/wms/receipts/edit';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { departBatch, ingestLoadScans } from '@/modules/wms/scanning/service';
import { finishUnload, ingestUnloadScans } from '@/modules/wms/scanning/unload';
import { wholeLedger } from '../fixtures/money-actor';

/**
 * Round C's customer pushes, end to end through the ONE sweep — with the Bot
 * API swapped for a recorder, because this container has no network and CI
 * has no token, so nothing else can show what a push POSTed (the scouts found
 * not one test that did).
 *
 * Every notice this file drives is made due by moving its `send_after` to
 * 2001: the sweep claims oldest first, so these rows are taken before any
 * stranger another file left behind, and assertions only ever read OUR chats.
 */

const S = String(Date.now()).slice(-6);
const APP = 'https://gsrwms.test';
/*
 * The sweep's clock, two days in the PAST: every row this file makes due sits
 * at 2001, and every row the services write lands at the real «now» (or ten
 * minutes after it) — never due on this clock, whatever hour CI runs at. A
 * fixed calendar date would make those due on a runner whose clock is earlier
 * than it, and the sweep would send them into the middle of an assertion.
 */
const BASE = new Date(Date.now() - 2 * 86_400_000);
const DAY = new Date(Date.UTC(BASE.getUTCFullYear(), BASE.getUTCMonth(), BASE.getUTCDate(), 6)); // 11:00 in Tashkent
const NIGHT = new Date(Date.UTC(BASE.getUTCFullYear(), BASE.getUTCMonth(), BASE.getUTCDate(), 20)); // 01:00 in Tashkent
let chatSeq = 0;
/** Chat ids of our own, per run: a leftover link from another run can never collide. */
const newChat = () => 7_700_000_000 + Number(S) * 10 + chatSeq++;

let actorId: string;
let cnId: string;
let uzId: string;
let uzCustomsId: string;
let cnHubId: string;
const madeClients: string[] = [];
const storedKeys: string[] = [];
const ctx = () => ({ actorId });

interface Call {
  method: string;
  chatId: number;
  fields: Record<string, unknown>;
  hasPhotoFile: boolean;
}
let calls: Call[] = [];
type Answer = { status: number; json: unknown };
let respond: (method: string, chatId: number) => Answer | null = () => null;

const savedEnv = { token: process.env.TELEGRAM_BOT_TOKEN, app: process.env.APP_URL };

function okAnswer(method: string): Answer {
  const messageId = 1000 + calls.length;
  return {
    status: 200,
    json: {
      ok: true,
      result: method === 'sendPhoto' ? { message_id: messageId, photo: [{ file_id: `F-${messageId}` }] } : { message_id: messageId },
    },
  };
}

async function ensureWarehouse(code: string, name: string, country: string, type: string): Promise<string> {
  const existing = await db.query.warehouses.findFirst({ where: eq(warehouses.code, code) });
  if (existing) return existing.id;
  const [wh] = await db
    .insert(warehouses)
    .values({ code, name, country, type, timezone: country === 'CN' ? 'Asia/Shanghai' : 'Asia/Tashkent', batchPrefix: code })
    .returning();
  return wh!.id;
}

async function makeClient(tag: string, opts: { chat?: number; locale?: string | null; linkedAt?: Date } = {}) {
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `P${tag}${S}`.slice(0, 10), name: `PA ${tag}`, locale: opts.locale ?? null })
    .returning();
  madeClients.push(c!.id);
  if (opts.chat !== undefined) {
    await db.insert(clientTelegramLinks).values({
      clientId: c!.id,
      telegramChatId: BigInt(opts.chat),
      status: 'linked',
      linkedAt: opts.linkedAt ?? new Date(),
    });
  }
  return c!;
}

/** A receipt of `boxCount` uniform boxes, its lot photographed — the bytes really stored when asked. */
async function receive(clientId: string, warehouseId: string, opts: { boxCount?: number; storeBytes?: boolean; name?: string } = {}) {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  const key = `pa-test/${lotId}.jpg`;
  const bytes = Buffer.from('not-really-a-jpeg-but-bytes');
  if (opts.storeBytes !== false) {
    await getStorage().put(key, bytes, 'image/jpeg');
    storedKeys.push(key);
  }
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: key,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: bytes.length,
    uploadedBy: actorId,
  });
  const out = await confirmReceipt(
    {
      receiptId,
      warehouseId,
      clientId,
      unclaimedMarking: '',
      lots: [
        {
          id: lotId,
          productNameZh: '手机壳',
          productNameRu: opts.name ?? 'Чехлы',
          boxCount: opts.boxCount ?? 2,
          dimsMode: 'uniform',
          boxLengthCm: 30,
          boxWidthCm: 30,
          boxHeightCm: 30,
          boxWeightKg: 5,
        },
      ],
      extraCosts: [],
    },
    ctx(),
  );
  const boxRows = await db.select().from(boxes).where(eq(boxes.lotId, lotId));
  return { receiptId, lotId, number: out.number, boxes: boxRows };
}

async function noticesOf(clientId: string, kind?: string) {
  return db
    .select()
    .from(clientNotices)
    .where(kind ? and(eq(clientNotices.clientId, clientId), eq(clientNotices.kind, kind)) : eq(clientNotices.clientId, clientId));
}

/** Due before anything else in the queue — the sweep claims oldest first. */
async function makeDue(noticeId: string, order = 0) {
  await db
    .update(clientNotices)
    .set({ sendAfter: new Date(Date.UTC(2001, 0, 1, 0, 0, order)) })
    .where(eq(clientNotices.id, noticeId));
}

const callsTo = (chat: number) => calls.filter((c) => c.chatId === chat);
interface Markup {
  inline_keyboard: { text: string; web_app?: { url: string }; callback_data?: string }[][];
}
/** A multipart body carries the keyboard as a JSON string, a JSON body as an object. */
const markupOf = (c: Call): Markup =>
  (typeof c.fields.reply_markup === 'string' ? JSON.parse(c.fields.reply_markup) : c.fields.reply_markup) as Markup;
const bodyOf = (c: Call) => String(c.fields.caption ?? c.fields.text ?? '');

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
  cnId = await ensureWarehouse('PACN1', 'PA Yiwu', 'CN', 'origin');
  uzId = await ensureWarehouse('PAUZ1', 'PA Toshkent 1', 'UZ', 'distribution');
  uzCustomsId = await ensureWarehouse('PAUZC', 'PA Bojxona', 'UZ', 'customs');
  cnHubId = await ensureWarehouse('PACNH', 'PA Qashqar', 'CN', 'hub');
  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  process.env.APP_URL = APP;
  __setTelegramTransport(async (url, init) => {
    const method = url.split('/').pop() ?? '';
    const form = init.body instanceof FormData ? init.body : null;
    const fields: Record<string, unknown> = form
      ? Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<file>']))
      : (JSON.parse(String(init.body)) as Record<string, unknown>);
    const chatId = Number(fields.chat_id);
    calls.push({ method, chatId, fields, hasPhotoFile: form ? form.get('photo') instanceof Blob : false });
    const answer = respond(method, chatId) ?? okAnswer(method);
    return new Response(JSON.stringify(answer.json), { status: answer.status });
  });
});

beforeEach(() => {
  calls = [];
  respond = () => null;
});

afterAll(async () => {
  __setTelegramTransport(null);
  if (savedEnv.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedEnv.token;
  if (savedEnv.app === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedEnv.app;
  if (madeClients.length) {
    await db.delete(clientNotices).where(inArray(clientNotices.clientId, madeClients));
    // Our chats must never be a later sweep's recipient.
    await db.update(clientTelegramLinks).set({ status: 'revoked' }).where(inArray(clientTelegramLinks.clientId, madeClients));
  }
  for (const key of storedKeys) await getStorage().delete(key).catch(() => {});
  await pgClient.end();
});

describe('the claim is written with the fact, and only when somebody can hear it', () => {
  it('a linked client gets «qabul qilindi» reserved behind the correction window; an unlinked one gets nothing', async () => {
    const linked = await makeClient('L', { chat: newChat() });
    const unlinked = await makeClient('U');
    const before = Date.now();
    const a = await receive(linked.id, cnId);
    await receive(unlinked.id, cnId);

    const rows = await noticesOf(linked.id, NOTICE_RECEIVED);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ refType: 'receipt', refId: a.receiptId, status: 'pending' });
    // The correction window: ten minutes, not now.
    const wait = rows[0]!.sendAfter.getTime() - before;
    expect(wait).toBeGreaterThan(9 * 60_000);
    expect(wait).toBeLessThan(11 * 60_000);
    // Outside the staff sweep's partial index.
    expect(rows[0]!.staffNotifiedAt).not.toBeNull();

    // Nobody to tell = no row, which is also no foreign key into `clients`.
    expect(await noticesOf(unlinked.id)).toHaveLength(0);
  });
});

describe('C1 «qabul qilindi» through the sweep', () => {
  it('one photograph, the text as its caption, the lot button and the manager door', async () => {
    const chat = newChat();
    const client = await makeClient('P', { chat });
    const r = await receive(client.id, cnId);
    const [notice] = await noticesOf(client.id, NOTICE_RECEIVED);
    await makeDue(notice!.id);

    await sendDueArrivalNotices(DAY);

    const mine = callsTo(chat);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.method).toBe('sendPhoto');
    expect(mine[0]!.hasPhotoFile).toBe(true);
    const caption = bodyOf(mine[0]!);
    expect(mine[0]!.fields.parse_mode).toBe('HTML');
    expect(caption).toContain(`<b>${clientLabels(null).arrivedTitle}</b>`);
    expect(caption).toContain(`<code>${r.number}</code>`);
    expect(htmlToPlain(caption)).toContain(client.clientCode);
    expect(htmlToPlain(caption)).toContain('PA Yiwu');
    // Daytime: it rings.
    expect(mine[0]!.fields.disable_notification).toBeUndefined();
    const keyboard = markupOf(mine[0]!);
    expect(keyboard.inline_keyboard[0]![0]!.web_app!.url).toBe(`${APP}/cabinet?lot=${r.lotId}`);
    // The manager door is answered at PRESS time — never a person's URL frozen in.
    expect(keyboard.inline_keyboard[1]![0]!.callback_data).toBe('mg');

    const [after] = await noticesOf(client.id, NOTICE_RECEIVED);
    expect(after).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('at night it arrives without a sound', async () => {
    const chat = newChat();
    const client = await makeClient('N', { chat });
    await receive(client.id, cnId);
    const [notice] = await noticesOf(client.id, NOTICE_RECEIVED);
    await makeDue(notice!.id);

    await sendDueArrivalNotices(NIGHT);

    const [call] = callsTo(chat);
    expect(String(call!.fields.disable_notification)).toBe('true');
  });

  it('cargo a customer brings to an UZBEK warehouse is «received», with no «next: loaded onto a truck» (PA-1)', async () => {
    const chat = newChat();
    const client = await makeClient('WK', { chat });
    await receive(client.id, uzId);
    const [notice] = await noticesOf(client.id, NOTICE_RECEIVED);
    await makeDue(notice!.id);

    await sendDueArrivalNotices(DAY);

    const t = clientLabels(null);
    const text = htmlToPlain(bodyOf(callsTo(chat)[0]!));
    expect(text).toContain(t.arrivedTitle);
    // «Added to your cabinet» is for cargo received long ago and given its
    // owner later — not for a delivery an hour old.
    expect(text).not.toContain(t.pushAddedTitle);
    expect(text).not.toContain(t.pushNextReceived);
  });

  it('a receipt moved to another code inside the window says nothing to the first — and comes back armed', async () => {
    const chat = newChat();
    const wrong = await makeClient('W', { chat });
    const right = await makeClient('R');
    const r = await receive(wrong.id, cnId);
    await assignReceiptClient(r.receiptId, right.id, ctx());
    const [notice] = await noticesOf(wrong.id, NOTICE_RECEIVED);
    await makeDue(notice!.id);

    await sendDueArrivalNotices(DAY);

    // One customer's goods photograph never reaches another (judge PRIV-4).
    expect(callsTo(chat)).toHaveLength(0);
    const [skipped] = await noticesOf(wrong.id, NOTICE_RECEIVED);
    expect(skipped).toMatchObject({ status: 'skipped', lastError: 'client_changed' });
    // The unlinked owner has nobody to tell.
    expect(await noticesOf(right.id)).toHaveLength(0);

    // …and when the receipt comes BACK, the fact is true again.
    await assignReceiptClient(r.receiptId, wrong.id, ctx());
    const [rearmed] = await noticesOf(wrong.id, NOTICE_RECEIVED);
    expect(rearmed).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('a receipt voided inside the window is settled as skipped, not sent', async () => {
    const chat = newChat();
    const client = await makeClient('V', { chat });
    const r = await receive(client.id, cnId);
    await db
      .update(receipts)
      .set({ status: 'voided', voidedAt: new Date(), voidReason: 'test' })
      .where(eq(receipts.id, r.receiptId));
    const [notice] = await noticesOf(client.id, NOTICE_RECEIVED);
    await makeDue(notice!.id);

    await sendDueArrivalNotices(DAY);

    expect(callsTo(chat)).toHaveLength(0);
    const [after] = await noticesOf(client.id, NOTICE_RECEIVED);
    expect(after).toMatchObject({ status: 'skipped', lastError: 'voided' });
  });

  it('speaks the language the PERSON chose on the chat, not the new code’s empty one', async () => {
    const chat = newChat();
    await makeClient('E', { chat, locale: 'en', linkedAt: new Date(Date.now() - 86_400_000) });
    const newer = await makeClient('F', { chat, locale: null });
    await receive(newer.id, cnId);
    const [notice] = await noticesOf(newer.id, NOTICE_RECEIVED);
    await makeDue(notice!.id);

    await sendDueArrivalNotices(DAY);

    const [call] = callsTo(chat);
    expect(bodyOf(call!)).toContain(clientLabels('en').arrivedTitle);
    const keyboard = markupOf(call!);
    expect(keyboard.inline_keyboard[1]![0]!.text).toBe(clientLabels('en').contactManager);
  });
});

describe('the photograph is an addition, never the delivery', () => {
  it('Telegram refusing the photo sends the same sentence as a message', async () => {
    const chat = newChat();
    const client = await makeClient('X', { chat });
    await receive(client.id, cnId);
    const [notice] = await noticesOf(client.id, NOTICE_RECEIVED);
    await makeDue(notice!.id);
    respond = (method, chatId) =>
      method === 'sendPhoto' && chatId === chat
        ? { status: 400, json: { ok: false, description: 'Bad Request: IMAGE_PROCESS_FAILED' } }
        : null;

    await sendDueArrivalNotices(DAY);

    const mine = callsTo(chat);
    expect(mine.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
    expect(mine[1]!.fields.text).toBe(mine[0]!.fields.caption);
    expect(mine[1]!.fields.parse_mode).toBe('HTML');
    const [after] = await noticesOf(client.id, NOTICE_RECEIVED);
    expect(after!.status).toBe('sent');
  });

  it('a photo whose upload died is NOT followed by the text (it may have arrived) — the row waits', async () => {
    const chat = newChat();
    const client = await makeClient('Y', { chat });
    await receive(client.id, cnId);
    const [notice] = await noticesOf(client.id, NOTICE_RECEIVED);
    await makeDue(notice!.id);
    respond = (method, chatId) =>
      method === 'sendPhoto' && chatId === chat ? { status: 502, json: { ok: false, description: 'Bad Gateway' } } : null;

    await sendDueArrivalNotices(DAY);

    expect(callsTo(chat).map((c) => c.method)).toEqual(['sendPhoto']);
    const [after] = await noticesOf(client.id, NOTICE_RECEIVED);
    expect(after).toMatchObject({ status: 'pending', attempts: 1 });
  });

  it('bytes that cannot be read send the text alone', async () => {
    const chat = newChat();
    const client = await makeClient('Z', { chat });
    await receive(client.id, cnId, { storeBytes: false });
    const [notice] = await noticesOf(client.id, NOTICE_RECEIVED);
    await makeDue(notice!.id);

    await sendDueArrivalNotices(DAY);

    expect(callsTo(chat).map((c) => c.method)).toEqual(['sendMessage']);
    const [after] = await noticesOf(client.id, NOTICE_RECEIVED);
    expect(after!.status).toBe('sent');
  });
});

describe('the queue keeps its customers through the bot’s bad hours', () => {
  it('a refused TOKEN stops the sweep and gives every claimed row back untouched', async () => {
    const chat = newChat();
    const client = await makeClient('T', { chat });
    await receive(client.id, cnId);
    await receive(client.id, cnId);
    const rows = await noticesOf(client.id, NOTICE_RECEIVED);
    expect(rows).toHaveLength(2);
    await makeDue(rows[0]!.id, 0);
    await makeDue(rows[1]!.id, 1);
    respond = () => ({ status: 401, json: { ok: false, description: 'Unauthorized' } });

    await sendDueArrivalNotices(DAY);

    // One knock, then nothing: the token refuses every chat after it too.
    expect(callsTo(chat)).toHaveLength(1);
    for (const row of await noticesOf(client.id, NOTICE_RECEIVED)) {
      expect(row).toMatchObject({ status: 'pending', attempts: 0, claimedAt: null });
    }
  });

  it('a 429 is a wait: pending past it, no attempt spent', async () => {
    const chat = newChat();
    const client = await makeClient('Q', { chat });
    await receive(client.id, cnId);
    const [notice] = await noticesOf(client.id, NOTICE_RECEIVED);
    await makeDue(notice!.id);
    respond = (_m, chatId) =>
      chatId === chat
        ? { status: 429, json: { ok: false, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } } }
        : null;

    const before = Date.now();
    await sendDueArrivalNotices(DAY);

    const [after] = await noticesOf(client.id, NOTICE_RECEIVED);
    expect(after).toMatchObject({ status: 'pending', attempts: 0, claimedAt: null });
    expect(after!.sendAfter.getTime()).toBeGreaterThan(before + 25_000);
  });

  it('a row a dead run left in «sending» is taken back with that run COUNTED, and given up at the cap', async () => {
    const chat = newChat();
    const client = await makeClient('K', { chat });
    const first = await receive(client.id, cnId, { name: `Birinchi ${S}` });
    const second = await receive(client.id, cnId, { name: `Ikkinchi ${S}` });
    const rows = await noticesOf(client.id, NOTICE_RECEIVED);
    const byRef = new Map(rows.map((row) => [row.refId, row]));
    // An hour before the sweep's own clock: past the reclaim window.
    const stale = new Date(DAY.getTime() - 60 * 60_000);
    await db
      .update(clientNotices)
      .set({ status: 'sending', claimedAt: stale, attempts: 0, sendAfter: new Date(Date.UTC(2001, 0, 1)) })
      .where(eq(clientNotices.id, byRef.get(first.receiptId)!.id));
    await db
      .update(clientNotices)
      .set({ status: 'sending', claimedAt: stale, attempts: MAX_NOTICE_ATTEMPTS - 1, sendAfter: new Date(Date.UTC(2001, 0, 1, 0, 0, 1)) })
      .where(eq(clientNotices.id, byRef.get(second.receiptId)!.id));

    await sendDueArrivalNotices(DAY);

    const after = new Map((await noticesOf(client.id, NOTICE_RECEIVED)).map((row) => [row.refId, row]));
    // The dead run is one attempt, this run another.
    expect(after.get(first.receiptId)).toMatchObject({ status: 'sent', attempts: 2 });
    // At the cap the dead run was the last attempt: failed, and never sent.
    expect(after.get(second.receiptId)).toMatchObject({ status: 'failed', attempts: MAX_NOTICE_ATTEMPTS });
    expect(callsTo(chat).filter((c) => bodyOf(c).includes(`Ikkinchi ${S}`))).toHaveLength(0);
    expect(callsTo(chat).filter((c) => bodyOf(c).includes(`Birinchi ${S}`))).toHaveLength(1);
  });
});

describe('C3 «berildi»', () => {
  it('names the receiver and what is left here, then says «everything» only when nothing is left anywhere', async () => {
    const chat = newChat();
    const client = await makeClient('G', { chat });
    const unlinked = await makeClient('H');
    const r = await receive(client.id, uzId, { boxCount: 3 });
    const t = clientLabels(null);

    await issueBoxes(
      {
        handoverId: uuidv4(),
        clientId: client.id,
        warehouseId: uzId,
        boxIds: r.boxes.slice(0, 2).map((b) => b.id),
        personName: 'Aziz <aka>',
        personPhone: '+998901112233',
        debtOk: true,
        priceOk: true,
      },
      ctx(),
      wholeLedger(actorId),
    );
    const [firstIssued] = await noticesOf(client.id, NOTICE_ISSUED);
    expect(firstIssued).toMatchObject({ refType: 'handover', status: 'pending' });
    expect(firstIssued!.staffNotifiedAt).not.toBeNull();
    await makeDue(firstIssued!.id);
    await sendDueArrivalNotices(DAY);

    let mine = callsTo(chat);
    expect(mine.map((c) => c.method)).toEqual(['sendMessage']);
    let text = htmlToPlain(bodyOf(mine[0]!));
    expect(text).toContain('Aziz <aka>');
    expect(bodyOf(mine[0]!)).toContain('Aziz &lt;aka&gt;');
    expect(text).toContain(`${t.issuedLeft}: 1`);
    expect(text).not.toContain(t.pushAllIssued);
    const keyboard = markupOf(mine[0]!);
    // A handover opens the cabinet at its top, not on one lot.
    expect(keyboard.inline_keyboard[0]![0]!.web_app!.url).toBe(`${APP}/cabinet`);
    expect(keyboard.inline_keyboard[1]![0]!.callback_data).toBe('mg');

    calls = [];
    await issueBoxes(
      {
        handoverId: uuidv4(),
        clientId: client.id,
        warehouseId: uzId,
        boxIds: [r.boxes[2]!.id],
        personName: 'Aziz',
        personPhone: '+998901112233',
        debtOk: true,
        priceOk: true,
      },
      ctx(),
      wholeLedger(actorId),
    );
    const second = (await noticesOf(client.id, NOTICE_ISSUED)).find((row) => row.status === 'pending')!;
    await makeDue(second.id);
    await sendDueArrivalNotices(DAY);
    mine = callsTo(chat);
    text = htmlToPlain(bodyOf(mine[0]!));
    expect(text).toContain(`🟩🟩🟩🟩🟩 ${t.pushAllIssued}`);

    // An unlinked customer's handover reserves nothing.
    const u = await receive(unlinked.id, uzId, { boxCount: 1 });
    await issueBoxes(
      {
        handoverId: uuidv4(),
        clientId: unlinked.id,
        warehouseId: uzId,
        boxIds: [u.boxes[0]!.id],
        personName: 'Ali',
        personPhone: '+998901112233',
        debtOk: true,
        priceOk: true,
      },
      ctx(),
      wholeLedger(actorId),
    );
    expect(await noticesOf(unlinked.id)).toHaveLength(0);
  });

  it('nothing left HERE but cargo still in China: this warehouse is done, not «everything»', async () => {
    const chat = newChat();
    const client = await makeClient('J', { chat });
    await receive(client.id, cnId, { boxCount: 2 });
    const here = await receive(client.id, uzId, { boxCount: 1 });
    await issueBoxes(
      {
        handoverId: uuidv4(),
        clientId: client.id,
        warehouseId: uzId,
        boxIds: [here.boxes[0]!.id],
        personName: 'Aziz',
        personPhone: '+998901112233',
        debtOk: true,
        priceOk: true,
      },
      ctx(),
      wholeLedger(actorId),
    );
    const [notice] = await noticesOf(client.id, NOTICE_ISSUED);
    await makeDue(notice!.id);
    await sendDueArrivalNotices(DAY);

    const t = clientLabels(null);
    const text = htmlToPlain(bodyOf(callsTo(chat)[0]!));
    expect(text).toContain(t.pushHereIssued);
    expect(text).toContain(`${t.sumChina}: 2`);
    expect(text).not.toContain(t.pushAllIssued);
  });
});

describe('the push and the Mini App read ONE kilo figure (round C review, second pass)', () => {
  it('3 of 7 boxes of a 10 kg lot say 4.29 in the «berildi» push AND on its handover card', async () => {
    const chat = newChat();
    const client = await makeClient('KG', { chat });
    const r = await receive(client.id, uzId, { boxCount: 7 });
    // A lot weighed as a whole, whose share does not divide evenly.
    await db.update(receiptLots).set({ totalWeightKg: '10' }).where(eq(receiptLots.id, r.lotId));
    const handoverId = uuidv4();
    await issueBoxes(
      {
        handoverId,
        clientId: client.id,
        warehouseId: uzId,
        boxIds: r.boxes.slice(0, 3).map((b) => b.id),
        personName: 'Aziz',
        personPhone: '+998901112233',
        debtOk: true,
        priceOk: true,
      },
      ctx(),
      wholeLedger(actorId),
    );
    const [notice] = await noticesOf(client.id, NOTICE_ISSUED);
    await makeDue(notice!.id);
    await sendDueArrivalNotices(DAY);

    const card = (await issuedHandovers(client.id)).find((h) => h.id === handoverId)!;
    const onCard = groupDigits(card.lots[0]!.weightKg);
    expect(onCard).toBe('4.29');
    const text = htmlToPlain(bodyOf(callsTo(chat)[0]!));
    expect(text).toContain(`${onCard} ${clientLabels(null).kg}`);
    expect(text).not.toContain('4.286');
  });
});

describe('the arrival push after a late find and a partial lot (round C review, second pass)', () => {
  function scan(batchId: string, code: string) {
    return { clientEventUuid: uuidv4(), batchId, code, method: 'qr' as const, scannedAt: new Date().toISOString() };
  }
  async function truck(clientLotId: string, boxCount: number) {
    const sub = await submitPlan(
      { originWarehouseId: cnId, destWarehouseId: uzId, lines: [{ lotId: clientLotId, boxCount }] },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    const planned = await db
      .select({ id: boxes.id, code: boxes.shortCode })
      .from(boxes)
      .where(and(eq(boxes.lotId, clientLotId), eq(boxes.status, 'planned')));
    for (const box of planned) {
      await ingestLoadScans([{ ...scan(batch!.id, box.code), addedOnSpot: false }], ctx());
    }
    await departBatch(batch!.id, ctx());
    return { batchId: batch!.id, planned };
  }

  it('a carton the stocktake FINDS days later re-arms the push under the day it was found', async () => {
    const chat = newChat();
    const client = await makeClient('IF', { chat });
    const r = await receive(client.id, cnId, { boxCount: 2 });
    const { batchId, planned } = await truck(r.lotId, 2);
    // One carton off; the other is not found, and the manager finishes over it.
    await ingestUnloadScans([scan(batchId, planned[0]!.code)], ctx());
    await finishUnload(batchId, ctx(), { mayCloseWithMissing: true });
    const firstDay = new Date(DAY.getTime() - 3 * 86_400_000);
    await db
      .update(boxMovements)
      .set({ createdAt: firstDay })
      .where(and(eq(boxMovements.boxId, planned[0]!.id), eq(boxMovements.cause, 'unload_scan')));
    const [notice] = await noticesOf(client.id, NOTICE_ARRIVED);
    await makeDue(notice!.id);
    await sendDueArrivalNotices(DAY);
    expect(htmlToPlain(bodyOf(callsTo(chat)[0]!))).toContain(formatDay(firstDay));

    // Days later the warehouse finds it on the shelf: the stocktake's door.
    calls = [];
    await acceptFoundBox({ warehouseId: uzId, code: planned[1]!.code }, ctx());
    const [found] = await db
      .select({ at: boxMovements.createdAt })
      .from(boxMovements)
      .where(and(eq(boxMovements.boxId, planned[1]!.id), eq(boxMovements.cause, 'inventory_found')));
    const [again] = await noticesOf(client.id, NOTICE_ARRIVED);
    expect(again!.status).toBe('pending');
    await makeDue(again!.id);
    await sendDueArrivalNotices(DAY);
    const text = htmlToPlain(bodyOf(callsTo(chat)[0]!));
    expect(formatDay(found!.at)).not.toBe(formatDay(firstDay));
    expect(text).toContain(formatDay(found!.at));
    expect(text).not.toContain(formatDay(firstDay));
  });

  it('3 of a 1.5 kg, 20-box lot read ONE figure in the push and on the lot card', async () => {
    const chat = newChat();
    const client = await makeClient('SH', { chat });
    const r = await receive(client.id, cnId, { boxCount: 20 });
    await db.update(receiptLots).set({ totalWeightKg: '1.5' }).where(eq(receiptLots.id, r.lotId));
    // Seventeen were handed over earlier — the way production's rows look.
    await db
      .update(boxes)
      .set({ status: 'issued' })
      .where(inArray(boxes.id, r.boxes.slice(0, 17).map((b) => b.id)));
    const { batchId, planned } = await truck(r.lotId, 3);
    for (const box of planned) await ingestUnloadScans([scan(batchId, box.code)], ctx());
    await finishUnload(batchId, ctx());
    const [notice] = await noticesOf(client.id, NOTICE_ARRIVED);
    await makeDue(notice!.id);
    await sendDueArrivalNotices(DAY);

    const [lot] = (await cargoOverview(client.id)).filter((l) => l.lotId === r.lotId);
    expect(lot!.total).toBe(3);
    const onCard = groupDigits(lot!.weightKg);
    // total × n ÷ boxes: 1.5 × 3 ÷ 20 = 0.225 → 0.23 on every surface. Both
    // other ways to write the share — n × (total ÷ boxes), the card's old
    // one, and total × (n ÷ boxes), the push's — give 0.22, so this lot
    // catches either surface drifting (the third pass's verifier).
    expect(onCard).toBe('0.23');
    const t = clientLabels(null);
    const text = htmlToPlain(bodyOf(callsTo(chat).find((c) => bodyOf(c).includes(t.readyTitle))!));
    expect(text).toContain(`${onCard} ${t.kg}`);
    expect(text).not.toContain('0.22');
  });

  it('a WHOLE lot reads its typed total — the «qabul qilindi» push and the card agree', async () => {
    const chat = newChat();
    const client = await makeClient('WL', { chat });
    const r = await receive(client.id, cnId, { boxCount: 9 });
    // Nine cartons of 25×20×25 cm: 0.1125 m³, whose share-of-nine is
    // 0.11249999999999999 in floating point — 0.112 against the push's 0.113.
    await db.update(receiptLots).set({ totalVolumeM3: '0.1125' }).where(eq(receiptLots.id, r.lotId));
    const [notice] = await noticesOf(client.id, NOTICE_RECEIVED);
    await makeDue(notice!.id);
    await sendDueArrivalNotices(DAY);

    const [lot] = (await cargoOverview(client.id)).filter((l) => l.lotId === r.lotId);
    const onCard = groupDigits(lot!.volumeM3);
    expect(onCard).toBe('0.113');
    const t = clientLabels(null);
    const text = htmlToPlain(bodyOf(callsTo(chat)[0]!));
    expect(text).toContain(`${onCard} ${t.m3}`);
  });
});

describe('C2 «yetib keldi» — the whole road', () => {
  function scan(batchId: string, code: string) {
    return { clientEventUuid: uuidv4(), batchId, code, method: 'qr' as const, scannedAt: new Date().toISOString() };
  }

  it('the warehouse by name, the «ready» step, and a photo that says when it was taken', async () => {
    const chat = newChat();
    const client = await makeClient('A', { chat });
    const r = await receive(client.id, cnId, { boxCount: 2 });
    const sub = await submitPlan(
      { originWarehouseId: cnId, destWarehouseId: uzCustomsId, lines: [{ lotId: r.lotId, boxCount: 2 }] },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    for (const box of r.boxes) {
      await ingestLoadScans([{ ...scan(batch!.id, box.shortCode), addedOnSpot: false }], ctx());
    }
    await departBatch(batch!.id, ctx());
    for (const box of r.boxes) await ingestUnloadScans([scan(batch!.id, box.shortCode)], ctx());
    await finishUnload(batch!.id, ctx());

    const [notice] = await noticesOf(client.id, NOTICE_ARRIVED);
    expect(notice).toBeDefined();
    // Two days of unloading: the first carton a day earlier, the second at
    // 23:55 Tashkent the evening BEFORE the sweep (18:55 UTC). The claim is
    // older still — a notice re-armed by the second day keeps its first
    // row's `created_at` (PA-4).
    const landed = new Date(DAY.getTime() - 11 * 3_600_000 - 5 * 60_000);
    const dayBefore = new Date(landed.getTime() - 86_400_000);
    const unloadOf = (boxId: string) =>
      and(eq(boxMovements.boxId, boxId), eq(boxMovements.cause, 'unload_scan'));
    await db.update(boxMovements).set({ createdAt: dayBefore }).where(unloadOf(r.boxes[0]!.id));
    await db.update(boxMovements).set({ createdAt: landed }).where(unloadOf(r.boxes[1]!.id));
    await db
      .update(clientNotices)
      .set({ createdAt: new Date(landed.getTime() - 2 * 86_400_000) })
      .where(eq(clientNotices.id, notice!.id));
    await makeDue(notice!.id);
    await sendDueArrivalNotices(DAY);

    const t = clientLabels(null);
    const arrival = callsTo(chat).find((c) => bodyOf(c).includes(t.readyTitle))!;
    expect(arrival.method).toBe('sendPhoto');
    const text = htmlToPlain(bodyOf(arrival));
    expect(text).toContain('PA Bojxona');
    expect(text).not.toContain('PAUZC');
    expect(text).toContain(`🟩🟩🟩🟩⬜ ${t.msReady}`);
    // Came from China and nobody pressed «rastamojka tugadi»: the honest caveat.
    expect(text).toContain(t.readyNote);
    expect(text).toContain(t.photoTakenOnReceipt);
    // Dated the day the NEWEST carton landed: not the first day's (PA-4),
    // not the claim's `created_at`, and not the sweep's clock — told after
    // midnight, the first fix printed a landing day that never happened.
    expect(formatDay(landed)).not.toBe(formatDay(DAY));
    expect(text).toContain(formatDay(landed));
    expect(text).not.toContain(formatDay(dayBefore));
    expect(text).not.toContain(formatDay(new Date(landed.getTime() - 2 * 86_400_000)));
    expect(text).not.toContain(formatDay(DAY));
    // The Mini App says what the push said (MA-1): nothing cleared here.
    const [lot] = (await cargoOverview(client.id)).filter((l) => l.lotId === r.lotId);
    expect(lot!.readyCleared).toBe(0);
    const keyboard = markupOf(arrival);
    expect(keyboard.inline_keyboard[0]![0]!.web_app!.url).toBe(`${APP}/cabinet?lot=${r.lotId}`);
    const [after] = await noticesOf(client.id, NOTICE_ARRIVED);
    expect(after!.status).toBe('sent');
  });
});

describe('the app says what the push said, after the truck is unloaded (MA-1)', () => {
  function scan(batchId: string, code: string) {
    return { clientEventUuid: uuidv4(), batchId, code, method: 'qr' as const, scannedAt: new Date().toISOString() };
  }

  it('a CLEARED truck: the ready card counts the cartons as cleared and the history keeps «rastamojka»', async () => {
    const chat = newChat();
    const client = await makeClient('MC', { chat });
    const r = await receive(client.id, cnId, { boxCount: 2 });
    const sub = await submitPlan(
      { originWarehouseId: cnId, destWarehouseId: uzId, lines: [{ lotId: r.lotId, boxCount: 2 }] },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    for (const box of r.boxes) {
      await ingestLoadScans([{ ...scan(batch!.id, box.shortCode), addedOnSpot: false }], ctx());
    }
    await departBatch(batch!.id, ctx());
    // «Rastamojka tugadi», pressed while the truck is on the road.
    await db.update(batches).set({ customsClearedAt: new Date() }).where(eq(batches.id, batch!.id));
    for (const box of r.boxes) await ingestUnloadScans([scan(batch!.id, box.shortCode)], ctx());
    await finishUnload(batch!.id, ctx());

    // Landed: the live pointer is gone, and the answer must not go with it.
    const landed = await db.select({ batch: boxes.currentBatchId }).from(boxes).where(eq(boxes.lotId, r.lotId));
    expect(landed.every((b) => b.batch === null)).toBe(true);
    const [lot] = (await cargoOverview(client.id)).filter((l) => l.lotId === r.lotId);
    expect(lot!.groups.map((g) => g.stage)).toEqual(['ready']);
    expect(lot!.readyCleared).toBe(2);
    expect(lot!.journey.map((s) => s.key)).toContain('customs');

    const [notice] = await noticesOf(client.id, NOTICE_ARRIVED);
    await makeDue(notice!.id);
    await sendDueArrivalNotices(DAY);
    const t = clientLabels(null);
    const arrival = callsTo(chat).find((c) => bodyOf(c).includes(t.readyTitle))!;
    expect(htmlToPlain(bodyOf(arrival))).toContain(t.pushReadyCleared);
  });

  it('a lot waiting at the Chinese hub after an internal leg has NO «in Uzbekistan» step (second pass)', async () => {
    const client = await makeClient('HB');
    const r = await receive(client.id, cnId, { boxCount: 2 });
    const sub = await submitPlan(
      { originWarehouseId: cnId, destWarehouseId: cnHubId, lines: [{ lotId: r.lotId, boxCount: 2 }] },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    for (const box of r.boxes) {
      await ingestLoadScans([{ ...scan(batch!.id, box.shortCode), addedOnSpot: false }], ctx());
    }
    await departBatch(batch!.id, ctx());
    for (const box of r.boxes) await ingestUnloadScans([scan(batch!.id, box.shortCode)], ctx());
    await finishUnload(batch!.id, ctx());

    // Standing at Kashgar, waiting for its export truck: no live pointer.
    const [lot] = (await cargoOverview(client.id)).filter((l) => l.lotId === r.lotId);
    expect(lot!.groups.map((g) => g.stage)).toEqual(['hub']);
    const keys = lot!.journey.map((s) => s.key);
    expect(keys).toContain('atHub');
    expect(keys).not.toContain('inUz');
    expect(keys).not.toContain('customs');
  });

  it('a China-ending truck still unloading lends no «in Uzbekistan» day to the box still on it', async () => {
    const client = await makeClient('HT');
    const r = await receive(client.id, cnId, { boxCount: 2 });
    const sub = await submitPlan(
      { originWarehouseId: cnId, destWarehouseId: cnHubId, lines: [{ lotId: r.lotId, boxCount: 2 }] },
      ctx(),
    );
    const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
    for (const box of r.boxes) {
      await ingestLoadScans([{ ...scan(batch!.id, box.shortCode), addedOnSpot: false }], ctx());
    }
    await departBatch(batch!.id, ctx());
    // The first carton is off at Kashgar — the truck is «arrived», the second
    // carton still on it, its live pointer still naming the truck.
    await ingestUnloadScans([scan(batch!.id, r.boxes[0]!.shortCode)], ctx());

    const [lot] = (await cargoOverview(client.id)).filter((l) => l.lotId === r.lotId);
    expect(lot!.journey.map((s) => s.key)).not.toContain('inUz');
  });

  it('a lot split between a Tashkent landing and a later Kashgar one keeps the Tashkent truck\'s customs step', async () => {
    const client = await makeClient('HS');
    const r = await receive(client.id, cnId, { boxCount: 2 });
    const road = async (destWarehouseId: string, clear: boolean) => {
      const sub = await submitPlan(
        { originWarehouseId: cnId, destWarehouseId, lines: [{ lotId: r.lotId, boxCount: 1 }] },
        ctx(),
      );
      const { batch } = await recordVerdict({ versionId: sub.version.id, verdict: 'approved' }, ctx());
      const [planned] = await db
        .select({ code: boxes.shortCode })
        .from(boxes)
        .where(and(eq(boxes.lotId, r.lotId), eq(boxes.status, 'planned')));
      await ingestLoadScans([{ ...scan(batch!.id, planned!.code), addedOnSpot: false }], ctx());
      await departBatch(batch!.id, ctx());
      if (clear) await db.update(batches).set({ customsClearedAt: new Date() }).where(eq(batches.id, batch!.id));
      await ingestUnloadScans([scan(batch!.id, planned!.code)], ctx());
      await finishUnload(batch!.id, ctx());
    };
    // Straight to Tashkent and cleared first; the other carton reaches
    // Kashgar AFTER it — the newer landing, off a truck that ends in China.
    await road(uzId, true);
    await road(cnHubId, false);

    const [lot] = (await cargoOverview(client.id)).filter((l) => l.lotId === r.lotId);
    expect(lot!.journey.map((s) => s.key)).toContain('customs');
  });

  it('cargo no truck brought (received in Uzbekistan) has no declaration to wait for', async () => {
    const client = await makeClient('NT');
    const r = await receive(client.id, uzId, { boxCount: 3 });
    // Marked ready at the counter, the way production's rows look after it.
    await db.update(boxes).set({ status: 'ready_for_pickup' }).where(eq(boxes.lotId, r.lotId));
    const [lot] = (await cargoOverview(client.id)).filter((l) => l.lotId === r.lotId);
    expect(lot!.groups).toEqual([{ stage: 'ready', n: 3, transit: null }]);
    expect(lot!.readyCleared).toBe(3);
  });
});

describe('no bot token: nothing is taken', () => {
  it('leaves due rows pending with no attempt spent', async () => {
    const chat = newChat();
    const client = await makeClient('O', { chat });
    await receive(client.id, cnId);
    const [notice] = await noticesOf(client.id, NOTICE_RECEIVED);
    await makeDue(notice!.id);
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      await sendDueArrivalNotices(DAY);
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
    }
    const [after] = await noticesOf(client.id, NOTICE_RECEIVED);
    expect(after).toMatchObject({ status: 'pending', attempts: 0, claimedAt: null });
  });
});
