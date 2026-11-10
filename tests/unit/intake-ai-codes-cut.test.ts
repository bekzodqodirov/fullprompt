import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The reading's codes must never cost the reading (docs/IKKI-ESHIK.md §3.1,
 * review PF-ADV-13): the AI door asks the model the Excel rows' codes inside
 * the same `INTAKE_MAX_TOKENS` as its thinking, and an answer cut at the cap
 * fails the WHOLE reading — totals, extra goods, steps. So a row with a code of
 * its own is listed and never asked, at most `KNOWN_CODES_MAX` rows are asked,
 * and an answer cut while the codes were asked is read once more without
 * them. The SDK is a stand-in that records what each call was shown.
 */
const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@anthropic-ai/sdk', async (importOriginal) => {
  const real = await importOriginal<typeof import('@anthropic-ai/sdk')>();
  class Stand extends real.default {
    constructor(opts: ConstructorParameters<typeof real.default>[0]) {
      super({ ...opts, apiKey: 'test-key' });
      (this as unknown as { messages: unknown }).messages = { create: sdk.create };
    }
  }
  return { ...real, default: Stand };
});

import { analyzeIntake, KNOWN_CODES_MAX } from '@/modules/wms/calc/intake-ai';

const answer = (body: Record<string, unknown>) => ({
  stop_reason: 'end_turn',
  content: [
    {
      type: 'text',
      text: JSON.stringify({ from_city: null, to_city: null, weight_kg: null, weight_netto: null, volume_m3: null, goods: [], steps: [], known_codes: [], ...body }),
    },
  ],
  usage: { input_tokens: 10, output_tokens: 20 },
});
const cut = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"from_city": null, "goods": [' }], usage: { input_tokens: 10, output_tokens: 16_000 } };
/** The prompt text one call was shown. */
const promptOf = (call: number): string =>
  (sdk.create.mock.calls[call]![0] as { messages: { content: { type: string; text?: string }[] }[] }).messages[0]!.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

const saved = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  sdk.create.mockReset();
});
afterEach(() => {
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

const base = { section: 'rastamojka' as const, text: 'invoice', fileCount: 1, codeKnown: true };

describe('the codes asked of the model (PF-ADV-13)', () => {
  it('a row with its own code is listed, never numbered; a number names the row it was shown for', async () => {
    sdk.create.mockResolvedValueOnce(answer({ known_codes: [{ n: 1, tnved_code: '6203420000' }] }));
    const out = await analyzeIntake({ ...base, knownGoods: ['Kurtka', 'Shim', 'Sumka'], knownCoded: [true, false, false] });
    const prompt = promptOf(0);
    expect(prompt).toContain('- Kurtka\n1. Shim\n2. Sumka');
    expect(out.ok && out.knownCodes).toEqual([{ index: 1, code: '6203420000' }]);
  });

  it(`at most ${KNOWN_CODES_MAX} rows are asked; the rest are listed`, async () => {
    sdk.create.mockResolvedValueOnce(answer({}));
    const names = Array.from({ length: 60 }, (_, i) => `Tovar ${i + 1}`);
    await analyzeIntake({ ...base, knownGoods: names });
    const prompt = promptOf(0);
    expect(prompt).toContain(`${KNOWN_CODES_MAX}. Tovar ${KNOWN_CODES_MAX}\n- Tovar ${KNOWN_CODES_MAX + 1}`);
    expect(prompt).not.toContain(`${KNOWN_CODES_MAX + 1}. `);
  });

  it('an answer cut at the cap while the codes were asked is read once more without them — both billed', async () => {
    sdk.create.mockResolvedValueOnce(cut).mockResolvedValueOnce(answer({ weight_kg: 3500, steps: ['o‘qildi'] }));
    const out = await analyzeIntake({ ...base, knownGoods: ['Kurtka', 'Shim'] });
    expect(sdk.create).toHaveBeenCalledTimes(2);
    expect(promptOf(0)).toContain('1. Kurtka');
    expect(promptOf(1)).not.toContain('1. Kurtka');
    expect(promptOf(1)).toContain('- Kurtka');
    expect(out).toMatchObject({ ok: true, facts: { weightKg: 3500 } });
    expect(out.answered).toHaveLength(2);
  });

  it('a cut answer with no codes asked stays the reading’s failure, billed once', async () => {
    sdk.create.mockResolvedValueOnce(cut);
    const out = await analyzeIntake({ ...base, codeKnown: false, knownGoods: ['Kurtka'] });
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: false, failure: 'truncated' });
    expect(out.answered).toHaveLength(1);
  });
});
