import { Api, GrammyError, HttpError, InputFile } from 'grammy';
import { logger } from '../logger';
import { getStorage } from '../files/storage';
import {
  downgradeToDocument,
  forgetFileId,
  noteWithFiles,
  rememberFileId,
} from '../notes/service';
import { cachedFileId, notePlan, planMessageCount, type NoteFile, type NoteSend } from '../notes/plan';
import { MEDIA_GROUP_MIN } from './limits';

/**
 * One tap on a zametka, delivered.
 *
 * Everything DECIDED is in `notes/plan.ts` and is pure; this file is the
 * grammy shell — a loop over the plan, the cache, and the words. It runs OFF
 * the middleware chain (`void sendNote(...)` at the call site): grammy's
 * built-in poller is sequential, so awaiting several megabytes of upload
 * inside a callback handler holds every customer's cabinet tap, every /start
 * and every arrival flow with it (#706, round 101's own outage).
 */

/** A Telegram call may not sit for ever; a stalled socket is an outage here. */
const SEND_TIMEOUT_MS = 60_000;

/**
 * One send per (chat, note) at a time.
 *
 * The first send of a part is a full object-store read plus an upload, which
 * on warehouse wifi is seconds of an unchanged chat with the button still
 * sitting there — exactly when a person taps again. Two interleaved copies of
 * the same note is the worst possible state for the multi-select forward this
 * feature exists to make easy.
 */
const inFlight = new Set<string>();

export interface NoteSendOutcome {
  status: 'sent' | 'partial' | 'empty' | 'busy' | 'not_found';
  sent: number;
  failed: number;
  messages: number;
}

export async function sendNote(
  api: Api,
  chatId: bigint,
  noteId: string,
  actorId: string,
): Promise<NoteSendOutcome> {
  const key = `${chatId}:${noteId}`;
  if (inFlight.has(key)) return { status: 'busy', sent: 0, failed: 0, messages: 0 };
  inFlight.add(key);
  try {
    // Re-read through the SAME visibility predicate the list used. An inline
    // keyboard is permanent chat history: a button tapped a week later can
    // name a note that has since been deleted, or one that has moved out of
    // this person's sight, and the query is what must refuse it.
    const found = await noteWithFiles(noteId, actorId);
    if (!found) return { status: 'not_found', sent: 0, failed: 0, messages: 0 };
    const plan = notePlan(found.note, found.files);
    if (plan.length === 0) return { status: 'empty', sent: 0, failed: 0, messages: 0 };

    const { sent, failed } = await sendPlan(api, chatId, plan, { onRateLimit: 'wait' });
    return {
      status: failed === 0 ? 'sent' : 'partial',
      sent,
      failed,
      messages: planMessageCount(plan),
    };
  } finally {
    inFlight.delete(key);
  }
}

/** Where a plan stopped, and Telegram's (or the network's) own words for why. */
export interface PlanStop {
  /** The step that did not go — every step before it did. */
  index: number;
  /** HTTP status; 0 when no answer arrived (the network, our deadline). */
  status: number;
  description: string;
  retryAfter: number | null;
}

export interface PlanSendResult {
  sent: number;
  failed: number;
  /** Set only in `'return'` mode, at the first step that did not go. */
  stop: PlanStop | null;
}

/**
 * A plan's steps, sent in order — the ONE sender of a zametka's shapes, for
 * the bot's 📌 tap and the drain's new-client card alike (the streaming, the
 * file-id cache read and written positionally, the photo downgrade and the
 * stale-id fallback all live below, and live once).
 *
 * The two callers differ only in what a failure means:
 *   - `'wait'` — the 📌 tap, a person looking at the chat: a 429 is waited out
 *     once, a failed step is counted and the rest still go (today's rule);
 *   - `'return'` — the drain: nothing sleeps, the FIRST step that does not go
 *     stops the plan and is handed back with Telegram's answer, and every step
 *     that did go is reported through `onStep` as it lands, so the row can
 *     remember it and a replay starts after it — never at the top (a 429 in
 *     the middle of a card must not send the customer's album to the seller
 *     twice, the forward he then makes being the duplicate).
 *
 * `silent` rides every send (the drain's night rule); absent, the calls are
 * exactly the 📌 tap's.
 */
