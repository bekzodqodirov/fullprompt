import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setTelegramTransport,
  editMarkup,
  isPermanentFailure,
  quietHour,
  sendPhoto,
  sendText,
} from '@/modules/platform/telegram/send';
import { isPermanentNoticeFailure } from '@/modules/wms/notices/arrival';

/**
 * The one sender (round C). Nothing before this round showed what a send
 * POSTed — CI has no token and this container no network — so the transport
 * is swapped for a recorder and the body is read back.
 */

interface Call {
  url: string;
  body: Record<string, unknown>;
  form: FormData | null;
}

let calls: Call[] = [];
let answers: Array<{ status: number; json: unknown }> = [];

beforeEach(() => {
  calls = [];
  answers = [];
  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  __setTelegramTransport(async (url, init) => {
    const form = init.body instanceof FormData ? init.body : null;
    const body = form ? Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<file>'])) : JSON.parse(String(init.body));
    calls.push({ url, body, form });
    const next = answers.shift() ?? { status: 200, json: { ok: true, result: { message_id: 7 } } };
    return new Response(JSON.stringify(next.json), { status: next.status });
  });
});

afterEach(() => {
  __setTelegramTransport(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

describe('sendText', () => {
  it('sends HTML with previews off and returns the message id', async () => {
    const r = await sendText({ chatId: 42n, html: '<b>Salom</b>', silent: true });
    expect(r).toMatchObject({ ok: true, messageId: 7, usedFallback: false });
    expect(calls[0]!.url).toMatch(/\/botTEST:TOKEN\/sendMessage$/);
    expect(calls[0]!.body).toMatchObject({
      chat_id: 42,
      text: '<b>Salom</b>',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      disable_notification: true,
    });
  });

  it('HTML Telegram cannot parse goes again as the same text, plain', async () => {
    answers.push({ status: 400, json: { ok: false, description: "Bad Request: can't parse entities: Unsupported start tag" } });
    const r = await sendText({ chatId: 1, html: '<b>A &amp; B</b>' });
    expect(r.ok).toBe(true);
    expect(r.usedFallback).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.text).toBe('A & B');
    expect(calls[1]!.body.parse_mode).toBeUndefined();
  });

  it('a refused keyboard is dropped and the sentence still goes', async () => {
    answers.push({ status: 400, json: { ok: false, description: 'Bad Request: BUTTON_URL_INVALID' } });
    const markup = { inline_keyboard: [[{ text: 'x', url: 'https://t.me/x' }]] };
    const r = await sendText({ chatId: 1, text: 'hi', replyMarkup: markup });
    expect(r.ok).toBe(true);
    expect(calls[0]!.body.reply_markup).toEqual(markup);
    expect(calls[1]!.body.reply_markup).toBeUndefined();
  });

  it('a 429 is a moment, not a message: retryAfter, not permanent, no second call', async () => {
    answers.push({ status: 429, json: { ok: false, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } } });
    const r = await sendText({ chatId: 1, text: 'hi' });
    expect(r).toMatchObject({ ok: false, status: 429, retryAfter: 7, permanent: false });
    expect(calls).toHaveLength(1);
  });

  it('a customer who blocked the bot is permanent', async () => {
    answers.push({ status: 403, json: { ok: false, description: 'Forbidden: bot was blocked by the user' } });
    const r = await sendText({ chatId: 1, text: 'hi' });
    expect(r).toMatchObject({ ok: false, permanent: true });
  });

  it('no token is an answer, not a throw, and nothing is posted', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const r = await sendText({ chatId: 1, text: 'hi' });
    expect(r).toMatchObject({ ok: false, status: 0, description: 'no_bot_token', permanent: false });
    expect(calls).toHaveLength(0);
  });

  it('a dead socket is transient', async () => {
    __setTelegramTransport(async () => {
      throw new Error('ECONNRESET');
    });
    const r = await sendText({ chatId: 1, text: 'hi' });
    expect(r).toMatchObject({ ok: false, status: 0, permanent: false });
  });
});

describe('sendPhoto', () => {
  it('uploads the bytes as multipart with the caption and keyboard, and returns the largest file id', async () => {
    answers.push({
      status: 200,
      json: { ok: true, result: { message_id: 9, photo: [{ file_id: 'small' }, { file_id: 'large' }] } },
    });
    const r = await sendPhoto({
      chatId: 5n,
      photo: { bytes: Buffer.from([1, 2, 3]), filename: 'a.webp', contentType: 'image/webp' },
      captionHtml: '<b>GS777</b>',
      replyMarkup: { inline_keyboard: [] },
    });
    expect(r).toMatchObject({ ok: true, messageId: 9, fileId: 'large' });
    expect(calls[0]!.url).toMatch(/sendPhoto$/);
    expect(calls[0]!.body).toMatchObject({ chat_id: '5', caption: '<b>GS777</b>', parse_mode: 'HTML', photo: '<file>' });
    expect(JSON.parse(String(calls[0]!.body.reply_markup))).toEqual({ inline_keyboard: [] });
  });
});

describe('edits', () => {
  it('«message is not modified» is success, not a refusal', async () => {
    answers.push({ status: 400, json: { ok: false, description: 'Bad Request: message is not modified' } });
    const r = await editMarkup({ chatId: 1, messageId: 3 });
    expect(r.ok).toBe(true);
    expect(calls[0]!.body).toEqual({ chat_id: 1, message_id: 3 });
  });
});

describe('the rules the sweeps read', () => {
  it('permanent = 400/401/403/404, and the notice path asks the same function', () => {
    for (const s of [400, 401, 403, 404]) expect(isPermanentFailure(s)).toBe(true);
    for (const s of [0, 408, 429, 500, 502]) expect(isPermanentFailure(s)).toBe(false);
    for (const s of [0, 400, 403, 429, 500]) expect(isPermanentNoticeFailure(s)).toBe(isPermanentFailure(s));
  });

  it('night in Tashkent is 22:00 to 07:59', () => {
    // 17:00Z = 22:00 Tashkent; 02:59Z = 07:59; 03:00Z = 08:00.
    expect(quietHour(new Date('2026-09-27T17:00:00Z'))).toBe(true);
    expect(quietHour(new Date('2026-09-27T16:59:00Z'))).toBe(false);
    expect(quietHour(new Date('2026-09-28T02:59:00Z'))).toBe(true);
    expect(quietHour(new Date('2026-09-28T03:00:00Z'))).toBe(false);
  });
});
