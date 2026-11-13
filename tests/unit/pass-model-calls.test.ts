import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pass's two model calls (docs/AI-SORAYDI.md §3.4 A12, PR-9): the
 * grouping that codes the uncoded rows and the pick that chooses a row's
 * declaration. What they SEND and what they make of an answer that is not one.
 *
 * The SDK's `messages.create` is the one thing replaced (grouping-count's
 * idiom): it records the request body the real code built and answers
 * whatever the case scripts — the shape a response carries, `stop_details`
 * and the thinking count among it. Everything that decides what a failure
 * IS — the listing, the branches, the log lines — is the production code.
 * The real API is never called.
 */
const model = vi.hoisted(() => ({
  next: null as null | (() => unknown),
  bodies: [] as Record<string, unknown>[],
}));
vi.mock('@anthropic-ai/sdk', async (original) => {
  const real = await original<typeof import('@anthropic-ai/sdk')>();
  class Scripted extends real.default {
    constructor(opts?: ConstructorParameters<typeof real.default>[0]) {
      super({ ...opts, apiKey: 'test-key' });
      (this as unknown as { messages: unknown }).messages = {
        create: async (body: Record<string, unknown>) => {
          model.bodies.push(body);
          return model.next!();
        },
      };
    }
  }
  return { ...real, default: Scripted };
});

import { logger } from '@/modules/platform/logger';
import { PICK_EFFORT, PICK_MAX_TOKENS, pickImportRows, type PickRequest } from '@/modules/wms/calc/prefill-ai';
import { GROUPING_EFFORT, GROUPING_MAX_TOKENS, listingNote, proposeGoodsGrouping } from '@/modules/wms/tnved/service';
import type { ImportBazaRow } from '@/modules/wms/customs/import-baza';

const keyBefore = process.env.ANTHROPIC_API_KEY;
beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
});
afterAll(() => {
  if (keyBefore === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = keyBefore;
});
let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  model.bodies.length = 0;
  model.next = null;
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  info.mockRestore();
});

/** A response as the SDK hands it back, with the fields a real one carries. */
const answered = (
  stop: string,
  text: string,
  extra: { details?: { type: 'refusal'; category: string | null; explanation: string | null }; thinking?: number } = {},
) => () => ({
  stop_reason: stop,
  stop_details: extra.details ?? null,
  usage: {
    input_tokens: 900,
    output_tokens: 16_000,
    output_tokens_details: extra.thinking === undefined ? null : { thinking_tokens: extra.thinking },
  },
  content: text ? [{ type: 'text', text }] : [],
});

const candidate = (over: Partial<ImportBazaRow> = {}): ImportBazaRow => ({
  id: 'row-0',
  tnvedCode: '9401310000',
  name: 'Кресло офисное вращающееся',
  unit: 'kg',
  basis: 'kg',
  pricePerUnitUsd: 2,
  weightPerUnitKg: 12.5,
  declaredAt: null,
  sender: null,
  originCountry: '156-КИТАЙ',
  nameSim: 0.5,
  score: 0.5,
  unitMatches: true,
  ...over,
});

const chair = (over: Partial<PickRequest> = {}): PickRequest => ({
  seq: 1,
  name: 'Стул офисный',
  tnvedCode: '9401310000',
  note: null,
  candidates: [candidate()],
  ...over,
});

/** The user turn the pick sent, as text. */
const listingSent = () => {
  const body = model.bodies[0] as { messages: { content: string }[] };
  return body.messages[0]!.content;
};

/** Every log call's object whose message is `msg`. */
const logged = (spy: ReturnType<typeof vi.spyOn>, msg: string) =>
  spy.mock.calls.filter((c: unknown[]) => c[1] === msg).map((c: unknown[]) => c[0] as Record<string, unknown>);

describe('the pick: room, effort, and the note the grouping already reads', () => {
  it('asks with 16 000 tokens of room and an explicit effort — never the model’s defaults', async () => {
    model.next = answered('end_turn', JSON.stringify({ picks: [{ row: 1, candidate: 0, reason: 'xuddi shu stul' }] }));
    await pickImportRows([chair()]);
    const body = model.bodies[0] as { max_tokens: number; output_config: { effort: string; format: { type: string } } };
    // A12's figures, written by hand: 16 000 tokens, effort «medium».
    expect(body.max_tokens).toBe(16_000);
    expect(body.output_config.effort).toBe('medium');
    expect(PICK_MAX_TOKENS).toBe(16_000);
    expect(PICK_EFFORT).toBe('medium');
    // The structured output is still the answer's shape.
    expect(body.output_config.format.type).toBe('json_schema');
  });

  it('the listing carries the row’s note as «прим.: …», as the grouping’s does', async () => {
    model.next = answered('end_turn', JSON.stringify({ picks: [] }));
    await pickImportRows([
      chair({ note: 'rasmda: qora ofis stuli,\nmetall oyoq, gaz-lift' }),
      chair({ seq: 2, name: 'Stol', tnvedCode: '9403100000', note: null, candidates: [candidate({ id: 'row-1' })] }),
    ]);
    const lines = listingSent().split('\n');
    // Row 1: its note on the head line, the note's own newline flattened.
    expect(lines[0]).toBe('Строка 1: «Стул офисный» (код 9401310000) — прим.: rasmda: qora ofis stuli, metall oyoq, gaz-lift');
    // Row 2 has none: its head line ends at the code, as before.
    expect(lines).toContain('Строка 2: «Stol» (код 9403100000)');
  });

  it('a long note is cut where the grouping cuts it — 120 characters and «…»', async () => {
    model.next = answered('end_turn', JSON.stringify({ picks: [] }));
    const note = `${'a'.repeat(100)} ${'b'.repeat(100)}`;
    await pickImportRows([chair({ note })]);
    // 100 a's, the space, 19 b's = 120 characters, then the ellipsis.
    expect(listingSent().split('\n')[0]).toBe(
      `Строка 1: «Стул офисный» (код 9401310000) — прим.: ${'a'.repeat(100)} ${'b'.repeat(19)}…`,
    );
    // ONE rendering for both calls.
    expect(listingNote(note)).toBe(`прим.: ${'a'.repeat(100)} ${'b'.repeat(19)}…`);
    expect(listingNote('  \n ')).toBeNull();
  });
});

