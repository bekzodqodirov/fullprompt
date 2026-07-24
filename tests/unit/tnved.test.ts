import { describe, expect, it } from 'vitest';
import { isValidTnved, productKey } from '@/modules/wms/tnved/service';

describe('tnved memory helpers (Phase 1.5)', () => {
  it('normalizes product names into one key', () => {
    expect(productKey(' 化妆品 ')).toBe('化妆品');
    expect(productKey('LED  Lamp')).toBe('led lamp');
    expect(productKey('化妆品')).toBe(productKey('化妆品  '));
  });

  it('accepts 4-10 digit codes only', () => {
    expect(isValidTnved('8471300000')).toBe(true);
    expect(isValidTnved('3304')).toBe(true);
    expect(isValidTnved(' 8471300000 ')).toBe(true);
    expect(isValidTnved('847')).toBe(false);
    expect(isValidTnved('84713000001')).toBe(false);
    expect(isValidTnved('8471-30')).toBe(false);
    expect(isValidTnved('')).toBe(false);
  });
});
