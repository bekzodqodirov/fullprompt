import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * `known_codes` over the wire (docs/IKKI-ESHIK.md §3.1): what the model is
 * SHOWN — the Excel's rows numbered, within `KNOWN_GOODS_CHARS` — and how its
 * answer comes back, against a local stand-in for the Messages API (the SDK
 * itself makes the call). A number the model was not shown is dropped, and a
 * shown number lands on the caller's own index.
 */
import { analyzeIntake } from '@/modules/wms/calc/intake-ai';

const bodies: { messages: { content: { type: string; text?: string }[] }[] }[] = [];
const answers: unknown[] = [];
let server: http.Server;
const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_stand_in',
          type: 'message',
          role: 'assistant',
          model: 'stand-in',
          content: [{ type: 'text', text: JSON.stringify(answers.shift() ?? {}) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
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
  bodies.length = 0;
  answers.length = 0;
});

const reading = (knownCodes: unknown) => ({
  from_city: null,
  to_city: null,
  weight_kg: null,
  weight_netto: false,
  volume_m3: null,
  goods: [],
  steps: [],
  known_codes: knownCodes,
});

const promptText = () =>
  bodies
    .at(-1)!
    .messages[0]!.content.filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

describe('the Excel’s rows, numbered, and the codes the model gives them', () => {
  it('a shown number lands on the caller’s index; a number past what was shown is dropped', async () => {
    // 120-character names: only about fifty fit `KNOWN_GOODS_CHARS`.
    const names = Array.from({ length: 80 }, (_, i) => `${String(i + 1).padStart(3, '0')} ${'Ж'.repeat(116)}`);
    // An empty name is never shown, so the shown numbers start at index 1.
    const knownGoods = ['  ', ...names];
    answers.push(
      reading([
        { n: 1, tnved_code: '6201930000' },
        { n: 3, tnved_code: '6403.99.0000' },
        { n: 79, tnved_code: '8528520000' },
      ]),
    );
    const out = await analyzeIntake({ section: 'rastamojka', text: 'x', fileCount: 1, knownGoods, codeKnown: true, timeoutMs: 10_000 });
    expect(out.ok).toBe(true);
    expect(out.ok && out.knownCodes).toEqual([
      { index: 1, code: '6201930000' },
      { index: 3, code: '6403990000' },
    ]);
    const prompt = promptText();
    expect(prompt).toContain(`1. ${names[0]}`);
    expect(prompt).toContain('known_codes');
    // The 79th row was not shown (the list stops near fifty and says how many more).
    expect(prompt).not.toContain(names[78]);
    expect(prompt).toMatch(/…и ещё \d+ строк этой таблицы/);
  });

  it('not asked → the list is today’s, and an answer’s codes are not taken', async () => {
    answers.push(reading([{ n: 1, tnved_code: '6201930000' }]));
    const out = await analyzeIntake({ section: 'rastamojka', text: 'x', fileCount: 1, knownGoods: ['Kurtka'], timeoutMs: 10_000 });
    expect(out.ok && out.knownCodes).toBeUndefined();
    expect(promptText()).toContain('- Kurtka');
    expect(promptText()).not.toContain('1. Kurtka');
    expect(promptText()).not.toContain('known_codes');
  });

  it('an answer from before the field, or with a broken entry, still reads — the codes are a proposal', async () => {
    const old: Record<string, unknown> = reading([]);
    delete old.known_codes;
    answers.push(old);
    const before = await analyzeIntake({ section: 'rastamojka', text: 'x', fileCount: 1, knownGoods: ['Kurtka'], codeKnown: true, timeoutMs: 10_000 });
    expect(before.ok).toBe(true);
    answers.push(reading([{ n: 'one', tnved_code: 6201930000 }, { n: 1, tnved_code: '6201930000' }]));
    const broken = await analyzeIntake({ section: 'rastamojka', text: 'x', fileCount: 1, knownGoods: ['Kurtka'], codeKnown: true, timeoutMs: 10_000 });
    expect(broken.ok && broken.knownCodes).toEqual([{ index: 0, code: '6201930000' }]);
  });
});
