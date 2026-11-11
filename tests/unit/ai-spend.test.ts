import { describe, expect, it } from 'vitest';
import { ANALYST_MODEL, STAFF_MODEL } from '@/modules/platform/ai/model';
import { aiSpendWindow, spendOf, type SpendGroup } from '@/modules/wms/reports/ai-spend';
import { aiLine, ownerSummaryText, summaryQuiet, type SummaryFacts } from '@/modules/wms/reports/owner-summary-text';

/**
 * «🤖 AI» on the evening summary (the owner's «8 ha», 2026-11-11;
 * docs/PRIXOD-XABARI.md §B): the pricing, the window and the WORDS — every
 * figure below is typed here, never computed by the code under test (#1116).
 *
 * The three ledgers against real rows are the integration file's.
 */

const group = (over: Partial<SpendGroup>): SpendGroup => ({
  model: STAFF_MODEL,
  calls: 0,
  frozenUsd: 0,
  unrecorded: 0,
  tokenCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});
const plain = (text: string | null) => (text ?? '').replace(/ /g, ' ');

describe('pricing a ledger', () => {
  it('tokens at the list price of their own model — the cache at its own two prices', () => {
    // Sonnet 5: $2 in · $10 out · $0.20 cache hit · $2.50 cache write, per million.
    expect(
      spendOf([group({ calls: 3, tokenCalls: 3, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 400_000 })]),
    ).toEqual({ calls: 3, usd: 4.4, unpriced: 0 }); // 2 + 1 + 0.4 + 1
    // Opus 5: $5 in · $25 out.
    expect(spendOf([group({ model: ANALYST_MODEL, calls: 1, tokenCalls: 1, inputTokens: 200_000, outputTokens: 40_000 })])).toEqual({
      calls: 1,
      usd: 2,
      unpriced: 0,
    });
  });

  it('dollars frozen on the row are summed as they stand, never re-priced', () => {
    expect(spendOf([group({ model: 'a-model-nobody-prices', calls: 4, frozenUsd: 0.123456 })])).toEqual({ calls: 4, usd: 0.12, unpriced: 0 });
  });

  it('a model with no list price is COUNTED and said — never a $0 in the sum', () => {
    expect(
      spendOf([
        group({ calls: 2, tokenCalls: 2, inputTokens: 500_000 }),
        group({ model: 'claude-retired-1', calls: 5, tokenCalls: 5, inputTokens: 9_000_000 }),
        group({ model: null, calls: 1, tokenCalls: 1, inputTokens: 10 }),
      ]),
    ).toEqual({ calls: 8, usd: 1, unpriced: 6 });
  });

  it('a request whose usage was never recorded is unpriced whatever its model', () => {
    expect(spendOf([group({ calls: 7, unrecorded: 3, tokenCalls: 4, inputTokens: 1_000_000 })])).toEqual({ calls: 7, usd: 2, unpriced: 3 });
  });
});

describe('the window', () => {
  const now = new Date('2026-11-11T15:00:07Z'); // 20:00:07 in Tashkent

  it('the daily message and the pull: the last 24 hours to the moment of reading', () => {
    // Not «today»: a Tashkent-day window would never show 20:00-24:00 in any
    // daily message — the hours the AI sotuvchi answers customers in.
    expect(aiSpendWindow({ weekly: false, from: '2026-11-11', to: '2026-11-11', now })).toEqual({
      from: new Date('2026-11-10T15:00:07Z'),
      to: now,
    });
  });

  it('Monday: the closed week, whole Tashkent days — the midnight after its Sunday', () => {
    expect(aiSpendWindow({ weekly: true, from: '2026-11-02', to: '2026-11-08', now })).toEqual({
      from: new Date('2026-11-01T19:00:00Z'),
      to: new Date('2026-11-08T19:00:00Z'),
    });
  });
});

