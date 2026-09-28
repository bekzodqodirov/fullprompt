import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendStaffMessage } from '@/modules/platform/notifications/service';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';

/**
 * «📊 Holat» delivers the way the 20:00 push does (review finding 1): the pull
 * used to dress the text with the drain's `composeStaffMessage` and then send
 * it through a plain `sendText`, whose answer to a refused keyboard is to send
 * the text WITHOUT it — and the dashboard link had already been lifted out of
 * the text into that keyboard, so the pulled message arrived with no link at
 * all. `sendStaffMessage` is the drain's own delivery; this reads back what
 * Telegram was sent (the transport swapped for a recorder, as the drain's own
 * integration test does — CI has no token and this container no network).
 */

const APP = 'https://test.gsrwms.uz';
const LINK = `${APP}/dashboard?davr=bugun`;
const TEXT = `📊 GSR — kun xulosasi, 28.09 (soat 20:00)\n\n💰 Tushum (hisoblangan): $1.00\n\n${LINK}`;

interface Call {
  method: string;
  body: Record<string, unknown>;
}
let calls: Call[] = [];
let answers: { status: number; json: unknown }[] = [];
const saved = { token: process.env.TELEGRAM_BOT_TOKEN, app: process.env.APP_URL };

beforeEach(() => {
  calls = [];
  answers = [];
  process.env.TELEGRAM_BOT_TOKEN = 'TEST:TOKEN';
  process.env.APP_URL = APP;
  __setTelegramTransport(async (url, init) => {
    calls.push({ method: url.slice(url.lastIndexOf('/') + 1), body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = answers.shift() ?? { status: 200, json: { ok: true, result: { message_id: 7 } } };
    return new Response(JSON.stringify(next.json), { status: next.status });
  });
});

afterEach(() => {
  __setTelegramTransport(null);
  if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = saved.token;
  if (saved.app === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = saved.app;
});

const sends = () => calls.filter((call) => call.method === 'sendMessage');

describe('the pulled summary is delivered by the drain’s own rule', () => {
  it('the link rides as «↗️ Ochish», with the title bolded — what 20:00 sends', async () => {
    const res = await sendStaffMessage(123n, 'OwnerSummary', { text: TEXT });
    expect(res.ok).toBe(true);
    const [only] = sends();
    expect(sends()).toHaveLength(1);
    expect(only!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: '↗️ Ochish', url: LINK }]] });
    expect(String(only!.body.text)).not.toContain(LINK);
    expect(String(only!.body.text)).toMatch(/^<b>📊 GSR — kun xulosasi/);
  });

  it('a refused button puts the link back into the text — never a message that lost it', async () => {
    answers.push({ status: 400, json: { ok: false, description: 'Bad Request: BUTTON_URL_INVALID' } });
    const res = await sendStaffMessage(123n, 'OwnerSummary', { text: TEXT });
    expect(res.ok).toBe(true);
    const [first, second] = sends();
    expect(sends()).toHaveLength(2);
    expect(first!.body.reply_markup).toBeDefined();
    expect(String(second!.body.text)).toContain(LINK);
  });
});
