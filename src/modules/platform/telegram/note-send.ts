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
import { SOURCE_UNREADABLE } from '../notifications/note-card';
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
      // The words, redacted — never the raw error: grammy's HttpError carries
      // node-fetch's own error, whose message IS the request URL, and that
      // URL holds the bot's token (review P1-DLV-1). The drain stores these
      // words as the row's `error` and logs them; the token reaches neither.
      const failure = stepFailure(err, api.token);
      logger.warn(
        { kind: step.kind, index, status: failure.status, description: failure.description },
        'note plan step not sent',
      );
      return { sent, failed: failed + 1, stop: { index, ...failure } };
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
 *
 * Two things are decided HERE, before the words leave this file:
 *   - our own file that could not be read is said as such
 *     (`SOURCE_UNREADABLE` first, then which file): a missing key or a MinIO
 *     reset is not «an answer that never came» (review P1-DLV-2) — the
 *     multipart body never completed, so nothing can be in the chat;
 *   - the bot's token is cut out of every word kept (`redactToken`):
 *     node-fetch's message is the request URL, `…/bot<TOKEN>/sendPhoto`.
 */
export function stepFailure(err: unknown, token?: string): Omit<PlanStop, 'index'> {
  if (err instanceof GrammyError) {
    return {
      status: err.error_code,
      description: redactToken(err.description, token),
      retryAfter: err.parameters?.retry_after ?? null,
    };
  }
  const unreadable = unreadableIn(err);
  if (unreadable) {
    return {
      status: 0,
      description: redactToken([unreadable.message, ...causeWords(unreadable.cause)].join(' '), token),
      retryAfter: null,
    };
  }
  const words = causeWords(err instanceof HttpError ? err.error : err);
  if (err instanceof HttpError) words.unshift(err.message);
  return { status: 0, description: redactToken(words.join(' ') || String(err), token), retryAfter: null };
}

/** The code/errno/message words of an error and its causes — what CONNECT_PHASE reads. */
function causeWords(err: unknown): string[] {
  const words: string[] = [];
  let cause: unknown = err;
  for (let depth = 0; cause && depth < 4; depth += 1) {
    const one = cause as { message?: unknown; code?: unknown; errno?: unknown; cause?: unknown };
    for (const part of [one.code, one.errno, one.message]) if (typeof part === 'string') words.push(part);
    cause = one.cause;
  }
  return words;
}

/**
 * The bot's token out of any words we keep. A fetch error's message is its
 * request URL (`http://…/bot123456:AA…/sendMessage`), and grammy keeps it out
 * of its own message on purpose (`sensitiveLogs`) — so the cause chain we
 * spell out must cut it too: by shape (`/bot<anything>`), and by the token's
 * own text wherever else it might sit.
 */
export function redactToken(text: string, token?: string): string {
  let out = text.replace(/\/bot[^/\s]+/g, '/bot<token>');
  if (token) out = out.split(token).join('<token>');
  return out;
}

/**
 * Our OWN bytes could not be read: the object store refused the key, or the
 * stream it gave broke while Telegram was being sent it. Thrown by `ownBytes`
 * and handed back by grammy unchanged as `HttpError.error` (its multipart
 * stream reports a source's failure through the call's own rejection).
 */
class SourceUnreadable extends Error {
  readonly code = 'SOURCE_UNREADABLE';
  constructor(file: Pick<NoteFile, 'fileName' | 'storageKey'>, cause: unknown) {
    super(`${SOURCE_UNREADABLE} ${file.fileName} (${file.storageKey}):`, { cause });
    this.name = 'SourceUnreadable';
  }
}