export async function sendPlan(
  api: Api,
  chatId: bigint,
  plan: NoteSend[],
  opts: {
    fromStep?: number;
    onRateLimit: 'wait' | 'return';
    silent?: boolean;
    onStep?: (index: number, messageIds: number[]) => Promise<void>;
  },
): Promise<PlanSendResult> {
  let sent = 0;
  let failed = 0;
  for (let index = Math.max(0, opts.fromStep ?? 0); index < plan.length; index += 1) {
    const step = plan[index]!;
    if (opts.onRateLimit === 'wait') {
      const ids = await sendStep(api, chatId, step, opts.silent === true);
      if (ids) {
        sent += 1;
        await opts.onStep?.(index, ids);
      } else {
        failed += 1;
      }
      continue;
    }
    let ids: number[];
    try {
      ids = await attemptStep(api, chatId, step, opts.silent === true);
    } catch (err) {
      logger.warn({ err, kind: step.kind, index }, 'note plan step not sent');
      return { sent, failed: failed + 1, stop: { index, ...stepFailure(err) } };
    }
    sent += 1;
    await opts.onStep?.(index, ids);
  }
  return { sent, failed, stop: null };
}

/**
 * A failed send as the drain reads one: Telegram's own code and words when it
 * answered, status 0 and the network's words when it did not — the cause chain
 * is spelled out, because «was this a refused CONNECT (nothing left the
 * machine) or a cut-off answer (the message may be in the chat)» is decided on
 * those words (the price channel's rule).
 */
function stepFailure(err: unknown): Omit<PlanStop, 'index'> {
  if (err instanceof GrammyError) {
    return { status: err.error_code, description: err.description, retryAfter: err.parameters?.retry_after ?? null };
  }
  const words: string[] = [];
  let cause: unknown = err instanceof HttpError ? err.error : err;
  for (let depth = 0; cause && depth < 4; depth += 1) {
    const one = cause as { message?: unknown; code?: unknown; errno?: unknown; cause?: unknown };
    for (const part of [one.code, one.errno, one.message]) if (typeof part === 'string') words.push(part);
    cause = one.cause;
  }
  if (err instanceof HttpError) words.unshift(err.message);
  return { status: 0, description: words.join(' ') || String(err), retryAfter: null };
}

/** The drain's sends go through a grammy Api of their own (it has no bot); made once per token. */
let planApiOverride: Api | null = null;
let planApiMade: { token: string; api: Api } | null = null;

/** Tests only: the Api the drain's card is sent through (a harness bot's `api`). */
export function __setPlanApi(api: Api | null): void {
  planApiOverride = api;
}

export function drainPlanApi(): Api | null {
  if (planApiOverride) return planApiOverride;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  if (planApiMade?.token !== token) planApiMade = { token, api: new Api(token) };
  return planApiMade.api;
}

async function sendStep(api: Api, chatId: bigint, step: NoteSend, silent: boolean): Promise<number[] | null> {
  try {
    return await attemptStep(api, chatId, step, silent);
  } catch (err) {
    // A 429 is «too fast», not «this failed». A multi-part note is a burst of
    // up to a dozen messages into one chat and there is no throttler installed
    // (a bot-wide one would queue every customer's cabinet behind a staff
    // member's uploads). One honest wait, then one retry — arrival.ts's own
    // transient/permanent rule, not a new one.
    const wait = retryAfter(err);
    if (wait !== null) {
      await sleep(Math.min(wait, 30) * 1000);
      try {
        return await attemptStep(api, chatId, step, silent);
      } catch (again) {
        logger.warn({ err: again, kind: step.kind }, 'note send failed after 429');
        return null;
      }
    }
    logger.warn({ err, kind: step.kind }, 'note send failed');
    return null;
  }
}

/**
 * `extra` as the 📌 tap has always sent it — the very same value, `undefined`
 * included — plus «no ring» when the drain sends at night.
 */
function quietly<T extends object>(extra: T | undefined, silent: boolean): T | undefined {
  if (!silent) return extra;
  return { ...(extra ?? ({} as T)), disable_notification: true };
}

/** One step, sent; the ids of the messages it became. */
async function attemptStep(api: Api, chatId: bigint, step: NoteSend, silent = false): Promise<number[]> {
  const chat = Number(chatId);
  const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
  if (step.kind === 'text') {
    const message = await api.sendMessage(chat, step.text, quietly(undefined, silent), signal);
    return idsOf(message);
  }
  return sendMedia(api, chat, step, signal, silent);
}

function idsOf(message: unknown): number[] {
  const list = Array.isArray(message) ? message : [message];
  return list
    .map((one) => (one as { message_id?: unknown } | null)?.message_id)
    .filter((id): id is number => typeof id === 'number');
}

