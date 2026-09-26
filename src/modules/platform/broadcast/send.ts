import { Api, GrammyError, InputFile } from 'grammy';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { attachments, broadcasts } from '../db/schema';
import { getStorage } from '../files/storage';
import { logger } from '../logger';
import { MAX_TELEGRAM_PHOTO_BYTES } from '../telegram/limits';
import { BROADCAST_ENTITY_TYPE, claimRecipients, finishIfDone, settleRecipient } from './service';

/**
 * The broadcast's sender — the job's body. Twenty chats a claim, one pause
 * between claims: Telegram allows about thirty messages a second from a bot
 * across all chats, and a broadcast of words plus three photos is four per
 * chat, so twenty chats a second-and-a-bit stays under it with room for the
 * arrival notices that share the bot. A 429 is «too fast», honoured and
 * retried once — never a failure (#706's rule); a blocked or deleted chat is
 * a failure for that chat alone.
 *
 * A file is read from storage ONCE: the first chat's upload returns a
 * Telegram file_id and every later chat is sent that id — the same bytes
 * are not pushed from Germany to Telegram three hundred times.
 */
const BATCH = 20;
const PAUSE_MS = 1_200;
const TIMEOUT_MS = 60_000;

interface Part {
  fileName: string;
  storageKey: string;
  asPhoto: boolean;
  fileId: string | null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const retryAfter = (err: unknown): number | null =>
  err instanceof GrammyError && err.error_code === 429 ? (err.parameters?.retry_after ?? 3) : null;

export async function runBroadcast(broadcastId: string, api = defaultApi()): Promise<number> {
  if (!api) {
    logger.warn({ broadcastId }, 'broadcast: TELEGRAM_BOT_TOKEN not set');
    return 0;
  }
  const row = await db.query.broadcasts.findFirst({ where: eq(broadcasts.id, broadcastId) });
  if (!row) return 0;
  const files = await db
    .select({
      fileName: attachments.fileName,
      storageKey: attachments.storageKey,
      contentType: attachments.contentType,
      sizeBytes: attachments.sizeBytes,
    })
    .from(attachments)
    .where(and(eq(attachments.entityType, BROADCAST_ENTITY_TYPE), eq(attachments.entityId, broadcastId)))
    .orderBy(asc(attachments.createdAt));
  const parts: Part[] = files.map((f) => ({
    fileName: f.fileName,
    storageKey: f.storageKey,
    // A photo goes as a photo (it shows inline) when Telegram will take it as
    // one; anything else — or a photo over sendPhoto's limit — as a file.
    asPhoto: /^image\/(jpeg|png|webp)$/.test(f.contentType) && f.sizeBytes <= MAX_TELEGRAM_PHOTO_BYTES,
    fileId: null,
  }));

  let sent = 0;
  for (;;) {
    const chats = await claimRecipients(broadcastId, BATCH);
    if (chats.length === 0) break;
    for (const chat of chats) {
      const outcome = await sendOne(api, chat, row.body, parts);
      await settleRecipient(broadcastId, chat, outcome);
      if (outcome.ok) sent += 1;
    }
    await sleep(PAUSE_MS);
  }
  await finishIfDone(broadcastId);
  return sent;
}

async function sendOne(
  api: Api,
  chatId: bigint,
  body: string,
  parts: Part[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const chat = Number(chatId);
  const step = async (run: () => Promise<unknown>) => {
    try {
      return await run();
    } catch (err) {
      const wait = retryAfter(err);
      if (wait === null) throw err;
      await sleep(Math.min(wait, 30) * 1000);
      return run();
    }
  };
  try {
    if (body) await step(() => api.sendMessage(chat, body, undefined, AbortSignal.timeout(TIMEOUT_MS)));
    for (const part of parts) {
      const media = part.fileId ?? new InputFile(() => getStorage().getStream(part.storageKey), part.fileName);
      const message = (await step(() =>
        part.asPhoto
          ? api.sendPhoto(chat, media, undefined, AbortSignal.timeout(TIMEOUT_MS))
          : api.sendDocument(chat, media, undefined, AbortSignal.timeout(TIMEOUT_MS)),
      )) as { photo?: { file_id: string }[]; document?: { file_id: string } };
      part.fileId ??= part.asPhoto ? (message.photo?.at(-1)?.file_id ?? null) : (message.document?.file_id ?? null);
    }
    return { ok: true };
  } catch (err) {
    const error =
      err instanceof GrammyError ? `${err.error_code}: ${err.description}` : err instanceof Error ? err.message : String(err);
    logger.warn({ err, chatId: String(chatId) }, 'broadcast send failed');
    return { ok: false, error };
  }
}

function defaultApi(): Api | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return token ? new Api(token) : null;
}
