import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { analyzeIntake } from '@/modules/wms/calc/intake-ai';

/**
 * What a reading BILLS (his 2.9 c, docs/SAKKIZ-R2.md §8.2.7): every attempt
 * the model ANSWERED, whatever was made of the answer — and nothing for an
 * attempt it never answered. Against a local stand-in for the Messages API,
 * so the SDK makes the calls and the shape measured is the one the collector
 * appends and the landing writes.
 */
type Scripted = { status: number; body?: unknown };
const script: Scripted[] = [];
/** What the SDK actually sent, request by request. */
const sent: string[] = [];
let calls = 0;
let server: http.Server;
const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };

const message = (stop: string, text: string, usage: { input_tokens: number; output_tokens: number }) => ({
  id: 'msg_stand_in',
  type: 'message',
  role: 'assistant',
  model: 'stand-in',
  content: [{ type: 'text', text }],
  stop_reason: stop,
  stop_sequence: null,
  usage,
});
const READING = JSON.stringify({
  from_city: null,
  to_city: null,
  weight_kg: 150,
  volume_m3: null,
  goods: [],
  steps: [],
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      calls += 1;
      sent.push(body);
      const next = script.shift() ?? { status: 400 };
      res.writeHead(next.status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          next.body ?? { type: 'error', error: { type: next.status === 529 ? 'overloaded_error' : 'invalid_request_error', message: 'stand-in' } },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.key;
  if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = saved.url;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  script.length = 0;
  sent.length = 0;
  calls = 0;
});

const read = () => analyzeIntake({ section: 'yolkira', text: 'Kurtka 300 dona', fileCount: 0, timeoutMs: 20_000 });

describe('the reading names every attempt the model answered', () => {
  it('a reading that came back is billed', async () => {
    script.push({ status: 200, body: message('end_turn', READING, { input_tokens: 900, output_tokens: 120 }) });
    const out = await read();
    expect(out.ok).toBe(true);
    expect(out.answered).toEqual([{ model: expect.any(String), inputTokens: 900, outputTokens: 120 }]);
  });

  it('a reading cut short is billed too — the model answered it', async () => {
    script.push({ status: 200, body: message('max_tokens', '{"goods":', { input_tokens: 40_000, output_tokens: 16_000 }) });
    const out = await read();
    expect(out).toMatchObject({ ok: false, failure: 'truncated' });
    expect(out.answered).toEqual([{ model: expect.any(String), inputTokens: 40_000, outputTokens: 16_000 }]);
  });

  it('an attempt nobody answered is not billed — the retry that WAS answered is', async () => {
    script.push(
      { status: 529 },
      { status: 200, body: message('end_turn', READING, { input_tokens: 700, output_tokens: 90 }) },
    );
    const out = await read();
    expect(calls).toBe(2);
    expect(out.answered).toEqual([{ model: expect.any(String), inputTokens: 700, outputTokens: 90 }]);
  });

  it('a reading nobody answered bills nothing at all', async () => {
    script.push({ status: 529 }, { status: 529 });
    const out = await read();
    expect(out).toMatchObject({ ok: false, failure: 'overloaded' });
    expect(out.answered ?? []).toEqual([]);
  });
});

describe('what the reading is told about a netto-only total (review P3-R3)', () => {
  /** The text the model is handed beside the material, for one section. */
  async function told(section: 'yolkira' | 'rastamojka' | 'podklyuch') {
    script.push({ status: 200, body: message('end_turn', READING, { input_tokens: 10, output_tokens: 10 }) });
    await analyzeIntake({ section, text: 'Kurtka 300 dona, N.W. 450 kg', fileCount: 0, timeoutMs: 20_000 });
    const request = JSON.parse(sent.at(-1)!) as {
      system: unknown;
      messages: { content: { type: string; text?: string }[] }[];
    };
    const text = request.messages[0]!.content.find((c) => c.type === 'text')!.text!;
    return { system: JSON.stringify(request.system), text };
  }

  it('a freight section leaves it null — the bot asks the brutto there', async () => {
    for (const section of ['yolkira', 'podklyuch'] as const) {
      const { text } = await told(section);
      expect(text, section).toContain('Только нетто: общий вес null — сотрудник спросит брутто.');
    }
  });

  it('a customs job keeps the netto as its total, and says so — nobody will ask it there', async () => {
    const { system, text } = await told('rastamojka');
    expect(text).toContain('Только нетто: возьми нетто как общий вес');
    expect(text).toContain('Umumiy og‘irlik faqat netto');
    expect(text).not.toContain('сотрудник спросит брутто');
    // …and the shared instruction promises no question to every section.
    expect(system).not.toContain('сотрудник спросит брутто');
  });
});
