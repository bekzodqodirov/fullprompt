import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setTelegramTransport, sendAlbum } from '@/modules/platform/telegram/send';

/**
 * The cabinet's 📷 answer as one album (round C). It was grammy's
 * `replyWithMediaGroup` — no deadline worth the name, no caption, awaited on
 * the poller — so what the body looks like is read back here through the
 * sender's test transport, the same way `bot-send.test.ts` reads a message.
 */

interface Call {
  method: string;
  form: FormData | null;
}

let calls: Call[] = [];
let answers: { status: number; json: unknown }[] = [];

beforeEach(() => {
  calls = [];
  answers = [];
  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  __setTelegramTransport(async (url, init) => {
    calls.push({ method: url.split('/').pop()!, form: init.body instanceof FormData ? init.body : null });
    const next = answers.shift() ?? {
      status: 200,
      json: { ok: true, result: [{ message_id: 31 }, { message_id: 32 }] },
    };
    return new Response(JSON.stringify(next.json), { status: next.status });
  });
});

afterEach(() => {
  __setTelegramTransport(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

const photo = (n: number) => ({ bytes: Buffer.from(`img${n}`), filename: `p${n}.jpg`, contentType: 'image/jpeg' });

describe('sendAlbum', () => {
  it('sends one media group, the caption on the FIRST photo only, as HTML', async () => {
    const r = await sendAlbum({ chatId: 7n, photos: [photo(1), photo(2), photo(3)], captionHtml: '<b>GS777 · A</b>' });
    expect(r).toMatchObject({ ok: true, messageId: 31, usedFallback: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('sendMediaGroup');
    const media = JSON.parse(String(calls[0]!.form!.get('media'))) as Record<string, unknown>[];
    expect(media).toHaveLength(3);
    expect(media[0]).toEqual({ type: 'photo', media: 'attach://p0', caption: '<b>GS777 · A</b>', parse_mode: 'HTML' });
    expect(media[1]).toEqual({ type: 'photo', media: 'attach://p1' });
    expect(calls[0]!.form!.get('chat_id')).toBe('7');
    // The bytes ride as attachments named by the media entries.
    expect(calls[0]!.form!.get('p2')).toBeInstanceOf(Blob);
  });

  it('a caption Telegram cannot parse goes again as the same words, plain — the photos still arrive', async () => {
    answers.push({ status: 400, json: { ok: false, description: "Bad Request: can't parse entities" } });
    const r = await sendAlbum({ chatId: 7, photos: [photo(1), photo(2)], captionHtml: '<b>A &amp; B</b>' });
    expect(r.ok).toBe(true);
    expect(r.usedFallback).toBe(true);
    const media = JSON.parse(String(calls[1]!.form!.get('media'))) as Record<string, unknown>[];
    expect(media[0]).toEqual({ type: 'photo', media: 'attach://p0', caption: 'A & B' });
  });

  it('one photo is a photo — Telegram refuses a group of one', async () => {
    answers.push({ status: 200, json: { ok: true, result: { message_id: 5, photo: [{ file_id: 'F' }] } } });
    const r = await sendAlbum({ chatId: 7, photos: [photo(1)], captionHtml: 'x' });
    expect(calls[0]!.method).toBe('sendPhoto');
    expect(r).toMatchObject({ ok: true, messageId: 5 });
    expect('fileId' in r).toBe(false);
  });

  it('never sends more than ten, and nothing at all for none', async () => {
    await sendAlbum({ chatId: 7, photos: Array.from({ length: 13 }, (_, i) => photo(i)) });
    expect(JSON.parse(String(calls[0]!.form!.get('media')))).toHaveLength(10);
    const none = await sendAlbum({ chatId: 7, photos: [] });
    expect(none.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('a revoked token is the bot, not the customer — the caller must not give up on the chat', async () => {
    answers.push({ status: 401, json: { ok: false, description: 'Unauthorized' } });
    const r = await sendAlbum({ chatId: 7, photos: [photo(1), photo(2)] });
    expect(r).toMatchObject({ ok: false, botDown: true, permanent: false });
  });
});
