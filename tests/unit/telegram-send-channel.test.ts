import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setTelegramTransport,
  editCaption,
  sendAlbum,
  sendText,
} from '@/modules/platform/telegram/send';

/**
 * The sender's two new per-message fields for the price channel (his F7 a:
 * forwarding forbidden; a correction is a reply to the post it replaces), the
 * caption edit, and the network cause code — read back off the wire through
 * the recording transport.
 */
interface Call {
  url: string;
  body: Record<string, unknown>;
}

let calls: Call[] = [];
let throwNext: Error | null = null;

beforeEach(() => {
  calls = [];
  throwNext = null;
  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  __setTelegramTransport(async (url, init) => {
    if (throwNext) {
      const err = throwNext;
      throwNext = null;
      throw err;
    }
    const form = init.body instanceof FormData ? init.body : null;
    const body = form
      ? Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<file>']))
      : JSON.parse(String(init.body));
    calls.push({ url, body });
    return new Response(JSON.stringify({ ok: true, result: [{ message_id: 9 }] }), { status: 200 });
  });
});

afterEach(() => {
  __setTelegramTransport(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
});

const photo = { bytes: Buffer.from([1, 2, 3]), filename: 'a.jpg', contentType: 'image/jpeg' };

describe('protect_content and reply_parameters', () => {
  it('sendText carries both when asked', async () => {
    await sendText({ chatId: '-100123', html: 'x', protectContent: true, replyToMessageId: 77 });
    expect(calls[0]!.body.protect_content).toBe(true);
    expect((calls[0]!.body.reply_parameters as { message_id: number }).message_id).toBe(77);
  });

  it('an ordinary sendText carries neither (existing callers byte-identical)', async () => {
    await sendText({ chatId: 42, html: 'x' });
    expect(calls[0]!.body).not.toHaveProperty('protect_content');
    expect(calls[0]!.body).not.toHaveProperty('reply_parameters');
  });

  it('a two-photo album carries both in its form', async () => {
    await sendAlbum({ chatId: '-100123', photos: [photo, photo], captionHtml: 'c', protectContent: true, replyToMessageId: 77 });
    expect(calls[0]!.url).toMatch(/sendMediaGroup$/);
    expect(calls[0]!.body.protect_content).toBe('true');
    expect(JSON.parse(String(calls[0]!.body.reply_parameters)).message_id).toBe(77);
  });

  it('a ONE-photo album reaches sendPhoto and does not drop the fields', async () => {
    await sendAlbum({ chatId: '-100123', photos: [photo], captionHtml: 'c', protectContent: true, replyToMessageId: 77 });
    expect(calls[0]!.url).toMatch(/sendPhoto$/);
    expect(calls[0]!.body.protect_content).toBe('true');
    expect(JSON.parse(String(calls[0]!.body.reply_parameters)).message_id).toBe(77);
  });
});

describe('editCaption', () => {
  it('posts editMessageCaption with the caption as HTML', async () => {
    await editCaption({ chatId: '-100123', messageId: 5, captionHtml: '<b>x</b>' });
    expect(calls[0]!.url).toMatch(/editMessageCaption$/);
    expect(calls[0]!.body).toMatchObject({ chat_id: '-100123', message_id: 5, caption: '<b>x</b>', parse_mode: 'HTML' });
  });
});

describe('the network cause code', () => {
  it('rides in the description, so a refused connect can be told from a timeout', async () => {
    throwNext = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const r = await sendText({ chatId: 1, text: 'x' });
    expect(r.status).toBe(0);
    expect(r.description).toContain('[ECONNREFUSED]');
  });
});