/** The `SourceUnreadable` in an error's chain, if one is there (grammy wraps it once). */
function unreadableIn(err: unknown): SourceUnreadable | null {
  let cause: unknown = err;
  for (let depth = 0; cause && depth < 4; depth += 1) {
    if (cause instanceof SourceUnreadable) return cause;
    const one = cause as { error?: unknown; cause?: unknown };
    cause = one.error ?? one.cause;
  }
  return null;
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
        // The redacted words, never the raw error — its fetch cause is the token's URL (P1-DLV-1).
        logger.warn({ kind: step.kind, description: stepFailure(again, api.token).description }, 'note send failed after 429');
        return null;
      }
    }
    logger.warn({ kind: step.kind, description: stepFailure(err, api.token).description }, 'note send failed');
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
    try {
      return await sendGroup(api, chat, step, signal, silent);
    } catch (err) {
      // A media group is all-or-nothing on a refusal: when Telegram says «no»,
      // no member of it is in the chat, so ONE resend — still as one call, so
      // the album stays an album — cannot double anything. The single photo
      // below has had both repairs since 📌 shipped; an album had neither, and
      // the new-client card merges every ticked note's files into one
      // (review P1-DLV-3).
      const cached = step.files.filter((file) => cachedFileId(file) !== null);
      if (isUnknownFileId(err) && cached.length > 0) {
        // Which member's id Telegram forgot is not said, so every cached one
        // is cleared and the whole group goes as bytes.
        for (const file of cached) await forgetFileId(file.partId).catch(() => {});
        const fresh = step.files.map((file) => ({ ...file, telegramFileId: null, telegramSentAs: null }));
        return await sendGroup(api, chat, { ...step, files: fresh }, AbortSignal.timeout(SEND_TIMEOUT_MS), silent);
      }
      if (step.as === 'photo' && isPhotoShapeRefusal(err)) {
        // Which member Telegram refused is not said either, so the group goes
        // as DOCUMENTS this once — and the downgrade is NOT persisted: the
        // culprit is unknown, and persisting would turn good photos into
        // documents for every later tap. Sourced as documents, so an id
        // Telegram minted for a PHOTO is never offered to a document slot.
        const asDocuments = step.files.map((file) => ({ ...file, sendAs: 'document' as const }));
        return await sendGroup(
          api,
          chat,
          { ...step, as: 'document', files: asDocuments },
          AbortSignal.timeout(SEND_TIMEOUT_MS),
          silent,
        );
      }
      throw err;
    }
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

/** One media group, sent; its ids cached by the plan's own index. */
async function sendGroup(
  api: Api,
  chat: number,
  step: Extract<NoteSend, { kind: 'media' }>,
  signal: AbortSignal,
  silent: boolean,
): Promise<number[]> {
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

/**
 * The id Telegram already has for these bytes, or the bytes themselves —
 * streamed, never buffered, so a 25 MB document is not held in the one Node
 * process that also serves every screen.
 *
 * The stored file is read through `ownBytes`, which says so when OUR read is
 * what broke (`SourceUnreadable`) — the store refusing the key, or its stream
 * breaking mid-upload — so the drain can tell «our bytes never came» from
 * «Telegram's answer never came» (review P1-DLV-2).
 */
async function source(file: NoteFile): Promise<InputFile | string> {
  const cached = cachedFileId(file);
  if (cached) return cached;
  const stored = new InputFile(() => getStorage().getStream(file.storageKey), file.fileName);
  return new InputFile(ownBytes(stored, file), file.fileName);
}

/**
 * The stored file's bytes, as grammy will stream them, with every failure OF
 * THE READ tagged. Iterated by hand, not by `for await`, so only the store's
 * own errors are ours: an abort grammy throws in at the `yield` is grammy's,
 * and passes through untagged.
 */
async function* ownBytes(stored: InputFile, file: NoteFile): AsyncGenerator<Uint8Array, void, undefined> {
  let data: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  try {
    data = await stored.toRaw();
  } catch (err) {
    throw new SourceUnreadable(file, err);
  }
  if (data instanceof Uint8Array) {
    yield data;
    return;
  }
  const iterator: AsyncIterator<Uint8Array> | Iterator<Uint8Array> =
    Symbol.asyncIterator in data
      ? (data as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      : (data as Iterable<Uint8Array>)[Symbol.iterator]();
  let finished = false;
  try {
    for (;;) {
      let next: IteratorResult<Uint8Array>;
      try {
        next = await iterator.next();
      } catch (err) {
        finished = true;
        throw new SourceUnreadable(file, err);
      }
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
    }
  } finally {
    // Stopped part-way (an abort, a refused upload): close the store's stream,
    // or a file handle / a MinIO socket is left open for the process's life.
    if (!finished) await Promise.resolve(iterator.return?.()).catch(() => {});
  }
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
