import { logger } from '../logger';
import { htmlToPlain } from './format';

/**
 * The ONE way the app talks to the Bot API outside a grammy handler.
 *
 * Before round C there were seven raw `fetch` calls building the same body by
 * hand — the staff drain, both client pushes, the arrival and pickup sweeps,
 * the code-added notice, the cabinet warnings — and each had learned a
 * different subset of the lessons: one had a deadline and the others could
 * hang the job for ever (round 101's defect), one read the answer and the
 * others could not tell a blocked customer from a reached one (#268), none
 * turned link previews off, and a 429 was counted as a failed attempt
 * everywhere it was seen at all. A lesson written into one of seven copies is
 * a lesson six places have not learned; here it is written once.
 *
 * What every call gets:
 *   - a deadline (20 s for text, 60 s for an upload);
 *   - link previews OFF — a staff message carrying a card link otherwise grows
 *     a «GSR LOGISTICS» preview card longer than the message;
 *   - an honest verdict: sent (with the message id), refused for good (the
 *     customer blocked the bot, no such chat), or refused for NOW (a 429 with
 *     its `retry_after`, a 5xx, a dead socket) — and never a sleep, because
 *     every caller is a sweep that comes back on its own;
 *   - the text standing on its own: HTML Telegram cannot parse is sent again
 *     as plain text, and a keyboard it refuses is dropped and the message sent
 *     without it (map-link.ts's rule — the sentence must never depend on the
 *     button). Both are logged as warnings, because each means a defect to
 *     find (a value that skipped `h()`, a button with a bad URL), not a state
 *     to live in.
 */

const API = 'https://api.telegram.org';

type Transport = (input: string, init: RequestInit) => Promise<Response>;
let transport: Transport | null = null;

/**
 * Tests only: what a send would have POSTed, without the network. The
 * container has none and CI has no token, so nothing else can show what the
 * body looked like (the scouts found not one test that did).
 */
export function __setTelegramTransport(fn: Transport | null): void {
  transport = fn;
}

export type ChatId = number | bigint | string;

export interface SendResult {
  ok: boolean;
  /** HTTP status; 0 when no answer arrived (network, deadline, no token). */
  status: number;
  description: string;
  /** The sent (or edited) message, when Telegram said which. */
  messageId: number | null;
  /** Seconds Telegram asked us to wait (a 429) — a moment, not a message. */
  retryAfter: number | null;
  /** True when retrying the SAME message can never succeed. */
  permanent: boolean;
  /** The TOKEN was refused (401/404): nothing will send until it is fixed. */
  botDown: boolean;
  /** The plain-text or no-keyboard second attempt was what went out. */
  usedFallback: boolean;
}

interface BotApiBody {
  ok?: boolean;
  description?: string;
  result?: unknown;
  parameters?: { retry_after?: number };
}

interface CallAnswer {
  ok: boolean;
  status: number;
  description: string;
  result: unknown;
  retryAfter: number | null;
}

/**
 * Is this refusal about THIS message (give up) or about this MOMENT (try
 * again)?
 *
 * Moved here from `wms/notices/arrival.ts` (which re-exports it) so the
 * platform senders can ask it too. The rule is the one rounds 48-49 settled:
 * 429 and 5xx are the world being busy; 403 (the customer blocked the bot)
 * and 400 (no such chat, a malformed body) will not change by being asked
 * again.
 *
 * 401 and 404 are NOT here any more (round C's judge, REL-1): Telegram answers
 * them for a revoked or mistyped TOKEN, which is a fact about US and not the
 * recipient — round 49's `isSessionDead` split, one layer over. Counted as
 * permanent, the morning a burned token is rotated would have settled every
 * waiting customer notice as `failed` for ever. `isBotFailure` names them so
 * a sweep can stop and wait instead.
 */
export function isPermanentFailure(status: number): boolean {
  return status === 400 || status === 403;
}

/** The bot itself cannot send (bad or revoked token) — stop, keep the queue. */
export function isBotFailure(status: number): boolean {
  return status === 401 || status === 404;
}

/**
 * Night in Tashkent — 22:00 to 07:59. A customer's phone should not ring at
 * 03:00 because a truck was unloaded at 03:00; the message still ARRIVES
 * (`disable_notification`), it just does not buzz. Uzbekistan keeps no
 * daylight saving, so the offset is a constant.
 */
export function quietHour(now: Date = new Date()): boolean {
  const hour = new Date(now.getTime() + 5 * 3600_000).getUTCHours();
  return hour >= 22 || hour < 8;
}

function chatValue(id: ChatId): number | string {
  return typeof id === 'bigint' ? Number(id) : id;
}

