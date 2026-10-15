import { describe, expect, it } from 'vitest';
import { numberOrNull, readNumberCell } from '@/modules/wms/calc/number-cell';

/**
 * His B4 a: «1,125» and «15,000» are not saved — the screen asks which one
 * he meant. Every cell of the calculation reads through this one function,
 * on both shapes of the screen and on the dictionary's baza form.
 */
describe('readNumberCell', () => {
  it('a comma with exactly three digits is AMBIGUOUS, both readings handed back', () => {
    expect(readNumberCell('1,125')).toEqual({
      state: 'ambiguous',
      decimal: 1.125,
      thousands: 1125,
      decimalText: '1.125',
      thousandsText: '1125',
    });
    expect(readNumberCell('15,000')).toEqual({
      state: 'ambiguous',
      decimal: 15,
      thousands: 15000,
      decimalText: '15.000',
      thousandsText: '15000',
    });
  });

  it('every other single comma is the decimal separator', () => {
    expect(readNumberCell('0,125')).toEqual({ state: 'ok', value: 0.125 });
    expect(readNumberCell('1,5')).toEqual({ state: 'ok', value: 1.5 });
    expect(readNumberCell('1,12')).toEqual({ state: 'ok', value: 1.12 });
    expect(readNumberCell('1234,567')).toEqual({ state: 'ok', value: 1234.567 });
  });

  it('grouping marks come out; two comma groups or a dot decimal mean thousands', () => {
    expect(readNumberCell('1 125')).toEqual({ state: 'ok', value: 1125 });
    expect(readNumberCell('1 125')).toEqual({ state: 'ok', value: 1125 });
    expect(readNumberCell('1 125')).toEqual({ state: 'ok', value: 1125 });
    expect(readNumberCell("1'125")).toEqual({ state: 'ok', value: 1125 });
    expect(readNumberCell('1,125.50')).toEqual({ state: 'ok', value: 1125.5 });
    expect(readNumberCell('1,125,000')).toEqual({ state: 'ok', value: 1125000 });
  });

  it('a plain dot decimal, an empty cell, and the shapes that are not numbers', () => {
    expect(readNumberCell('1.125')).toEqual({ state: 'ok', value: 1.125 });
    expect(readNumberCell('')).toEqual({ state: 'empty' });
    expect(readNumberCell('   ')).toEqual({ state: 'empty' });
    expect(readNumberCell('12a')).toEqual({ state: 'bad' });
    expect(readNumberCell('-1')).toEqual({ state: 'bad' });
    expect(readNumberCell('1,2,3')).toEqual({ state: 'bad' });
  });

  it('a number past what a double can hold is bad, never Infinity', () => {
    expect(readNumberCell('9'.repeat(400))).toEqual({ state: 'bad' });
  });

  it('numberOrNull prices nothing it cannot read', () => {
    expect(numberOrNull('2')).toBe(2);
    expect(numberOrNull('1,125')).toBeNull();
    expect(numberOrNull('abc')).toBeNull();
    expect(numberOrNull('')).toBeNull();
  });
});
