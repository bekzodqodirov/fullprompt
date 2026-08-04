import { describe, expect, it } from 'vitest';
import { MIN_QUERY, likeNeedle, parseQuery } from '@/modules/wms/search/query';

/**
 * What the search box makes of what was typed.
 *
 * Pure on purpose: the shape of a query decides which searches run at all, so
 * getting it wrong is the difference between one indexed lookup and eight
 * scans on every keystroke.
 */

describe('parseQuery', () => {
  it('ignores anything shorter than two characters', () => {
    expect(parseQuery('a').ok).toBe(false);
    expect(parseQuery('  ').ok).toBe(false);
    expect(MIN_QUERY).toBe(2);
  });

  it('reads the combined lot form the warehouse says out loud', () => {
    expect(parseQuery('gs777-a').lot).toEqual({ clientCode: 'GS777', letter: 'A' });
    expect(parseQuery(' GS102-BC ').lot).toEqual({ clientCode: 'GS102', letter: 'BC' });
  });

  it('does not mistake a batch code for a lot', () => {
    // `YW-001` is a truck; the lot form is letters+digits then LETTERS.
    expect(parseQuery('YW-001').lot).toBeUndefined();
    expect(parseQuery('YW-001').batchCode).toBe(true);
  });

  it('takes the last nine digits when it looks like a phone', () => {
    expect(parseQuery('+998 90 123 45 67').phone).toBe('901234567');
    expect(parseQuery('901234567').phone).toBe('901234567');
  });

  it('does not call a short run of digits a phone number', () => {
    // A quantity, a box count, a code — nine is the subscriber length (#111).
    expect(parseQuery('12345').phone).toBeUndefined();
  });

  it('recognises a client code so the code search runs first', () => {
    expect(parseQuery('GS777').clientCode).toBe(true);
    expect(parseQuery('Bobur').clientCode).toBe(false);
  });
});

describe('likeNeedle', () => {
  it('escapes the wildcards, so a typed % does not match everything', () => {
    expect(likeNeedle('50%')).toBe('%50\\%%');
    expect(likeNeedle('a_b')).toBe('%a\\_b%');
    expect(likeNeedle('GS7')).toBe('%GS7%');
  });
});
