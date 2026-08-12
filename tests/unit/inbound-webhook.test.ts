import { describe, expect, it } from 'vitest';
import {
  metaSourceKey,
  parseInboundPayload,
  refWithoutSecret,
  secretFrom,
  secretMatches,
} from '@/modules/wms/crm/inbound-webhook';

/**
 * Round 86b's universal advert door, decided without a network.
 *
 * Every body here is a stranger's JSON: nothing below may throw on any input,
 * which is why the odd shapes are tested beside the real ones.
 */

describe('parseInboundPayload — Google Ads (and therefore YouTube)', () => {
  const google = {
    lead_id: '9876543210',
    api_version: 'v1.0',
    form_id: 12345,
    campaign_id: 999,
    google_key: 'the-secret',
    user_column_data: [
      { column_id: 'FULL_NAME', string_value: 'Aziz Karimov' },
      { column_id: 'PHONE_NUMBER', string_value: '+998 90 111 22 33' },
      { column_id: 'CITY', string_value: 'Toshkent' },
    ],
  };

  it('reads the name, the phone and Google’s own lead id', () => {
    const fields = parseInboundPayload(google);
    expect(fields.name).toBe('Aziz Karimov');
    expect(fields.phone).toBe('+998 90 111 22 33');
    expect(fields.externalId).toBe('9876543210');
  });

  it('keeps a question it does not recognise instead of dropping it', () => {
    // «What did they actually ask for» is the first thing the seller wants.
    expect(parseInboundPayload(google).note).toContain('Toshkent');
  });

  it('joins first and last name when there is no full name', () => {
    const fields = parseInboundPayload({
      user_column_data: [
        { column_id: 'FIRST_NAME', string_value: 'Aziz' },
        { column_id: 'LAST_NAME', string_value: 'Karimov' },
      ],
    });
    expect(fields.name).toBe('Aziz Karimov');
    // …and the name parts do not also end up in the note.
    expect(fields.note).toBeNull();
  });
});

describe('parseInboundPayload — the plain shape', () => {
  it('reads a website’s or connector’s post, in either language', () => {
    expect(parseInboundPayload({ name: 'Aziz', phone: '901112233' })).toMatchObject({
      name: 'Aziz',
      phone: '901112233',
    });
    expect(parseInboundPayload({ ism: 'Aziz', telefon: '901112233' })).toMatchObject({
      name: 'Aziz',
      phone: '901112233',
    });
  });

  it('keeps the sender’s extra fields in the note', () => {
    const fields = parseInboundPayload({
      name: 'Aziz',
      phone: '901112233',
      note: 'Yiwudan',
      utm_campaign: 'bahor',
    });
    expect(fields.note).toContain('Yiwudan');
    expect(fields.note).toContain('bahor');
    // …and as pairs, the tarjimon's raw material.
    expect(fields.fields).toEqual([{ key: 'utm_campaign', value: 'bahor' }]);
  });

  it('NEVER copies the shared secret into the note or the pairs', () => {
    // `secretFrom` READS the key from these very body fields — a documented,
    // first-class way to authenticate. Until round 97 that same key then fell
    // through to the note as «key: …» and sat on the lead's lenta, where
    // refWithoutSecret's fence never reaches. Same names, same
    // case-insensitivity, both fences.
    const fields = parseInboundPayload({
      name: 'Aziz',
      phone: '901112233',
      key: 'THE-SECRET',
      google_key: 'THE-SECRET',
      Token: 'THE-SECRET',
      secret: 'THE-SECRET',
      utm_campaign: 'bahor',
    });
    expect(JSON.stringify(fields)).not.toContain('THE-SECRET');
    expect(fields.note).toContain('bahor');
  });

  it('throws on nothing — a stranger may post anything at all', () => {
    for (const body of [null, undefined, 42, 'text', [], [1, 2], { user_column_data: 'no' }]) {
      expect(() => parseInboundPayload(body)).not.toThrow();
    }
    expect(parseInboundPayload(null)).toMatchObject({ name: null, phone: null });
  });
});

describe('secretFrom', () => {
  it('prefers the header, and falls back to the body because Google has no header', () => {
    expect(secretFrom({ google_key: 'body' }, 'header')).toBe('header');
    expect(secretFrom({ google_key: 'body' }, null)).toBe('body');
    expect(secretFrom({ key: 'body' }, '   ')).toBe('body');
    expect(secretFrom({}, null)).toBeNull();
  });
});

describe('secretMatches', () => {
  it('matches an identical secret and nothing else', () => {
    expect(secretMatches('abc123', 'abc123')).toBe(true);
    expect(secretMatches('abc124', 'abc123')).toBe(false);
  });

  it('a different LENGTH is false, not a crash — timingSafeEqual throws', () => {
    // A throw here is a 500, and every platform reads a 500 as "send it again".
    expect(() => secretMatches('short', 'muchlongersecret')).not.toThrow();
    expect(secretMatches('short', 'muchlongersecret')).toBe(false);
  });

  it('an absent secret on either side is false, never “matches nothing”', () => {
    expect(secretMatches(null, 'abc')).toBe(false);
    expect(secretMatches('abc', null)).toBe(false);
    expect(secretMatches(null, null)).toBe(false);
    expect(secretMatches('', '')).toBe(false);
  });
});

describe('refWithoutSecret', () => {
  it('keeps the campaign trail and drops the key Google puts in the body', () => {
    const ref = refWithoutSecret({
      lead_id: '1',
      campaign_id: 'bahor',
      google_key: 'THE-SECRET',
      key: 'also',
      Secret: 'ALSO',
      TOKEN: 'ALSO',
    });
    expect(ref).toMatchObject({ lead_id: '1', campaign_id: 'bahor' });
    // Stored verbatim it would sit in the arrivals table and in every nightly
    // backup, where it can never be taken back.
    expect(JSON.stringify(ref)).not.toContain('SECRET');
    expect(JSON.stringify(ref)).not.toContain('ALSO');
    expect(JSON.stringify(ref)).not.toContain('also');
  });

  it('is null for anything that is not an object', () => {
    expect(refWithoutSecret([1, 2])).toBeNull();
    expect(refWithoutSecret('text')).toBeNull();
    expect(refWithoutSecret(null)).toBeNull();
  });
});

describe('metaSourceKey', () => {
  it('tells Instagram from Facebook, because they are different adverts', () => {
    expect(metaSourceKey('ig')).toBe('instagram');
    expect(metaSourceKey('IG')).toBe('instagram');
    expect(metaSourceKey('instagram')).toBe('instagram');
    expect(metaSourceKey('fb')).toBe('facebook');
    expect(metaSourceKey('facebook')).toBe('facebook');
  });

  it('stays «meta» when Meta says nothing or says something new', () => {
    // Guessing would put a lie into the one report that answers which advert
    // is worth paying for; «a Meta advert» is still true.
    expect(metaSourceKey(undefined)).toBe('meta');
    expect(metaSourceKey(null)).toBe('meta');
    expect(metaSourceKey('threads')).toBe('meta');
    expect(metaSourceKey(42)).toBe('meta');
  });
});
