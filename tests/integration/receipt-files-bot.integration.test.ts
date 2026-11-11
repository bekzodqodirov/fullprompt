import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  // Nothing is really queued (thumbnails, the event kick).
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => null),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  receipts,
  roles,
  telegramLinks,
  userRoles,
  userWarehouses,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { __resetBacklog } from '@/modules/platform/telegram/backlog';
import { __forgetKeptLast } from '@/modules/platform/telegram/kept-last';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import { endCapture, startCapture } from '@/modules/platform/telegram/note-capture';
import { __resetPresses } from '@/modules/platform/telegram/press';
import { closeReceiptFiles, standingReceiptFiles } from '@/modules/platform/telegram/receipt-files';
import { __resetDrafts } from '@/modules/platform/telegram/task-draft';
import { __forgetWaitMemory, flushWaitWrites, hydrateWaits, setDurableWaits } from '@/modules/platform/telegram/waits';
import { botHarness, tg, type BotHarness } from '../fixtures/bot-harness';

/**
 * «📎 Fayl qo‘shish» — the prixod's file collection, through the WHOLE handler
 * chain (the owner, 2026-11-11: «agar file qoshishni bossa fillarni tashlasin
 * boldi va hisobga tashlagandek boldi deb bosganda prixodga fillar
 * biriktirilsin»; docs/PRIXOD-XABARI.md §C.5-C.6).
 *
 * What only the chain can prove: that a file sent after the press lands on
 * THAT prixod — before the task door's «📌 Topshiriq qilamizmi?» can offer
 * to make something else of it — and that the collection never ends in
 * silence: thirty quiet minutes and another collector's opening both tell
 * the next file that it was not attached.
 */

const STAMP = String(Date.now()).slice(-6);
const PREFIX = `93${STAMP}`;
const sellerChat = Number(`${PREFIX}1`);
const operatorChat = Number(`${PREFIX}2`);
let h: BotHarness;
let sellerId = '';
let operatorId = '';
let warehouseId = '';
let otherWarehouseId = '';
const madeReceipts: string[] = [];
const savedAiKey = process.env.ANTHROPIC_API_KEY;

async function mintReceipt(tag: string): Promise<{ id: string; number: string }> {
  const number = `PF-${STAMP}-${tag}`;
  const [row] = await db
    .insert(receipts)
    .values({ warehouseId, number, status: 'confirmed', createdBy: sellerId, confirmedAt: new Date(), confirmedBy: sellerId })
    .returning({ id: receipts.id });
  madeReceipts.push(row!.id);
  return { id: row!.id, number };
}

const filesOn = (receiptId: string) =>
  db
    .select({ id: attachments.id, kind: attachments.kind, fileName: attachments.fileName, contentType: attachments.contentType, uploadedBy: attachments.uploadedBy })
    .from(attachments)
    .where(and(eq(attachments.entityType, 'receipt'), eq(attachments.entityId, receiptId)));

/** Press «📎 Fayl qo‘shish» and return the prompt the bot sent. */
async function open(chat: number, receiptId: string) {
  const m = h.mark();
  await h.handle(tg.callback(chat, 40_000 + Math.floor(Math.random() * 1000), `pf:${receiptId}`, { text: '📥 Prixod keldi' }));
  const prompt = h.since(m).api.filter((c) => c.method === 'sendMessage').at(-1)!;
  return { messageId: prompt.messageId!, text: String(prompt.payload.text), markup: prompt.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] } };
}

let fileSeq = 0;
/** A document update whose bytes the fake Telegram will hand over. `after` = a bot message it must be newer than. */
function doc(chat: number, name: string, opts: { after?: number; date?: number; forwarded?: boolean; mime?: string } = {}) {
  fileSeq += 1;
  const fileId = `rf-${STAMP}-${fileSeq}`;
  h.serveFile(fileId, Buffer.from(`%PDF-1.4 ${name}`));
  return tg.document(chat, fileId, {
    fileName: name,
    mime: opts.mime ?? 'application/pdf',
    ...(opts.after ? { messageId: opts.after + fileSeq } : {}),
    ...(opts.date ? { date: opts.date } : {}),
    ...(opts.forwarded ? { forwarded: true } : {}),
  });
}

