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
 * 429 and 5xx are the world being busy; 403 (the customer blocked the bot),
 * 400 (no such chat, a malformed body) and 404/401 will not change by being
 * asked again.
 */
export function isPermanentFailure(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404;
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
    permanent: !answer.ok && answer.status !== 429 && isPermanentFailure(answer.status),
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
