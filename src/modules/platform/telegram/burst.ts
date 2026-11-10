import type { Api, Context, MiddlewareFn } from 'grammy';
import type { Message } from 'grammy/types';
import { logger } from '../logger';
import { activeIntake, holdingIntake, noteOwnMessage } from './calc-store';
import { addOfferRows } from './calc-amend';
import { burstPauseLine, pauseKeyboard } from './calc-dialog';
import { activeCapture } from './note-capture';
import { activeDraft, MAX_DRAFT_SOURCES } from './task-draft';
import { drawKeptLast, keepLastSoon, type KeptLastApi } from './kept-last';
import { isBacklog } from './lifecycle';
import { forwardKeyboard, staffForChat } from './staff-bot';
import {
  BURST_FULL,
  BURST_FULL_TASK,
  burstCounts,
  burstFull,
  burstLastSeen,
  burstOfferText,
  burstOneText,
  endBurst,
  endsBurst,
  nextOfferIds,
  noteBurstPart,
  noteOverflow,
  burstOwed,
  readBurst,
  rewriteBurst,
  type BurstPart,
  type BurstPayload,
} from './burst-wait';
import { nowSec, waitsOfKind } from './waits';

/**
 * The burst door (docs/IKKI-ESHIK.md §4.1, §4.2, his 6a): files or forwards
 * sent in a row while no collection, draft or capture is open get ONE
 * message — the offer («➕ 3 ta faylni so‘rovga qo‘shamizmi?», or Door B's
 * «📌 5 ta xabar (3 tasi fayl) — …» with the ➕ rows under it), or, beside a
 * PARKED collection, the pause line — always the chat's LAST message
 * (kept-last.ts), and its buttons act on every part. The wait and its words
 * are burst-wait.ts; this file is grammy's side of it.
 */

/** What the door showed — the caller returns on an offer and falls through otherwise. */
export type BurstShown = 'offer' | 'pause' | 'none';

/** The ctx a draw needs: a reply, and the api to edit or delete the older copy. */
export type BurstCtx = {
  message?: Message;
  reply: (text: string, extra?: Record<string, unknown>) => Promise<{ message_id: number }>;
  api?: unknown;
};

/**
 * A message as a burst part: a photo, a document, or ANY forward (a text, a
 * voice note, a video, a contact card). A plain voice note or a text is not
 * one — the collector and Door B never offered those.
 */
export function burstPartOf(message: Message): BurstPart | null {
  const forwarded = Boolean(message.forward_origin);
  const text = message.text ?? message.caption ?? null;
  const base = { messageId: message.message_id, forwarded, text, fileId: null, name: null, mime: null, size: null };
  if (message.photo?.length) {
    const best = message.photo[message.photo.length - 1]!;
    return { ...base, kind: 'photo', fileId: best.file_id, mime: 'image/jpeg', size: best.file_size ?? null };
  }
  if (message.document) {
    const d = message.document;
    return { ...base, kind: 'document', fileId: d.file_id, name: d.file_name ?? null, mime: d.mime_type ?? null, size: d.file_size ?? null };
  }
  if (!forwarded) return null;
  const media = message.voice ?? message.audio ?? message.video ?? message.video_note ?? null;
  if (media) {
    const kind = message.voice ? 'voice' : message.audio ? 'audio' : message.video ? 'video' : 'video_note';
    const named = media as { file_name?: string; mime_type?: string };
    const name = named.file_name ?? null;
    const mime = named.mime_type ?? null;
    return { ...base, kind, fileId: media.file_id, name, mime, size: media.file_size ?? null };
  }
  if (message.contact) {
    const who = [message.contact.first_name, message.contact.last_name].filter(Boolean).join(' ');
    return { ...base, kind: 'contact', text: null, fact: `👤 Kontakt: ${who} ${message.contact.phone_number}`.trim() };
  }
  if (message.location) {
    return { ...base, kind: 'location', text: null, fact: `📍 Joylashuv: ${message.location.latitude}, ${message.location.longitude}` };
  }
  return message.text ? { ...base, kind: null } : null;
}

