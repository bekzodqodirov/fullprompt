import { describe, expect, it } from 'vitest';
import {
  phoneBelongsToClient,
  phoneDigits,
  phonesMatch,
} from '@/modules/wms/client-cabinet/service';

/** Cabinet phone verification (owner's wrong-recipient incident). */
describe('phone matching', () => {
  it('normalizes formatting to digits', () => {
    expect(phoneDigits('+998 90 175-78-00')).toBe('998901757800');
    expect(phoneDigits('(90) 175 78 00')).toBe('901757800');
  });

  it('matches the same number in different formats', () => {
    expect(phonesMatch('+998901757800', '90 175 78 00')).toBe(true);
    expect(phonesMatch('998901757800', '+998-90-175-78-00')).toBe(true);
    expect(phonesMatch('+821067085587', '82 10 6708 5587')).toBe(true);
  });

  it('rejects different numbers — including the incident pair', () => {
    // Owner's incident: +8210... person opened +99890... client's link.
    expect(phonesMatch('+821067085587', '+998901757800')).toBe(false);
    expect(phonesMatch('+998901757800', '+998901757801')).toBe(false);
  });

  it('rejects degenerate values', () => {
    expect(phonesMatch('', '+998901757800')).toBe(false);
    expect(phonesMatch('12345', '12345')).toBe(false);
  });

  it('checks against all of the client registered phones', () => {
    const phones = ['+998 90 175 78 00', '+998911234567'];
    expect(phoneBelongsToClient('998911234567', phones)).toBe(true);
    expect(phoneBelongsToClient('+821067085587', phones)).toBe(false);
    expect(phoneBelongsToClient('+998901757800', [])).toBe(false);
    expect(phoneBelongsToClient('+998901757800', null)).toBe(false);
  });
});
