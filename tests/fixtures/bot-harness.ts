import { Bot, BotError } from 'grammy';
import type { Update } from 'grammy/types';
import { registerBotHandlers } from '@/modules/platform/telegram/bot';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { __dispatchSettled } from '@/modules/platform/telegram/client-cabinet';
import { membershipSettled } from '@/modules/platform/telegram/price-channel-handlers';
import { flushWaitWrites, nowSec } from '@/modules/platform/telegram/waits';
import { flushIntakeWrites } from '@/modules/platform/telegram/calc-store';
import { tableEditsSettled } from '@/modules/platform/telegram/calc-dialog';
import { keptLastSettled } from '@/modules/platform/telegram/kept-last';

/**
 * The bot the server runs, driven without a network (Q5 a).
 *
 * The SAME handler chain (`registerBotHandlers`) on a real grammy `Bot` with
 * its `botInfo` given (no getMe), a fake transformer answering every Bot API
 * call grammy makes, and `__setTelegramTransport` recording every call that
 * goes through send.ts. Updates are handed to `bot.handleUpdate` one at a
 * time, exactly as the poller hands them over.
 */

export const BOT_ID = 7_000_001;

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
  /** The id of the message the fake «sent», when the call sends one — a press names it later. */
  messageId?: number;
}
export interface SentCall {
  method: string;
  body: Record<string, unknown>;
}
interface Mark {
  api: number;
  sent: number;
}
type FakeError = { error_code: number; description: string; parameters?: { retry_after?: number } };

export interface BotHarness {
  bot: Bot;
  /** grammy calls (ctx.reply, ctx.api.*, answerCallbackQuery). */
  api: ApiCall[];
  /** send.ts calls (__setTelegramTransport). */
  sent: SentCall[];
  handle(update: Update): Promise<void>;
  /** Every send.ts and grammy call AFTER this mark — assertions about ONE handle(), never the flat log. */
  mark(): Mark;
  since(mark: Mark): { api: ApiCall[]; sent: SentCall[] };
  /** Awaits the cabinet's per-chat chains, the membership chain, the owed kept-last draws, the wait and collection writes and one setImmediate. */
  settle(): Promise<void>;
  /** The `date` the fake gives the messages it sends (default nowSec()). */
  setClock(sec: number | null): void;
  /** The next call of `method` (grammy or send.ts) fails with this. */
  failNext(method: string, error: FakeError): void;
  /**
   * The next send.ts call of `method` runs `during` BEFORE it is answered —
   * something that happens while a message is on its way (a correction landing
   * mid-send).
   */
  duringNext(method: string, during: () => Promise<void>): void;
  /**
   * A file the bot can download: `getFile` names it and the file endpoint
   * hands these bytes over (anything not served answers as before — no path).
   */
  serveFile(fileId: string, body: Buffer): void;
  /** Every text this chat was sent, both senders, in order. */
  textsTo(chatId: number, mark?: Mark): string[];
  restore(): void;
}

