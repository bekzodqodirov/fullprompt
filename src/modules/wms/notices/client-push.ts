import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { attachments, clientNotices, clients, clientTelegramLinks } from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { logger } from '@/modules/platform/logger';
import { visibleLength } from '@/modules/platform/telegram/format';
import { MAX_CAPTION_CHARS, MAX_TELEGRAM_PHOTO_BYTES } from '@/modules/platform/telegram/limits';
import { sendPhoto, sendText, type PhotoMessage, type SendResult } from '@/modules/platform/telegram/send';

/**
 * How one claimed customer notice reaches Telegram (round C) — the part every
 * kind shares, so the four pushes cannot learn four different lessons.
 *
 * The sweep (`arrival-jobs.ts`) asks each kind's renderer for a
 * `PreparedPush` and hands it here: one message per CHAT (a person's two
 * codes share one chat and a chat is told once), in that chat's language,
 * silent at night, with the goods photograph when there is one — and a
 * verdict for the row that tells a refusal about THIS message from a refusal
 * about this MOMENT from a refusal about the BOT.
 */

export type NoticeRow = typeof clientNotices.$inferSelect;
export type ClientRow = typeof clients.$inferSelect;

export interface PushMessage {
  /** The message as HTML, built from escaped parts. */
  text: string;
  /** The same message as a photo's caption; null = this kind never has a photo. */
  caption: string | null;
}

export interface PhotoRef {
  storageKey: string;
  thumb800Key: string | null;
  contentType: string;
  sizeBytes: number;
}

export interface PreparedPush {
  /** The message in one chat's language. */
  render: (locale: string | null | undefined) => PushMessage;
  /**
   * The push keyboard, opened on this lot (null lot = the cabinet's top).
   * Null = no keyboard at all: the factory pickup has no boxes yet, so the
   * cabinet would open on nothing (`pickups/notice.ts`'s own reason).
   */
  keyboard: { lotId: string | null } | null;
  photo: PhotoRef | null;
}

export type Skip = { skip: string };
export type Preparer = (notice: NoticeRow, client: ClientRow) => Promise<PreparedPush | Skip>;

/**
 * A photo that has failed to go twice goes no more: from the third attempt
 * the notice is sent as text. The photograph is an addition (round C's first
 * principle); a slow link that times out every upload must not cost the
 * customer the sentence as well.
 */
export const PHOTO_ATTEMPTS = 2;

/** Every chat this client is linked to — one message each, never one per link ROW (#267). */
export async function linkedChats(clientId: string): Promise<bigint[]> {
  const rows = await db
    .select({ chatId: clientTelegramLinks.telegramChatId })
    .from(clientTelegramLinks)
    .where(
      and(
        eq(clientTelegramLinks.clientId, clientId),
        eq(clientTelegramLinks.status, 'linked'),
        isNotNull(clientTelegramLinks.telegramChatId),
      ),
    );
  return [...new Set(rows.map((r) => r.chatId!.toString()))].map((id) => BigInt(id));
}

/**
 * The goods photograph a push carries: the first lot, in the order the lots
 * were given (by letter), that HAS a photo — and that lot's oldest. Every lot
 * is photographed at the warehouse (the wizard will not confirm without), so
 * this is almost always lot A.
 */
export async function firstLotPhoto(lotIds: readonly string[]): Promise<PhotoRef | null> {
  if (lotIds.length === 0) return null;
  const rows = await db
    .select({
      lotId: attachments.entityId,
      storageKey: attachments.storageKey,
      thumb800Key: attachments.thumb800Key,
      contentType: attachments.contentType,
      sizeBytes: attachments.sizeBytes,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.entityType, 'receipt_lot'),
        inArray(attachments.entityId, [...lotIds]),
        eq(attachments.kind, 'photo'),
      ),
    )
    .orderBy(asc(attachments.createdAt));
  for (const lotId of lotIds) {
    const hit = rows.find((r) => r.lotId === lotId);
    if (hit) return { storageKey: hit.storageKey, thumb800Key: hit.thumb800Key, contentType: hit.contentType, sizeBytes: hit.sizeBytes };
  }
  return null;
}

/**
 * The bytes to upload, or null — and null is an ordinary answer (the text
 * goes alone), never an error.
 *
 * The 800 px thumbnail first: it is what a phone screen shows anyway, it is
 * a tenth of the upload from Germany, and it has had its EXIF location
 * stripped by the re-encode. The original only when it is an image Telegram
 * will take as a photo at all (≤ 10 MB) — a thumbnail job that has not run
 * yet leaves a 15 MB original, which `sendPhoto` would refuse. Each read in
 * its own try (judge PHOTO-1): a missing object in storage is not a reason
 * to lose the message.
 */
/**
 * How long one storage read may take before the push goes without its photo.
 * The S3 client has no deadline of its own, and this sweep is ONE worker for
 * every customer's message: a MinIO that stops answering would otherwise hold
 * all of them behind a photograph (round C review, PA-2).
 */
export const PHOTO_READ_MS = 15_000;

/**
 * One sweep's memory that storage has stopped answering. Without it a stalled
 * store costs the deadline PER NOTICE (twice: thumbnail, then original), and
 * thirty photo pushes from one unloaded truck outlast pg-boss's 15-minute
 * expiry — the next sweep starts while this one is still sending, and rows it
 * reclaims can go out twice (the review's verifier on PA-2). Tripped once, the
 * rest of the sweep sends text.
 */
