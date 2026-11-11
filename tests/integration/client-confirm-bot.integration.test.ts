import 'dotenv/config';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  boxes,
  clientNotices,
  clientTelegramLinks,
  clients,
  lotChecks,
  lotClientConfirms,
  lotCompositionLines,
  lotCompositions,
  notifications,
  receiptLots,
  receipts,
  telegramLinks,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { clientLabels } from '@/modules/platform/telegram/client-labels';
import { parseConfirmCallback } from '@/modules/platform/telegram/confirm-callback';
import { htmlToPlain, visibleLength } from '@/modules/platform/telegram/format';
import { MAX_CAPTION_CHARS } from '@/modules/platform/telegram/limits';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { sendDueArrivalNotices } from '@/modules/wms/notices/arrival-jobs';
import { NOTICE_RECEIVED } from '@/modules/wms/notices/client-claims';
import { receivedFacts } from '@/modules/wms/notices/client-summary';
import { receivedText } from '@/modules/wms/notices/client-text';
import { NOTICE_LOT_ASK, askClientAboutReceipt, clientAskFacts } from '@/modules/wms/receipts/client-confirm';
import { askFits } from '@/modules/wms/receipts/client-confirm-text';
import type { LotCheckActor } from '@/modules/wms/receipts/lot-check';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';

/**
 * The client's own ✅ / ❌ in Telegram, end to end (0144,
 * docs/TARKIB-TAKLIFLAR.md §4): what the sweep SENDS — the «qabul qilindi»
 * push with its third row, the question a person asked from the card — and
 * what a PRESS does, through the bot's real handler chain with the Bot API
 * swapped for a recorder (this container has no network and CI has no token).
 *
 * Every notice this file drives is made due by moving its `send_after` to
 * 2001 and sweeping on a clock two days in the past (client-push's own
 * discipline): no stranger's row another file left behind is ever due.
 */

const RUN = String(Date.now()).slice(-6);
const APP = 'https://gsrwms.test';
const SWEEP_AT = new Date(Date.now() - 2 * 86_400_000);
const CHAT_A = 8_300_000_000 + Number(RUN) * 10 + 1;
const CHAT_B = 8_300_000_000 + Number(RUN) * 10 + 2;
const CHAT_STAFF = 8_300_000_000 + Number(RUN) * 10 + 3;
const CHAT_NOBODY = 8_300_000_000 + Number(RUN) * 10 + 9;

let h: BotHarness;
let staffId = '';
let whId = '';
const client = { A: '', B: '', S: '' };
const receipt = { plain: '', tarkib: '', long: '' };
const lot = { P1: '', P2: '', T: '' };
const longLots: string[] = [];
const storedKeys: string[] = [];
const madeBoxes: string[] = [];
const saved = { app: process.env.APP_URL, setting: undefined as unknown };

const logist = (): LotCheckActor => ({ id: staffId, permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] });
const ctx = () => ({ actorId: staffId, ip: null, userAgent: 'client-confirm-bot.integration' });

async function mintLot(key: keyof typeof lot, receiptId: string, seq: number, letter: string, zh: string, ru: string | null, n: number) {
  const [row] = await db
    .insert(receiptLots)
    .values({ receiptId, seq, letter, productNameZh: zh, productNameRu: ru, boxCount: n, totalWeightKg: '100.000', totalVolumeM3: '1.0000' })
    .returning({ id: receiptLots.id });
  lot[key] = row!.id;
  for (let i = 1; i <= n; i += 1) {
    const [box] = await db
      .insert(boxes)
      .values({ lotId: row!.id, seqInLot: i, shortCode: `CB${RUN}${key}${i}`, status: 'in_stock', currentWarehouseId: whId })
      .returning({ id: boxes.id });
    madeBoxes.push(box!.id);
  }
}

/** A «qabul qilindi» notice for the plain prixod, due on the sweep's clock. */
async function armReceived(clientId = client.A): Promise<void> {
  await db.delete(clientNotices).where(and(eq(clientNotices.kind, NOTICE_RECEIVED), eq(clientNotices.refId, receipt.plain)));
  await db.insert(clientNotices).values({
    clientId,
    kind: NOTICE_RECEIVED,
    refType: 'receipt',
    refId: receipt.plain,
    sendAfter: new Date('2001-01-01T00:00:00Z'),
    staffNotifiedAt: new Date(),
  });
}
const noticeOf = async (kind: string, receiptId: string) =>
  (await db.select().from(clientNotices).where(and(eq(clientNotices.kind, kind), eq(clientNotices.refId, receiptId))))[0];
const dueNow = (kind: string, receiptId: string) =>
  db
    .update(clientNotices)
    .set({ sendAfter: new Date('2001-01-01T00:00:00Z') })
    .where(and(eq(clientNotices.kind, kind), eq(clientNotices.refId, receiptId)));