/** Every text the collection drew or sent since `m` — a kept-last draw may EDIT its message in place. */
function saidSince(m: ReturnType<BotHarness['mark']>): string[] {
  return h
    .since(m)
    .api.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')
    .map((c) => String(c.payload.text));
}

beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  const whs = await db.select({ id: warehouses.id }).from(warehouses).limit(2);
  warehouseId = whs[0]!.id;
  otherWarehouseId = whs[1]!.id;
  const mint = async (tag: string, role: string, chat: number) => {
    const [u] = await db
      .insert(users)
      .values({ phone: `+99893${STAMP}${tag}`, fullName: `Prixod fayl ${tag} ${STAMP}`, passwordHash: 'x', locale: 'uz', active: true })
      .returning({ id: users.id });
    const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
    await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
    await db.insert(telegramLinks).values({ userId: u!.id, telegramChatId: BigInt(chat), status: 'linked', linkedAt: new Date() });
    return u!.id;
  };
  sellerId = await mint('1', 'sales_manager', sellerChat);
  // A warehouse operator of ANOTHER warehouse: scoped, and this cargo is not theirs.
  operatorId = await mint('2', 'warehouse_operator', operatorChat);
  await db.insert(userWarehouses).values({ userId: operatorId, warehouseId: otherWarehouseId });
  h = botHarness();
});

beforeEach(() => {
  __resetLifecycle();
  __forgetWaitMemory();
  __forgetKeptLast();
  __resetPresses();
  __resetBacklog();
  __resetDrafts();
});

afterEach(async () => {
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
  await db.execute(sql`DELETE FROM telegram_chat_waits WHERE chat_id::text LIKE ${`${PREFIX}%`}`);
  if (madeReceipts.length) {
    await db.delete(attachments).where(inArray(attachments.entityId, madeReceipts));
    await db.delete(receipts).where(inArray(receipts.id, madeReceipts));
  }
  const people = [sellerId, operatorId].filter(Boolean);
  await db.update(telegramLinks).set({ status: 'revoked' }).where(inArray(telegramLinks.userId, people));
  await db.delete(userWarehouses).where(inArray(userWarehouses.userId, people));
  await db.delete(userRoles).where(inArray(userRoles.userId, people));
  // DEACTIVATED, never deleted: the audit rows above point at them.
  await db.update(users).set({ active: false }).where(inArray(users.id, people));
  await pgClient.end();
});

