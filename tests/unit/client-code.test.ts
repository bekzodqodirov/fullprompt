import { describe, expect, it } from 'vitest';

/** Mirrors the validation in clients/actions.ts (spec 5.2: `{prefix}{digits}`). */
function isValidClientCode(code: string, prefix: string): boolean {
  return new RegExp(`^${prefix}\\d+$`).test(code);
}

describe('client code format (spec 5.2, §17 client_code_prefix)', () => {
  it('accepts prefix + digits', () => {
    expect(isValidClientCode('GS777', 'GS')).toBe(true);
    expect(isValidClientCode('GS1', 'GS')).toBe(true);
  });

  it('rejects wrong prefix, letters after prefix, empty digits', () => {
    expect(isValidClientCode('AB777', 'GS')).toBe(false);
    expect(isValidClientCode('GS77A', 'GS')).toBe(false);
    expect(isValidClientCode('GS', 'GS')).toBe(false);
    expect(isValidClientCode('777', 'GS')).toBe(false);
  });

  it('respects a changed prefix setting', () => {
    expect(isValidClientCode('KG42', 'KG')).toBe(true);
    expect(isValidClientCode('GS42', 'KG')).toBe(false);
  });
});