interface Sent {
  method: string;
  chatId: number;
  text: string;
  rows: Record<string, unknown>[][];
}
/** What send.ts posted since the mark, with the keyboard parsed (a photo's travels as a JSON string). */
function sentSince(mark: ReturnType<BotHarness['mark']>): Sent[] {
  return h.since(mark).sent.map((call) => {
    const raw = call.body.reply_markup;
    const markup = typeof raw === 'string' ? (JSON.parse(raw) as { inline_keyboard?: Record<string, unknown>[][] }) : (raw as { inline_keyboard?: Record<string, unknown>[][] } | undefined);
    return {
      method: call.method,
      chatId: Number(call.body.chat_id),
      text: htmlToPlain(String(call.body.text ?? call.body.caption ?? '')),
      rows: markup?.inline_keyboard ?? [],
    };
  });
}
const answersOf = async () => db.select().from(lotClientConfirms).where(inArray(lotClientConfirms.lotId, Object.values(lot).filter(Boolean)));
const staffQueued = async () =>
  db
    .select({ userId: notifications.userId, type: notifications.type })
    .from(notifications)
    .where(and(inArray(notifications.type, ['ClientLotDisputed', 'ClientLotConfirmed']), like(sql`${notifications.payload}::text`, `%B${RUN}%`)));
const clearState = async () => {
  await db.delete(lotClientConfirms).where(inArray(lotClientConfirms.lotId, Object.values(lot).filter(Boolean)));
  await db
    .delete(notifications)
    .where(and(inArray(notifications.type, ['ClientLotDisputed', 'ClientLotConfirmed']), like(sql`${notifications.payload}::text`, `%B${RUN}%`)));
};
const tagOf = async (receiptId: string): Promise<string> => {
  const facts = await clientAskFacts(receiptId);
  if ('skip' in facts) throw new Error(`facts skipped: ${facts.skip}`);
  return facts.tag;
};
/** The keyboard the push under test carried, as Telegram would echo it on a press. */
const keyboard = (receiptId: string, tag: string) => ({
  inline_keyboard: [
    [{ text: 'Kabinet', web_app: { url: `${APP}/cabinet` } }],
    [{ text: 'Menejer', callback_data: 'mg' }],
    [
      { text: '✅', callback_data: `yt:1:${receiptId}:${tag}` },
      { text: '❌', callback_data: `yt:0:${receiptId}:${tag}` },
    ],
  ],
});
/** One press on a pushed message — a PHOTO with a caption, as the receipt's push is. */
async function press(chat: number, data: string, markup: unknown = undefined, messageId = 4242) {
  const mark = h.mark();
  await h.handle(tg.callback(chat, messageId, data, { markup, message: { text: undefined, caption: 'Yukingiz qabul qilindi', photo: [{ file_id: 'F', file_unique_id: 'u', width: 1, height: 1 }] } }));
  await h.settle();
  const since = h.since(mark);
  const answers = since.api.filter((call) => call.method === 'answerCallbackQuery');
  return {
    answers,
    toast: answers[0]?.payload.text as string | undefined,
    edits: since.sent.filter((call) => call.method === 'editMessageReplyMarkup'),
    texts: h.textsTo(chat, mark).map((text) => htmlToPlain(text)),
  };
}