/**
 * Is the bot's TOKEN working — told once per CHANGE, to whoever listens.
 *
 * «Kill the bot and every admin screen stays green» (B9): the staff drain
 * paused on a 401 and wrote nothing a screen could read, the customer notices
 * and the broadcast did the same each on their own, and the one alarm channel
 * the owner reads — Telegram — is the thing that died. Every Bot API call in
 * the app comes through `botCall`, so this is where the fact is learnt, for all
 * three senders at once (the package judge's finding: a fact recorded by one
 * consumer and cleared by another rule goes stale).
 *
 * Remembered per process and passed on only when it FLIPS, so a drain paused
 * on the same 401 every minute writes nothing, and the first success after a
 * rotated token clears it — whoever sent it. A 400/403/429 is Telegram having
 * ACCEPTED the token and refused something else, so it counts as «working»; a
 * dead socket or a 5xx says nothing about the token and changes nothing.
 *
 * The listener is installed at boot by the app (instrumentation-node.ts), not
 * imported here: a test, a script or the listener container that sends through
 * this module must not write the company's alarm state as a side effect.
 */
type BotStateListener = (state: { down: boolean; detail: string }) => Promise<void> | void;
let botStateListener: BotStateListener | null = null;
let lastBotState: 'up' | 'down' | null = null;

export function setBotStateListener(fn: BotStateListener | null): void {
  botStateListener = fn;
  lastBotState = null;
}

export function noteBotAnswer(status: number, description: string, ok = false): void {
  const next: 'up' | 'down' | null =
    ok || isPermanentFailure(status) || status === 429 ? 'up' : isBotFailure(status) ? 'down' : null;
  if (next === null || next === lastBotState) return;
  lastBotState = next;
  const listener = botStateListener;
  if (!listener) return;
  void Promise.resolve()
    .then(() => listener({ down: next === 'down', detail: description }))
    .catch((err: unknown) => {
      // Not recorded (a database blip): forget the memo so the next answer
      // tries again, rather than believing a state nobody wrote down.
      lastBotState = null;
      logger.warn({ err }, 'bot state not recorded');
    });
}

