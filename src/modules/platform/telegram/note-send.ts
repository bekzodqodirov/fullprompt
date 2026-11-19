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
import { CARD_CALL_DEADLINE_MS, SOURCE_UNREADABLE } from '../notifications/note-card';
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

/**
 * A Telegram call may not sit for ever; a stalled socket is an outage here.
 * The card's reclaim window is measured against it (note-card.ts), so it
 * lives there.
 */
const SEND_TIMEOUT_MS = CARD_CALL_DEADLINE_MS;
let sendTimeoutMs = SEND_TIMEOUT_MS;

/** Tests only: a shorter deadline, so a stalled read is provable without waiting a minute. */
export function __setSendTimeout(ms: number | null): void {
  sendTimeoutMs = ms ?? SEND_TIMEOUT_MS;
}

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
 * stream reports a source's failure through the call's own rejection) — and
 * by `within` when the store STALLED until the call's deadline (FR1-2).
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

/**
 * ONE Telegram call's deadline, and what OUR side of that call is doing
 * (review FR1-2).
 *
 * A read of our own object store that STALLS — MinIO takes the GET and then
 * sends nothing, and the S3 client has no request timeout — ends on this
 * deadline like an answer that never came, and the card would mark the step
 * `maybe` and never send it, although the multipart body never completed and
 * Telegram cannot have it. Worse, the read could not even be stopped: grammy
 * closes our byte generator with `return()`/`throw()`, and those wait behind
 * the `await` the generator is parked on, so the store's stream stayed open
 * for the process's life. So the call knows which of our reads is in flight
 * (`pending`), remembers it when the deadline strikes (`stalled`), and cuts
 * the store's stream itself.
 *
 * Made BEFORE the call's sources, so every source of the call is read against
 * the call's own deadline.
 */
interface SendCall {
  signal: AbortSignal;
  /** Our own read in flight — the object store is being awaited. */
  pending: NoteFile | null;
  /** What was in flight when the deadline struck: our bytes never came. */
  stalled: NoteFile | null;
  /** The store's streams this call opened, cut when the deadline strikes. */
  streams: Set<{ destroy(): unknown }>;
}

function newCall(): SendCall {
  const call: SendCall = { signal: AbortSignal.timeout(sendTimeoutMs), pending: null, stalled: null, streams: new Set() };
  // Registered first, so it runs before every other listener on this signal
  // (our own read's, grammy's own): the read in flight is known before it is
  // rejected and forgotten. `destroy()` with NO error — an 'error' event on a
  // stream nobody listens to any more is an uncaught exception; a pending read
  // rejects all the same («Premature close»).
  call.signal.addEventListener(
    'abort',
    () => {
      call.stalled = call.pending;
      for (const stream of call.streams) stream.destroy();
    },
    { once: true },
  );
  return call;
}

/**
 * Run one call; when it failed on OUR deadline while our own read was in
 * flight, say so as an unreadable source — `cardStepVerdict` then retries it
 * instead of stepping over a «maybe» that cannot be in the chat. node-fetch
 * rejects the request on the abort before our read is rejected, so the error
 * that comes back is the network's, and only the call can tell them apart.
 */
async function within<T>(call: SendCall, run: (call: SendCall) => Promise<T>): Promise<T> {
  try {
    return await run(call);
  } catch (err) {
    if (call.signal.aborted && call.stalled) throw new SourceUnreadable(call.stalled, new Error('stalled'));
    throw err;
  }
}

/** One step, sent; the ids of the messages it became. */
async function attemptStep(api: Api, chatId: bigint, step: NoteSend, silent = false): Promise<number[]> {
  const chat = Number(chatId);
  if (step.kind === 'text') {
    const message = await within(newCall(), (call) =>
      api.sendMessage(chat, step.text, quietly(undefined, silent), call.signal),
    );
    return idsOf(message);
  }
  return sendMedia(api, chat, step, silent);
}

function idsOf(message: unknown): number[] {
  const list = Array.isArray(message) ? message : [message];
  return list
    .map((one) => (one as { message_id?: unknown } | null)?.message_id)
    .filter((id): id is number => typeof id === 'number');
}

