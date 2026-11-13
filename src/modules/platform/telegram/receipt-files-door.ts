import { eq } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { db } from '../db/client';
import { attachments } from '../db/schema';
import { AttachmentDeleteError, deleteAttachment } from '../files/service';
import { logger } from '../logger';
import { fileOf, isFileRefusal, saveBotFile, type BotFileRefusal } from './calc-files';
import { holdingIntake } from './calc-store';
import { drawKeptLast, keepLastSoon, retireCopy, type KeptLastApi } from './kept-last';
import { activeCapture } from './note-capture';
import { answerPress } from './press';
import {
  endReceiptFiles,
  MAX_RECEIPT_FILES,
  noteReceiptFile,
  noteReceiptFilesMessage,
  openReceiptFiles,
  RECEIPT_FILE_NOT_STORED,
  RECEIPT_FILES_REFUSED,
  RECEIPT_FILES_SAY,
  receiptFilesAck,
  receiptFilesCancelled,
  receiptFilesClosed,
  receiptFilesDone,
  receiptFilesKeyboard,
  receiptFilesPrompt,
  receiptFilesReplied,
  receiptFilesReopenKeyboard,
  standingReceiptFiles,
  type ReceiptFilesWait,
} from './receipt-files';
import { editMarkup } from './send';
import { botActorFor } from './staff-bot';
import { activeDraft } from './task-draft';
import { flushWaitWrites } from './waits';

/**
 * «📎 Fayl qo‘shish» — the doors of a prixod's file collection (the press that
 * opens it, a file that arrives, «✅ Bo‘ldi», «↩️ Bekor qilish»), for the
 * staff bot's dispatcher and its media ladder (docs/PRIXOD-XABARI.md §C.5-C.6).
 *
 * The decision «may this person put a file on this prixod» is wms's
 * (`receiptFilesDoor`, the web upload route's own rule), reached the
 * established way — a dynamic import, because platform never imports wms
 * statically. It is asked at the press AND at every file: the button stays
 * under its message for ever, and a prixod can be voided between two forwards.
 *
 * Every file is stored the moment it arrives, on the prixod itself. «✅
 * Bo‘ldi» closes the collection and says the count — it attaches nothing,
 * because nothing is waiting to be attached — and «↩️ Bekor qilish» takes
 * back exactly what this collection put there.
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
    reply_to_message?: { message_id: number; from?: { is_bot?: boolean } };
  };
  reply: Reply;
  api?: unknown;
}

/**
 * Does this file swipe-reply to one of the BOT's messages that is not the
 * collection's own? Telegram's gesture for «this belongs to that message»: a
 * reply to another prixod's «Prixod keldi», to an AI answer (the add door),
 * to a thread or a task ping. Such a file is never this collection's — it
 * was storing GS812's packing list on GS777's prixod, and it took a file
 * the add door had always opened on.
 */
