import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  openSession,
  sealSession,
  SessionKeyError,
  sessionKey,
  sessionOpens,
} from '@/modules/wms/crm/telegram-session';

/**
 * This protects a manager's PERSONAL Telegram account, so the tests are about
 * what must not work, not about the round trip.
 */

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const OWNER = '019fa64c-0eb0-75d8-9ed5-5fdcc8ccf688';
const SESSION = '1BQANOTEuMTA4LjU2LjEzMAG7fake-session-string-for-a-test';

describe('sealing a Telegram session', () => {
  it('comes back exactly as it went in', () => {
    expect(openSession(sealSession(SESSION, OWNER, KEY), OWNER, KEY)).toBe(SESSION);
  });

  it('never stores the session in the clear', () => {
    const sealed = sealSession(SESSION, OWNER, KEY);
    expect(sealed).not.toContain(SESSION);
    // Not even a recognisable fragment: a Telegram session string is a
    // base64-ish blob and a partial leak is still a leak.
    expect(sealed).not.toContain(SESSION.slice(0, 16));
  });

  it('is different every time, so two managers cannot be compared by eye', () => {
    // A fresh IV per seal. Equal ciphertexts would say "these two accounts are
    // the same account" to anybody who can read the table.
    expect(sealSession(SESSION, OWNER, KEY)).not.toBe(sealSession(SESSION, OWNER, KEY));
  });

  it('refuses to open with the wrong key', () => {
    const sealed = sealSession(SESSION, OWNER, KEY);
    expect(() => openSession(sealed, OWNER, OTHER_KEY)).toThrow();
  });

  it('refuses to open for a different owner', () => {
    // The point of the AAD: a row lifted from one manager to another must not
    // decrypt, or write access to one table becomes read access to somebody
    // else's private conversations.
    const sealed = sealSession(SESSION, OWNER, KEY);
    expect(() => openSession(sealed, '019fa657-2376-7518-a9d1-268fb2f1b17c', KEY)).toThrow();
  });

  it('refuses a row that has been edited', () => {
    const sealed = sealSession(SESSION, OWNER, KEY);
    const [v, iv, tag, body] = sealed.split('.');
    const flipped = Buffer.from(body!, 'base64');
    flipped[0] = flipped[0]! ^ 0x01;
    const tampered = [v, iv, tag, flipped.toString('base64')].join('.');
    // GCM authenticates: this must throw, not decrypt to nonsense.
    expect(() => openSession(tampered, OWNER, KEY)).toThrow();
  });

  it('refuses anything that is not in the stored format', () => {
    expect(() => openSession('', OWNER, KEY)).toThrow(SessionKeyError);
    expect(() => openSession(SESSION, OWNER, KEY)).toThrow(SessionKeyError);
    expect(() => openSession('v2.a.b.c', OWNER, KEY)).toThrow(SessionKeyError);
  });

  it('answers whether a blob still opens, without throwing', () => {
    const sealed = sealSession(SESSION, OWNER, KEY);
    expect(sessionOpens(sealed, OWNER, KEY)).toBe(true);
    expect(sessionOpens(sealed, OWNER, OTHER_KEY)).toBe(false);
  });
});

describe('the key itself', () => {
  it('says what to do when it is missing', () => {
    // The message is the documentation for whoever hits this at 2 a.m.
    expect(() => sessionKey('')).toThrow(/openssl rand -base64 32/);
    expect(() => sessionKey(undefined)).toThrow(SessionKeyError);
  });

  it('rejects a key that is too short instead of silently weakening', () => {
    // 16 bytes would be accepted by node as AES-128 without a word.
    expect(() => sessionKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('accepts a proper 32-byte key', () => {
    expect(sessionKey(KEY.toString('base64'))).toEqual(KEY);
  });
});