describe('the line', () => {
  const ai = (over: Partial<NonNullable<SummaryFacts['ai']>> = {}) => ({ usd: 4.2, calls: 132, unpriced: 0, unread: [] as string[], ...over });

  it('the ordinary evening', () => {
    expect(plain(aiLine(ai(), false))).toBe('🤖 AI (oxirgi 24 soat): ≈ $4.20 · 132 murojaat');
    expect(plain(aiLine(ai({ usd: 31.5, calls: 1204 }), true))).toBe('🤖 AI (hafta): ≈ $31.50 · 1 204 murojaat');
  });

  it('some requests could not be priced: said beside the count', () => {
    expect(plain(aiLine(ai({ unpriced: 5 }), false))).toBe('🤖 AI (oxirgi 24 soat): ≈ $4.20 · 132 murojaat (5 tasining narxi noma’lum)');
  });

  it('nothing could be priced: the count, and NO dollar figure — never a $0 for an unknown', () => {
    const line = plain(aiLine(ai({ usd: 0, calls: 5, unpriced: 5 }), false));
    expect(line).toBe('🤖 AI (oxirgi 24 soat): 5 murojaat — narxi noma’lum');
    expect(line).not.toContain('$');
  });

  it('a ledger that could not be read is named, never a smaller total in silence', () => {
    expect(plain(aiLine(ai({ unread: ['agent'] }), false))).toBe(
      '🤖 AI (oxirgi 24 soat): ≈ $4.20 · 132 murojaat · ⚠ o‘qilmadi: sotuvchi AI',
    );
    expect(plain(aiLine(ai({ usd: 0, calls: 0, unread: ['calc', 'agent', 'assistant'] }), false))).toBe(
      '🤖 AI (oxirgi 24 soat): ⚠ o‘qilmadi: hisob-kitob AI, sotuvchi AI, yordamchi AI',
    );
  });

  it('a day the machine was not asked anything: no line at all', () => {
    expect(aiLine(ai({ usd: 0, calls: 0 }), false)).toBeNull();
    expect(aiLine(null, false)).toBeNull();
  });
});

describe('in the message', () => {
  const facts = (over: Partial<SummaryFacts> = {}): SummaryFacts => ({
    day: '2026-11-11',
    weekly: false,
    from: '2026-11-11',
    to: '2026-11-11',
    asOf: '20:00',
    revenueUsd: 0,
    collectedUsd: 0,
    cash: { inUsd: 0, outUsd: 0, unconverted: { count: 0, byCurrency: [] } },
    tills: { usd: 0, count: 0, unrated: [] },
    intake: { receipts: 0, boxes: 0, m3: 0, kg: 0 },
    trucks: { departed: 0, arrived: 0, onRoad: 0 },
    leads: { fresh: 4, won: 1, wonUsd: 500, wonOther: 0 },
    attention: { total: 0, top: [] },
    ai: { usd: 4.2, calls: 132, unpriced: 0, unread: [] },
    weeklyBlock: null,
    link: 'https://gsrwms.uz/dashboard?davr=bugun',
    ...over,
  });

  it('one line, right under the leads — and the link still last', () => {
    const lines = plain(ownerSummaryText(facts())).split('\n');
    const at = lines.findIndex((line) => line.startsWith('🤖 AI'));
    expect(lines[at]).toBe('🤖 AI (oxirgi 24 soat): ≈ $4.20 · 132 murojaat');
    expect(lines[at - 1]).toMatch(/^👥 Yangi lid/);
    expect(lines.at(-1)).toBe('https://gsrwms.uz/dashboard?davr=bugun');
    expect(plain(ownerSummaryText(facts({ ai: null })))).not.toContain('🤖');
  });

  it('the machine’s bill alone does not make a day «not quiet»: a silent business day stays one', () => {
    // The pull says «Hali harakat yo‘q.» for a day with no business movement;
    // an AI answering customers at night is not business movement.
    const quiet = facts({ leads: { fresh: 0, won: 0, wonUsd: 0, wonOther: 0 } });
    expect(summaryQuiet(quiet)).toBe(true);
    expect(summaryQuiet({ ...quiet, ai: null })).toBe(true);
  });
});