function repliesElsewhere(message: FileCtx['message'], wait: ReceiptFilesWait): boolean {
  const target = message.reply_to_message;
  return Boolean(target && target.from?.is_bot === true && target.message_id !== wait.messageId);
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

/** The pressed message loses its buttons (a stale copy must not go on offering what no longer exists). Best-effort. */
async function stripPressed(ctx: PressCtx, chatId: bigint): Promise<void> {
  const pressed = ctx.callbackQuery.message?.message_id;
  if (!pressed) return;
  await editMarkup({ chatId, messageId: pressed }).catch(() => undefined);
}

/** The standing collection, when it is THIS prixod's — open or closed. */
function standingFor(chatId: bigint, receiptId: string): ReceiptFilesWait | null {
  const standing = standingReceiptFiles(chatId);
  return standing && standing.wait.receiptId === receiptId ? standing.wait : null;
}

/**
 * The press on «📎 Fayl qo‘shish». Every path answers the callback (#939).
 *
 * A second press for the SAME prixod while its collection is open only asks
 * again and keeps what it took; a press for ANOTHER prixod closes the open
 * collection, saying what it took.
 */
export async function openReceiptFilesPress(ctx: PressCtx, chatId: bigint, receiptId: string): Promise<void> {
  const { actor, door } = await doorFor(chatId, receiptId);
  if (!actor || !door) {
    await answerPress(ctx, RECEIPT_FILES_SAY.notLinked);
    return;
  }
  // One collector at a time, and this one holds no unsaved work — so it is the
  // one that waits. Refused in words rather than opened beside a collection
  // whose files it would then never see.
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
  const standing = standingReceiptFiles(chatId);
  const keep = standing?.state === 'live' && standing.wait.receiptId === door.receipt.id ? standing.wait : null;
  // What the open collection of ANOTHER prixod took is said as it closes; a
  // closed entry of any prixod simply goes (its files are on their prixod).
  const said = standing && !keep && standing.state === 'live' ? standing.wait : null;
  if (standing && !keep) endReceiptFiles(chatId);
  const next = { number: door.receipt.number, clientCode: door.receipt.clientCode, files: keep?.files ?? [] };
  const prompt = await ctx.reply(receiptFilesPrompt(next, said), {
    reply_markup: receiptFilesKeyboard({ receiptId: door.receipt.id, files: next.files }),
  });
  // The earlier copy of the collection's one message goes, best-effort — its
  // buttons would otherwise stand twice on the screen.
  if (standing?.wait.messageId && standing.wait.messageId !== prompt.message_id) {
    await retireCopy(apiOf(ctx), chatId, standing.wait.messageId);
  }
  // Armed AFTER the prompt, at its own date (Q5 a).
  openReceiptFiles(chatId, door.receipt, { messageId: prompt.message_id, date: prompt.date }, keep);
}

/**
 * «✅ Bo‘ldi» — under THIS prixod's collection. The files are already on the
 * prixod; this ends the collection and says how many, as a message. A press
 * under any other prixod's message closes nothing.
 */
export async function doneReceiptFilesPress(ctx: PressCtx, chatId: bigint, receiptId: string): Promise<void> {
  const stood = standingFor(chatId, receiptId);
  if (!stood) {
    await answerPress(ctx);
    await stripPressed(ctx, chatId);
    await ctx.reply(RECEIPT_FILES_SAY.over);
    return;
  }
  endReceiptFiles(chatId);
  // The DELETE lands before the sentence: a redelivered press after a restart
  // must find no collection to close a second time.
  await flushWaitWrites();
  await answerPress(ctx);
  await retireCollectionMessage(ctx, chatId, stood);
  const url = stood.files.length > 0 ? cardUrl(stood.receiptId) : null;
  await ctx.reply(
    receiptFilesDone(stood),
    url ? { reply_markup: { inline_keyboard: [[{ text: RECEIPT_FILES_SAY.openCard, url }]] } } : {},
  );
}

/** The collection's own message (and the pressed copy, when it is another) goes; one that cannot be deleted loses its buttons. */
async function retireCollectionMessage(ctx: PressCtx, chatId: bigint, stood: ReceiptFilesWait): Promise<void> {
  const pressed = ctx.callbackQuery.message?.message_id ?? null;
  for (const id of new Set([stood.messageId, pressed])) {
    if (id === null) continue;
    if (!(await retireCopy(apiOf(ctx), chatId, id))) await editMarkup({ chatId, messageId: id }).catch(() => undefined);
  }
}

/**
 * «↩️ Bekor qilish» — takes back what THIS collection put on the prixod,
 * through the shared delete door and under the presser's own right (the
 * uploader may always remove their upload). A file something already cites —
 * a lot's tarkib names its paper — stays, and is counted as kept.
 */
export async function cancelReceiptFilesPress(ctx: PressCtx, chatId: bigint, receiptId: string): Promise<void> {
  const actor = await botActorFor(chatId);
  if (!actor) {
    await answerPress(ctx, RECEIPT_FILES_SAY.notLinked);
    return;
  }
  const stood = standingFor(chatId, receiptId);
  if (!stood) {
    await answerPress(ctx);
    await stripPressed(ctx, chatId);
    await ctx.reply(RECEIPT_FILES_SAY.overCancel);
    return;
  }
  endReceiptFiles(chatId);
  await flushWaitWrites();
  await answerPress(ctx);
  let removed = 0;
  let kept = 0;
  for (const file of stood.files) {
    try {
      await deleteAttachment(file.a, { id: actor.id, permissions: actor.permissions });
      removed += 1;
    } catch (err) {
      // Already gone is as good as removed; anything else stays and is said.
      if (err instanceof AttachmentDeleteError && err.code === 'not_found') removed += 1;
      else {
        kept += 1;
        if (!(err instanceof AttachmentDeleteError)) logger.warn({ err, receiptId }, '[receipt-files] file not removed');
      }
    }
  }
  await retireCollectionMessage(ctx, chatId, stood);
  await ctx.reply(receiptFilesCancelled(stood, removed, kept));
}

/** The namespace of a collected file's attachment id — `uuidv5(prixod:chat:message)`, so a redelivered update stores nothing twice. */
const RECEIPT_FILE_NS = '5a1d5c0e-7f3b-4d0a-9c53-0f6f2c7b1e44';

/**
 * A photo or a document while the chat has a collection. True = this
 * collection answered for it (stored, or refused in words); false = not this
 * collection's, the rest of the ladder asks.
 *
 * The CALLER decides the order: it is asked only after a taking «Hisoblatish»
 * collection, a zametka capture and a live task draft have each declined —
 * this is the lowest collector, it holds no unsaved work.
 *
 * A CLOSED collection (thirty quiet minutes, or another collector opened)
 * says so once, under the first file that meets it, with the button that
 * opens it again — and lets the file go on down the ladder as if this
 * collector were not there. Nothing here ends in silence.
 */
export async function receiptFileArrives(ctx: FileCtx, chatId: bigint): Promise<boolean> {
  const standing = standingReceiptFiles(chatId, ctx.message.date);
  if (!standing) return false;
  const file = fileOf(ctx.message);
  if (!file) return false;
  // A reply to another message is that message's: the doors below this one
  // (the add door, a thread, a task) answer it as they always did, and what
  // none of them takes is told by `receiptFileRepliedElsewhere`.
  if (repliesElsewhere(ctx.message, standing.wait)) return false;
  const at = { messageId: ctx.message.message_id, date: ctx.message.date };
  const under = { reply_parameters: { message_id: at.messageId, allow_sending_without_reply: true } };

  if (standing.state === 'closed') {
    endReceiptFiles(chatId);
    await ctx.reply(receiptFilesClosed(standing.wait, standing.why), {
      ...under,
      reply_markup: receiptFilesReopenKeyboard(standing.wait),
    });
    return false;
  }
  const live = standing.wait;

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
  if (live.files.length >= MAX_RECEIPT_FILES) {
    await ctx.reply(RECEIPT_FILES_SAY.full, under);
    return true;
  }

  // The row is looked up FIRST: a redelivered update (a kill after the row
  // landed, before the batch was confirmed) finds it, joins the set and
  // downloads nothing — a fixed id alone would be a primary-key violation.
  const id = uuidv5(`${live.receiptId}:${String(chatId)}:${at.messageId}`, RECEIPT_FILE_NS);
  const [known] = await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.id, id)).limit(1);
  if (!known) {
    const saved = await saveBotFile(
      ctx,
      {
        entityType: 'receipt',
        entityId: live.receiptId,
        uploadedBy: actor.id,
        // A photo is named by its prixod and its place in the collection — the
        // tarkib editor lists these as chips, and five «rasm.jpg» are no list.
        namePrefix: `${live.number}_${live.files.length + 1}`,
        id,
        keyName: `tg${String(chatId).replace('-', 'n')}m${at.messageId}`,
        // A PAPER, whatever its bytes: a seller's photo of an invoice must
        // never become «the prixod's first photo» the loader's list draws
        // where the carton should be.
        asPaper: true,
      },
      file,
    ).catch((err: unknown): BotFileRefusal => {
      logger.warn({ err, receiptId: live.receiptId }, '[receipt-files] file not stored');
      return { refused: 'download_failed' };
    });
    if (isFileRefusal(saved)) {
      await ctx.reply(RECEIPT_FILE_NOT_STORED[saved.refused], under);
      // The thirty minutes still start again: the person is here, sending.
      noteReceiptFile(chatId, at, null);
      return true;
    }
    const { recordReceiptFile } = await import('../../wms/receipts/files-door');
    await recordReceiptFile({
      actorId: actor.id,
      receipt: door.receipt,
      item: String(at.messageId),
      // The name the file is STORED under — the one its tile on the card
      // reads. A photo used to be recorded as «rasm», which matched nothing
      // on the screen the History sits under.
      fileName: saved.fileName ?? (file.isPhoto ? 'rasm' : (file.fileName ?? 'fayl')),
    });
  }
  noteReceiptFile(chatId, at, id);
  // ONE acknowledgement per burst, off the poller (#706): an album of ten
  // parts moves the collection's message once, after its last part.
  keepLastSoon(`rfiles:${chatId}`, () => drawReceiptFiles(ctx, chatId), RECEIPT_ACK_DEBOUNCE_MS);
  return true;
}

