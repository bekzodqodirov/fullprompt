import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * ONE local stand-in for the Messages API's STREAM (docs/FAYL-OQISH.md §3.2,
 * judge model-tests-reanchor): the reading is `client.messages.stream()`, and
 * a test that hand-stubs `stream()` never runs the paths that matter — the
 * caller's abort, a mid-stream `event: error`, a socket that drops — against
 * the real SDK. So every test that drives `analyzeIntake` talks to THIS, and
 * the SDK parses real server-sent events off a real socket.
 *
 * One reply per request, from the script, in order:
 *  - `status` other than 200: the JSON error body the API sends (the shape the
 *    older JSON stand-ins served — 529 is `overloaded_error`), before any
 *    event; `delayMs` holds the headers back;
 *  - otherwise `message_start` → the `thinking` then the `text` as deltas of
 *    `chunk` characters every `paceMs` → `message_delta` (the stop reason and
 *    the usage, `thinking_tokens` among `output_tokens_details`) →
 *    `message_stop`;
 *  - variants, each after `afterChars` characters of the text were sent:
 *    `errorType` — a mid-stream `event: error` of that type;
 *    `drop` — the socket is destroyed mid-body;
 *    `abortAfterMs` — the stand-in goes SILENT after this long and never ends
 *    the response: only the caller's leash ends the attempt.
 *
 * An unscripted request is a 400. `close()` destroys every open connection, so
 * a silent response never holds the suite.
 */
export interface SseReply {
  status?: number;
  delayMs?: number;
  text?: string;
  thinking?: string;
  chunk?: number;
  paceMs?: number;
  stop?: 'end_turn' | 'max_tokens' | 'refusal';
  usage?: { input_tokens: number; output_tokens: number; thinking_tokens?: number };
  /** Send no `message_delta` (the usage never arrives) — with a variant below. */
  noDelta?: boolean;
  errorType?: string;
  drop?: boolean;
  abortAfterMs?: number;
  /** Where the variant fires: after this many characters of `text` (default: all of it). */
  afterChars?: number;
}

export interface SseStandIn {
  url: string;
  script: SseReply[];
  /** Every request body the SDK sent, parsed. */
  bodies: { messages: { content: { type: string; text?: string }[] }[]; output_config?: unknown; max_tokens?: number }[];
  calls(): number;
  /** Point the SDK at this stand-in (key + base URL) — and back on `close()`. */
  close(): Promise<void>;
}

const ev = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

export async function startSseStandIn(): Promise<SseStandIn> {
  const script: SseReply[] = [];
  const bodies: SseStandIn['bodies'] = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      calls += 1;
      try {
        bodies.push(JSON.parse(raw) as SseStandIn['bodies'][number]);
      } catch {
        bodies.push({ messages: [] });
      }
      const reply = script.shift() ?? { status: 400 };
      const timers: NodeJS.Timeout[] = [];
      res.on('close', () => timers.forEach((t) => clearTimeout(t)));
      const later = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
      const status = reply.status ?? 200;
      if (status !== 200) {
        later(reply.delayMs ?? 0, () => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'error',
              error: { type: status === 529 ? 'overloaded_error' : status === 429 ? 'rate_limit_error' : 'invalid_request_error', message: 'stand-in' },
            }),
          );
        });
        return;
      }
      later(reply.delayMs ?? 0, () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const usage = reply.usage ?? { input_tokens: 10, output_tokens: 5 };
        res.write(
          ev('message_start', {
            message: {
              id: 'msg_stand_in',
              type: 'message',
              role: 'assistant',
              model: 'stand-in',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: usage.input_tokens, output_tokens: 1 },
            },
          }),
        );
        // The deltas: the thinking block, then the text block.
        const size = Math.max(1, reply.chunk ?? 64);
        const pieces: (() => void)[] = [];
        const thinking = reply.thinking ?? '';
        const text = reply.text ?? '';
        if (thinking) {
          pieces.push(() => res.write(ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })));
          for (let i = 0; i < thinking.length; i += size) {
            const part = thinking.slice(i, i + size);
            pieces.push(() => res.write(ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: part } })));
          }
          pieces.push(() => res.write(ev('content_block_stop', { index: 0 })));
        }
        const textIndex = thinking ? 1 : 0;
        pieces.push(() => res.write(ev('content_block_start', { index: textIndex, content_block: { type: 'text', text: '' } })));
        const until = Math.min(text.length, reply.afterChars ?? text.length);
        const variant = reply.errorType !== undefined || reply.drop === true || reply.abortAfterMs !== undefined;
        for (let i = 0; i < (variant ? until : text.length); i += size) {
          const part = text.slice(i, Math.min(i + size, variant ? until : text.length));
          pieces.push(() => res.write(ev('content_block_delta', { index: textIndex, delta: { type: 'text_delta', text: part } })));
        }
        const pace = reply.paceMs ?? 0;
        let at = 0;
        for (const piece of pieces) {
          later(at, piece);
          at += pace;
        }
        later(at, () => {
          if (reply.errorType !== undefined) {
            res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: reply.errorType, message: 'stand-in' } })}\n\n`);
            res.end();
            return;
          }
          if (reply.drop) {
            res.socket?.destroy();
            return;
          }
          if (reply.abortAfterMs !== undefined) return; // silent for ever — only the caller ends it
          res.write(ev('content_block_stop', { index: textIndex }));
          if (!reply.noDelta) {
            res.write(
              ev('message_delta', {
                delta: { stop_reason: reply.stop ?? 'end_turn', stop_sequence: null },
                usage: {
                  input_tokens: usage.input_tokens,
                  output_tokens: usage.output_tokens,
                  ...(usage.thinking_tokens !== undefined ? { output_tokens_details: { thinking_tokens: usage.thinking_tokens } } : {}),
                },
              }),
            );
          }
          res.write(ev('message_stop', {}));
          res.end();
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = url;
  return {
    url,
    script,
    bodies,
    calls: () => calls,
    close: async () => {
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved.url;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The answer JSON a reading parses: every key, the goods as given. */
export function readingJson(body: Record<string, unknown> = {}): string {
  return JSON.stringify({
    from_city: null,
    to_city: null,
    weight_kg: null,
    weight_netto: null,
    volume_m3: null,
    goods: [],
    steps: [],
    known_codes: [],
    ...body,
  });
}

/** One good as the schema writes it — every key present. */
export function goodJson(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    quantity: null,
    weight_kg: null,
    volume_m3: null,
    unit: null,
    measure_qty: null,
    tnved_code: null,
    note: null,
    ...over,
  };
}