export function botHarness(): BotHarness {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = `${BOT_ID}:TEST`;
  const api: ApiCall[] = [];
  const sent: SentCall[] = [];
  const failures = new Map<string, FakeError[]>();
  const duringSends = new Map<string, (() => Promise<void>)[]>();
  const files = new Map<string, Buffer>();
  // The file endpoint is grammy's own `fetch`, not the transport: a file a
  // test serves is answered there. Installed by the first `serveFile` and
  // taken out by `restore()`, so a file that serves none leaves the
  // process's fetch alone.
  const realFetch = globalThis.fetch;
  let fetchServed = false;
  const serveFetch = () => {
    if (fetchServed) return;
    fetchServed = true;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const served = /^https:\/\/api\.telegram\.org\/file\/bot[^/]+\/served\/(.+)$/.exec(url);
      if (served && files.has(decodeURIComponent(served[1]!))) {
        return new Response(new Uint8Array(files.get(decodeURIComponent(served[1]!))!), { status: 200 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
  };
  let clock: number | null = null;
  let messageSeq = 900_000;
  const date = () => clock ?? nowSec();
  const takeFailure = (method: string) => {
    const queue = failures.get(method);
    return queue && queue.length ? queue.shift()! : null;
  };

  const bot = new Bot(`${BOT_ID}:TEST`, {
    botInfo: {
      id: BOT_ID,
      is_bot: true,
      first_name: 'GSR',
      username: 'gsr_test_bot',
      can_join_groups: false,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    } as never,
  });

  bot.api.config.use(async (_prev, method, payload) => {
    const body = (payload ?? {}) as Record<string, unknown>;
    const call: ApiCall = { method, payload: body };
    api.push(call);
    const failure = takeFailure(method);
    if (failure) return { ok: false, ...failure } as never;
    const chat = { id: Number(body.chat_id ?? 0), type: 'private' };
    switch (method) {
      case 'sendMessage':
      case 'sendPhoto':
      case 'sendDocument':
      case 'copyMessage':
      case 'forwardMessage':
        call.messageId = messageSeq += 1;
        return { ok: true, result: { message_id: call.messageId, date: date(), chat, text: body.text } } as never;
      case 'sendMediaGroup':
        call.messageId = messageSeq += 1;
        return { ok: true, result: [{ message_id: call.messageId, date: date(), chat }] } as never;
      case 'editMessageText':
        return { ok: true, result: { message_id: Number(body.message_id ?? 0), date: date(), chat, text: body.text } } as never;
      case 'getMe':
        return { ok: true, result: bot.botInfo } as never;
      default:
        return { ok: true, result: true } as never;
    }
  });

  __setTelegramTransport(async (url, init) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    let body: Record<string, unknown> = {};
    if (typeof init.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
    else if (init.body instanceof FormData) {
      for (const [key, value] of init.body.entries()) body[key] = typeof value === 'string' ? value : '[file]';
    }
    sent.push({ method, body });
    const during = duringSends.get(method)?.shift();
    if (during) await during();
    const failure = takeFailure(method);
    if (failure) return new Response(JSON.stringify({ ok: false, ...failure }), { status: failure.error_code });
    if (method === 'getFile' && files.has(String(body.file_id))) {
      const fileId = String(body.file_id);
      return new Response(
        JSON.stringify({ ok: true, result: { file_id: fileId, file_unique_id: fileId, file_path: `served/${encodeURIComponent(fileId)}` } }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: (messageSeq += 1), date: date(), chat: { id: Number(body.chat_id ?? 0) } } }),
      { status: 200 },
    );
  });

  registerBotHandlers(bot);

  const harness: BotHarness = {
    bot,
    api,
    sent,
    async handle(update) {
      try {
        await bot.handleUpdate(structuredClone(update));
      } catch (err) {
        throw err instanceof BotError ? err.error : err;
      }
    },
    mark: () => ({ api: api.length, sent: sent.length }),
    since: (m) => ({ api: api.slice(m.api), sent: sent.slice(m.sent) }),
    async settle() {
      await __dispatchSettled();
      await membershipSettled();
      // A kept-last draw owed (docs/IKKI-ESHIK.md §1.4, §4.1): an album's ONE
      // message waits out its debounce, so a test reads it once it is drawn.
      await keptLastSettled();
      await flushWaitWrites();
      // The collector's kept-last prompt and its table edits, dispatched off
      // the handler (docs/IKKI-ESHIK.md §1.4): drawn before anything is read.
      await keptLastSettled();
      await tableEditsSettled();
      // The «Hisoblatish» collections too (docs/SAKKIZ-R3.md §6.1): a no-op
      // unless the file switched the durable store on.
      await flushIntakeWrites();
      await new Promise((resolve) => setImmediate(resolve));
      await __dispatchSettled();
    },
    setClock(sec) {
      clock = sec;
    },
    failNext(method, error) {
      failures.set(method, [...(failures.get(method) ?? []), error]);
    },
    duringNext(method, during) {
      duringSends.set(method, [...(duringSends.get(method) ?? []), during]);
    },
    serveFile(fileId, body) {
      files.set(fileId, body);
      serveFetch();
    },
    textsTo(chatId, m = { api: 0, sent: 0 }) {
      const out: string[] = [];
      for (const call of api.slice(m.api)) {
        if (call.method === 'sendMessage' && Number(call.payload.chat_id) === chatId) out.push(String(call.payload.text));
      }
      for (const call of sent.slice(m.sent)) {
        if (call.method === 'sendMessage' && Number(call.body.chat_id) === chatId) out.push(String(call.body.text));
      }
      return out;
    },
    restore() {
      __setTelegramTransport(null);
      if (fetchServed) globalThis.fetch = realFetch;
      fetchServed = false;
      if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = savedToken;
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------
// Update builders — `date` in unix seconds, Telegram's unit.
// ---------------------------------------------------------------------------

let updateSeq = 1_000_000 + Math.floor(Math.random() * 1_000_000);
let messageSeq = 500_000 + Math.floor(Math.random() * 100_000);
let querySeq = 0;

const person = (chat: number) => ({ id: chat, is_bot: false, first_name: 'Test', username: `u${chat}` });
const privateChat = (chat: number) => ({ id: chat, type: 'private' as const, first_name: 'Test' });

interface MessageOpts {
  date?: number;
  messageId?: number;
  /** A reply to one of the BOT's messages (a swipe-reply). */
  replyTo?: number;
  forwarded?: boolean;
}

function message(chat: number, opts: MessageOpts, extra: Record<string, unknown>) {
  return {
    message_id: opts.messageId ?? (messageSeq += 1),
    date: opts.date ?? nowSec(),
    chat: privateChat(chat),
    from: person(chat),
    ...(opts.replyTo
      ? {
          reply_to_message: {
            message_id: opts.replyTo,
            date: nowSec() - 3600,
            chat: privateChat(chat),
            from: { id: BOT_ID, is_bot: true, first_name: 'GSR' },
            text: 'ping',
          },
        }
      : {}),
    ...(opts.forwarded ? { forward_origin: { type: 'hidden_user', sender_user_name: 'Mijoz', date: nowSec() - 60 } } : {}),
    ...extra,
  };
}

export const tg = {
  /** The same Telegram message delivered again: same update and message ids. */
  again(update: Update): Update {
    return structuredClone(update);
  },
  text(chat: number, text: string, opts: MessageOpts = {}): Update {
    return { update_id: (updateSeq += 1), message: message(chat, opts, { text }) } as unknown as Update;
  },
  command(chat: number, command: string, payload = '', opts: MessageOpts = {}): Update {
    const text = payload ? `/${command} ${payload}` : `/${command}`;
    return {
      update_id: (updateSeq += 1),
      message: message(chat, opts, { text, entities: [{ type: 'bot_command', offset: 0, length: command.length + 1 }] }),
    } as unknown as Update;
  },
  callback(
    chat: number,
    pressedMessageId: number,
    data: string,
    opts: { id?: string; text?: string; markup?: unknown; date?: number; message?: Record<string, unknown> } = {},
  ): Update {
    return {
      update_id: (updateSeq += 1),
      callback_query: {
        id: opts.id ?? `q${Date.now()}${(querySeq += 1)}`,
        from: person(chat),
        chat_instance: `ci${chat}`,
        data,
        message: {
          message_id: pressedMessageId,
          date: opts.date ?? nowSec() - 60,
          chat: privateChat(chat),
          from: { id: BOT_ID, is_bot: true, first_name: 'GSR' },
          text: opts.text ?? 'Vazifa',
          ...(opts.markup ? { reply_markup: opts.markup } : {}),
          ...(opts.message ?? {}),
        },
      },
    } as unknown as Update;
  },
  contact(chat: number, phone: string, opts: MessageOpts & { userId?: number } = {}): Update {
    return {
      update_id: (updateSeq += 1),
      message: message(chat, opts, { contact: { phone_number: phone, first_name: 'Test', user_id: opts.userId ?? chat } }),
    } as unknown as Update;
  },
  photo(chat: number, opts: MessageOpts & { caption?: string } = {}): Update {
    return {
      update_id: (updateSeq += 1),
      message: message(chat, opts, {
        photo: [{ file_id: `AgAC${(messageSeq += 1)}`, file_unique_id: `u${messageSeq}`, width: 1, height: 1, file_size: 10 }],
        ...(opts.caption ? { caption: opts.caption } : {}),
      }),
    } as unknown as Update;
  },
  document(chat: number, fileId: string, opts: MessageOpts & { fileName?: string; mime?: string; caption?: string } = {}): Update {
    return {
      update_id: (updateSeq += 1),
      message: message(chat, opts, {
        document: {
          file_id: fileId,
          file_unique_id: `u${fileId}`,
          file_name: opts.fileName ?? 'invoice.csv',
          mime_type: opts.mime ?? 'text/csv',
          file_size: 100,
        },
        ...(opts.caption ? { caption: opts.caption } : {}),
      }),
    } as unknown as Update;
  },
  forward(chat: number, text: string, opts: MessageOpts = {}): Update {
    return tg.text(chat, text, { ...opts, forwarded: true });
  },
};
