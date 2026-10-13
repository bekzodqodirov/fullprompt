import { describe, expect, it } from 'vitest';
import { codeIn, parseGoodsLine, readAmountText, routeAmount, unitOf } from '@/modules/wms/calc/units';

/**
 * The one reading of «what did the person mean by 120 m2» (2026-10-09). Every
 * case here was a real loss at one of the four doors: the number in the dona
 * column whatever its unit, «Lak 50 litr» losing its 50, «1 200 kg» read as
 * 200, «2,5» splitting a line.
 */
describe('parseGoodsLine — a number lands in the column its unit names', () => {
  const read = (s: string) => {
    const l = parseGoodsLine(s);
    return {
      name: l.name,
      code: l.tnvedCode,
      dona: l.quantity,
      kg: l.weightKg,
      m3: l.volumeM3,
      pair: l.measureUnit ? `${l.measureQty} ${l.measureUnit}` : null,
      cartons: l.cartons,
      problems: l.problems.map((p) => p.kind),
    };
  };

  it('m², juft and litr go to the measure pair, never the count', () => {
    expect(read('Kafel plitka, 120, m2')).toMatchObject({ name: 'Kafel plitka', dona: null, pair: '120 m2' });
    expect(read('Kafel, 120 m2')).toMatchObject({ name: 'Kafel', dona: null, pair: '120 m2' });
    expect(read('Krossovka; 40; juft')).toMatchObject({ dona: null, pair: '40 juft' });
    expect(read('Lak 50 litr')).toMatchObject({ name: 'Lak', dona: null, pair: '50 litr' });
    expect(read('Kafel\t1 200\tкв.м')).toMatchObject({ pair: '1200 m2' });
    expect(read('鞋 40 双 12 kg')).toMatchObject({ pair: '40 juft', kg: 12 });
  });

  it('kg goes to the weight and a count AND a weight both survive (clothing)', () => {
    expect(read('Kurtka, 500, kg')).toMatchObject({ dona: null, kg: 500 });
    expect(read('Kurtka 300 dona 150 kg')).toMatchObject({ name: 'Kurtka', dona: 300, kg: 150 });
    expect(read('Kurtka 300 dona, 150кг')).toMatchObject({ dona: 300, kg: 150 });
  });

  it('a bare number is the count — «nomi, soni», the convention every door kept', () => {
    expect(read('Stol, 10')).toMatchObject({ name: 'Stol', dona: 10 });
    expect(read('Stol; 1000')).toMatchObject({ name: 'Stol', dona: 1000, code: null });
    expect(read('Samsung A54 10')).toMatchObject({ name: 'Samsung A54', dona: 10 });
    expect(read('iPhone 15 Pro, 30')).toMatchObject({ name: 'iPhone 15 Pro', dona: 30 });
    expect(read('Kafel 60x60 120 m2')).toMatchObject({ name: 'Kafel 60x60', pair: '120 m2' });
  });

  it('a decimal comma is a decimal, never a column break', () => {
    expect(read('Kabel, 2,5, kg')).toMatchObject({ name: 'Kabel', kg: 2.5 });
  });

  it('grouped thousands are read whole; a comma or dot thousand is ASKED', () => {
    expect(read('Stul 1 250 kg')).toMatchObject({ kg: 1250 });
    expect(read('Paypoq 1 200 juft')).toMatchObject({ pair: '1200 juft' });
    expect(read('Stul 1,200 kg')).toMatchObject({ kg: null, problems: ['ambiguous'] });
    expect(read('Stul 1.200 kg')).toMatchObject({ kg: null, problems: ['ambiguous'] });
  });

  it('a carton count is not pieces — it lands nowhere a price reads', () => {
    expect(read('Futbolka 20 karobka')).toMatchObject({ dona: null, cartons: 20, problems: ['cartons_only'] });
  });

  it('an unknown unit is asked, never priced', () => {
    expect(read('Ткань 300 м')).toMatchObject({ dona: null, problems: ['unknown_unit'] });
  });

  it('two different pair units on one line is a problem, not a silent pick', () => {
    expect(read('Plitka 120 m2 30 juft')).toMatchObject({ pair: '120 m2', problems: ['two_pairs'] });
  });

  it('the TNVED code is found in every shape people write it — and a count is never a code', () => {
    expect(read('6907210000 Kafel 120 m2')).toMatchObject({ code: '6907210000', name: 'Kafel' });
    expect(read('6907.21.00.00 Kafel 120 m2')).toMatchObject({ code: '6907210000' });
    expect(read('kod 6403 Krossovka 40 juft')).toMatchObject({ code: '6403', name: 'Krossovka' });
    expect(read('6403\tKrossovka\t40\tпар')).toMatchObject({ code: '6403', pair: '40 juft' });
    expect(codeIn('model 2024 qizil')).toBeNull();
    expect(codeIn('1200 50')).toBeNull();
  });
});

describe('the pieces', () => {
  it('readAmountText refuses zero and asks about a comma or dot thousand', () => {
    expect(readAmountText('1 200')).toEqual({ state: 'ok', value: 1200 });
    expect(readAmountText('0,5')).toEqual({ state: 'ok', value: 0.5 });
    expect(readAmountText('0')).toEqual({ state: 'bad' });
    expect(readAmountText('1,200').state).toBe('ambiguous');
    expect(readAmountText('1.200').state).toBe('ambiguous');
  });

  it('routeAmount: no word = a count; an unknown word keeps the number off every priced column', () => {
    expect(routeAmount(5, '')).toEqual({ quantity: 5 });
    expect(routeAmount(5, 'кг')).toEqual({ weightKg: 5 });
    expect(routeAmount(5, 'пар')).toEqual({ measureUnit: 'juft', measureQty: 5 });
    expect(routeAmount(5, 'ctns')).toEqual({ cartons: 5 });
    expect(routeAmount(5, 'рулон')).toEqual({ unknownUnit: 'рулон', value: 5 });
  });

  it('«件» is deliberately unknown — a piece on one invoice, a package on the next', () => {
    expect(unitOf('件')).toBeNull();
  });
});