/** A file offered by its bytes alone — no cached id of any shape. */
function bytesOnly(file: NoteFile): NoteFile {
  return { ...file, telegramFileId: null, telegramSentAs: null };
}

async function sendMedia(
  api: Api,
  chat: number,
  step: Extract<NoteSend, { kind: 'media' }>,
  silent: boolean,
): Promise<number[]> {
  if (step.files.length >= MEDIA_GROUP_MIN) return sendAlbum(api, chat, step, silent);

  const file = step.files[0]!;
  const extra = quietly(step.caption ? { caption: step.caption } : undefined, silent);
  const send = (as: 'photo' | 'document', one: NoteFile) =>
    within<unknown>(newCall(), (call) =>
      as === 'photo'
        ? api.sendPhoto(chat, source(one, call), extra, call.signal)
        : api.sendDocument(chat, source(one, call), extra, call.signal),
    );
  try {
    const message = await send(step.as, file);
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
      const asDocument: NoteFile = { ...bytesOnly(file), sendAs: 'document' };
      const message = await send('document', asDocument);
      await cacheFrom(asDocument, message, 'document');
      return idsOf(message);
    }
    if (isUnknownFileId(err) && cachedFileId(file)) {
      // The cached id is gone from Telegram's side. Clear it and send the
      // bytes — the fallback is the load-bearing half of the cache.
      await forgetFileId(file.partId).catch(() => {});
      const message = await send(step.as, bytesOnly(file));
      await cacheFrom(file, message, step.as);
      return idsOf(message);
    }
    throw err;
  }
}

/**
 * A media group, with the single photo's two repairs — CHAINED, each at most
 * once (review ALB-2): a stale-id resend from the bytes that is itself refused
 * for a photo's shape goes on to the documents retry, built from the files it
 * already cleared. The card's steps are frozen on its row, so a repair that
 * stopped at the first refusal would replay the same two refusals on every
 * run until the row failed. At most three calls; both repairs follow only a
 * GrammyError — Telegram's definite «no», under which no member of the group
 * is in the chat — so nothing is sent again after an answer that never came.
 *
 * The documents retry goes from the BYTES, never a cached id (review ALB-1):
 * an id Telegram minted for a document is not offered to a document slot it
 * was never checked against, and one that went stale would be refused with no
 * repair left. Its ids are NOT cached onto the parts either — they are photos
 * on the row, and `rememberFileId` keeps only an id of the shape a part is
 * sent as (FR1-5), so the good members keep their PHOTO ids.
 *
 * The cost, stated (ALB-3): the culprit is unknown, so the downgrade is not
 * persisted and an album holding one shape-bad photo goes as documents EVERY
 * time — first as photos (the good members by their cached ids, the culprit
 * as bytes), refused, then all as document bytes. An album that has NEVER been
 * accepted as photos (a note made with the tall sheet among its pictures) has
 * no photo id to offer, so it uploads every member TWICE on every send (the
 * third review's TR2-2). Persisting would turn good photos into documents for
 * every later tap; «Fayl bo‘lib ketsin» on the note's tall part is the person's
 * way to settle it.
 */
async function sendAlbum(
  api: Api,
  chat: number,
  step: Extract<NoteSend, { kind: 'media' }>,
  silent: boolean,
): Promise<number[]> {
  let current = step;
  let triedStale = false;
  let triedShape = false;
  for (;;) {
    try {
      return await sendGroup(api, chat, current, silent);
    } catch (err) {
      const cached = current.files.filter((file) => cachedFileId(file) !== null);
      if (!triedStale && isUnknownFileId(err) && cached.length > 0) {
        // Which member's id Telegram forgot is not said, so every cached one
        // is cleared and the whole group goes as bytes.
        triedStale = true;
        for (const file of cached) await forgetFileId(file.partId).catch(() => {});
        current = { ...current, files: current.files.map(bytesOnly) };
        continue;
      }
      if (!triedShape && current.as === 'photo' && isPhotoShapeRefusal(err)) {
        // Which member Telegram refused is not said either: the group goes as
        // DOCUMENTS this once, the downgrade not persisted (see above).
        triedShape = true;
        current = {
          ...current,
          as: 'document',
          files: current.files.map((file) => ({ ...bytesOnly(file), sendAs: 'document' as const })),
        };
        continue;
      }
      throw err;
    }
  }
}