/** One Bot API method, answered — never thrown. */
export async function botCall(
  method: string,
  payload: Record<string, unknown> | FormData,
  timeoutMs = 20_000,
): Promise<CallAnswer> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { ok: false, status: 0, description: 'no_bot_token', result: null, retryAfter: null };
  }
  const isForm = typeof FormData !== 'undefined' && payload instanceof FormData;
  try {
    const res = await (transport ?? fetch)(`${API}/bot${token}/${method}`, {
      method: 'POST',
      ...(isForm ? {} : { headers: { 'content-type': 'application/json' } }),
      body: isForm ? (payload as FormData) : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json: BotApiBody | null = null;
    try {
      json = (await res.json()) as BotApiBody;
    } catch {
      json = null;
    }
    const ok = res.ok && json?.ok === true;
    noteBotAnswer(res.status, json?.description ?? `HTTP ${res.status}`, ok);
    return {
      ok,
      status: res.status,
      description: json?.description ?? (ok ? '' : `HTTP ${res.status}`),
      result: json?.result ?? null,
      retryAfter:
        typeof json?.parameters?.retry_after === 'number' ? json.parameters.retry_after : null,
    };
  } catch (err) {
    // The deadline or the network — this moment, not this message.
    return {
      ok: false,
      status: 0,
      description: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      result: null,
      retryAfter: null,
    };
  }
}

/** Telegram could not read our markup: an escape was missed somewhere. */
const PARSE_REFUSAL = /can't parse entities|unsupported start tag|can't find end tag|unclosed|entity/i;
/** Telegram refused a button: a bad URL, a web_app on a non-https page. */
const MARKUP_REFUSAL = /button|keyboard|reply.?markup|web.?app/i;

function verdict(answer: CallAnswer, usedFallback: boolean): SendResult {
  const result = answer.result as { message_id?: number } | null;
  return {
    ok: answer.ok,
    status: answer.status,
    description: answer.description,
    messageId: answer.ok && typeof result?.message_id === 'number' ? result.message_id : null,
    retryAfter: answer.retryAfter,
    permanent: !answer.ok && isPermanentFailure(answer.status),
    botDown: !answer.ok && isBotFailure(answer.status),
    usedFallback,
  };
}

/**
 * Send once, then — only on the two refusals that are about OUR formatting
 * and not the recipient — once more without the offending part.
 */
async function sendWithFallbacks(
  method: string,
  base: Record<string, unknown>,
  textKey: 'text' | 'caption',
  timeoutMs: number,
  toForm?: (body: Record<string, unknown>) => FormData,
): Promise<{ answer: CallAnswer; usedFallback: boolean }> {
  const send = (body: Record<string, unknown>) => botCall(method, toForm ? toForm(body) : body, timeoutMs);
  let answer = await send(base);
  if (answer.ok || answer.status !== 400) return { answer, usedFallback: false };

  let body = base;
  let usedFallback = false;
  if (base.parse_mode === 'HTML' && PARSE_REFUSAL.test(answer.description)) {
    logger.warn({ method, description: answer.description }, 'telegram refused our HTML — sent as plain text');
    body = { ...base, [textKey]: htmlToPlain(String(base[textKey] ?? '')) };
    delete body.parse_mode;
    usedFallback = true;
    answer = await send(body);
    if (answer.ok || answer.status !== 400) return { answer, usedFallback };
  }
  if (body.reply_markup && MARKUP_REFUSAL.test(answer.description)) {
    logger.warn({ method, description: answer.description }, 'telegram refused a keyboard — sent without it');
    const bare = { ...body };
    delete bare.reply_markup;
    usedFallback = true;
    answer = await send(bare);
  }
  return { answer, usedFallback };
}

export interface TextMessage {
  chatId: ChatId;
  /** Safe HTML (built with format.ts). Exactly one of html/text. */
  html?: string;
  /** Plain text, sent as-is. */
  text?: string;
  replyMarkup?: unknown;
  /** Arrives without a sound — the customer's night (quietHour). */
  silent?: boolean;
  timeoutMs?: number;
}

export async function sendText(msg: TextMessage): Promise<SendResult> {
  const html = msg.html !== undefined;
  const base: Record<string, unknown> = {
    chat_id: chatValue(msg.chatId),
    text: html ? msg.html : (msg.text ?? ''),
    link_preview_options: { is_disabled: true },
    ...(html ? { parse_mode: 'HTML' } : {}),
    ...(msg.silent ? { disable_notification: true } : {}),
    ...(msg.replyMarkup ? { reply_markup: msg.replyMarkup } : {}),
  };
  const { answer, usedFallback } = await sendWithFallbacks('sendMessage', base, 'text', msg.timeoutMs ?? 20_000);
  return verdict(answer, usedFallback);
}

export interface PhotoMessage {
  chatId: ChatId;
  /** Bytes read from our storage, or a file id Telegram gave us earlier. */
  photo: { bytes: Buffer | Uint8Array; filename: string; contentType: string } | { fileId: string };
  /** Safe HTML; its VISIBLE length must be ≤ 1024 — the caller checks. */
  captionHtml?: string;
  replyMarkup?: unknown;
  silent?: boolean;
  timeoutMs?: number;
}

/**
 * One photo with its caption and keyboard. The bytes are UPLOADED: our
 * storage's signed URLs point at `minio:9000`, which only the containers can
 * reach, so Telegram cannot fetch them by URL.
 *
 * A photo Telegram refuses (too big, a shape it will not take) comes back as
 * `ok:false` — the caller holds the text and sends it as a message, which is
 * principle one of round C: the photo is an addition, never the delivery.
 */
export async function sendPhoto(msg: PhotoMessage): Promise<SendResult & { fileId: string | null }> {
  const base: Record<string, unknown> = {
    chat_id: chatValue(msg.chatId),
    ...(msg.captionHtml ? { caption: msg.captionHtml, parse_mode: 'HTML' } : {}),
    ...(msg.silent ? { disable_notification: true } : {}),
    ...(msg.replyMarkup ? { reply_markup: msg.replyMarkup } : {}),
  };
  const photo = msg.photo;
  const toForm = (body: Record<string, unknown>) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    if ('fileId' in photo) form.append('photo', photo.fileId);
    // Copied into a plain ArrayBuffer: a Buffer may sit on a shared pool the
    // Blob constructor does not accept.
    else form.append('photo', new Blob([new Uint8Array(photo.bytes)], { type: photo.contentType }), photo.filename);
    return form;
  };
  const { answer, usedFallback } = await sendWithFallbacks('sendPhoto', base, 'caption', msg.timeoutMs ?? 60_000, toForm);
  const sent = answer.result as { photo?: { file_id: string }[] } | null;
  // Every size comes back; the LAST is the largest and the one to re-send.
  const fileId = answer.ok && sent?.photo?.length ? sent.photo[sent.photo.length - 1]!.file_id : null;
  return { ...verdict(answer, usedFallback), fileId };
}

/** «Not modified» is the edit having nothing to do — success, not a refusal. */
function editVerdict(answer: CallAnswer): SendResult {
  if (!answer.ok && /message is not modified/i.test(answer.description)) {
    return { ...verdict({ ...answer, ok: true }, false), messageId: null };
  }
  return verdict(answer, false);
}

/**
 * Replace (or, with no markup, REMOVE) the buttons under a message we sent.
 * Best-effort by nature: Telegram refuses edits to a message older than 48
 * hours, and a button that stays is a nuisance, not a loss.
 */
