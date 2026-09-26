import { describe, expect, it } from 'vitest';
import { parseTypedMoney } from '@/modules/wms/calc/money-input';

/**
 * What a person types, read as what they meant (audit A3).
 *
 * `Number('1 000')` is NaN and NaN passes every comparison-shaped guard, so
 * the «Готово» answer closed a job with a currency and no amount and the
 * seller's Telegram read «💵 NaN USD». These are the shapes his office
 * actually writes — a phone keyboard's NBSP included.
 */
describe('a typed amount', () => {
  it('reads the office’s grouping marks', () => {
    expect(parseTypedMoney('1 000')).toBe(1000);
    expect(parseTypedMoney('1 000')).toBe(1000); // NBSP — phone keyboards
    expect(parseTypedMoney('1 000')).toBe(1000); // narrow NBSP — Excel
    expect(parseTypedMoney("1'000")).toBe(1000);
    expect(parseTypedMoney('1,000')).toBe(1000);
    expect(parseTypedMoney('1,000,500')).toBe(1000500);
    expect(parseTypedMoney('1,000.50')).toBe(1000.5);
  });

  it('reads a decimal comma as a decimal comma', () => {
    expect(parseTypedMoney('1,5')).toBe(1.5);
    expect(parseTypedMoney('0,45')).toBe(0.45);
    expect(parseTypedMoney('4800.75')).toBe(4800.75);
    // Nobody groups the thousands of zero: a per-kilo baza, a part of a cube.
    expect(parseTypedMoney('0,125')).toBe(0.125);
    expect(parseTypedMoney('-0,125')).toBe(-0.125);
  });

  it('reads the office\u2019s figures at every money door (U28)', () => {
    expect(parseTypedMoney('1,200')).toBe(1200);
    expect(parseTypedMoney('12,500,000')).toBe(12_500_000);
    expect(parseTypedMoney('5,000.00')).toBe(5000);
    expect(parseTypedMoney('-1,200')).toBe(-1200);
  });

  it('refuses rather than inventing — and never answers NaN', () => {
    for (const junk of ['', '   ', 'abc', '12abc', '1,2,3', '$4800', '1..2', '—']) {
      expect(parseTypedMoney(junk), junk).toBeNull();
    }
  });
});
