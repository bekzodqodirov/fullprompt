import { describe, expect, it } from 'vitest';
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  FEED_LIMIT_DEFAULT,
  FEED_LIMIT_MAX,
  HASH_RULE,
  hashTail,
  parseSince,
  saltIdFor,
} from '@/modules/wms/crm/agent-feed';
import { parseReasonList, reasonListValid } from '@/modules/platform/settings/reason-list';
import { isReminderExempt, REMINDER_EXEMPT_SOURCES } from '@/modules/wms/crm/first-contact';
import { AGENT_SOURCE_KEY, inboundSourceKey } from '@/modules/wms/crm/inbound';

/**
 * The agent feeds' pure half (docs/AGENT-FEED.md): the hash both sides must
 * compute identically, the cursor codec, the setting's parser and the two
 * one-line rules about the `agent` key.
 *
 * The hash vector was computed OUTSIDE this code, once, with openssl —
 *   printf '%s' 901234567 | openssl dgst -sha256 -hmac k
 * — so a test that restated `createHmac` could not agree with a broken one
 * (#166). The Python side pins the same vector.
 */

describe('the phone hash', () => {
  it('is the documented rule, byte for byte', () => {
    expect(hashTail('k', '901234567')).toBe('2ea6869e504cebca50f0');
    expect(HASH_RULE).toBe('hmac-sha256(secret, last9digits) hex[0:20]');
  });

  it('salt_id is eight hex characters of the key and moves when the key is re-minted', () => {
    // printf '%s' k | openssl dgst -sha256
    expect(saltIdFor('k')).toBe('8254c329');
    expect(saltIdFor('k')).toMatch(/^[0-9a-f]{8}$/);
    expect(saltIdFor('another key')).not.toBe(saltIdFor('k'));
  });
});

describe('the cursor', () => {
  const at = '2026-10-24T05:06:07.123456Z';
  const id = '01928c3e-7b1a-7cc0-9d2e-1f0a2b3c4d5e';

  it('round-trips the instant at postgres precision, the id and the phone position', () => {
    expect(decodeCursor(encodeCursor({ at, id, n: 2 }))).toEqual({ at, id, n: 2 });
  });

  it('reads a two-part cursor as position 0', () => {
    const raw = Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
    expect(decodeCursor(raw)).toEqual({ at, id, n: 0 });
  });

  it('absent is null; anything unreadable is «invalid», never a throw', () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('')).toBeNull();
    const enc = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
    for (const raw of [
      'garbage!!',
      enc('no separator'),
      enc(`${at}|not-a-uuid`),
      enc(`yesterday|${id}`),
      enc(`2026-02-30T00:00:00Z|${id}`),
      enc(`${at}|${id}|-1`),
      enc(`${at}|${id}|1|extra`),
      enc(`2026-10-24 05:06:07|${id}`),
    ]) {
      expect(decodeCursor(raw), raw).toBe('invalid');
    }
  });

  it('since is an ISO instant or «invalid»', () => {
    expect(parseSince(null)).toBeNull();
    expect(parseSince('2026-10-24T05:00:00+05:00')).toBe('2026-10-24T00:00:00.000Z');
    expect(parseSince('soon')).toBe('invalid');
  });
});

describe('the page size', () => {
  it('defaults, floors and caps', () => {
    expect(clampLimit(null)).toBe(FEED_LIMIT_DEFAULT);
    expect(clampLimit('0')).toBe(1000);
    expect(clampLimit('abc')).toBe(1000);
    expect(clampLimit('99999')).toBe(FEED_LIMIT_MAX);
    expect(clampLimit('99999')).toBe(5000);
    expect(clampLimit('7')).toBe(7);
    // A fractional limit would reach postgres as `LIMIT 8.5`.
    expect(clampLimit('7.5')).toBe(7);
    expect(clampLimit('-3')).toBe(1);
  });
});

describe('agent_no_contact_reasons', () => {
  it('splits on «;», trims, lower-cases, de-duplicates and drops stubs', () => {
    expect(parseReasonList(' Qayta qilinmasin ; NARX;;')).toEqual(['qayta qilinmasin', 'narx']);
    expect(parseReasonList('Qayta   qilinmasin;qayta qilinmasin;x')).toEqual(['qayta qilinmasin']);
  });

  it('never throws on what reached the table by hand', () => {
    for (const raw of [null, undefined, 42, ['a'], { a: 1 }]) {
      expect(parseReasonList(raw)).toEqual([]);
    }
  });

  it('the settings screen refuses an empty list and an absurd label', () => {
    expect(reasonListValid('')).toBe(false);
    expect(reasonListValid(' ; ;')).toBe(false);
    expect(reasonListValid('Qayta qilinmasin')).toBe(true);
    expect(reasonListValid(`Qayta qilinmasin;${'x'.repeat(81)}`)).toBe(false);
  });
});

describe('the agent key', () => {
  it('is the one source whose arrivals are measured but never reminded', () => {
    expect(isReminderExempt('agent')).toBe(true);
    expect(isReminderExempt('tiktok')).toBe(false);
    expect(isReminderExempt(null)).toBe(false);
    expect([...REMINDER_EXEMPT_SOURCES]).toEqual([AGENT_SOURCE_KEY]);
  });

  it('only the webhook may claim it — a person through the form or the bot lands under «Boshqa»', () => {
    expect(inboundSourceKey('agent', 'webhook')).toBe('agent');
    expect(inboundSourceKey('agent', 'form')).toBe('other');
    expect(inboundSourceKey('agent', 'telegram')).toBe('other');
    expect(inboundSourceKey('agent', 'site')).toBe('other');
    // …and every other key is exactly what it was.
    expect(inboundSourceKey('tiktok', 'form')).toBe('tiktok');
    expect(inboundSourceKey('tiktok', 'webhook')).toBe('tiktok');
    expect(inboundSourceKey('nonsense', 'webhook')).toBe('other');
    expect(inboundSourceKey(null, 'form')).toBe('other');
  });
});