export async function editMarkup(o: {
  chatId: ChatId;
  messageId: number;
  replyMarkup?: unknown;
}): Promise<SendResult> {
  const answer = await botCall(
    'editMessageReplyMarkup',
    {
      chat_id: chatValue(o.chatId),
      message_id: o.messageId,
      ...(o.replyMarkup ? { reply_markup: o.replyMarkup } : {}),
    },
    10_000,
  );
  return editVerdict(answer);
}

/** Rewrite a message we sent — its text and, optionally, its buttons. */
export async function editText(o: {
  chatId: ChatId;
  messageId: number;
  html: string;
  replyMarkup?: unknown;
}): Promise<SendResult> {
  const base: Record<string, unknown> = {
    chat_id: chatValue(o.chatId),
    message_id: o.messageId,
    text: o.html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(o.replyMarkup ? { reply_markup: o.replyMarkup } : {}),
  };
  const { answer } = await sendWithFallbacks('editMessageText', base, 'text', 10_000);
  return editVerdict(answer);
}

/** «Typing…» at the top of the chat while a slow answer is being made. */
export async function sendTyping(chatId: ChatId): Promise<void> {
  await botCall('sendChatAction', { chat_id: chatValue(chatId), action: 'typing' }, 5_000);
}

export interface AlbumMessage {
  chatId: ChatId;
  /** One to ten photos; one goes as a plain photo, more as a media group. */
  photos: { bytes: Buffer | Uint8Array; filename: string; contentType: string }[];
  /** Safe HTML under the FIRST photo — an album carries one caption. */
  captionHtml?: string;
  silent?: boolean;
  timeoutMs?: number;
}

/**
 * Several photos as ONE album (round C, the cabinet's 📷) — through the one
 * sender, so the upload has a deadline and a verdict like every other call.
 *
 * It was grammy's `replyWithMediaGroup`, awaited on the sequential poller
 * with grammy's 500-second default and no caption: ten photographs from our
 * storage held every other customer's tap, and arrived with nothing saying
 * which lot they were. An album carries no keyboard, which is why the pushes
 * never use one; the 📷 answer has no button to lose.
 *
 * The caption is HTML with the same plain fallback as a message — refused
 * markup goes again as the same words, unformatted, and the photos still
 * arrive. One photo is simply `sendPhoto`: Telegram refuses a group of one.
 */
export async function sendAlbum(msg: AlbumMessage): Promise<SendResult> {
  const photos = msg.photos.slice(0, 10);
  if (photos.length === 0) {
    return {
      ok: false,
      status: 0,
      description: 'no_photos',
      messageId: null,
      retryAfter: null,
      permanent: true,
      botDown: false,
      usedFallback: false,
    };
  }
  if (photos.length === 1) {
    const { fileId: _unused, ...one } = await sendPhoto({
      chatId: msg.chatId,
      photo: photos[0]!,
      captionHtml: msg.captionHtml,
      silent: msg.silent,
      timeoutMs: msg.timeoutMs,
    });
    void _unused;
    return one;
  }
  const build = (plain: boolean) => {
    const form = new FormData();
    form.append('chat_id', String(chatValue(msg.chatId)));
    if (msg.silent) form.append('disable_notification', 'true');
    const caption = msg.captionHtml
      ? plain
        ? { caption: htmlToPlain(msg.captionHtml) }
        : { caption: msg.captionHtml, parse_mode: 'HTML' }
      : {};
    const media = photos.map((_, index) => ({
      type: 'photo',
      media: `attach://p${index}`,
      ...(index === 0 ? caption : {}),
    }));
    form.append('media', JSON.stringify(media));
    photos.forEach((p, index) => {
      // Copied into a plain ArrayBuffer, as sendPhoto does: a Buffer may sit on
      // a shared pool the Blob constructor does not accept.
      form.append(`p${index}`, new Blob([new Uint8Array(p.bytes)], { type: p.contentType }), p.filename);
    });
    return form;
  };
  const timeoutMs = msg.timeoutMs ?? 60_000;
  let answer = await botCall('sendMediaGroup', build(false), timeoutMs);
  let usedFallback = false;
  if (!answer.ok && answer.status === 400 && msg.captionHtml && PARSE_REFUSAL.test(answer.description)) {
    logger.warn({ description: answer.description }, 'telegram refused our album caption — sent as plain text');
    usedFallback = true;
    answer = await botCall('sendMediaGroup', build(true), timeoutMs);
  }
  // The answer is the array of sent messages; the first carries the caption.
  const first = Array.isArray(answer.result) ? ((answer.result[0] as unknown) ?? null) : null;
  return verdict({ ...answer, result: first }, usedFallback);
}
