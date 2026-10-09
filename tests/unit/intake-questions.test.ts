import { describe, expect, it } from 'vitest';
import {
  anyMeasureLine,
  bareChoices,
  bareUnitFor,
  collectPromptText,
  lineQuestionText,
  needFigure,
  nextLineToAsk,
} from '@/modules/wms/calc/intake';
import { needLawOf, type NeedLaw } from '@/modules/wms/calc/needs';

/**
 * The follow-up loop's decision, without a Telegram.
 *
 * It asks about exactly the rows the ENGINE would refuse — a row stating no
 * figure at all, or a row stating a figure its LAW does not price in — and
 * about nothing else. A bot that asks about a row it could already price is a
 * bot the office stops answering, and that costs the feature more than a
 * missing number does.
 */
const goods = (
  rows: {
    name: string;
    quantity?: number | null;
    weightKg?: number | null;
    measureUnit?: 'm2' | 'juft' | 'litr' | 'sm3' | null;
    measureQty?: number | null;
    tnvedCode?: string | null;
    unit?: string | null;
  }[],
) => ({ weightKg: 500, volumeM3: 10, goods: rows });

const noLaws: ReadonlyMap<string, NeedLaw> = new Map();
const laws = new Map<string, NeedLaw>([
  ['6110200000', needLawOf({ dutyMode: 'max', dutyUnit: 'dona', dutySpecific: 1, dutyFree: false })],
  ['6403990000', needLawOf({ dutyMode: 'max', dutyUnit: 'juft', dutySpecific: 3, dutyFree: false })],
]);

describe('nextLineToAsk', () => {
  it('names the first row that states no figure at all', () => {
    const facts = goods([{ name: 'Monitor', quantity: 10 }, { name: 'Sumka' }, { name: 'Choynak' }]);
    expect(nextLineToAsk('rastamojka', facts, noLaws)).toMatchObject({ index: 1, name: 'Sumka' });
  });

  it('walks past every row already dealt with — answered OR skipped', () => {
    // `skip` replaced `after` (P1.3): a re-analysis after «➕ Yana
    // ma'lumot» rebuilds the facts, and a cursor would have asked the
    // first line again.
    const facts = goods([{ name: 'Sumka' }, { name: 'Choynak' }]);
    expect(nextLineToAsk('rastamojka', facts, noLaws, { skip: [0] })).toMatchObject({
      index: 1,
      name: 'Choynak',
    });
    expect(nextLineToAsk('rastamojka', facts, noLaws, { skip: [0, 1] })).toBeNull();
    // A skip set is not a cursor: skipping only the second still asks the first.
    expect(nextLineToAsk('rastamojka', facts, noLaws, { skip: [1] })).toMatchObject({ index: 0 });
  });

  it('a weight, a count OR a pair all answer an uncoded line', () => {
    const two = (row: Parameters<typeof goods>[0][number]) => goods([row, { name: 'B', quantity: 1 }]);
    expect(nextLineToAsk('rastamojka', two({ name: 'A', weightKg: 300 }), noLaws)).toBeNull();
    expect(nextLineToAsk('rastamojka', two({ name: 'A', quantity: 5 }), noLaws)).toBeNull();
    expect(nextLineToAsk('rastamojka', two({ name: 'A', measureUnit: 'm2', measureQty: 12 }), noLaws)).toBeNull();
  });

  it('a CODED line is asked the figure its law counts in, even when it states another', () => {
    // A sweater stating only kg still owes its count: «boj kamida $1/dona».
    const facts = goods([
      { name: 'Sviter', weightKg: 150, tnvedCode: '6110200000' },
      { name: 'B', quantity: 1 },
    ]);
    const line = nextLineToAsk('rastamojka', facts, laws);
    expect(line).toMatchObject({ index: 0, units: ['dona'], anyMeasure: false });
    expect(bareUnitFor(line!)).toBe('dona');
    expect(lineQuestionText(line!)).toContain('boj kamida $1/dona');
  });

  it('a SINGLE line inherits the shipment weight and is never asked about', () => {
    // `loneWeightKg`'s rule on the bot's READ facts: with one line the
    // shipment's weight IS that line's weight (said in its note), and
    // asking a person to retype a number they have given reads as a broken
    // form.
    expect(nextLineToAsk('rastamojka', goods([{ name: 'Sumka' }]), noLaws)).toBeNull();
  });

  it('a freight-only job is asked nothing — a truck is priced on the totals', () => {
    const facts = goods([{ name: 'Sumka' }, { name: 'Choynak' }]);
    expect(nextLineToAsk('yolkira', facts, noLaws)).toBeNull();
    expect(nextLineToAsk('podklyuch', facts, noLaws)).toMatchObject({ index: 0 });
  });
});

describe('what a bare «50» means, and how it is asked', () => {
  it('the law’s one pinned unit takes it; otherwise it is never a silent kg', () => {
    expect(bareUnitFor(anyMeasureLine(0, 'Sumka'))).toBeNull();
    expect(bareChoices(anyMeasureLine(0, 'Sumka'), null)).toEqual(['dona', 'kg']);
  });

  it('a pair is offered only when the seller’s own word named one', () => {
    // A pair nobody mentioned is not a third guess to hand the seller.
    expect(bareChoices(anyMeasureLine(0, 'Kafel'), 'm2')).toEqual(['dona', 'kg', 'm2']);
    expect(bareChoices(anyMeasureLine(0, 'Kafel'), 'karobka')).toEqual(['dona', 'kg']);
  });

  it('a chosen unit lands in the column it names, through the kernel’s router', () => {
    expect(needFigure('dona', 50)).toEqual({ quantity: 50 });
    expect(needFigure('kg', 50)).toEqual({ weightKg: 50 });
    expect(needFigure('m2', 50)).toEqual({ measureUnit: 'm2', measureQty: 50 });
    expect(needFigure('juft', 40)).toEqual({ measureUnit: 'juft', measureQty: 40 });
    expect(needFigure('m3', 2)).toEqual({ volumeM3: 2 });
  });
});

describe('the words', () => {
  it('the question names the row by its number and its name', () => {
    expect(lineQuestionText(anyMeasureLine(2, 'Sumka'))).toContain('3-qator «Sumka»');
  });

  it('an uncoded line is asked for a count OR a weight, never one unit', () => {
    // judge UX5: «nechta dona yoki necha kg?» — either prices it.
    const text = lineQuestionText(anyMeasureLine(0, 'Sumka'));
    expect(text).toContain('nechta dona yoki necha kg');
    expect(text).toContain('120 m²');
  });

  it('the «send everything» prompt names a code and a pair on the customs sections', () => {
    // The owner's first complaint: «there is no place to enter» them, and
    // the bot itself had been asking for «kub/kg» and nothing else.
    for (const section of ['rastamojka', 'podklyuch'] as const) {
      const text = collectPromptText(section);
      expect(text).toContain('TNVED');
      expect(text).toContain('120 m²');
    }
    // Freight is priced on the truck: the old prompt stands.
    expect(collectPromptText('yolkira')).toContain('kub/kg');
  });
});
