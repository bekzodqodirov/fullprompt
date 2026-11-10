import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { goodJson, readingJson, startSseStandIn, type SseStandIn } from '../fixtures/sse-anthropic';

/**
 * The reading's codes must never cost the reading (docs/IKKI-ESHIK.md §3.1,
 * review PF-ADV-13): the AI door asks the model the Excel rows' codes inside
 * the same `INTAKE_MAX_TOKENS` as its thinking, and an answer cut at the cap
 * fails the WHOLE reading — totals, extra goods, steps. So a row with a code of
 * its own is listed and never asked, at most `KNOWN_CODES_MAX` rows are asked,
 * and an answer cut while the codes were asked — with no good completed — is
 * read once more without them. A cut that DID complete goods is the reading
 * (docs/FAYL-OQISH.md §3.3), never re-read.
 *
 * Re-anchored on the shared STREAMING stand-in (docs/FAYL-OQISH.md §3.2,
 * judge model-tests-reanchor): the reading is `messages.stream()`, and a stub
 * of the SDK's method would never run its abort or its event parsing.
 */
import { analyzeIntake, INTAKE_EFFORT, INTAKE_MAX_TOKENS, KNOWN_CODES_MAX } from '@/modules/wms/calc/intake-ai';

let api: SseStandIn;
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

const answer = (body: Record<string, unknown>) => ({ text: readingJson(body), usage: { input_tokens: 10, output_tokens: 20 } });
const cut = { stop: 'max_tokens' as const, text: '{"from_city": null, "goods": [', usage: { input_tokens: 10, output_tokens: 32_000 } };
/** The prompt text one call was shown. */
const promptOf = (call: number): string =>
  api.bodies[call]!.messages[0]!.content.filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

const base = { section: 'rastamojka' as const, text: 'invoice', fileCount: 1, codeKnown: true, salvage: true, timeoutMs: 10_000 };

describe('the codes asked of the model (PF-ADV-13)', () => {
  it('a row with its own code is listed, never numbered; a number names the row it was shown for', async () => {
    api.script.push(answer({ known_codes: [{ n: 1, tnved_code: '6203420000' }] }));
    const out = await analyzeIntake({ ...base, knownGoods: ['Kurtka', 'Shim', 'Sumka'], knownCoded: [true, false, false] });
    const prompt = promptOf(0);
    expect(prompt).toContain('- Kurtka\n1. Shim\n2. Sumka');
    expect(out.ok && out.knownCodes).toEqual([{ index: 1, code: '6203420000' }]);
  });

  it(`at most ${KNOWN_CODES_MAX} rows are asked; the rest are listed`, async () => {
    api.script.push(answer({}));
    const names = Array.from({ length: 60 }, (_, i) => `Tovar ${i + 1}`);
    await analyzeIntake({ ...base, knownGoods: names });
    const prompt = promptOf(0);
    expect(prompt).toContain(`${KNOWN_CODES_MAX}. Tovar ${KNOWN_CODES_MAX}\n- Tovar ${KNOWN_CODES_MAX + 1}`);
    expect(prompt).not.toContain(`${KNOWN_CODES_MAX + 1}. `);
  });

  it('an answer cut at the cap while the codes were asked, with no good completed, is read once more without them — both billed', async () => {
    api.script.push(cut, answer({ weight_kg: 3500, steps: ['o‘qildi'] }));
    const out = await analyzeIntake({ ...base, knownGoods: ['Kurtka', 'Shim'] });
    expect(api.bodies).toHaveLength(2);
    expect(promptOf(0)).toContain('1. Kurtka');
    expect(promptOf(1)).not.toContain('1. Kurtka');
    expect(promptOf(1)).toContain('- Kurtka');
    expect(out).toMatchObject({ ok: true, facts: { weightKg: 3500 } });
    expect(out.answered).toHaveLength(2);
  });

  it('a cut answer with no codes asked stays the reading’s failure, billed once', async () => {
    api.script.push(cut);
    const out = await analyzeIntake({ ...base, codeKnown: false, knownGoods: ['Kurtka'] });
    expect(api.bodies).toHaveLength(1);
    expect(out).toMatchObject({ ok: false, failure: 'truncated' });
    expect(out.answered).toHaveLength(1);
  });

  it('a size cut that COMPLETED goods is the reading — kept, never re-read, its codes dropped (docs/FAYL-OQISH.md §3.3)', async () => {
    const text = readingJson({
      weight_kg: 900,
      goods: [goodJson('Kurtka', { quantity: 300 }), goodJson('Shim', { quantity: 200 })],
      known_codes: [{ n: 1, tnved_code: '6201930000' }],
    });
    // Cut inside a third good: two closed, the third begun.
    const partial = `${text.slice(0, text.indexOf(']'))},{"name":"Sumka","quantity":4`;
    api.script.push({ stop: 'max_tokens', text: partial, usage: { input_tokens: 10, output_tokens: INTAKE_MAX_TOKENS } });
    const out = await analyzeIntake({ ...base, knownGoods: ['Kurtka', 'Shim'] });
    expect(api.bodies).toHaveLength(1);
    expect(out).toMatchObject({ ok: true, cut: { goods: 2, why: 'size' }, facts: { weightKg: 900 } });
    expect(out.ok && out.facts.goods?.map((g) => g.name)).toEqual(['Kurtka', 'Shim']);
    expect(out.ok && out.knownCodes).toBeUndefined();
    expect(out.answered).toHaveLength(1);
  });
});

describe('what the call asks for (docs/FAYL-OQISH.md §3.1-§3.2)', () => {
  it('a stream at effort medium, the json_schema format passed through, 32 000 tokens', async () => {
    api.script.push(answer({}));
    await analyzeIntake({ ...base, knownGoods: ['Kurtka'] });
    const body = api.bodies[0] as unknown as { stream?: boolean; max_tokens: number; output_config: { effort: string; format: { type: string } } };
    expect(INTAKE_EFFORT).toBe('medium');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(32_000);
    expect(body.output_config.effort).toBe('medium');
    expect(body.output_config.format.type).toBe('json_schema');
  });
});
