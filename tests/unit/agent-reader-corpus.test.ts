import { describe, expect, it } from 'vitest';
import { READER_CORPUS, type Reader } from './fixtures/agent-reader-corpus';
import { KNOWN_HELD } from './fixtures/agent-reader-corpus-known';
import { observe } from './fixtures/agent-reader-corpus-eval';

/**
 * The free-text readers' regression corpus (tests/unit/fixtures/agent-reader-corpus.ts), run case by case against the
 * CURRENT code — the avia hand-over rule, the destination, the customer's language, his answer's figures, the money
 * and Chinese-numeral readers, the lesson's money and the ✍️ phone — through the functions a run calls
 * (`agent-reader-corpus-eval.ts`). Three fix passes each reopened what the one before had closed, because each read
 * only the cases in front of it; this file reads all of them, every time.
 *
 * A dangerous case must hold, always. An ordinary case should go; one that cannot is on the ratchet
 * (`agent-reader-corpus-known.ts`) and runs as `it.fails`, so freeing it is red until its id leaves the list.
 */

describe('the corpus itself', () => {
  it('ids are unique, every case says where it came from, and expects what its kind says', () => {
    const ids = READER_CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of READER_CORPUS) {
      expect(c.source, c.id).not.toBe('');
      expect(c.expect, c.id).toBe(c.kind === 'dangerous' ? 'held' : 'goes');
    }
  });

  it('the ratchet names only ordinary cases that exist, each with its reason — a dangerous case is never excused', () => {
    const byId = new Map(READER_CORPUS.map((c) => [c.id, c]));
    for (const [id, why] of KNOWN_HELD) {
      expect(byId.has(id), `${id} is on the ratchet and not in the corpus`).toBe(true);
      expect(byId.get(id)!.kind, `${id} is dangerous and on the ratchet`).toBe('ordinary');
      expect(why.trim(), id).not.toBe('');
    }
  });

  it('every reader the round named has cases of both kinds', () => {
    const readers: Reader[] = ['avia', 'destination', 'language', 'owner_figure', 'money', 'han', 'han_g1', 'lesson', 'phone'];
    for (const reader of readers) {
      const of = READER_CORPUS.filter((c) => c.reader === reader);
      expect(of.some((c) => c.kind === 'dangerous'), reader).toBe(true);
      expect(of.some((c) => c.kind === 'ordinary'), reader).toBe(true);
    }
  });
});

for (const reader of ['avia', 'destination', 'language', 'owner_figure', 'money', 'han', 'han_g1', 'lesson', 'phone'] as const) {
  describe(`reader: ${reader}`, () => {
    for (const c of READER_CORPUS.filter((x) => x.reader === reader)) {
      const known = KNOWN_HELD.get(c.id);
      const title = `${c.id} ${c.kind} → ${c.expect} — «${c.input.replace(/\n/gu, ' / ')}» (${c.source})`;
      if (known !== undefined) {
        it.fails(`${title} — KNOWN: ${known}`, () => {
          expect(observe(c)).toBe(c.expect);
        });
      } else {
        it(title, () => {
          expect(observe(c)).toBe(c.expect);
        });
      }
    }
  });
}

// The rule with his price act OFF is today's, byte for byte (spec SPEC-P1-v2 §1.2): every quoted flight asks him,
// whatever its reply says — the dangerous direction of every avia case, armed or not.
describe('reader: avia, the price act OFF — every quoted flight asks him', () => {
  for (const c of READER_CORPUS.filter((x) => x.reader === 'avia')) {
    it(`${c.id} off → held — «${c.input}»`, () => {
      expect(observe(c, 'off')).toBe('held');
    });
  }
});
