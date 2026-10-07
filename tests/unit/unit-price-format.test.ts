import { describe, expect, it } from 'vitest';
import { kg, unitPrice } from '@/components/charts/format';

/**
 * A baza per unit is never «$0»: his file declares a button at $0.0004 a
 * piece, and a chip that rounds it to whole dollars is a price nobody
 * declared (D1).
 */
describe('unitPrice', () => {
  it('prints what the column holds, at the size a person reads', () => {
    expect(unitPrice(0.1664)).toBe('$0.1664');
    expect(unitPrice(0.0004)).toBe('$0.0004');
    expect(unitPrice(0.17)).toBe('$0.17');
    expect(unitPrice(0.5)).toBe('$0.50');
    expect(unitPrice(0.123)).toBe('$0.123');
    expect(unitPrice(1.7548)).toBe('$1.75');
    expect(unitPrice(2.4)).toBe('$2.40');
    expect(unitPrice(235000)).toBe('$235,000');
  });

  it('is never «$0» for any positive value', () => {
    for (let v = 0.0001; v < 2000; v *= 1.37) {
      const text = unitPrice(v);
      expect(text, String(v)).not.toBe('$0');
      expect(Number(text.replace(/[$,]/g, '')), String(v)).toBeGreaterThan(0);
    }
  });
});

/**
 * The per-piece weight beside his ±25 % line. `num(v, 3)` labelled a 0.4 g
 * button «0 kg» and rounded a 0.6 g one to «0.001»: the band itself was
 * right, its label named a weight no piece has.
 */
describe('kg', () => {
  it('prints a light piece as what it weighs', () => {
    expect(kg(0.0004)).toBe('0.0004');
    expect(kg(0.0006)).toBe('0.0006');
    expect(kg(0.00045)).toBe('0.00045');
    expect(kg(0.0125)).toBe('0.0125');
    expect(kg(0.5)).toBe('0.5');
    expect(kg(1)).toBe('1');
    expect(kg(1.234)).toBe('1.23');
    expect(kg(1250)).toBe('1,250');
  });

  it('is never «0» for any positive weight', () => {
    for (let v = 0.000001; v < 5000; v *= 1.37) {
      const text = kg(v);
      expect(text, String(v)).not.toBe('0');
      expect(Number(text.replace(/,/g, '')), String(v)).toBeGreaterThan(0);
    }
  });
});
