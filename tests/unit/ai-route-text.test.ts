import { describe, expect, it } from 'vitest';
import { codeCandidates } from '@/modules/platform/ai/route-text';

/**
 * The free-first routing rule: a code inside a sentence must be answered by
 * the free lookup before a model call is even considered — «GS777 qayerda»
 * was the review's own example of the owner's staff question about to become
 * slower and paid.
 */
describe('codeCandidates', () => {
  it('finds the code inside a question', () => {
    expect(codeCandidates('GS777 qayerda')).toEqual(['GS777']);
    expect(codeCandidates('gs777 qayerda?')).toEqual(['GS777']);
    expect(codeCandidates('YW26-000123 keldimi')).toEqual(['YW26-000123']);
    expect(codeCandidates('CR-12 nima bo‘ldi')).toEqual(['CR-12']);
  });

  it('needs both a letter and a digit — ordinary words are not codes', () => {
    expect(codeCandidates('menda bugun nima bor')).toEqual([]);
    expect(codeCandidates('qancha pul kirdi')).toEqual([]);
    // Bare numbers are not codes either (a sum, a count, a year).
    expect(codeCandidates('2026 yilda 500 kub')).toEqual([]);
  });

  it('strips punctuation, dedupes, and stops at three', () => {
    expect(codeCandidates('GS777, GS777!')).toEqual(['GS777']);
    expect(codeCandidates('GS1 GS2 GS3 GS4')).toHaveLength(3);
  });
});
