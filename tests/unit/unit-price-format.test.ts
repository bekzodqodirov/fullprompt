import { describe, expect, it } from 'vitest';
import { unitPrice } from '@/components/charts/format';

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