/**
 * A file or a forward with no collector to take it, from a staff chat: into
 * the chat's burst, and the burst's ONE message drawn (coalesced, so an album
 * of ten moves it once). Never the backlog (one sentence answers it), never a
 * reply (its own doors), never beside a holding collection, a draft or a
 * capture — they take it first. 'none' = nothing to say: plain files with no
 * request to join them, as today — the part is still kept, so a forward that
 * follows draws ONE message for all of them.
 */
export async function burstDoor(ctx: BurstCtx, chatId: bigint): Promise<BurstShown> {
  const message = ctx.message;
  if (!message || isBacklog(message.date)) return 'none';
  const part = burstPartOf(message);
  if (!part) return 'none';
  if (!part.forwarded && message.reply_to_message) return 'none';
  if (holdingIntake(chatId) || activeDraft(chatId) || activeCapture(chatId)) return 'none';
  if (!(await staffForChat(chatId))) return 'none';
  // A FULL burst that has a message takes the part as its overflow — counted
  // and said on that message, the twenty it holds kept (review PB-ADV-1). A
  // full burst that draws nothing (plain files, no request to join) is no
  // reason to lose a forward that would draw: the part opens the next one.
  const stored = readBurst(chatId);
  const full = stored !== null && burstFull(stored, message.date) && (await burstShows(chatId, stored.payload)) !== 'none';
  const payload = full ? noteOverflow(chatId, part, message.date)! : noteBurstPart(chatId, part, message.date);
  // The shape now, for the caller; the draw decides it again at its moment.
  const shown = await burstShows(chatId, payload);
  if (shown !== 'none') {
    // Off the poller (#706): the draw waits out the album, then speaks.
    keepLastSoon(`burst:${chatId}`, () => drawBurst(ctx, chatId));
  }
  return shown;
}

/** What the burst's ONE message is, as things stand: the pause line, the offer, or nothing to say. */
async function burstShows(chatId: bigint, payload: BurstPayload): Promise<BurstShown> {
  if (activeIntake(chatId)) return 'pause';
  if (burstCounts(payload.parts).forwards > 0) return 'offer';
  return (await addOfferRows(chatId)).length > 0 ? 'offer' : 'none';
}

/**
 * The burst's ONE message, drawn as it stands: below its newest part, the
 * previous copy deleted (kept answerable when it cannot be), as a reply to
 * that part — a press whose wait is gone takes what it replies to. Beside a
 * parked collection it is the pause line, which joins the collection's own
 * messages so «✖️ Bekor qilish» acts on it.
 */
