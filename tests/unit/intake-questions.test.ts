import { describe, expect, it } from 'vitest';
import { lineQuestionText, nextLineToAsk } from '@/modules/wms/calc/intake';

/**
 * The follow-up loop's decision, without a Telegram.
 *
 * It asks about exactly the rows the ENGINE would refuse — a row stating
 * neither a count nor a weight nor the law's own unit — and about nothing
 * else. A bot that asks about a row it could already price is a bot the
 * office stops answering, and that costs the feature more than a missing
 * number does.
 */
const goods = (
  rows: { name: string; quantity?: number | null; weightKg?: number | null; measureQty?: number | null }[],
) => ({ weightKg: 500, volumeM3: 10, goods: rows });

describe('nextLineToAsk', () => {
  it('names the first row that states no figure at all', () => {
    const facts = goods([
      { name: 'Monitor', quantity: 10 },
      { name: 'Sumka' },
      { name: 'Choynak' },
    ]);
    expect(nextLineToAsk('rastamojka', facts)).toMatchObject({ index: 1, name: 'Sumka' });
  });

  it('walks past the row it has already asked about', () => {
    const facts = goods([{ name: 'Sumka' }, { name: 'Choynak' }]);
    expect(nextLineToAsk('rastamojka', facts, { after: 0 })).toMatchObject({
      index: 1,
      name: 'Choynak',
    });
    expect(nextLineToAsk('rastamojka', facts, { after: 1 })).toBeNull();
  });

  it('a weight, a count OR the law’s own unit all count as answered', () => {
    expect(nextLineToAsk('rastamojka', goods([{ name: 'A', weightKg: 300 }]))).toBeNull();
    expect(nextLineToAsk('rastamojka', goods([{ name: 'A', quantity: 5 }]))).toBeNull();
    expect(nextLineToAsk('rastamojka', goods([{ name: 'A', measureQty: 12 }]))).toBeNull();
  });

  it('a SINGLE line inherits the shipment weight and is never asked about', () => {
    // `loneWeightKg`'s rule: with one line the shipment's weight IS that
    // line's weight, and asking a person to retype a number they have given
    // reads as a broken form.
    expect(nextLineToAsk('rastamojka', goods([{ name: 'Sumka' }]))).toBeNull();
  });

  it('a freight-only job is asked nothing — a truck is priced on the totals', () => {
    const facts = goods([{ name: 'Sumka' }, { name: 'Choynak' }]);
    expect(nextLineToAsk('yolkira', facts)).toBeNull();
    expect(nextLineToAsk('podklyuch', facts)).toMatchObject({ index: 0 });
  });

  it('the question names the row by its number and its name', () => {
    expect(lineQuestionText({ index: 2, name: 'Sumka' })).toContain('3-qator «Sumka»');
  });
});
