import { describe, expect, it } from 'vitest';
import { parseLineAnswer } from '@/modules/wms/calc/intake-manual';

/**
 * The follow-up question's answer, read without a model.
 *
 * The bot asks about a row that states neither a count nor a weight, and
 * whatever this returns is written onto that row and priced. So the rule is
 * «read it exactly or refuse»: a refusal costs one more question, a wrong
 * reading costs a duty computed on a number nobody stated.
 */
describe('parseLineAnswer', () => {
  it('reads a weight in every spelling the office uses', () => {
    expect(parseLineAnswer('300 kg')).toEqual({ weightKg: 300 });
    expect(parseLineAnswer('300кг')).toEqual({ weightKg: 300 });
    expect(parseLineAnswer('  300,5 кг  ')).toEqual({ weightKg: 300.5 });
    expect(parseLineAnswer('vazni 120kilo')).toEqual({ weightKg: 120 });
  });

  it('reads a count in every spelling the office uses', () => {
    expect(parseLineAnswer('50 dona')).toEqual({ quantity: 50 });
    expect(parseLineAnswer('50 шт')).toEqual({ quantity: 50 });
    expect(parseLineAnswer('50ta')).toEqual({ quantity: 50 });
    expect(parseLineAnswer('50 pcs')).toEqual({ quantity: 50 });
  });

  it('a bare number means whatever the question asked for', () => {
    expect(parseLineAnswer('50')).toEqual({ quantity: 50 });
    expect(parseLineAnswer('50', { bareMeans: 'weight' })).toEqual({ weightKg: 50 });
  });

  it('refuses rather than choosing between two figures', () => {
    // «50 dona, 300 kg jami» is a sentence about the whole line, and picking
    // either half would put a number on the row that nobody stated about it.
    expect(parseLineAnswer('50 dona 300 kg')).toBeNull();
    // Two different weights in one message is the same problem.
    expect(parseLineAnswer('300 kg va 400 kg')).toBeNull();
  });

  it('refuses nonsense, zero and negatives', () => {
    expect(parseLineAnswer('bilmayman')).toBeNull();
    expect(parseLineAnswer('')).toBeNull();
    expect(parseLineAnswer('0 kg')).toBeNull();
    expect(parseLineAnswer('0')).toBeNull();
    expect(parseLineAnswer('-5')).toBeNull();
    // A unit this office does not write is not guessed at.
    expect(parseLineAnswer('50 litr')).toBeNull();
  });

  it('the same figure written twice is still one answer', () => {
    expect(parseLineAnswer('300 kg, ya’ni 300 kg')).toEqual({ weightKg: 300 });
  });
});
