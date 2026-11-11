import { eq } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { db } from '../db/client';
import { attachments } from '../db/schema';
import { logger } from '../logger';
import { fileOf, isFileRefusal, saveBotFile, type BotFileRefusal } from './calc-files';
import { holdingIntake } from './calc-store';
import { drawKeptLast, keepLastSoon, retireCopy, type KeptLastApi } from './kept-last';
import { activeCapture } from './note-capture';
import { answerPress } from './press';
import {
  endReceiptFiles,
  liveReceiptFiles,
  MAX_RECEIPT_FILES,
  noteReceiptFile,
  noteReceiptFilesMessage,
  openReceiptFiles,
  readReceiptFiles,
  RECEIPT_FILE_NOT_STORED,
  RECEIPT_FILES_REFUSED,
  RECEIPT_FILES_SAY,
  receiptFilesAck,
  receiptFilesDone,
  receiptFilesKeyboard,
  receiptFilesPrompt,
} from './receipt-files';
import { botActorFor } from './staff-bot';
import { activeDraft } from './task-draft';
import { flushWaitWrites } from './waits';

/**
 * «📎 Fayl qo‘shish» — the three doors of a prixod's file collection (the
 * press that opens it, a file that arrives, «✅ Bo‘ldi»), for the staff bot's
 * dispatcher and its media ladder (docs/PRIXOD-XABARI.md §C.5-C.6).
 *
 * The decision «may this person put a file on this prixod» is wms's
 * (`receiptFilesDoor`, the web upload route's own rule), reached the
 * established way — a dynamic import, because platform never imports wms
 * statically. It is asked at the press AND at every file: the button stays
 * under its message for ever, and a prixod can be voided between two forwards.
 *
 * Every file is stored the moment it arrives, on the prixod itself. «✅
 * Bo‘ldi» closes the collection and says the count; it attaches nothing,
 * because nothing is waiting to be attached.
 */

type Reply = (text: string, extra?: Record<string, unknown>) => Promise<{ message_id: number; date: number }>;

interface PressCtx {
  answerCallbackQuery: (other?: { text?: string }) => Promise<unknown>;
  reply: Reply;
  api?: unknown;
  callbackQuery: { message?: { message_id: number } };
}

