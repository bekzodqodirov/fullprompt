import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DELEGATED_USER_HEADER,
  DOWNLOAD_TTL_MS,
  INTERNAL_HEADER,
  delegatedUserId,
  internalKey,
  linkablePath,
  mintDownloadToken,
  readDownloadToken,
} from '@/modules/platform/auth/download-link';

/**
 * The download link (the owner, 2026-10-27: «download unsuccessful … 3 c») —
 * a signed address the phone's download manager can fetch without the login
 * cookie. Everything here is the signature's own arithmetic; the route that
 * serves it and the session that honours it have their own tests.
 */

const USER = '0193c2a4-1111-7222-8333-444455556666';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'unit-test-secret-long-enough';
});
afterEach(() => {
  if (saved === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = saved;
});

describe('which addresses a link may name', () => {
  it('takes a file route of this app with its query', () => {
    expect(linkablePath('/api/reports/stock?q=GS7&tek=ha')).toBe('/api/reports/stock?q=GS7&tek=ha');
    expect(linkablePath('/api/attachments/abc')).toBe('/api/attachments/abc');
  });

  it('refuses anything that is not /api/ on this origin, and the link route itself', () => {
    for (const bad of [
      '',
      '/admin/users',
      '//evil.example/api/x',
      'https://evil.example/api/x',
      '/api/../admin/users',
      '/api/dl/abc.def',
      '/api/dl',
      `/api/${'x'.repeat(3000)}`,
      42,
      null,
    ]) {
      expect(linkablePath(bad), String(bad).slice(0, 40)).toBeNull();
    }
  });
});

describe('a token', () => {
  it('round-trips the person and the path until its deadline', () => {
    const now = 1_800_000_000_000;
    const token = mintDownloadToken(USER, '/api/handovers/h1/act', now)!;
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(readDownloadToken(token, now + DOWNLOAD_TTL_MS)).toEqual({
      ok: true,
      grant: { userId: USER, path: '/api/handovers/h1/act' },
    });
    expect(readDownloadToken(token, now + DOWNLOAD_TTL_MS + 1)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a changed path, a changed signature and a different key', () => {
    const now = Date.now();
    const token = mintDownloadToken(USER, '/api/attachments/one', now)!;
    const [body, sig] = token.split('.') as [string, string];
    const other = Buffer.from(
      JSON.stringify({ u: USER, p: '/api/attachments/two', e: now + DOWNLOAD_TTL_MS }),
    ).toString('base64url');
    expect(readDownloadToken(`${other}.${sig}`, now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(readDownloadToken(`${body}.${sig.slice(0, -2)}AA`, now)).toEqual({ ok: false, reason: 'bad_signature' });
    // A short forgery is a «no», never a throw (timingSafeEqual's length rule).
    expect(readDownloadToken(`${body}.x`, now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(readDownloadToken('nodot', now)).toEqual({ ok: false, reason: 'malformed' });
    process.env.SESSION_SECRET = 'a-different-secret-entirely';
    expect(readDownloadToken(token, now)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('is never minted or honoured under a missing or guessable key', () => {
    const token = mintDownloadToken(USER, '/api/attachments/one')!;
    for (const weak of [undefined, '', 'short']) {
      if (weak === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = weak;
      expect(mintDownloadToken(USER, '/api/attachments/one')).toBeNull();
      expect(readDownloadToken(token)).toEqual({ ok: false, reason: 'no_key' });
      expect(internalKey()).toBeNull();
    }
  });
});

describe('the delegated user on the link route’s own request', () => {
  const headers = (map: Record<string, string>) => (name: string) => map[name] ?? null;

  it('is honoured only beside the process’s internal key', () => {
    const key = internalKey()!;
    expect(delegatedUserId(headers({ [INTERNAL_HEADER]: key, [DELEGATED_USER_HEADER]: USER }))).toBe(USER);
    expect(delegatedUserId(headers({ [DELEGATED_USER_HEADER]: USER }))).toBeNull();
    expect(delegatedUserId(headers({ [INTERNAL_HEADER]: `${key}x`, [DELEGATED_USER_HEADER]: USER }))).toBeNull();
    expect(delegatedUserId(headers({ [INTERNAL_HEADER]: 'short', [DELEGATED_USER_HEADER]: USER }))).toBeNull();
    // The ordinary request: no delegation header at all.
    expect(delegatedUserId(headers({ [INTERNAL_HEADER]: key }))).toBeNull();
  });

  it('is not the same value as any link signature (the two keys are separate purposes)', () => {
    const token = mintDownloadToken(USER, '/api/attachments/one')!;
    expect(token.split('.')[1]).not.toBe(internalKey());
  });
});
