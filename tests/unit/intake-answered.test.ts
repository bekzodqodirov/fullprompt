import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { analyzeIntake } from '@/modules/wms/calc/intake-ai';
import { goodJson, readingJson, startSseStandIn, type SseStandIn } from '../fixtures/sse-anthropic';

/**
 * What a reading BILLS (his 2.9 c, docs/SAKKIZ-R2.md §8.2.7): every attempt
 * the model ANSWERED, whatever was made of the answer — and nothing for an
 * attempt it never answered. Against the shared STREAMING stand-in for the
 * Messages API (re-anchored, docs/FAYL-OQISH.md §3.2), so the SDK makes the
 * calls and parses the events, and the shape measured is the one the
 * collector appends and the landing writes. Since the stream, «answered» is
 * «received `message_start`»: a cut, an abort and a drop are billed too
 * (§3.3, judge model-cut-unbilled).
 */
let api: SseStandIn;
/** What the SDK actually sent, request by request. */
const sent = () => api.bodies.map((b) => JSON.stringify(b));
const script = { push: (...r: Parameters<SseStandIn['script']['push']>) => api.script.push(...r) };
const READING = readingJson({ weight_kg: 150 });

beforeAll(async () => {
  api = await startSseStandIn();
});

afterAll(async () => {
  await api.close();
});

beforeEach(() => {
  api.script.length = 0;
  api.bodies.length = 0;
});

const read = (timeoutMs = 20_000) => analyzeIntake({ section: 'yolkira', text: 'Kurtka 300 dona', fileCount: 0, timeoutMs, salvage: true });