interface FileCtx {
  message: {
    message_id: number;
    date: number;
    photo?: { file_id: string; file_size?: number }[];
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  reply: Reply;
  api?: unknown;
}

const apiOf = (ctx: { api?: unknown }) => ctx.api as KeptLastApi | undefined;

async function doorFor(chatId: bigint, receiptId: string) {
  const actor = await botActorFor(chatId);
  if (!actor) return { actor: null, door: null } as const;
  const { receiptFilesDoor } = await import('../../wms/receipts/files-door');
  return { actor, door: await receiptFilesDoor(actor, receiptId) } as const;
}

/** The prixod's card, for a URL button — only on https (Telegram refuses any other button URL, and takes the message with it). */
function cardUrl(receiptId: string): string | null {
  const base = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
  return base.startsWith('https://') ? `${base}/receipts/${receiptId}` : null;
}

/**
 * The press on «📎 Fayl qo‘shish». Every path answers the callback (#939).
 *
 * A second press for the SAME prixod only asks again and keeps the count; a
 * press for ANOTHER prixod closes the open collection, saying what it took.
 */
export async function openReceiptFilesPress(ctx: PressCtx, chatId: bigint, receiptId: string): Promise<void> {
  const { actor, door } = await doorFor(chatId, receiptId);
  if (!actor || !door) {
    await answerPress(ctx, RECEIPT_FILES_SAY.notLinked);
    return;
  }
  // One collector at a time, and this one holds no unsaved work — so it is the
  // one that waits. A press is refused in words rather than opened beside a
  // collection whose files it would then never see.
  const busy = holdingIntake(chatId)
    ? RECEIPT_FILES_SAY.busyIntake
    : activeCapture(chatId)
      ? RECEIPT_FILES_SAY.busyCapture
      : activeDraft(chatId)
        ? RECEIPT_FILES_SAY.busyDraft
        : null;
  if (busy) {
    await answerPress(ctx, busy);
    await ctx.reply(busy);
    return;
  }
  if (!door.ok) {
    const text = RECEIPT_FILES_REFUSED[door.error];
    await answerPress(ctx, text);
    await ctx.reply(text);
    return;
  }
  await answerPress(ctx);
  const stood = readReceiptFiles(chatId)?.payload ?? null;
  const same = stood !== null && stood.receiptId === door.receipt.id && liveReceiptFiles(chatId) !== null;
  const closed = stood !== null && !same ? endReceiptFiles(chatId) : null;
  const count = same ? stood.count : 0;
  const prompt = await ctx.reply(
    receiptFilesPrompt({ number: door.receipt.number, clientCode: door.receipt.clientCode, count }, closed && closed.count > 0 ? closed : null),
    { reply_markup: receiptFilesKeyboard() },
  );
  // The earlier copy of the collection's one message (its «✅ Bo‘ldi» would
  // otherwise stand twice on the screen) goes, best-effort.
  if (stood?.messageId && stood.messageId !== prompt.message_id) await retireCopy(apiOf(ctx), chatId, stood.messageId);
  // Armed AFTER the prompt, at its own date (Q5 a).
  openReceiptFiles(chatId, door.receipt, { messageId: prompt.message_id, date: prompt.date }, count);
}

/** «✅ Bo‘ldi». The files are already on the prixod; this ends the collection and says how many. */
export async function doneReceiptFilesPress(ctx: PressCtx, chatId: bigint): Promise<void> {
  const stood = endReceiptFiles(chatId);
  if (!stood) {
    await answerPress(ctx, RECEIPT_FILES_SAY.over);
    return;
  }
  // The DELETE lands before the sentence: a redelivered press after a restart
  // must find no collection to close a second time.
  await flushWaitWrites();
  await answerPress(ctx);
  const pressed = ctx.callbackQuery.message?.message_id ?? null;
  for (const id of new Set([stood.messageId, pressed])) {
    if (id !== null) await retireCopy(apiOf(ctx), chatId, id);
  }
  const url = stood.count > 0 ? cardUrl(stood.receiptId) : null;
  await ctx.reply(
    receiptFilesDone(stood),
    url ? { reply_markup: { inline_keyboard: [[{ text: RECEIPT_FILES_SAY.openCard, url }]] } } : {},
  );
}

/** The namespace of a collected file's attachment id — `uuidv5(prixod:chat:message)`, so a redelivered update stores nothing twice. */
const RECEIPT_FILE_NS = '5a1d5c0e-7f3b-4d0a-9c53-0f6f2c7b1e44';

/**
 * A photo or a document while the chat's collection is live. True = this
 * collection answered for it (stored, or refused in words); false = not this
 * collection's, the rest of the ladder asks.
 *
 * The CALLER decides the order: it is asked only after a taking «Hisoblatish»
 * collection, a zametka capture and a live task draft have each declined —
 * this is the lowest collector, it holds no unsaved work — and never for a
 * backlog file (no collector opened by this process takes one, Q5 a).
 */
export async function receiptFileArrives(ctx: FileCtx, chatId: bigint): Promise<boolean> {
  const live = liveReceiptFiles(chatId, ctx.message.date);
  if (!live) return false;
  const file = fileOf(ctx.message);
  if (!file) return false;
  const at = { messageId: ctx.message.message_id, date: ctx.message.date };
  const under = { reply_parameters: { message_id: at.messageId, allow_sending_without_reply: true } };

  const { actor, door } = await doorFor(chatId, live.receiptId);
  if (!actor || !door) {
    endReceiptFiles(chatId);
    return false;
  }
  if (!door.ok) {
    // Voided (or closed to this person) since the press: nothing more goes on
    // it, and the person is told why this file did not.
    endReceiptFiles(chatId);
    await ctx.reply(RECEIPT_FILES_REFUSED[door.error], under);
    return true;
  }
  if (live.count >= MAX_RECEIPT_FILES) {
    await ctx.reply(RECEIPT_FILES_SAY.full, under);
    return true;
  }

  const id = uuidv5(`${live.receiptId}:${String(chatId)}:${at.messageId}`, RECEIPT_FILE_NS);
  const [known] = await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.id, id)).limit(1);
  let stored = false;
  if (!known) {
    const saved = await saveBotFile(
      ctx,
      { entityType: 'receipt', entityId: live.receiptId, uploadedBy: actor.id, namePrefix: 'prixod', id, keyName: `tg${at.messageId}` },
      file,
    ).catch((err: unknown): BotFileRefusal => {
      logger.warn({ err, receiptId: live.receiptId }, '[receipt-files] file not stored');
      return { refused: 'download_failed' };
    });
    if (isFileRefusal(saved)) {
      await ctx.reply(RECEIPT_FILE_NOT_STORED[saved.refused], under);
      // The thirty minutes still start again: the person is here, sending.
      noteReceiptFile(chatId, at, false);
      return true;
    }
    stored = true;
    const { recordReceiptFile } = await import('../../wms/receipts/files-door');
    await recordReceiptFile({
      actorId: actor.id,
      receipt: door.receipt,
      fileName: file.isPhoto ? 'rasm' : (file.fileName ?? 'fayl'),
    });
  }
  noteReceiptFile(chatId, at, stored);
  // ONE acknowledgement per burst, off the poller (#706): an album of ten
  // parts moves the collection's message once, after its last part.
  keepLastSoon(`rfiles:${chatId}`, () => drawReceiptFiles(ctx, chatId), RECEIPT_ACK_DEBOUNCE_MS);
  return true;
}

/** How long a run of files waits before its one acknowledgement — an album's parts arrive within a second of each other. */
export const RECEIPT_ACK_DEBOUNCE_MS = 1200;

/** The collection's ONE message as it stands now, kept last: the prompt first, then «N ta fayl biriktirildi». */
async function drawReceiptFiles(ctx: { reply: Reply; api?: unknown }, chatId: bigint): Promise<void> {
  // Re-read: «✅ Bo‘ldi» or another collector may have ended it during the debounce.
  const now = liveReceiptFiles(chatId);
  if (!now || now.count === 0) return;
  const drawn = await drawKeptLast(
    { reply: (text, extra) => ctx.reply(text, extra), api: apiOf(ctx) },
    chatId,
    now.messageId,
    now.lastSeen,
    receiptFilesAck(now),
    { reply_markup: receiptFilesKeyboard() },
  );
  noteReceiptFilesMessage(chatId, now.receiptId, drawn.messageId);
}