async function sendMedia(
  api: Api,
  chat: number,
  step: Extract<NoteSend, { kind: 'media' }>,
  signal: AbortSignal,
  silent: boolean,
): Promise<number[]> {
  if (step.files.length >= MEDIA_GROUP_MIN) {
    const media = await Promise.all(
      step.files.map(async (file, index) => ({
        type: step.as === 'photo' ? ('photo' as const) : ('document' as const),
        media: await source(file),
        ...(index === 0 && step.caption ? { caption: step.caption } : {}),
      })),
    );
    // The response is an ARRAY, one message per item, and the ids must be
    // mapped back BY THE PLAN'S OWN INDEX. Get that wrong and one warehouse's
    // address sheet is cached onto another warehouse's note — a customer is
    // then sent the wrong address, silently, with a cache that looks healthy.
    // So: only when the lengths agree, and only positionally.
    const out = await api.sendMediaGroup(
      chat,
      media as Parameters<Api['sendMediaGroup']>[1],
      quietly(undefined, silent),
      signal,
    );
    if (out.length === step.files.length) {
      for (let i = 0; i < out.length; i += 1) {
        await cacheFrom(step.files[i]!, out[i], step.as);
      }
    }
    return idsOf(out);
  }

  const file = step.files[0]!;
  const body = await source(file);
  const extra = quietly(step.caption ? { caption: step.caption } : undefined, silent);
  try {
    const message =
      step.as === 'photo'
        ? await api.sendPhoto(chat, body, extra, signal)
        : await api.sendDocument(chat, body, extra, signal);
    await cacheFrom(file, message, step.as);
    return idsOf(message);
  } catch (err) {
    if (step.as === 'photo' && isPhotoShapeRefusal(err)) {
      // sendPhoto refuses on bytes, on width+height summed AND on the ratio,
      // and `attachments` stores no dimensions — so a tall address sheet is
      // exactly the file that passes every check we can make and is refused
      // here. The downgrade is PERSISTED: the next tap must not propose a
      // shape Telegram has already refused once.
      await downgradeToDocument(file.partId).catch(() => {});
      const message = await api.sendDocument(
        chat,
        await source({ ...file, telegramFileId: null, telegramSentAs: null }),
        extra,
        AbortSignal.timeout(SEND_TIMEOUT_MS),
      );
      await cacheFrom({ ...file, sendAs: 'document' }, message, 'document');
      return idsOf(message);
    }
    if (isUnknownFileId(err) && cachedFileId(file)) {
      // The cached id is gone from Telegram's side. Clear it and send the
      // bytes — the fallback is the load-bearing half of the cache.
      await forgetFileId(file.partId).catch(() => {});
      const fresh = { ...file, telegramFileId: null, telegramSentAs: null };
      const message =
        step.as === 'photo'
          ? await api.sendPhoto(chat, await source(fresh), extra, AbortSignal.timeout(SEND_TIMEOUT_MS))
          : await api.sendDocument(chat, await source(fresh), extra, AbortSignal.timeout(SEND_TIMEOUT_MS));
      await cacheFrom(file, message, step.as);
      return idsOf(message);
    }
    throw err;
  }
}

/**
 * The id Telegram already has for these bytes, or the bytes themselves —
 * streamed, never buffered, so a 25 MB document is not held in the one Node
 * process that also serves every screen.
 */
async function source(file: NoteFile): Promise<InputFile | string> {
  const cached = cachedFileId(file);
  if (cached) return cached;
  return new InputFile(() => getStorage().getStream(file.storageKey), file.fileName);
}

async function cacheFrom(
  file: NoteFile,
  message: unknown,
  as: 'photo' | 'document',
): Promise<void> {
  const id = fileIdOf(message);
  if (!id || id === file.telegramFileId) return;
  await rememberFileId(file.partId, id, as).catch(() => {});
}

function fileIdOf(message: unknown): string | null {
  const m = message as {
    photo?: { file_id: string }[];
    document?: { file_id?: string };
  };
  // A photo message carries every size; the LAST is the largest and is the one
  // re-sending must ask for.
  if (m?.photo?.length) return m.photo[m.photo.length - 1]!.file_id;
  return m?.document?.file_id ?? null;
}

function retryAfter(err: unknown): number | null {
  if (err instanceof GrammyError && err.error_code === 429) {
    return err.parameters?.retry_after ?? 1;
  }
  return null;
}

function isPhotoShapeRefusal(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  const d = err.description.toLowerCase();
  return (
    d.includes('photo_invalid_dimensions') ||
    d.includes('dimensions') ||
    d.includes('photo should be') ||
    d.includes('image_process_failed') ||
    d.includes('file is too big')
  );
}

function isUnknownFileId(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  const d = err.description.toLowerCase();
  return d.includes('wrong file identifier') || d.includes('wrong remote file identifier');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
