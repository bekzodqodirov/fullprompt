import { describe, expect, it } from 'vitest';
import { parseLineAnswer, type LineFigures } from '@/modules/wms/calc/intake-manual';

/**
 * The follow-up question's answer, read without a model.
 *
 * The bot asks about a row its law (or the one-measure rule) says cannot be
 * priced yet, and whatever this returns is written onto that row and priced.
 * So the rule is «read it exactly or refuse»: a refusal costs one more
 * question, a wrong reading costs a duty computed on a number nobody stated.
 *
 * Since 2026-10-09 (P1.3) the grammar is the kernel's `parseGoodsLine`, the
 * same one every other door reads with, and the answer is a tagged union:
 * `figures` in their own columns, a `bare` number whose unit is the LAW's or
 * the seller's tap, an `ambiguous` separator asked both ways, or a refusal
 * with its reason for the bot to word.
 */
const none: LineFigures = { quantity: null, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null };
const figures = (f: Partial<LineFigures>, code: string | null = null) => ({
  kind: 'figures',
  figures: { ...none, ...f },
  code,
});

describe('parseLineAnswer', () => {
  it('reads a weight in every spelling the office uses', () => {
    expect(parseLineAnswer('300 kg')).toEqual(figures({ weightKg: 300 }));
    expect(parseLineAnswer('300кг')).toEqual(figures({ weightKg: 300 }));
    expect(parseLineAnswer('  300,5 кг  ')).toEqual(figures({ weightKg: 300.5 }));
    expect(parseLineAnswer('vazni 120kilo')).toEqual(figures({ weightKg: 120 }));
  });

  it('reads a count in every spelling the office uses', () => {
    expect(parseLineAnswer('50 dona')).toEqual(figures({ quantity: 50 }));
    expect(parseLineAnswer('50 шт')).toEqual(figures({ quantity: 50 }));
    expect(parseLineAnswer('50ta')).toEqual(figures({ quantity: 50 }));
    expect(parseLineAnswer('50 pcs')).toEqual(figures({ quantity: 50 }));
  });

  it('«1 200 kg» is twelve hundred — a space groups thousands', () => {
    // The old reader stopped at the space and wrote 200 onto the row.
    expect(parseLineAnswer('1 200 kg')).toEqual(figures({ weightKg: 1200 }));
  });

  it('«1,200 kg» is asked both ways, with its unit, never guessed', () => {
    expect(parseLineAnswer('1,200 kg')).toEqual({
      kind: 'ambiguous',
      decimal: 1.2,
      thousands: 1200,
      unit: 'kg',
    });
  });

  it('a bare number is handed back — its unit is the law’s question, not a default', () => {
    // The audit's finding: «a bare number becomes KILOGRAMS on practically
    // every line». The bot now offers buttons (or takes the ONE unit the
    // law pins), so this reader must not choose.
    expect(parseLineAnswer('50')).toEqual({ kind: 'bare', value: 50, code: null });
  });

  it('m², juft and litr land in the measure pair — they were refused before', () => {
    // The owner's «juftda o'tadigan tovarlar»: a shoe line had no way to be
    // answered in the unit its own law is written in.
    expect(parseLineAnswer('120 m2')).toEqual(figures({ measureUnit: 'm2', measureQty: 120 }));
    expect(parseLineAnswer('40 juft')).toEqual(figures({ measureUnit: 'juft', measureQty: 40 }));
    expect(parseLineAnswer('50 litr')).toEqual(figures({ measureUnit: 'litr', measureQty: 50 }));
    // «120 ta juft» is 120 PAIRS — the counter word must not make it pieces.
    expect(parseLineAnswer('120 ta juft')).toEqual(figures({ measureUnit: 'juft', measureQty: 120 }));
  });

  it('a count AND a weight is the clothing answer, and is kept whole', () => {
    // It was refused: «50 dona 300 kg» read as «a sentence about the whole
    // line». It is exactly what a 6110 sweater owes — a per-kg baza under a
    // per-piece floor — and refusing it made the line unanswerable.
    expect(parseLineAnswer('300 dona 150 kg')).toEqual(figures({ quantity: 300, weightKg: 150 }));
  });

  it('a TNVED code is a CODE, never a 6.4-billion-kg weight', () => {
    expect(parseLineAnswer('6403990000')).toEqual(figures({}, '6403990000'));
    expect(parseLineAnswer('6403.99.00.00')).toEqual(figures({}, '6403990000'));
    expect(parseLineAnswer('kod 6907')).toEqual(figures({}, '6907'));
    // Nine digits are a code whose leading zero was lost, not 901 million
    // pieces — refused with the text, so the bot can say so.
    expect(parseLineAnswer('901210000')).toEqual({ kind: 'refused', reason: 'code_short', detail: '901210000' });
  });

  it('a figure no column can hold is refused in words, at parse time', () => {
    // Ten digits with a unit are an amount, not a code.
    expect(parseLineAnswer('2000000000 kg')).toEqual({ kind: 'refused', reason: 'too_large' });
    expect(parseLineAnswer('12000000000 m2')).toEqual({ kind: 'refused', reason: 'too_large' });
  });

  it('refuses rather than choosing between two figures in one unit', () => {
    // Two different weights in one message: picking either is a number
    // nobody stated about the line.
    expect(parseLineAnswer('300 kg va 400 kg')).toEqual({ kind: 'refused', reason: 'repeated' });
    // The same weight written twice is refused too, deliberately (the
    // subject of this case moved with the shared grammar): the kernel says
    // the unit was repeated, not that the figures agree, and one more
    // question is the cheap side of «read it exactly or refuse».
    expect(parseLineAnswer('300 kg, ya’ni 300 kg')).toEqual({ kind: 'refused', reason: 'repeated' });
    // Two different pairs on one line.
    expect(parseLineAnswer('120 m2 40 juft')).toEqual({ kind: 'refused', reason: 'two_pairs' });
  });

  it('a carton count is not a quantity, and an unknown unit is not guessed', () => {
    expect(parseLineAnswer('20 karobka')).toEqual({ kind: 'refused', reason: 'cartons', detail: '20' });
    expect(parseLineAnswer('300 рулон')).toEqual({ kind: 'refused', reason: 'unknown_unit', detail: 'рулон' });
  });

  it('refuses nonsense, zero and negatives', () => {
    for (const text of ['bilmayman', '', '0 kg', '0', '-5']) {
      expect(parseLineAnswer(text), text).toEqual({ kind: 'refused', reason: 'nothing' });
    }
  });
});