describe('the collection: press, send, «Bo‘ldi»', () => {
  it('a file sent after the press is on THAT prixod the moment it arrives — a paper, never a carton photo — and «Bo‘ldi» says how many', async () => {
    const receipt = await mintReceipt('a');
    const prompt = await open(sellerChat, receipt.id);
    expect(prompt.text).toContain(`📎 Prixod ${receipt.number}.`);
    expect(prompt.markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual([`pf:ok:${receipt.id}`]);

    let m = h.mark();
    const invoice = doc(sellerChat, 'invoice.pdf', { after: prompt.messageId });
    await h.handle(invoice);
    // Stored before any acknowledgement, and before «Bo‘ldi»: nothing waits to be attached.
    expect((await filesOn(receipt.id)).map((f) => [f.kind, f.fileName, f.uploadedBy])).toEqual([['file', 'invoice.pdf', sellerId]]);
    await h.settle();
    const ack = h.since(m).api.filter((c) => c.method === 'sendMessage').at(-1)!;
    expect(String(ack.payload.text)).toContain(`📎 ${receipt.number}: 1 ta fayl biriktirildi.`);
    expect((ack.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat().map((b) => b.callback_data)).toEqual([
      `pf:ok:${receipt.id}`,
      `pf:no:${receipt.id}`,
    ]);

    // A PHOTO of a packing list, forwarded: Door B would offer «📌 Topshiriq
    // qilamizmi?» for a forward — the collection takes it first. And it is
    // stored as a FILE: a prixod's `kind = 'photo'` rows are its carton
    // photos, which the loader's list draws where the cargo should be.
    m = h.mark();
    const photo = tg.photo(sellerChat, { forwarded: true, messageId: ack.messageId! + 1 });
    const photoId = (photo as unknown as { message: { photo: { file_id: string }[] } }).message.photo[0]!.file_id;
    h.serveFile(photoId, Buffer.from('jpeg bytes'));
    await h.handle(photo);
    await h.settle();
    const stored = await filesOn(receipt.id);
    expect(stored.map((f) => f.kind)).toEqual(['file', 'file']);
    expect(stored.some((f) => f.contentType === 'image/jpeg')).toBe(true);
    expect(saidSince(m).join('\n')).not.toContain('Topshiriq');

    // The same Telegram message delivered again (a kill after the row
    // landed): nothing is stored twice and nothing is counted twice.
    await h.handle(tg.again(invoice));
    await h.settle();
    expect(await filesOn(receipt.id)).toHaveLength(2);

    m = h.mark();
    await h.handle(tg.callback(sellerChat, ack.messageId!, `pf:ok:${receipt.id}`, { text: 'ack' }));
    expect(saidSince(m).at(-1)).toBe(`✅ 2 ta fayl prixod ${receipt.number} ga biriktirildi.`);
    expect(standingReceiptFiles(BigInt(sellerChat))).toBeNull();

    // The History names every file, each under its own key — a shared key
    // would have folded the run into one line about the last.
    const audit = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, receipt.id)));
    const keys = audit.flatMap((row) => Object.keys((row.after ?? {}) as Record<string, unknown>));
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => key.startsWith('fileAdded:'))).toBe(true);
  });

  it('an album is acknowledged ONCE, after its last part', async () => {
    const receipt = await mintReceipt('b');
    const prompt = await open(sellerChat, receipt.id);
    const m = h.mark();
    for (const name of ['1.pdf', '2.pdf', '3.pdf']) {
      const part = doc(sellerChat, name, { after: prompt.messageId });
      (part as unknown as { message: Record<string, unknown> }).message.media_group_id = `al-${STAMP}`;
      await h.handle(part);
    }
    await h.settle();
    expect(await filesOn(receipt.id)).toHaveLength(3);
    const acks = saidSince(m).filter((text) => text.includes('ta fayl biriktirildi'));
    expect(acks).toHaveLength(1);
    expect(acks[0]).toContain('3 ta fayl biriktirildi');
  });

  it('a second press for the SAME prixod is the same collection: what it took is kept', async () => {
    const receipt = await mintReceipt('c');
    const prompt = await open(sellerChat, receipt.id);
    await h.handle(doc(sellerChat, 'first.pdf', { after: prompt.messageId }));
    await h.settle();
    const again = await open(sellerChat, receipt.id);
    expect(again.text).toContain('Hozircha 1 ta fayl biriktirilgan.');
    const m = h.mark();
    await h.handle(tg.callback(sellerChat, again.messageId, `pf:ok:${receipt.id}`));
    expect(saidSince(m).at(-1)).toBe(`✅ 1 ta fayl prixod ${receipt.number} ga biriktirildi.`);
  });

  it('«↩️ Bekor qilish» takes back exactly what this collection put on the prixod', async () => {
    const receipt = await mintReceipt('d');
    // A file that was on the prixod BEFORE the collection stays.
    await db.insert(attachments).values({
      entityType: 'receipt',
      entityId: receipt.id,
      kind: 'file',
      storageKey: `rftest/${receipt.id}/old`,
      fileName: 'earlier.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1,
      uploadedBy: sellerId,
    });
    const prompt = await open(sellerChat, receipt.id);
    await h.handle(doc(sellerChat, 'wrong-1.pdf', { after: prompt.messageId }));
    await h.handle(doc(sellerChat, 'wrong-2.pdf', { after: prompt.messageId }));
    await h.settle();
    expect(await filesOn(receipt.id)).toHaveLength(3);
    const m = h.mark();
    await h.handle(tg.callback(sellerChat, prompt.messageId, `pf:no:${receipt.id}`));
    expect((await filesOn(receipt.id)).map((f) => f.fileName)).toEqual(['earlier.pdf']);
    expect(saidSince(m).at(-1)).toBe(`↩️ Prixod ${receipt.number}: 2 ta fayl olib tashlandi.`);
    expect(standingReceiptFiles(BigInt(sellerChat))).toBeNull();
  });
});