describe('the reading names every attempt the model answered', () => {
  it('a reading that came back is billed', async () => {
    script.push({ text: READING, usage: { input_tokens: 900, output_tokens: 120 } });
    const before = Date.now();
    const out = await read();
    expect(out.ok).toBe(true);
    // Re-anchored (judge concurrency-11): each bill says WHEN the model
    // answered, so the landing writes it on the day it was spent.
    expect(out.answered).toEqual([{ model: expect.any(String), inputTokens: 900, outputTokens: 120, at: expect.any(Number) }]);
    expect(out.answered![0]!.at).toBeGreaterThanOrEqual(before);
    expect(out.answered![0]!.at).toBeLessThanOrEqual(Date.now());
  });

  it('a reading cut short is billed too — the model answered it', async () => {
    script.push({ stop: 'max_tokens', text: '{"goods":', usage: { input_tokens: 40_000, output_tokens: 16_000 } });
    const out = await read();
    expect(out).toMatchObject({ ok: false, failure: 'truncated' });
    expect(out.answered).toEqual([{ model: expect.any(String), inputTokens: 40_000, outputTokens: 16_000, at: expect.any(Number) }]);
  });

  it('an attempt nobody answered is not billed — the retry that WAS answered is', async () => {
    script.push({ status: 529 }, { text: READING, usage: { input_tokens: 700, output_tokens: 90 } });
    const out = await read();
    expect(api.bodies).toHaveLength(2);
    expect(out.answered).toEqual([{ model: expect.any(String), inputTokens: 700, outputTokens: 90, at: expect.any(Number) }]);
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
    script.push({ text: READING, usage: { input_tokens: 10, output_tokens: 10 } });
    await analyzeIntake({ section, text: 'Kurtka 300 dona, N.W. 450 kg', fileCount: 0, timeoutMs: 20_000, salvage: true });
    const request = JSON.parse(sent().at(-1)!) as {
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

describe('a reading the STREAM ended early keeps what it completed, and is billed (docs/FAYL-OQISH.md §3.2-§3.3)', () => {
  const two = readingJson({
    weight_kg: 900,
    goods: [goodJson('Kurtka {ayollar}', { quantity: 300, weight_kg: 150 }), goodJson('Shim "classic"', { quantity: 200 })],
    steps: ['o‘qildi'],
  });
  /** The text up to the second good's closing brace — and the third good begun. */
  const throughSecond = `${two.slice(0, two.indexOf(']'))},{"name":"Sumka","quantity":4`;

  it('the caller’s clock aborts a stream gone silent — within the leash plus a second, the goods it completed kept', async () => {
    // Every delta is written in ~0.1 s, then nothing: no final message, ever.
    script.push({ text: throughSecond, chunk: 40, paceMs: 10, abortAfterMs: 500, usage: { input_tokens: 777, output_tokens: 1 } });
    const started = Date.now();
    const out = await read(1_500);
    const took = Date.now() - started;
    expect(took).toBeLessThan(1_500 + 1_000);
    expect(out).toMatchObject({ ok: true, cut: { goods: 2, why: 'clock' }, facts: { weightKg: 900 } });
    expect(out.ok && out.facts.goods?.map((g) => g.name)).toEqual(['Kurtka {ayollar}', 'Shim "classic"']);
    // Billed though no final message exists: the input from `message_start`,
    // the output an estimate from what was streamed.
    expect(out.answered).toHaveLength(1);
    expect(out.answered![0]!.inputTokens).toBe(777);
    expect(out.answered![0]!.outputTokens).toBe(Math.ceil(throughSecond.length / 3));
  });

  it('the thread door’s leash too — and a cut is NOT kept when the caller said so (§3.6): today’s «timeout», «truncated»', async () => {
    // Two goods completed, then silence: kept for the bot, not for the
    // thread door, whose preview has no word for a partial list.
    script.push({ text: throughSecond, chunk: 40, paceMs: 10, abortAfterMs: 500 });
    const started = Date.now();
    const out = await analyzeIntake({ section: 'yolkira', text: 'x', fileCount: 0, timeoutMs: 2_000, salvage: false });
    expect(Date.now() - started).toBeLessThan(2_000 + 1_000);
    expect(out).toEqual({ ok: false, failure: 'timeout', answered: [expect.objectContaining({ inputTokens: 10 })] });
    script.push({ stop: 'max_tokens', text: throughSecond });
    const size = await analyzeIntake({ section: 'yolkira', text: 'x', fileCount: 0, timeoutMs: 2_000, salvage: false });
    expect(size).toMatchObject({ ok: false, failure: 'truncated' });
  });

  it('a stream gone silent right after `message_start` completed nothing: «timeout», billed by the input it said it read', async () => {
    // `abortAfterMs: 0` — no delta is ever written (review
    // model-spec-fixture-abortafter-unused: the value was read nowhere, so
    // every «silent» stream had sent all its text first).
    script.push({ text: throughSecond, chunk: 40, paceMs: 10, abortAfterMs: 0, usage: { input_tokens: 55, output_tokens: 1 } });
    const out = await read(1_000);
    expect(out).toEqual({ ok: false, failure: 'timeout', answered: [expect.objectContaining({ inputTokens: 55, outputTokens: 0 })] });
  });

  it('the caller’s clock aborts a stream STILL DRIPPING past it — the body has no deadline of its own (judge model-leash-unbounded)', async () => {
    // Forty goods at twenty characters every 50 ms: ~13 s of answer, still
    // arriving when the 1 s leash fires. Only the goods whole by then are kept.
    const forty = Array.from({ length: 40 }, (_, i) => goodJson(`Tovar ${i + 1}`, { quantity: i + 1 }));
    const long = readingJson({ goods: forty });
    script.push({ text: long, chunk: 20, paceMs: 50 });
    const started = Date.now();
    const out = await read(1_000);
    expect(Date.now() - started).toBeLessThan(1_000 + 1_000);
    expect(out).toMatchObject({ ok: true, cut: { why: 'clock' } });
    const names = out.ok ? (out.facts.goods ?? []).map((g) => g.name) : [];
    expect(names.length).toBeGreaterThanOrEqual(1);
    expect(names.length).toBeLessThan(40);
    expect(names).toEqual(forty.slice(0, names.length).map((g) => g.name));
    expect(out.ok && out.cut?.goods).toBe(names.length);
  });

  it('a mid-stream `event: error` overload with goods completed is a «dropped» cut, never «rejected»', async () => {
    script.push({ text: throughSecond, errorType: 'overloaded_error' });
    const out = await read();
    expect(out).toMatchObject({ ok: true, cut: { goods: 2, why: 'dropped' } });
    expect(api.bodies).toHaveLength(1);
    expect(out.answered).toHaveLength(1);
  });

  it('a mid-stream overload with NOTHING completed is «overloaded» and read once more — both attempts billed', async () => {
    script.push({ text: '{"from_city":null,"goods":[{"na', errorType: 'overloaded_error' }, { text: READING, usage: { input_tokens: 5, output_tokens: 6 } });
    const out = await read();
    expect(api.bodies).toHaveLength(2);
    expect(out).toMatchObject({ ok: true, facts: { weightKg: 150 } });
    expect(out.answered).toHaveLength(2);
  });

  it('a socket dropped mid-body with goods completed is kept; with none it is «network»', async () => {
    script.push({ text: throughSecond, drop: true });
    const kept = await read();
    expect(kept).toMatchObject({ ok: true, cut: { goods: 2, why: 'dropped' } });
    script.push({ text: '{"goods":[', drop: true }, { text: '{"goods":[', drop: true });
    const lost = await read();
    expect(lost).toMatchObject({ ok: false, failure: 'network' });
    expect(lost.answered).toHaveLength(2);
  });

  it('a refusal is never salvaged', async () => {
    script.push({ stop: 'refusal', text: throughSecond });
    const out = await read();
    expect(out).toMatchObject({ ok: false, failure: 'refused' });
  });
});
