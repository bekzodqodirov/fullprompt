import { describe, expect, it } from 'vitest';
import {
  adSourceFromPayload,
  adVisitFor,
  clearAdVisit,
  rememberAdVisit,
} from '@/modules/platform/telegram/ad-intake';

/**
 * The bot's advert door: `t.me/<bot>?start=ad_instagram`.
 *
 * The payload is a stranger's string and it arrives on the same handler as the
 * staff link codes and the cabinet codes, so what it must NOT do is as
 * important as what it does.
 */

describe('the deep-link payload', () => {
  it('reads the source an advert named', () => {
    expect(adSourceFromPayload('ad_instagram')).toBe('instagram');
    expect(adSourceFromPayload('ad-telegram')).toBe('telegram');
    expect(adSourceFromPayload('AD_TikTok')).toBe('tiktok');
    expect(adSourceFromPayload(' ad_sayt ')).toBe('sayt');
  });

  it('does not answer for anything that is not an advert', () => {
    // A staff link code and a client cabinet code arrive at the very same
    // handler, and treating one of those as an advert would swallow the link.
    for (const payload of [undefined, null, '', 'a1b2c3d4', 'ad_', 'ad', 'read_me', 'x_ad_form']) {
      expect(adSourceFromPayload(payload)).toBeNull();
    }
  });

  it('refuses a payload long or strange enough to be an attack on the source list', () => {
    expect(adSourceFromPayload(`ad_${'x'.repeat(40)}`)).toBeNull();
    expect(adSourceFromPayload("ad_'; drop table leads--")).toBeNull();
  });
});

describe('remembering the visit', () => {
  it('holds the source until the enquiry lands, then forgets it', () => {
    rememberAdVisit(4242, 'instagram');
    expect(adVisitFor(4242)).toBe('instagram');
    clearAdVisit(4242);
    // Cleared on BOTH paths: an enquiry that landed, and a visitor who turned
    // out to be an existing customer and got the cabinet instead. A visit left
    // behind would make their next contact look like a fresh advert lead.
    expect(adVisitFor(4242)).toBeNull();
  });

  it('knows nothing about a chat that did not come from an advert', () => {
    expect(adVisitFor(999_001)).toBeNull();
  });
});