describe('a collection never ends in silence', () => {
  it('thirty quiet minutes: the next file is told, once, that it was NOT attached — with the button that opens the collection again', async () => {
    const receipt = await mintReceipt('e');
    const t0 = Math.floor(Date.now() / 1000) - 3600;
    h.setClock(t0);
    const prompt = await open(sellerChat, receipt.id);
    await h.handle(doc(sellerChat, 'in-time.pdf', { after: prompt.messageId, date: t0 + 60 }));
    await h.settle();
    const m = h.mark();
    // 31 minutes after the last file.
    await h.handle(doc(sellerChat, 'late.pdf', { after: prompt.messageId, date: t0 + 60 + 31 * 60 }));
    await h.settle();
    expect((await filesOn(receipt.id)).map((f) => f.fileName)).toEqual(['in-time.pdf']);
    const said = h.since(m).api.find((c) => c.method === 'sendMessage' && String(c.payload.text).startsWith('⌛'))!;
    expect(String(said.payload.text)).toContain(`Prixod ${receipt.number} uchun fayl yig‘ish 30 daqiqa fayl kelmagani uchun yopilgan`);
    expect(String(said.payload.text)).toContain('bu fayl biriktirilmadi');
    expect((said.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0]![0]!.callback_data).toBe(
      `pf:${receipt.id}`,
    );
    // Said ONCE: the next file of the same burst goes down the ladder with no second sentence from here.
    const m2 = h.mark();
    await h.handle(doc(sellerChat, 'late-2.pdf', { after: prompt.messageId, date: t0 + 60 + 31 * 60 + 1 }));
    await h.settle();
    expect(saidSince(m2).filter((text) => text.startsWith('⌛'))).toEqual([]);
    expect(await filesOn(receipt.id)).toHaveLength(1);
  });

  it('another collector opened: this one takes nothing more, and says so under the next file', async () => {
    const receipt = await mintReceipt('f');
    const prompt = await open(sellerChat, receipt.id);
    await h.handle(doc(sellerChat, 'mine.pdf', { after: prompt.messageId }));
    await h.settle();
    // What «Hisoblatish», a task draft and a zametka each do as they open
    // (the three call sites are fenced in the unit suite).
    closeReceiptFiles(BigInt(sellerChat));
    const m = h.mark();
    await h.handle(doc(sellerChat, 'not-mine.pdf', { after: prompt.messageId }));
    await h.settle();
    expect((await filesOn(receipt.id)).map((f) => f.fileName)).toEqual(['mine.pdf']);
    const said = saidSince(m).find((text) => text.startsWith('⌛'))!;
    expect(said).toContain('boshqa ish boshlangani uchun yopilgan (unda 1 ta fayl biriktirilgan)');
  });

  it('a press under an EARLIER prixod’s message closes nothing: the open collection goes on', async () => {
    const earlier = await mintReceipt('g1');
    const current = await mintReceipt('g2');
    const first = await open(sellerChat, earlier.id);
    const prompt = await open(sellerChat, current.id);
    // The stale «✅ Bo‘ldi» under the first prompt.
    const m = h.mark();
    await h.handle(tg.callback(sellerChat, first.messageId, `pf:ok:${earlier.id}`));
    expect(saidSince(m).at(-1)).toBe('Bu yig‘ish allaqachon yopilgan — yuborilgan fayllar prixodga biriktirilgan.');
    await h.handle(doc(sellerChat, 'still.pdf', { after: prompt.messageId }));
    expect((await filesOn(current.id)).map((f) => f.fileName)).toEqual(['still.pdf']);
    expect(await filesOn(earlier.id)).toEqual([]);
  });

  it('a video and a typed text are answered in words — never silence, never a question to the paid assistant', async () => {
    const receipt = await mintReceipt('h');
    await open(sellerChat, receipt.id);
    let m = h.mark();
    const video = tg.text(sellerChat, 'x', { forwarded: true });
    const message = (video as unknown as { message: Record<string, unknown> }).message;
    delete message.text;
    message.video = { file_id: 'v1', file_unique_id: 'v1', width: 1, height: 1, duration: 1 };
    await h.handle(video);
    expect(saidSince(m)).toEqual([expect.stringContaining('prixodga biriktirilmaydi')]);

    m = h.mark();
    // A sentence no free lookup answers (a client code in it would be looked up, as it should).
    await h.handle(tg.text(sellerChat, 'bu invoys ertaga keladi, kutib turing'));
    await h.settle();
    expect(saidSince(m)).toEqual([expect.stringContaining('✍️ Matn prixodga yozilmaydi')]);
    expect(await filesOn(receipt.id)).toEqual([]);
  });
});