beforeAll(async () => {
  h = botHarness();
  process.env.APP_URL = APP;
  saved.setting = await getSetting('client_confirm_on_receipt');
  await setSetting('client_confirm_on_receipt', true, null);
  const people = await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1);
  staffId = people[0]!.id;
  const [wh] = await db
    .insert(warehouses)
    .values({ code: `BW${RUN}`, name: `Bot sklad ${RUN}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: `BW${RUN}` })
    .returning({ id: warehouses.id });
  whId = wh!.id;
  for (const [key, chat, locale] of [
    ['A', CHAT_A, 'uz'],
    ['B', CHAT_B, 'ru'],
    ['S', CHAT_STAFF, 'uz'],
  ] as const) {
    const [row] = await db
      .insert(clients)
      .values({ clientCode: `${key}B${RUN}`, name: `Bot mijoz ${key} ${RUN}`, locale })
      .returning({ id: clients.id });
    client[key] = row!.id;
    await db.insert(clientTelegramLinks).values({ clientId: row!.id, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
  }
  for (const key of ['plain', 'tarkib', 'long'] as const) {
    const [row] = await db
      .insert(receipts)
      .values({
        warehouseId: whId,
        number: `CB-${RUN}-${key}`,
        clientId: client.A,
        status: 'confirmed',
        createdBy: staffId,
        receivedAt: new Date(Date.now() - 7_200_000),
        confirmedAt: new Date(Date.now() - 3_600_000),
        confirmedBy: staffId,
      })
      .returning({ id: receipts.id });
    receipt[key] = row!.id;
  }
  await mintLot('P1', receipt.plain, 1, 'A', `键盘${RUN}`, `Клавиатура ${RUN}`, 3);
  await mintLot('P2', receipt.plain, 2, 'B', `鼠标${RUN}`, null, 2);
  await mintLot('T', receipt.tarkib, 1, 'A', `杂货${RUN}`, `складское ${RUN}`, 2);
  await db.insert(lotCompositions).values({ lotId: lot.T, seenBoxCount: 2, savedBy: staffId });
  await db.insert(lotCompositionLines).values([
    { lotId: lot.T, seq: 1, name: `Мышь ${RUN}`, pieces: 500, weightKg: '60.000', volumeM3: '0.6000' },
    { lotId: lot.T, seq: 2, name: `Коврик ${RUN}`, pieces: null, weightKg: '40.000', volumeM3: '0.4000' },
  ]);
});

afterAll(async () => {
  await clearState();
  for (const id of Object.values(receipt).filter(Boolean)) await db.delete(clientNotices).where(eq(clientNotices.refId, id));
  const lotIds = [...Object.values(lot).filter(Boolean), ...longLots];
  if (lotIds.length > 0) {
    await db.delete(lotClientConfirms).where(inArray(lotClientConfirms.lotId, lotIds));
    await db.delete(attachments).where(and(eq(attachments.entityType, 'receipt_lot'), inArray(attachments.entityId, lotIds)));
    for (const key of storedKeys) await getStorage().delete(key).catch(() => undefined);
    await db.delete(lotChecks).where(inArray(lotChecks.lotId, lotIds));
    await db.delete(lotCompositions).where(inArray(lotCompositions.lotId, lotIds));
    if (madeBoxes.length > 0) await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  }
  const receiptIds = Object.values(receipt).filter(Boolean);
  if (receiptIds.length > 0) await db.delete(receipts).where(inArray(receipts.id, receiptIds));
  await db.delete(telegramLinks).where(eq(telegramLinks.telegramChatId, BigInt(CHAT_STAFF)));
  for (const id of Object.values(client).filter(Boolean)) {
    await db.delete(clientTelegramLinks).where(eq(clientTelegramLinks.clientId, id));
    await db.delete(clients).where(eq(clients.id, id));
  }
  if (whId) await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, whId));
  await setSetting('client_confirm_on_receipt', saved.setting as boolean, null);
  if (saved.app === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = saved.app;
  h.restore();
  await pgClient.end();
});

beforeEach(() => {
  __resetPresses();
});

describe('what the sweep sends', () => {
  it('«yukingiz qabul qilindi» for cargo in China nobody has confirmed: the question is the last line, ✅ / ❌ the THIRD row — rows one and two unmoved', async () => {
    await armReceived();
    const mark = h.mark();
    await sendDueArrivalNotices(SWEEP_AT);
    const mine = sentSince(mark).filter((call) => call.chatId === CHAT_A);
    expect(mine).toHaveLength(1);
    const push = mine[0]!;
    const t = clientLabels('uz');
    expect(push.text).toContain(t.arrivedTitle);
    expect(push.text).toContain(`Клавиатура ${RUN}`);
    // Named: what is being confirmed is the goods and the count — the lines above print kilos too.
    expect(push.text.trimEnd().split('\n').at(-1)).toBe(t.confirmAskLine);
    expect(push.rows).toHaveLength(3);
    expect(push.rows[0]![0]).toMatchObject({ web_app: { url: expect.stringContaining(`lot=${lot.P1}`) } });
    expect(push.rows[1]).toEqual([{ text: t.contactManager, callback_data: 'mg' }]);
    const tag = await tagOf(receipt.plain);
    expect(push.rows[2]).toEqual([
      { text: t.confirmYes, callback_data: `yt:1:${receipt.plain}:${tag}` },
      { text: t.confirmNo, callback_data: `yt:0:${receipt.plain}:${tag}` },
    ]);
    // Telegram's own limit: a refused button drops the WHOLE keyboard.
    for (const button of push.rows[2]!) {
      expect(Buffer.byteLength(String(button.callback_data), 'utf8')).toBeLessThanOrEqual(64);
      expect(parseConfirmCallback(String(button.callback_data))).toMatchObject({ receiptId: receipt.plain, tag });
    }
    expect((await noticeOf(NOTICE_RECEIVED, receipt.plain))!.status).toBe('sent');
  });

  it('…and says nothing new when the switch is off, when a colleague has ticked every lot, or when the prixod has a tarkib', async () => {
    const pushOf = async () => {
      const mark = h.mark();
      await sendDueArrivalNotices(SWEEP_AT);
      return sentSince(mark).filter((call) => call.chatId === CHAT_A)[0]!;
    };
    const plain = (push: Sent) => {
      expect(push.rows).toHaveLength(2);
      expect(push.text).not.toContain(clientLabels('uz').confirmAskLine);
    };
    await setSetting('client_confirm_on_receipt', false, null);
    await armReceived();
    plain(await pushOf());
    await setSetting('client_confirm_on_receipt', true, null);

    for (const key of ['P1', 'P2'] as const) {
      const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot[key]));
      await db.insert(lotChecks).values({ lotId: lot[key], seenNameZh: row!.productNameZh, seenNameRu: row!.productNameRu, seenBoxCount: row!.boxCount, seenClientId: client.A, checkedBy: staffId });
    }
    await armReceived();
    plain(await pushOf());
    await db.delete(lotChecks).where(inArray(lotChecks.lotId, [lot.P1, lot.P2]));

    // The tarkib prixod: the push prints «Мышь +1» and cannot list the goods — that question is the card's.
    await db.delete(clientNotices).where(and(eq(clientNotices.kind, NOTICE_RECEIVED), eq(clientNotices.refId, receipt.tarkib)));
    await db.insert(clientNotices).values({ clientId: client.A, kind: NOTICE_RECEIVED, refType: 'receipt', refId: receipt.tarkib, sendAfter: new Date('2001-01-01T00:00:00Z'), staffNotifiedAt: new Date() });
    const push = await pushOf();
    expect(push.text).toContain(`Мышь ${RUN} +1`);
    plain(push);
  });

  it('the question never costs the PHOTOGRAPH: a caption the extra line would push past Telegram’s limit goes without it — the buttons carry the question', async () => {
    // Eight lots, the first one photographed; names sized so the push fits a caption and the push PLUS the question does not.
    const n = 8;
    for (let i = 0; i < n; i += 1) {
      const [row] = await db
        .insert(receiptLots)
        .values({ receiptId: receipt.long, seq: i + 1, letter: String.fromCharCode(65 + i), productNameZh: `长${i}${RUN}`, productNameRu: `Товар ${i}`, boxCount: 1, totalWeightKg: '10.000', totalVolumeM3: '0.1000' })
        .returning({ id: receiptLots.id });
      longLots.push(row!.id);
      const [box] = await db
        .insert(boxes)
        .values({ lotId: row!.id, seqInLot: 1, shortCode: `CL${RUN}${i}`, status: 'in_stock', currentWarehouseId: whId })
        .returning({ id: boxes.id });
      madeBoxes.push(box!.id);
    }
    const key = `cb-test/${longLots[0]}.jpg`;
    const bytes = Buffer.from('not-really-a-jpeg-but-bytes');
    await getStorage().put(key, bytes, 'image/jpeg');
    storedKeys.push(key);
    await db.insert(attachments).values({
      entityType: 'receipt_lot',
      entityId: longLots[0]!,
      kind: 'photo',
      storageKey: key,
      fileName: 'x.jpg',
      contentType: 'image/jpeg',
      sizeBytes: bytes.length,
      uploadedBy: staffId,
    });
    // The pad that lands the plain push just under the limit — found with the push's own renderer.
    const lengths = async (pad: number) => {
      for (let i = 0; i < n; i += 1) {
        await db.update(receiptLots).set({ productNameRu: `Товар ${i} ${'я'.repeat(pad)}` }).where(eq(receiptLots.id, longLots[i]!));
      }
      const got = await receivedFacts(client.A, receipt.long);
      if ('skip' in got) throw new Error(got.skip);
      const summary = { ...got.summary, clientCode: `AB${RUN}` };
      return { plain: visibleLength(receivedText(summary, 'uz')), asking: visibleLength(receivedText(summary, 'uz', { ask: true })) };
    };
    let fit: { plain: number; asking: number } | null = null;
    for (let pad = 70; pad >= 0 && !fit; pad -= 1) {
      const at = await lengths(pad);
      if (at.plain <= MAX_CAPTION_CHARS && at.asking > MAX_CAPTION_CHARS) fit = at;
    }
    expect(fit, 'no name length puts the push between the two limits — re-size the fixture').not.toBeNull();

    await db.insert(clientNotices).values({ clientId: client.A, kind: NOTICE_RECEIVED, refType: 'receipt', refId: receipt.long, sendAfter: new Date('2001-01-01T00:00:00Z'), staffNotifiedAt: new Date() });
    const mark = h.mark();
    await sendDueArrivalNotices(SWEEP_AT);
    const push = sentSince(mark).filter((call) => call.chatId === CHAT_A)[0]!;
    // Still a PHOTO — the question did not push it into a text message…
    expect(push.method).toBe('sendPhoto');
    expect(push.text).not.toContain(clientLabels('uz').confirmAskLine);
    // …and the ✅ / ❌ are there all the same.
    expect(push.rows).toHaveLength(3);
    expect(parseConfirmCallback(String(push.rows[2]![0]!.callback_data))).toMatchObject({ receiptId: receipt.long, verdict: 'yes' });
  });

  it('«Mijozdan so‘rash»: the question lists every lot — a tarkib’s goods one per line with their pieces — in the chat’s language, no kilos, ✅ / ❌ under it', async () => {
    expect(await askClientAboutReceipt(receipt.tarkib, logist(), ctx(), askFits)).toEqual({ lots: 1 });
    await dueNow(NOTICE_LOT_ASK, receipt.tarkib);
    const mark = h.mark();
    await sendDueArrivalNotices(SWEEP_AT);
    const ask = sentSince(mark).filter((call) => call.chatId === CHAT_A)[0]!;
    const t = clientLabels('uz');
    expect(ask.method).toBe('sendMessage');
    const lines = ask.text.split('\n').filter((line) => line.trim() !== '');
    expect(lines[0]).toBe(t.confirmAskTitle);
    expect(lines[1]).toContain(`AB${RUN}`);
    expect(lines.slice(2, 5)).toEqual([`📦 A — 2 quti`, `   • Мышь ${RUN} — 500 ${t.unitDona}`, `   • Коврик ${RUN}`]);
    expect(lines).toContain(t.confirmAskLine);
    expect(ask.text).not.toMatch(/\bkg\b|m³/);
    const tag = await tagOf(receipt.tarkib);
    expect(ask.rows.at(-1)).toEqual([
      { text: t.confirmYes, callback_data: `yt:1:${receipt.tarkib}:${tag}` },
      { text: t.confirmNo, callback_data: `yt:0:${receipt.tarkib}:${tag}` },
    ]);
    const row = await noticeOf(NOTICE_LOT_ASK, receipt.tarkib);
    expect(row!.status).toBe('sent');
  });

  it('a question that waited is re-proved at SEND time: the prixod moved to another client reaches NOBODY — not the old owner, not the new', async () => {
    await db.execute(sql`UPDATE client_notices SET sent_at = now() - interval '11 minutes' WHERE kind = ${NOTICE_LOT_ASK} AND ref_id = ${receipt.tarkib}::uuid`);
    expect(await askClientAboutReceipt(receipt.tarkib, logist(), ctx(), askFits)).toEqual({ lots: 1 });
    await dueNow(NOTICE_LOT_ASK, receipt.tarkib);
    // The bot was down; meanwhile the prixod was corrected to client B.
    await db.update(receipts).set({ clientId: client.B }).where(eq(receipts.id, receipt.tarkib));
    try {
      const mark = h.mark();
      await sendDueArrivalNotices(SWEEP_AT);
      expect(sentSince(mark).filter((call) => call.chatId === CHAT_A || call.chatId === CHAT_B)).toEqual([]);
      const row = await noticeOf(NOTICE_LOT_ASK, receipt.tarkib);
      expect([row!.status, row!.lastError]).toEqual(['skipped', 'client_changed']);
    } finally {
      await db.update(receipts).set({ clientId: client.A }).where(eq(receipts.id, receipt.tarkib));
    }
  });
});

describe('a press', () => {
  it('✅: a toast of thanks and nothing else said; the pressed message keeps its two rows and loses the third; the lots are confirmed', async () => {
    await clearState();
    const tag = await tagOf(receipt.plain);
    const got = await press(CHAT_A, `yt:1:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag));
    expect(got.answers).toHaveLength(1);
    expect(got.toast).toBe(clientLabels('uz').confirmThanks);
    expect(got.texts).toEqual([]);
    expect(got.edits).toHaveLength(1);
    expect(got.edits[0]!.body).toMatchObject({ chat_id: CHAT_A, message_id: 4242 });
    const kept = (got.edits[0]!.body.reply_markup as { inline_keyboard: Record<string, unknown>[][] }).inline_keyboard;
    expect(kept).toEqual(keyboard(receipt.plain, tag).inline_keyboard.slice(0, 2));
    const rows = await answersOf();
    expect(rows.map((row) => [row.lotId, row.verdict, Number(row.chatId)]).sort()).toEqual(
      [
        [lot.P1, 'yes', CHAT_A],
        [lot.P2, 'yes', CHAT_A],
      ].sort(),
    );
    expect(await staffQueued()).toEqual([]);
  });

  it('the same press again — a second tap, a redelivered update — is «already»: one toast, nothing written twice', async () => {
    const tag = await tagOf(receipt.plain);
    const before = await answersOf();
    const got = await press(CHAT_A, `yt:1:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag));
    expect(got.answers).toHaveLength(1);
    expect(got.toast).toBe(clientLabels('uz').confirmAlready);
    expect(got.texts).toEqual([]);
    expect(await answersOf()).toEqual(before);
  });

  it('❌: NO toast — its sentence is a message that stays on the screen — the row is taken off, the lots are disputed and the people who can fix it are queued', async () => {
    const tag = await tagOf(receipt.plain);
    const got = await press(CHAT_A, `yt:0:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag));
    expect(got.answers).toHaveLength(1);
    expect(got.toast).toBeUndefined();
    expect(got.texts).toEqual([clientLabels('uz').confirmTellUs]);
    expect(got.edits).toHaveLength(1);
    expect((await answersOf()).every((row) => row.verdict === 'no')).toBe(true);
    const told = await staffQueued();
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((row) => row.type === 'ClientLotDisputed')).toBe(true);
  });

  it('a ❌ on a message whose data has since moved: «eskirgan», nothing written — and the customer is still told where to say what is wrong', async () => {
    await clearState();
    const got = await press(CHAT_A, `yt:0:${receipt.plain}:deadbeef`, keyboard(receipt.plain, 'deadbeef'));
    const t = clientLabels('uz');
    expect(got.answers).toHaveLength(1);
    expect(got.toast).toBe(t.confirmStale);
    expect(got.texts).toEqual([t.confirmTellUs]);
    expect(got.edits).toHaveLength(1);
    expect(await answersOf()).toEqual([]);
    expect(await staffQueued()).toEqual([]);
    // A stale ✅ is a toast and nothing more.
    const yes = await press(CHAT_A, `yt:1:${receipt.plain}:deadbeef`, keyboard(receipt.plain, 'deadbeef'), 4243);
    expect([yes.toast, yes.texts]).toEqual([t.confirmStale, []]);
  });

  it('somebody else’s chat, an unlinked chat, a hand-made or malformed button: the SAME neutral toast, answered once, nothing written (#273)', async () => {
    const tag = await tagOf(receipt.plain);
    // Client B's chat — linked, but the prixod is not theirs. Their language is Russian.
    const other = await press(CHAT_B, `yt:0:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag));
    expect(other.answers).toHaveLength(1);
    expect(other.toast).toBe(clientLabels('ru').confirmStale);
    expect(other.texts).toEqual([]);
    const nobody = await press(CHAT_NOBODY, `yt:1:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag));
    expect(nobody.answers).toHaveLength(1);
    expect(nobody.toast).toBe(clientLabels(null).confirmStale);
    // A later grammar's past, or garbage: registered on the PREFIX, so it is answered and never left to spin.
    for (const data of ['yt:', 'yt:2:x', `yt:1:${receipt.plain}`, 'yt:1:not-a-uuid:deadbeef']) {
      const got = await press(CHAT_A, data, undefined, 4300);
      expect(got.answers, data).toHaveLength(1);
      expect(got.toast, data).toBe(clientLabels('uz').confirmStale);
      expect(got.texts, data).toEqual([]);
      __resetPresses();
    }
    expect(await answersOf()).toEqual([]);
  });

  it('«busy»: the toast asks to press again, and the buttons STAY — nothing was written', async () => {
    const tag = await tagOf(receipt.plain);
    const holder = await pgClient.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT pg_advisory_xact_lock(hashtextextended(${`lot-answer:${lot.P1}`}, 0))`;
      const got = await press(CHAT_A, `yt:1:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag));
      expect(got.answers).toHaveLength(1);
      expect(got.toast).toBe(clientLabels('uz').confirmFailed);
      expect(got.edits).toEqual([]);
      expect(got.texts).toEqual([]);
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect(await answersOf()).toEqual([]);
  }, 20_000);

  it('a chat that is ALSO a staff chat: the relay does not run there, so ❌ says «xodimlarga xabar berildi» and never «shu yerga yozing»', async () => {
    await db.update(receipts).set({ clientId: client.S }).where(eq(receipts.id, receipt.plain));
    await db.insert(telegramLinks).values({ userId: staffId, telegramChatId: BigInt(CHAT_STAFF), status: 'linked', linkedAt: new Date() }).onConflictDoNothing();
    try {
      const tag = await tagOf(receipt.plain);
      const t = clientLabels('uz');
      const got = await press(CHAT_STAFF, `yt:0:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag));
      expect(got.answers).toHaveLength(1);
      expect(got.texts).toEqual([t.confirmNoted]);
      expect((await answersOf()).every((row) => row.verdict === 'no')).toBe(true);
      // …and a STALE ❌ there says only the toast: nothing was recorded, so «told» would be false.
      const stale = await press(CHAT_STAFF, `yt:0:${receipt.plain}:deadbeef`, keyboard(receipt.plain, 'deadbeef'), 4400);
      expect([stale.toast, stale.texts]).toEqual([t.confirmStale, []]);
    } finally {
      await db.delete(telegramLinks).where(eq(telegramLinks.telegramChatId, BigInt(CHAT_STAFF)));
      await db.update(receipts).set({ clientId: client.A }).where(eq(receipts.id, receipt.plain));
      await clearState();
    }
  });

  it('a press that arrives too late to be a toast (the bot was restarted): the ✅’s thanks are SAID in the chat once, and a ❌ still says one sentence, not two', async () => {
    const tag = await tagOf(receipt.plain);
    const late = { error_code: 400, description: 'Bad Request: query is too old and response timeout expired or query ID is invalid' };
    h.failNext('answerCallbackQuery', late);
    const yes = await press(CHAT_A, `yt:1:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag), 4500);
    expect(yes.texts).toEqual([clientLabels('uz').confirmThanks]);
    expect((await answersOf()).every((row) => row.verdict === 'yes')).toBe(true);
    __resetPresses();
    h.failNext('answerCallbackQuery', late);
    const no = await press(CHAT_A, `yt:0:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag), 4501);
    expect(no.texts).toEqual([clientLabels('uz').confirmTellUs]);
    await clearState();
  });

  it('a LATE press that came back «busy» asks to be pressed again — and the next press on that very button RUNS', async () => {
    // The as-built review (L2-1). A late press is remembered for a minute so that five taps into a bot
    // that was not there are one request — but «busy» wrote nothing and its sentence ASKS for a repeat.
    // The one outcome that asks for a second press was the one whose second press was swallowed.
    const tag = await tagOf(receipt.plain);
    const t = clientLabels('uz');
    const holder = await pgClient.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT pg_advisory_xact_lock(hashtextextended(${`lot-answer:${lot.P1}`}, 0))`;
      h.failNext('answerCallbackQuery', { error_code: 400, description: 'Bad Request: query is too old and response timeout expired or query ID is invalid' });
      const busy = await press(CHAT_A, `yt:1:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag), 4600);
      // Too late to be a toast: the sentence is said in the chat.
      expect(busy.texts).toEqual([t.confirmFailed]);
      expect(busy.edits).toEqual([]);
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect(await answersOf()).toEqual([]);
    // The customer does as told: the same button on the same message, seconds later. The middleware's
    // memory is the subject here, so it is NOT reset between the two.
    const again = await press(CHAT_A, `yt:1:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag), 4600);
    expect(again.toast).toBe(t.confirmThanks);
    const rows = await answersOf();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.verdict === 'yes')).toBe(true);
    await clearState();
  }, 20_000);

  it('the ❌’s one sentence goes FIRST and through the house’s ordered send: before the keyboard is touched, and a brief 429 is waited out', async () => {
    // L2-2. A ❌ has no toast by design, so this sentence is the customer's ONLY sign that the press did
    // anything. It was a bare send behind the keyboard edit: one 429 in the burst after a deploy and the
    // customer saw the buttons vanish and nothing else — with nothing in the log.
    const tag = await tagOf(receipt.plain);
    const mark = h.mark();
    h.failNext('sendMessage', { error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
    const got = await press(CHAT_A, `yt:0:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag), 4610);
    const sent = h.since(mark).sent;
    const says = sent.filter((call) => call.method === 'sendMessage' && Number(call.body.chat_id) === CHAT_A);
    // The refused one and its retry.
    expect(says).toHaveLength(2);
    expect(got.texts.at(-1)).toBe(clientLabels('uz').confirmTellUs);
    const firstSay = sent.findIndex((call) => call.method === 'sendMessage');
    const edit = sent.findIndex((call) => call.method === 'editMessageReplyMarkup');
    expect(firstSay).toBeGreaterThan(-1);
    expect(edit).toBeGreaterThan(firstSay);
    await clearState();
  }, 20_000);

  it('a message whose keyboard Telegram no longer echoes: the answer is recorded and the ✅ / ❌ row still goes — the two standing rows are rebuilt', async () => {
    // L2-5. A push stays in the chat for ever and a press on an old message arrives with no
    // `reply_markup`: with nothing to filter there was no edit at all, the row stayed under the message,
    // and ❌ / ✅ / ❌ … could be flipped on it for ever, each ❌ alarming the seller and every logist.
    const tag = await tagOf(receipt.plain);
    const got = await press(CHAT_A, `yt:1:${receipt.plain}:${tag}`, undefined, 4700);
    expect(got.toast).toBe(clientLabels('uz').confirmThanks);
    expect(got.edits).toHaveLength(1);
    const raw = got.edits[0]!.body.reply_markup;
    const markup = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { inline_keyboard: Record<string, unknown>[][] };
    expect(markup.inline_keyboard).toHaveLength(2);
    expect(markup.inline_keyboard[0]![0]).toHaveProperty('web_app');
    expect(markup.inline_keyboard[1]![0]).toMatchObject({ callback_data: 'mg' });
    expect(JSON.stringify(markup)).not.toContain('yt:');
    await clearState();
  });

  it('what the customer writes after a ❌ goes to the seller of THAT prixod’s client — not to the manager of the chat’s first code — with the prixod’s link', async () => {
    // L2-3. One person holds several codes in one chat (his 444 / 555 / 777) and since round 111 «the
    // minter is the manager», so two codes of one person can have two sellers. The bot says «nima
    // noto‘g‘ri ekanini shu yerga yozing»; the relay sent those words to the manager of the chat's FIRST
    // code: seller SA got «❌ xato dedi» with no explanation, seller SB the explanation with no prixod.
    const sellers = await db.select({ id: users.id }).from(users).where(and(eq(users.active, true), sql`${users.id} <> ${staffId}`)).limit(2);
    expect(sellers).toHaveLength(2);
    const [sa, sb] = [sellers[0]!.id, sellers[1]!.id];
    const chats = [BigInt(CHAT_STAFF + 100), BigInt(CHAT_STAFF + 101)];
    const before = await db.select({ id: clients.id, seller: clients.salesManagerId }).from(clients).where(inArray(clients.id, [client.A, client.B]));
    const mutes = await db.select({ id: users.id, muted: users.mutedNotificationTypes }).from(users).where(inArray(users.id, [sa, sb]));
    // The seeded people may hold a link of their own: theirs are parked for the test and put back.
    const parked = await db.select().from(telegramLinks).where(inArray(telegramLinks.userId, [sa, sb]));
    try {
      await db.delete(telegramLinks).where(inArray(telegramLinks.userId, [sa, sb]));
      await db.insert(telegramLinks).values([
        { userId: sa, telegramChatId: chats[0]!, status: 'linked', linkedAt: new Date() },
        { userId: sb, telegramChatId: chats[1]!, status: 'linked', linkedAt: new Date() },
      ]);
      await db.update(users).set({ mutedNotificationTypes: [] }).where(inArray(users.id, [sa, sb]));
      await db.update(clients).set({ salesManagerId: sa }).where(eq(clients.id, client.A));
      await db.update(clients).set({ salesManagerId: sb }).where(eq(clients.id, client.B));
      // B is the chat's OLDER code — the one the relay used to choose.
      await db.insert(clientTelegramLinks).values({ clientId: client.B, telegramChatId: BigInt(CHAT_A), status: 'linked', linkedAt: new Date('2020-01-01T00:00:00Z') });

      const tag = await tagOf(receipt.plain);
      await press(CHAT_A, `yt:0:${receipt.plain}:${tag}`, keyboard(receipt.plain, tag), 4800);
      const said = `nomi xato ${RUN}`;
      await h.handle(tg.text(CHAT_A, said));
      await h.settle();
      const relayed = await db
        .select({ userId: notifications.userId, payload: notifications.payload })
        .from(notifications)
        .where(and(eq(notifications.type, 'ClientBotMessage'), like(sql`${notifications.payload}::text`, `%${said}%`)));
      expect(relayed.map((row) => row.userId)).toEqual([sa]);
      const text = String((relayed[0]!.payload as { text: string }).text);
      // The disputed code leads, and the link is the prixod's — where the ❌ is fixed.
      expect(text).toContain(`AB${RUN}, BB${RUN}`);
      expect(text.split('\n').at(-1)).toBe(`${APP}/receipts/${receipt.plain}`);
    } finally {
      await db.delete(notifications).where(and(eq(notifications.type, 'ClientBotMessage'), like(sql`${notifications.payload}::text`, `%nomi xato ${RUN}%`)));
      await db.delete(clientTelegramLinks).where(and(eq(clientTelegramLinks.clientId, client.B), eq(clientTelegramLinks.telegramChatId, BigInt(CHAT_A))));
      for (const row of before) await db.update(clients).set({ salesManagerId: row.seller }).where(eq(clients.id, row.id));
      for (const row of mutes) await db.update(users).set({ mutedNotificationTypes: row.muted }).where(eq(users.id, row.id));
      await db.delete(telegramLinks).where(inArray(telegramLinks.telegramChatId, chats));
      if (parked.length > 0) await db.insert(telegramLinks).values(parked);
      await clearState();
    }
  });
});
