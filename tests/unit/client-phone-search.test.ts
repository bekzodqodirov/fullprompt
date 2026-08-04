import { describe, expect, it } from 'vitest';
import { phoneDigits, phoneNeedle } from '@/modules/platform/clients/phone';

/**
 * Finding a client by the number that is ringing.
 *
 * Every case here is a way the office actually writes a phone number — the
 * import parser found eight of them in one spreadsheet — plus the two ways
 * this can go wrong: matching nothing because the country code differs, and
 * matching everything because somebody typed a short number.
 */
describe('phone search', () => {
  it('reduces every format the office uses to the same digits', () => {
    expect(phoneDigits('+998 90 175-78-00')).toBe('998901757800');
    expect(phoneDigits('(90) 175 78 00')).toBe('901757800');
    expect(phoneDigits('90.175.78.00')).toBe('901757800');
  });

  it('finds the same person whether or not the country code was typed', () => {
    // The card is stored one way and the manager types the other; both must
    // land on the same nine digits (DECISIONS #111).
    expect(phoneNeedle('+998 90 175 78 00')).toBe('901757800');
    expect(phoneNeedle('901757800')).toBe('901757800');
    expect(phoneNeedle('998901757800')).toBe('901757800');
  });

  it('accepts a partial number, because people read the last digits aloud', () => {
    expect(phoneNeedle('1757800')).toBe('1757800');
    expect(phoneNeedle('75 78 00')).toBe('757800');
  });

  it('refuses to treat a short number as a phone at all', () => {
    // Otherwise a search for a client CODE like "444" runs a phone match that
    // returns half the book and buries the code hit it was meant to help.
    expect(phoneNeedle('123')).toBeNull();
    expect(phoneNeedle('GS777')).toBeNull();
    expect(phoneNeedle('')).toBeNull();
    expect(phoneNeedle('kassa')).toBeNull();
  });

  it('keeps a foreign number distinct rather than padding it', () => {
    // A Korean number and an Uzbek one must not collapse into each other —
    // the owner's wrong-recipient incident was exactly this shape.
    expect(phoneNeedle('+82 10 6708 5587')).toBe('1067085587'.slice(-9));
    expect(phoneNeedle('+82 10 6708 5587')).not.toBe(phoneNeedle('+998 90 175 78 00'));
  });
});
