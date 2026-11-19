import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { Api } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/modules/platform/logger';
import type { NoteFile, NoteSend } from '@/modules/platform/notes/plan';
import { cardStepVerdict, SOURCE_UNREADABLE } from '@/modules/platform/notifications/note-card';
import { __setSendTimeout, redactToken, sendPlan } from '@/modules/platform/telegram/note-send';
import { CONNECT_PHASE } from '@/modules/platform/telegram/staff-group-rules';

/** The object store, stood in for on demand — a store that STALLS (review FR1-2). */
const store = vi.hoisted(() => ({ getStream: null as null | ((key: string) => Promise<unknown>) }));
vi.mock('@/modules/platform/files/storage', async (original) => {
  const real = await original<typeof import('@/modules/platform/files/storage')>();
  return {
    ...real,
    getStorage: () => {
      const driver = real.getStorage();
      if (!store.getStream) return driver;
      return { ...driver, getStream: store.getStream } as unknown as ReturnType<typeof real.getStorage>;
    },
  };
});

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
  store.getStream = null;
  __setSendTimeout(null);
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

/**
 * Our own read that STALLS (review FR1-2): MinIO takes the GET and then sends
 * nothing, and the S3 client has no request timeout. Through a REAL grammy
 * Api and its real node-fetch, against a local server that reads the request
 * body and never answers — so the call ends on OUR deadline, exactly as in
 * production, with node-fetch's own abort.
 */
describe('a stalled read of our own store (review FR1-2)', () => {
  const photo = (): NoteFile => ({
    partId: '00000000-0000-0000-0000-000000000002',
    attachmentId: 'b',
    fileName: 'sklad.jpg',
    storageKey: 'staff_note/stall/sklad.jpg',
    sizeBytes: 1000,
    sendAs: 'photo',
    telegramFileId: null,
    telegramSentAs: null,
  });
  const step = (): NoteSend => ({
    kind: 'media',
    as: 'photo',
    caption: 'Xitoy sklad\n\nIvu: 浙江省 义乌市 …\n\nMarkirovka / 唛头: GS777',
    files: [photo()],
  });

  let server: Server | null = null;
  async function silentTelegram(): Promise<string> {
    server = createServer((req) => {
      // Takes whatever the body gives and never answers: the body never completes.
      req.on('data', () => {});
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  }
  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('a stream that never yields: retried as our own unreadable bytes, and the store’s stream is closed', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // A Readable that never pushes a byte — the store's GET accepted, nothing after.
    const stalled = new Readable({ read() {} });
    store.getStream = async () => stalled;
    __setSendTimeout(300);
    const api = new Api('1:TEST', { apiRoot: await silentTelegram() });

    const began = Date.now();
    const out = await sendPlan(api, 42n, [step()], { onRateLimit: 'return' });
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(out.stop).not.toBeNull();
    expect(out.stop!.status).toBe(0);
    // Not «Network request … The user aborted a request»: the multipart body never
    // completed, so Telegram cannot have it — the card retries instead of a «maybe».
    expect(out.stop!.description).toMatch(new RegExp(`^${SOURCE_UNREADABLE} sklad\\.jpg \\(staff_note/stall/sklad\\.jpg\\): stalled`));
    expect(cardStepVerdict({ ...out.stop!, botDown: false })).toBe('retry');
    // The store's stream is cut, not left holding a socket for the process's life.
    expect(stalled.destroyed).toBe(true);
  });

  it('a store that never answers the GET at all: the same — retried, never stepped over', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    store.getStream = () => new Promise<never>(() => {});
    __setSendTimeout(300);
    const api = new Api('1:TEST', { apiRoot: await silentTelegram() });
    const out = await sendPlan(api, 42n, [step()], { onRateLimit: 'return' });
    expect(out.stop!.description.startsWith(`${SOURCE_UNREADABLE} sklad.jpg`)).toBe(true);
    expect(out.stop!.description).toContain('stalled');
    expect(cardStepVerdict({ ...out.stop!, botDown: false })).toBe('retry');
  });

  it('a deadline with our bytes all read is still an answer that never came — «maybe», never re-sent', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    store.getStream = async () => Readable.from([Buffer.from('jpeg bytes')]);
    __setSendTimeout(300);
    const api = new Api('1:TEST', { apiRoot: await silentTelegram() });
    const out = await sendPlan(api, 42n, [step()], { onRateLimit: 'return' });
    expect(out.stop!.description.startsWith(SOURCE_UNREADABLE)).toBe(false);
    expect(cardStepVerdict({ ...out.stop!, botDown: false })).toBe('ambiguous');
  });
});
