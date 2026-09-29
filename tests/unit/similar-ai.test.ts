import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIMILAR_PICKS, validPicks } from '@/modules/wms/finance/similar-ai';

/**
 * «📈»'s fallback (0119, 18a): the model answers with INDEXES into real past
 * lots and nothing else; the price is read afterwards from the ledger. This
 * pins the gate between the two — `pickImportRows`' law 1 at its narrowest.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('validPicks — the model\'s answer, checked against the list it claims', () => {
  it('drops an index outside the list, a negative one and a non-integer', () => {
    const picks = validPicks(
      [
        { index: 3, reason: 'a' },
        { index: 4, reason: 'out of range' },
        { index: -1, reason: 'negative' },
        { index: 1.5, reason: 'half' },
        { index: 0, reason: 'b' },
      ],
      4,
    );
    expect(picks).toEqual([
      { index: 3, reason: 'a' },
      { index: 0, reason: 'b' },
    ]);
  });

  it('keeps each index once — a duplicate is not a second vote', () => {
    const picks = validPicks(
      [
        { index: 2, reason: 'first' },
        { index: 2, reason: 'again' },
      ],
      5,
    );
    expect(picks).toEqual([{ index: 2, reason: 'first' }]);
  });

  it('five at most, the model\'s own order', () => {
    const raw = Array.from({ length: 9 }, (_, i) => ({ index: 8 - i, reason: String(i) }));
    const picks = validPicks(raw, 9);
    expect(SIMILAR_PICKS).toBe(5);
    expect(picks.map((p) => p.index)).toEqual([8, 7, 6, 5, 4]);
  });

  it('an empty list is a real answer («none of these»), and nothing is invented for it', () => {
    expect(validPicks([], 10)).toEqual([]);
    expect(validPicks([{ index: 0, reason: 'x' }], 0)).toEqual([]);
  });

  it('a reason is cut, never trusted to be short', () => {
    const [pick] = validPicks([{ index: 0, reason: 'x'.repeat(1000) }], 1);
    expect(pick!.reason.length).toBe(300);
  });

  it('the output carries no number but the index', () => {
    const picks = validPicks([{ index: 0, reason: 'r', usd: 9 } as never], 1);
    for (const pick of picks) {
      expect(Object.keys(pick).sort()).toEqual(['index', 'reason']);
      for (const [key, value] of Object.entries(pick)) {
        if (typeof value === 'number') expect(key).toBe('index');
      }
    }
  });
});

describe('the model can never reach a number (source shape)', () => {
  const source = strip(readFileSync('src/modules/wms/finance/similar-ai.ts', 'utf8'));

  it('the schema the model answers in declares index and reason only', () => {
    const schema = /properties:\s*\{\s*index:[\s\S]*?required:\s*\[([^\]]*)\]/.exec(source);
    expect(schema, 'the pick schema — re-anchor this fence').not.toBeNull();
    expect(schema![1]!.replace(/\s/g, '')).toBe("'index','reason'");
    expect(source).toMatch(/additionalProperties:\s*false/);
  });

  it('the declared pick type has exactly those two fields', () => {
    const body = /export interface SimilarPick \{([\s\S]*?)\n\}/.exec(source);
    expect(body).not.toBeNull();
    const fields = [...body![1]!.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(fields.sort()).toEqual(['index', 'reason']);
  });

  it('the call carries its own deadline — a person is waiting on the button (#706)', () => {
    expect(source).toMatch(/new Anthropic\(\{[^}]*timeout:/);
  });
});