/**
 * A replied file that NO door took, while a collection is live: said under
 * the file — never the silence a staff chat's unclaimed file meets, under a
 * prompt that still says «shu yerga yuboring». Asked by the ladder AFTER the
 * task door and the reply door declined it. True = said.
 */
export async function receiptFileRepliedElsewhere(ctx: FileCtx, chatId: bigint): Promise<boolean> {
  const standing = standingReceiptFiles(chatId, ctx.message.date);
  if (!standing || standing.state !== 'live' || !repliesElsewhere(ctx.message, standing.wait)) return false;
  await ctx.reply(receiptFilesReplied(standing.wait), {
    reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
  });
  return true;
}

/** How long a run of files waits before its one acknowledgement — an album's parts arrive within a second of each other. */
export const RECEIPT_ACK_DEBOUNCE_MS = 1200;

/** The collection's ONE message as it stands now, kept last: the prompt first, then «N ta fayl biriktirildi». */
async function drawReceiptFiles(ctx: { reply: Reply; api?: unknown }, chatId: bigint): Promise<void> {
  // Re-read: «✅ Bo‘ldi», the cancel or another collector may have ended it during the debounce.
  const standing = standingReceiptFiles(chatId);
  if (!standing || standing.wait.files.length === 0) return;
  if (standing.state === 'closed') {
    // Taken by its own date and drawn after the window passed by the clock
    // (a file sent into a long outage): it IS on the prixod, so it is said —
    // as the collection's last word, with no «Yana yuboring», because
    // nothing more will be taken. The closed entry STAYS: a file sent after
    // this is still told that it was not attached. Closed by another
    // collector's opening, nothing is said here: that collector is talking.
    if (standing.why !== 'quiet') return;
    if (standing.wait.messageId) await retireCopy(apiOf(ctx), chatId, standing.wait.messageId);
    await ctx.reply(receiptFilesDone(standing.wait));
    return;
  }
  const now = standing.wait;
  const drawn = await drawKeptLast(
    { reply: (text, extra) => ctx.reply(text, extra), api: apiOf(ctx) },
    chatId,
    now.messageId,
    now.lastSeen,
    receiptFilesAck(now),
    { reply_markup: receiptFilesKeyboard(now) },
  );
  noteReceiptFilesMessage(chatId, now.receiptId, drawn.messageId);
}

/**
 * A video, a voice note, a sticker, a place while a collection is LIVE:
 * answered in words — the collection keeps photos and files, and without this
 * the message would meet silence (or an offer to make a task of it). True =
 * said.
 */
export async function receiptFilesRefuseOther(
  ctx: { message: { message_id: number; date: number }; reply: Reply },
  chatId: bigint,
): Promise<boolean> {
  if (standingReceiptFiles(chatId, ctx.message.date)?.state !== 'live') return false;
  await ctx.reply(RECEIPT_FILES_SAY.notAFile, {
    reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
  });
  return true;
}

/** The sentence a typed text gets while a collection is live — instead of being sent to the paid assistant as a question. */
export function receiptFilesTextAnswer(chatId: bigint): string | null {
  return standingReceiptFiles(chatId)?.state === 'live' ? RECEIPT_FILES_SAY.notText : null;
}