/** One media group, sent; its ids cached by the plan's own index. */
async function sendGroup(
  api: Api,
  chat: number,
  step: Extract<NoteSend, { kind: 'media' }>,
  silent: boolean,
): Promise<number[]> {
  const out = await within(newCall(), (call) => {
    const media = step.files.map((file, index) => ({
      type: step.as === 'photo' ? ('photo' as const) : ('document' as const),
      media: source(file, call),
      ...(index === 0 && step.caption ? { caption: step.caption } : {}),
    }));
    return api.sendMediaGroup(chat, media as Parameters<Api['sendMediaGroup']>[1], quietly(undefined, silent), call.signal);
  });
  // The response is an ARRAY, one message per item, and the ids must be
  // mapped back BY THE PLAN'S OWN INDEX. Get that wrong and one warehouse's
  // address sheet is cached onto another warehouse's note — a customer is
  // then sent the wrong address, silently, with a cache that looks healthy.
  // So: only when the lengths agree, and only positionally.
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
 * «Telegram's answer never came» (review P1-DLV-2), and reads against the
 * call's own deadline (FR1-2).
 */
function source(file: NoteFile, call: SendCall): InputFile | string {
  const cached = cachedFileId(file);
  if (cached) return cached;
  const stored = new InputFile(() => getStorage().getStream(file.storageKey), file.fileName);
  return new InputFile(ownBytes(stored, file, call), file.fileName);
}

/**
 * One read of OUR store, against the call's deadline: marked in flight while
 * it is awaited, and given up the moment the deadline strikes — the read
 * itself may never answer.
 */
function ownRead<T>(read: Promise<T>, call: SendCall, file: NoteFile): Promise<T> {
  if (call.signal.aborted) return Promise.reject(new Error('stalled'));
  call.pending = file;
  return new Promise<T>((resolve, reject) => {
    const cut = () => reject(new Error('stalled'));
    // Cleared BEFORE the answer is handed on, in the same tick: the reader
    // resumes and starts its next read of the SAME file (the open, then its
    // first chunk), and a clear that ran later would wipe that one's mark — a
    // stall there would then read as an answer that never came.
    const settle = () => {
      call.signal.removeEventListener('abort', cut);
      if (call.pending === file) call.pending = null;
    };
    call.signal.addEventListener('abort', cut, { once: true });
    void read.then(
      (value) => {
        settle();
        resolve(value);
      },
      (err: unknown) => {
        settle();
        reject(err);
      },
    );
  });
}

function destroyable(data: unknown): data is { destroy(): unknown } {
  return typeof (data as { destroy?: unknown } | null)?.destroy === 'function';
}

/**
 * The stored file's bytes, as grammy will stream them, with every failure OF
 * THE READ tagged. Iterated by hand, not by `for await`, so only the store's
 * own errors are ours: an abort grammy throws in at the `yield` is grammy's,
 * and passes through untagged.
 */
async function* ownBytes(stored: InputFile, file: NoteFile, call: SendCall): AsyncGenerator<Uint8Array, void, undefined> {
  let data: Uint8Array | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;
  const raw = stored.toRaw();
  try {
    data = await ownRead(raw, call, file);
  } catch (err) {
    // A store that answers after the deadline hands back a stream nobody
    // will read: it is closed, not left holding a socket.
    if (call.signal.aborted) void raw.then((late) => (destroyable(late) ? late.destroy() : undefined), () => {});
    throw new SourceUnreadable(file, err);
  }
  if (data instanceof Uint8Array) {
    yield data;
    return;
  }
  if (destroyable(data)) call.streams.add(data);
  const iterator: AsyncIterator<Uint8Array> | Iterator<Uint8Array> =
    Symbol.asyncIterator in data
      ? (data as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      : (data as Iterable<Uint8Array>)[Symbol.iterator]();
  let finished = false;
  try {
    for (;;) {
      let next: IteratorResult<Uint8Array>;
      try {
        next = await ownRead(Promise.resolve(iterator.next()), call, file);
      } catch (err) {
        // Never `return()` a stream whose read is still parked: an async
        // iterator queues it behind that read, and the read may never answer
        // — the deadline has cut the stream itself (`newCall`).
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