export async function drawBurst(ctx: BurstCtx, chatId: bigint): Promise<void> {
  const entry = readBurst(chatId);
  if (!entry || entry.payload.taken || entry.payload.parts.length === 0) return;
  // A collector opened during the debounce takes what comes next; the burst
  // has nothing to offer beside it.
  if (holdingIntake(chatId) || activeDraft(chatId) || activeCapture(chatId)) return;
  const p = entry.payload;
  const parked = activeIntake(chatId);
  const forwards = burstCounts(p.parts).forwards > 0;
  let text: string;
  let keyboard: { inline_keyboard: { text: string; callback_data: string }[][] };
  // Does the message carry a door that takes a RESEND (the pause line's ▶️,
  // a ➕ row: the collection then holds and takes what comes next)? Only then
  // may the overflow line tell him to send the rest again (BURST-2).
  let resend: boolean;
  if (parked) {
    text = burstPauseLine(p.parts.length);
    keyboard = pauseKeyboard({ forwards });
    resend = true;
  } else {
    const rows = await addOfferRows(chatId);
    if (!forwards && rows.length === 0) return;
    text = burstOfferText(p.parts, rows.length > 0);
    keyboard = { inline_keyboard: [...(forwards ? forwardKeyboard({ search: burstOneText(p.parts) !== null }) : []), ...rows] };
    resend = rows.length > 0;
  }
  if ((p.overflow ?? 0) > 0) text = `${text}\n${resend ? BURST_FULL(p.overflow!) : BURST_FULL_TASK(MAX_DRAFT_SOURCES)}`;
  // Below the newest message it concerns (an overflow part too), as a reply
  // to its newest PART: a press whose wait is gone takes what it replies to.
  const newestPart = p.parts[p.parts.length - 1]!.messageId;
  const prior = p.offerIds.at(-1) ?? null;
  const drawn = await drawKeptLast(
    { reply: (t, extra) => ctx.reply(t, extra), api: ctx.api as KeptLastApi | undefined },
    chatId,
    prior,
    burstLastSeen(p),
    text,
    { reply_markup: keyboard, reply_parameters: { message_id: newestPart, allow_sending_without_reply: true } },
  );
  rewriteBurst(chatId, p.id, (now) => ({
    ...now,
    offerIds: nextOfferIds(now.offerIds, prior, drawn),
    parkedNote: parked?.noteId ?? null,
  }));
  if (parked) {
    noteOwnMessage(chatId, drawn.messageId);
    if (drawn.kept !== null) noteOwnMessage(chatId, drawn.kept);
  }
  logger.info({ chatId: String(chatId), parts: p.parts.length, moved: drawn.moved }, '[burst] one message drawn');
}

/**
 * The draws a dead process OWED (as-built review BURST-8, DURABILITY-2): a
 * burst's ONE message waits out the album off the handler (`keepLastSoon`),
 * after grammy has confirmed its parts, so a process killed inside those
 * 700 ms (an OOM, a SIGKILL, a stop whose draw share ran out) left the parts
 * in the durable row and the question asked of nobody, for good — the
 * updates are never redelivered. At boot, after the waits and the
 * collections are back in memory and before the first getUpdates, every
 * burst still inside its window whose newest part no copy was drawn below
 * (`burstOwed`) is drawn once, by chat id, through the SAME `drawBurst` — which
 * still says nothing beside a collector, or when nothing would be offered.
 * Dispatched `void` through `keepLastSoon`, as the door's own draw. The
 * number queued, for the log.
 */
export function drawOwedBursts(api: Api, nowS: number = nowSec()): number {
  let queued = 0;
  for (const { chatId, entry } of waitsOfKind<BurstPayload>('burst')) {
    if (!burstOwed(entry, nowS)) continue;
    const chat = BigInt(chatId);
    const ctx: BurstCtx = {
      reply: (text, extra) => api.sendMessage(chatId, text, extra as Parameters<Api['sendMessage']>[2]),
      api: {
        editMessageText: (c: string, id: number, text: string, extra?: Record<string, unknown>) =>
          api.editMessageText(c, id, text, extra as Parameters<Api['editMessageText']>[3]),
        deleteMessage: (c: string, id: number) => api.deleteMessage(c, id),
      } satisfies KeptLastApi,
    };
    keepLastSoon(`burst:${chat}`, () => drawBurst(ctx, chat));
    queued += 1;
  }
  if (queued > 0) logger.info({ queued }, '[burst] owed messages drawn after the restart');
  return queued;
}

/**
 * The burst's ONE end (§4.1): any update in the chat that is neither a media
 * message nor a forward — a typed text, a press, a contact — closes it, so
 * the next file opens a new one. Beside `collectorScope`, before every
 * handler: a typed text beside a parked collection is answered knowing the
 * burst stands closed. Its parts stay for the message it drew (burst-wait.ts
 * `endBurst`).
 */
export function burstScope(): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const chat = ctx.chat?.id;
    if (chat !== undefined && endsBurst({ message: ctx.message, callbackQuery: ctx.callbackQuery })) endBurst(BigInt(chat));
    await next();
  };
}