describe('the door, asked at the press and at every file', () => {
  it('a voided prixod takes no collection — and one voided mid-collection takes no more files', async () => {
    const receipt = await mintReceipt('i');
    const prompt = await open(sellerChat, receipt.id);
    await db
      .update(receipts)
      .set({ status: 'voided', voidedAt: new Date(), voidedBy: sellerId, voidReason: 'test' })
      .where(eq(receipts.id, receipt.id));
    let m = h.mark();
    await h.handle(doc(sellerChat, 'after-void.pdf', { after: prompt.messageId }));
    expect(saidSince(m)).toEqual(['Bu prixod bekor qilingan — fayl qo‘shib bo‘lmaydi.']);
    expect(await filesOn(receipt.id)).toEqual([]);
    expect(standingReceiptFiles(BigInt(sellerChat))).toBeNull();

    m = h.mark();
    await h.handle(tg.callback(sellerChat, 41_500, `pf:${receipt.id}`));
    expect(saidSince(m)).toEqual(['Bu prixod bekor qilingan — fayl qo‘shib bo‘lmaydi.']);
    expect(standingReceiptFiles(BigInt(sellerChat))).toBeNull();
  });

  it('a person who may not open the prixod on the site may not feed it from the bot', async () => {
    const receipt = await mintReceipt('j');
    const m = h.mark();
    await h.handle(tg.callback(operatorChat, 41_600, `pf:${receipt.id}`));
    expect(saidSince(m)).toEqual(['Bu prixodni ochishga huquqingiz yo‘q.']);
    expect(standingReceiptFiles(BigInt(operatorChat))).toBeNull();
  });

  it('refused in words while another collector holds the chat', async () => {
    const receipt = await mintReceipt('k');
    startCapture(BigInt(sellerChat), crypto.randomUUID());
    try {
      const m = h.mark();
      await h.handle(tg.callback(sellerChat, 41_700, `pf:${receipt.id}`));
      expect(saidSince(m)).toEqual([expect.stringContaining('Avval zametkani saqlang yoki bekor qiling')]);
      expect(standingReceiptFiles(BigInt(sellerChat))).toBeNull();
    } finally {
      endCapture(BigInt(sellerChat));
    }
  });
});

describe('a deploy in the middle', () => {
  it('the collection is a ROW the table admits: after a restart the next file still lands on its prixod', async () => {
    const receipt = await mintReceipt('l');
    setDurableWaits(true);
    try {
      const prompt = await open(sellerChat, receipt.id);
      await flushWaitWrites();
      const rows = await db.execute(sql`SELECT kind FROM telegram_chat_waits WHERE chat_id = ${String(sellerChat)}::bigint`);
      // Red if 0145 did not widen the CHECK: the write is refused in silence
      // and memory goes on answering until the next restart.
      expect(rows.map((r) => r.kind)).toContain('receipt_files');
      __forgetWaitMemory();
      await hydrateWaits();
      await h.handle(doc(sellerChat, 'after-restart.pdf', { after: prompt.messageId }));
      await h.settle();
      expect((await filesOn(receipt.id)).map((f) => f.fileName)).toEqual(['after-restart.pdf']);
    } finally {
      await flushWaitWrites();
      setDurableWaits(false);
    }
  });

  it('a file sent INTO the outage, after the press, is taken — updates come in order, so it was sent for this prixod', async () => {
    const receipt = await mintReceipt('m');
    const boot = new Date();
    markBoot(boot);
    const prompt = await open(sellerChat, receipt.id);
    // Written two minutes before the bot came back: backlog to every other collector.
    const sent = Math.floor(boot.getTime() / 1000) - 120;
    await h.handle(doc(sellerChat, 'into-the-outage.pdf', { after: prompt.messageId, date: sent }));
    await h.settle();
    expect((await filesOn(receipt.id)).map((f) => f.fileName)).toEqual(['into-the-outage.pdf']);
  });
});
