import { Api } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/modules/platform/logger';
import type { NoteSend } from '@/modules/platform/notes/plan';
import { cardStepVerdict, SOURCE_UNREADABLE } from '@/modules/platform/notifications/note-card';
import { redactToken, sendPlan } from '@/modules/platform/telegram/note-send';
import { CONNECT_PHASE } from '@/modules/platform/telegram/staff-group-rules';

/**
 * A zametka step that did not go, as the drain reads it (`PlanStop`) — the
 * words it stores as the row's `error` and the line it logs.
 *
 * Through a REAL grammy Api (the production client) pointed at a port
 * nothing listens on, and through one whose fetch reads the multipart body the
 * way an upload does: the two failures the review reproduced with a probe.
 */

const TOKEN = '123456:SECRET-BOT-TOKEN';

afterEach(() => {
  vi.restoreAllMocks();
});

function logged(spy: { mock: { calls: unknown[][] } }): string {
  return JSON.stringify(spy.mock.calls);
}

describe('a refused connect carries no bot token (review P1-DLV-1)', () => {
  it('the stop the drain stores names the network, never the token, and still reads as a refused connect', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const api = new Api(TOKEN, { apiRoot: 'http://127.0.0.1:9' });
    const out = await sendPlan(api, 42n, [{ kind: 'text', text: 'Xitoy sklad' }], { onRateLimit: 'return' });
    expect(out.stop).not.toBeNull();
    const description = out.stop!.description;
    expect(description).not.toContain('SECRET');
    expect(description).not.toContain(TOKEN);
    // The words the connect-phase rule reads are kept — the verdict is unchanged.
    expect(CONNECT_PHASE.test(description)).toBe(true);
    expect(cardStepVerdict({ ...out.stop!, botDown: false })).toBe('retry');
    // …and the log line carries the same redacted words, never the raw error
    // (pino serialises `HttpError.error`, node-fetch's message is the URL).
    expect(warn).toHaveBeenCalled();
    expect(logged(warn)).not.toContain('SECRET');
  });

  it('the 📌 tap’s own log line is redacted too', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const api = new Api(TOKEN, { apiRoot: 'http://127.0.0.1:9' });
    const out = await sendPlan(api, 42n, [{ kind: 'text', text: 'Xitoy sklad' }], { onRateLimit: 'wait' });
    expect(out.failed).toBe(1);
    expect(warn).toHaveBeenCalled();
    expect(logged(warn)).not.toContain('SECRET');
  });

  it('cuts the token by shape and by its own text', () => {
    expect(redactToken('request to http://127.0.0.1:9/bot123456:AAx-y_z/sendPhoto failed')).toBe(
      'request to http://127.0.0.1:9/bot<token>/sendPhoto failed',
    );
    expect(redactToken(`token=${TOKEN} ECONNREFUSED`, TOKEN)).toBe('token=<token> ECONNREFUSED');
    // A link that is merely ABOUT a bot is not a token.
    expect(redactToken('https://t.me/gsr_bot?start=mijoz')).toBe('https://t.me/gsr_bot?start=mijoz');
  });
});

describe('our own bytes that could not be read (review P1-DLV-2)', () => {
  it('are said as such, naming the file — and the card retries them instead of stepping over a «maybe»', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let bodyRead = false;
    const api = new Api('1:TEST', {
      // A fetch that READS the multipart body, the way a real upload does.
      fetch: (async (_url: string, init: { body?: unknown }) => {
        if (init.body && typeof init.body !== 'string') {
          for await (const chunk of init.body as AsyncIterable<Uint8Array>) bodyRead = bodyRead || chunk.length > 0;
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
      }) as never,
    });
    const step: NoteSend = {
      kind: 'media',
      as: 'photo',
      caption: 'Xitoy sklad\n\nIvu: 浙江省 义乌市 …\n\nMarkirovka / 唛头: GS777',
      files: [
        {
          partId: '00000000-0000-0000-0000-000000000001',
          attachmentId: 'a',
          fileName: 'sklad.jpg',
          storageKey: `gone/never-was-${Date.now()}.jpg`,
          sizeBytes: 1000,
          sendAs: 'photo',
          telegramFileId: null,
          telegramSentAs: null,
        },
      ],
    };
    const out = await sendPlan(api, 42n, [step], { onRateLimit: 'return' });
    expect(out.stop).not.toBeNull();
    expect(out.stop!.status).toBe(0);
    expect(out.stop!.description.startsWith(SOURCE_UNREADABLE)).toBe(true);
    expect(out.stop!.description).toContain('sklad.jpg');
    expect(cardStepVerdict({ ...out.stop!, botDown: false })).toBe('retry');
    void bodyRead;
  });
});