describe('the pick: an answer that is not one is NAMED (A12)', () => {
  it('cut at max_tokens: no answers, `cut`, the usage billed — and the log line says the cut', async () => {
    model.next = answered('max_tokens', '{"picks": [{"row": 1, "candidate"', { thinking: 15_200 });
    const out = await pickImportRows([chair()]);
    expect(out.answers).toBeNull();
    expect(out.failed).toBe('cut');
    expect(out.usage).toMatchObject({ inputTokens: 900, outputTokens: 16_000 });
    const [cut] = logged(warn, '[calc-prefill pick] answer cut at max_tokens');
    expect(cut, 'the cut is named in its own words').toBeDefined();
    // The thinking and the stop ride the line — the 4096 trap's own evidence.
    expect(cut).toMatchObject({ stop: 'max_tokens', thinking: 15_200, out: 16_000, rows: 1 });
  });

  it('a refusal: `refused`, and its policy category is in the log (`stop_details`)', async () => {
    model.next = answered('refusal', '', {
      details: { type: 'refusal', category: 'reasoning_extraction', explanation: 'stand-in' },
    });
    const out = await pickImportRows([chair()]);
    expect(out.answers).toBeNull();
    expect(out.failed).toBe('refused');
    const [line] = logged(warn, '[calc-prefill pick] refused');
    expect(line).toMatchObject({ stop: 'refusal', details: { category: 'reasoning_extraction', explanation: 'stand-in' } });
    // …and every answered call leaves its token line too, refusal or not.
    expect(logged(info, '[calc-prefill pick] model tokens')).toHaveLength(1);
  });

  it('an answer that is not the schema: `unreadable`, billed', async () => {
    model.next = answered('end_turn', 'bu JSON emas');
    const out = await pickImportRows([chair()]);
    expect(out.failed).toBe('unreadable');
    expect(out.usage).not.toBeNull();
  });

  it('no answer at all (the network): `no_answer`, nothing billed', async () => {
    model.next = () => {
      throw new Error('socket hang up');
    };
    const out = await pickImportRows([chair()]);
    expect(out).toEqual({ answers: null, usage: null, failed: 'no_answer' });
  });

  it('an answer that IS one says nothing failed; no key and nothing to ask make no call and name no failure', async () => {
    model.next = answered('end_turn', JSON.stringify({ picks: [{ row: 1, candidate: 0, reason: 'shu' }] }));
    const ok = await pickImportRows([chair()]);
    expect(ok.answers).toEqual([{ seq: 1, candidate: 0, reason: 'shu' }]);
    expect(ok.failed).toBeUndefined();
    expect(await pickImportRows([chair({ candidates: [] })])).toEqual({ answers: [], usage: null });
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(await pickImportRows([chair()])).toEqual({ answers: null, usage: null });
    } finally {
      process.env.ANTHROPIC_API_KEY = 'test-key';
    }
    expect(model.bodies).toHaveLength(1);
  });
});

describe('the grouping: room, effort, and the stop in the log (A12)', () => {
  const goods = [{ name: 'Zapchast XJ-200', quantity: null, unit: null, weightKg: 5, volumeM3: null, measure: null, note: null }];

  it('asks with 16 000 tokens of room and an explicit effort', async () => {
    model.next = answered(
      'end_turn',
      JSON.stringify({
        groups: [
          { tnved_code: '8708309109', name_ru: 'Детали тормозов', item_indexes: [0], confidence: 'medium', reasoning: 'x', duty_rate_pct: null },
        ],
      }),
    );
    await proposeGoodsGrouping(goods);
    const body = model.bodies[0] as { max_tokens: number; output_config: { effort: string } };
    // A12's figures, by hand: 16 000 (it was 8 192), effort «medium».
    expect(body.max_tokens).toBe(16_000);
    expect(body.output_config.effort).toBe('medium');
    expect(GROUPING_MAX_TOKENS).toBe(16_000);
    expect(GROUPING_EFFORT).toBe('medium');
    expect(logged(info, '[tnved] grouping')[0]).toMatchObject({ stop: 'end_turn', goods: 1 });
  });

  it('cut at max_tokens: `ai_failed` with the usage, and the cut named with its thinking', async () => {
    model.next = answered('max_tokens', '{"groups": [{"tnved_code": "8708', { thinking: 14_900 });
    await expect(proposeGoodsGrouping(goods)).rejects.toMatchObject({ code: 'ai_failed', usage: { inputTokens: 900, outputTokens: 16_000 } });
    const [cut] = logged(warn, '[tnved] grouping cut at max_tokens');
    expect(cut).toMatchObject({ stop: 'max_tokens', thinking: 14_900 });
  });

  it('a refusal names its category', async () => {
    model.next = answered('refusal', '', { details: { type: 'refusal', category: 'reasoning_extraction', explanation: null } });
    await expect(proposeGoodsGrouping(goods)).rejects.toMatchObject({ code: 'ai_failed' });
    expect(logged(warn, '[tnved] grouping refused')[0]).toMatchObject({ details: { category: 'reasoning_extraction', explanation: null } });
  });
});