export interface PhotoBreaker {
  stalled: boolean;
}

export class ReadTimeout extends Error {}

/** A storage read bounded by a deadline — the price channel's drain reads its photos through this too. */
export function readWithin(read: Promise<Buffer>, ms: number): Promise<Buffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReadTimeout(`storage read took longer than ${ms} ms`)), ms);
  });
  // The read itself cannot be cancelled; its late answer is simply dropped.
  read.catch(() => undefined);
  return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
}

export async function loadPhoto(
  ref: PhotoRef,
  readMs = PHOTO_READ_MS,
  breaker: PhotoBreaker = { stalled: false },
): Promise<PhotoMessage['photo'] | null> {
  if (breaker.stalled) return null;
  const storage = getStorage();
  const usable = (bytes: Buffer) => bytes.length > 0 && bytes.length <= MAX_TELEGRAM_PHOTO_BYTES;
  if (ref.thumb800Key) {
    try {
      const bytes = await readWithin(storage.get(ref.thumb800Key), readMs);
      if (usable(bytes)) return { bytes, filename: 'photo.webp', contentType: 'image/webp' };
    } catch (err) {
      logger.warn({ err, key: ref.thumb800Key }, 'push photo: thumbnail unreadable');
      // A store that did not ANSWER will not answer for the original either.
      if (err instanceof ReadTimeout) {
        breaker.stalled = true;
        return null;
      }
    }
  }
  if (ref.contentType.startsWith('image/') && ref.sizeBytes <= MAX_TELEGRAM_PHOTO_BYTES) {
    try {
      const bytes = await readWithin(storage.get(ref.storageKey), readMs);
      if (usable(bytes)) {
        const ext = ref.contentType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'jpg';
        return { bytes, filename: `photo.${ext}`, contentType: ref.contentType };
      }
    } catch (err) {
      logger.warn({ err, key: ref.storageKey }, 'push photo: original unreadable');
      if (err instanceof ReadTimeout) breaker.stalled = true;
    }
  }
  return null;
}

/**
 * One chat, one message: the photo with its caption when there is a photo and
 * the caption fits, else the text.
 *
 * A 400 from `sendPhoto` has already been through `send.ts`'s own two
 * fallbacks (unparseable HTML re-sent plain, a refused keyboard dropped), so
 * what is left is Telegram refusing the PHOTO itself — the same sentence goes
 * as a message (judge REL-7). Anything else is the verdict as it stands: a
 * 5xx or a dead socket after an upload may have DELIVERED the photo, so
 * sending the text too would say it twice.
 */
export async function pushToChat(o: {
  chatId: bigint;
  message: PushMessage;
  keyboard: unknown;
  photo: PhotoMessage['photo'] | null;
  silent: boolean;
}): Promise<SendResult & { fileId?: string | null }> {
  const replyMarkup = o.keyboard ?? undefined;
  if (o.photo && o.message.caption !== null && visibleLength(o.message.caption) <= MAX_CAPTION_CHARS) {
    const shot = await sendPhoto({ chatId: o.chatId, photo: o.photo, captionHtml: o.message.caption, replyMarkup, silent: o.silent });
    if (shot.ok || shot.status !== 400) return shot;
    logger.warn({ chatId: String(o.chatId), description: shot.description }, 'push photo refused — sending the text');
  }
  return sendText({ chatId: o.chatId, html: o.message.text, replyMarkup, silent: o.silent });
}

/** What the sweep does with the row after trying every chat. */
export type PushVerdict =
  | { kind: 'sent' }
  /** The bot cannot send at all: stop the sweep, give everything back. */
  | { kind: 'botDown'; delivered: boolean; detail: string }
  /** «Not now» (429): back to pending past the wait, no attempt spent. */
  | { kind: 'defer'; retryAfter: number | null; detail: string }
  /** Every chat refused for good (blocked the bot, no such chat). */
  | { kind: 'failed'; detail: string }
  /** The world was busy (5xx, a dead socket): an attempt spent, try again. */
  | { kind: 'retry'; detail: string };

/**
 * Reaching one of a person's chats is reaching the person. A token failure
 * outranks everything, since nothing after it will go either; then a delivery;
 * then a rate limit; and a notice is given up only when EVERY refusal was
 * about the recipient.
 */
export function pushVerdict(results: readonly SendResult[]): PushVerdict {
  const delivered = results.some((r) => r.ok);
  const detail = (r: SendResult | undefined) => (r ? `${r.status} ${r.description}`.slice(0, 300) : 'no chat answered');
  const down = results.find((r) => r.botDown);
  if (down) return { kind: 'botDown', delivered, detail: detail(down) };
  if (delivered) return { kind: 'sent' };
  const limited = results.filter((r) => r.status === 429);
  if (limited.length > 0) {
    const waits = limited.map((r) => r.retryAfter ?? 0);
    return { kind: 'defer', retryAfter: Math.max(...waits) || null, detail: detail(limited[0]) };
  }
  const last = results[results.length - 1];
  if (results.length > 0 && results.every((r) => r.permanent)) return { kind: 'failed', detail: detail(last) };
  return { kind: 'retry', detail: detail(last) };
}
