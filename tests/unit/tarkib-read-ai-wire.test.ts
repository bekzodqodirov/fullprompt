import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { READ_EFFORT, READ_MAX_TOKENS, readTarkibDocument } from '@/modules/wms/receipts/tarkib-read-ai';
import type { PreparedFile } from '@/modules/wms/receipts/tarkib-file';
import { startSseStandIn, type SseStandIn } from '../fixtures/sse-anthropic';

/**
 * «🤖 Fayldan to'ldirish» — the model call ON THE WIRE, with the real SDK
 * against a local stand-in for the Messages API's stream
 * (`tests/fixtures/sse-anthropic.ts`, the intake reader's own).
 *
 * `tarkib-read-ai.test.ts` replaces the SDK's `messages` object, so nothing
 * the SDK itself does — its retry, its sleep, the error classes it really
 * throws, its parsing of server-sent events — ran in any T1 test, and three
 * of that file's endings were hand-written imitations of what the SDK «would»
 * throw (the T1 review, A12). Here the request really leaves a socket:
 *
 *  · the request is STREAMED, at effort «medium», with 32 000 tokens of room;
 *  · a refusal by the provider (429, 529) is ONE request — never retried
 *    inside a leash it would outlive — and is not counted;
 *  · a provider that goes silent is ended by OUR deadline: counted;
 *  · a connection that never opened is not our deadline: not counted.
 */

let api: SseStandIn;
beforeAll(async () => {
  api = await startSseStandIn();
});
afterAll(async () => {
  await api.close();
});
afterEach(() => {
  api.script.length = 0;
  vi.unstubAllGlobals();
});

const ROW = { name: '键盘', name_ru: 'Клавиатура', pieces: 500, cartons: 50, gross_kg: 600, net_kg: 550, volume_m3: 1.5, hs_code: null, unsure: null };
const good = JSON.stringify({ rows: [ROW], totals: null, document: 'packing_list', notes: null });
const pdf: PreparedFile = { kind: 'pdf', data: Buffer.from('%PDF-1.4\n%%EOF\n') };
const sheet: PreparedFile = { kind: 'sheet', text: 'Name | Qty\n键盘 | 500', rows: 2, rowsCut: false, cellsCut: false };
const read = (file: PreparedFile = pdf, leashMs = 5_000) => readTarkibDocument(file, { fileName: 'p.pdf', leashMs });

describe('the request that leaves the socket', () => {
  it('is streamed, at effort «medium», with 32 000 tokens of room — and the answer is the final message’s', async () => {
    api.script.push({ text: good, thinking: 'считаю строки', usage: { input_tokens: 2100, output_tokens: 640 } });
    const before = api.calls();
    const out = await read();
    expect(out).toMatchObject({ ok: true, usage: { inputTokens: 2100, outputTokens: 640 } });
    expect(out.ok && out.answer.rows).toEqual([ROW]);
    expect(api.calls()).toBe(before + 1);
    const sent = JSON.parse(api.raws.at(-1)!) as { stream?: boolean; max_tokens: number; output_config: { effort: string; format: { type: string } } };
    expect(sent.stream).toBe(true);
    expect(sent.max_tokens).toBe(READ_MAX_TOKENS);
    expect(sent.output_config.effort).toBe(READ_EFFORT);
    expect(sent.output_config.format.type).toBe('json_schema');
  });

  it('an answer cut at its size — the cap or the context window — is «ai_truncated», with its tokens', async () => {
    for (const stop of ['max_tokens', 'model_context_window_exceeded'] as const) {
      api.script.push({ text: '{"rows": [{"name": "键', stop, usage: { input_tokens: 900, output_tokens: 32_000 } });
      expect(await read(), stop).toEqual({
        ok: false,
        code: 'ai_truncated',
        outcome: 'failed',
        usage: { model: expect.any(String), inputTokens: 900, outputTokens: 32_000 },
      });
    }
  });
});

describe('what a failure costs', () => {
  it('a rate limit or an overload is ONE request and «no_answer»: never retried inside a leash it would outlive', async () => {
    // With the SDK's own retry a 429 that carries `retry-after` is slept through — uncapped, deaf to the
    // signal — and came back minutes later as OUR timeout: counted, cooled, «the paper is too large».
    for (const status of [429, 529, 500]) {
      api.script.push({ status });
      const before = api.calls();
      const started = Date.now();
      expect(await read(), String(status)).toEqual({ ok: false, code: 'ai_failed', outcome: 'no_answer' });
      expect(api.calls(), String(status)).toBe(before + 1);
      expect(Date.now() - started).toBeLessThan(2_000);
    }
  });

  it('a request the provider will not take: «ai_rejected» for a FILE, «ai_failed» for a spreadsheet’s text — neither counted', async () => {
    api.script.push({ status: 400 });
    expect(await read(pdf)).toEqual({ ok: false, code: 'ai_rejected', outcome: 'no_answer' });
    api.script.push({ status: 400 });
    expect(await read(sheet)).toEqual({ ok: false, code: 'ai_failed', outcome: 'no_answer' });
  });

  it('a provider that starts answering and goes SILENT is ended by our deadline: «ai_timeout», counted', async () => {
    api.script.push({ text: good, chunk: 4, paceMs: 20, abortAfterMs: 60 });
    const started = Date.now();
    expect(await read(pdf, 400)).toEqual({ ok: false, code: 'ai_timeout', outcome: 'failed' });
    // The leash, not the stand-in, ended it — and it was not waited on twice.
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('a connection that never opened — what the SDK itself calls a timeout — is NOT our deadline: not counted', async () => {
    // undici's own shape for a connect timeout; the SDK turns it into APIConnectionTimeoutError.
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: new Error('Connect Timeout Error (attempted address: api.anthropic.com:443, timeout: 10000ms)'),
      });
    });
    const started = Date.now();
    expect(await read(pdf, 5_000)).toEqual({ ok: false, code: 'ai_failed', outcome: 'no_answer' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a socket dropped mid-answer is not a timeout either', async () => {
    api.script.push({ text: good, chunk: 4, drop: true, afterChars: 12 });
    expect(await read(pdf, 5_000)).toEqual({ ok: false, code: 'ai_failed', outcome: 'no_answer' });
  });
});
