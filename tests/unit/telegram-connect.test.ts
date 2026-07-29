import { describe, expect, it } from 'vitest';
import {
  connectConfig,
  connectErrorCode,
  normalizeTgPhone,
  PENDING_TTL_MS,
  pendingExpired,
} from '@/modules/wms/crm/telegram-connect';

/**
 * The connect flow's decisions, without a network — the tg-import
 * discipline: gramjs glue stays thin because everything decidable lives
 * here and is proved here.
 */

describe('the phone a login may be asked for', () => {
  it('accepts an international number, with the junk people paste stripped', () => {
    expect(normalizeTgPhone('+998901234567')).toBe('+998901234567');
    expect(normalizeTgPhone(' +998 90 123-45-67 ')).toBe('+998901234567');
    expect(normalizeTgPhone('+86 (139) 5850-0000')).toBe('+8613958500000');
  });

  it('refuses what Telegram would refuse louder', () => {
    expect(normalizeTgPhone('998901234567')).toBeNull(); // no plus
    expect(normalizeTgPhone('+998')).toBeNull(); // too short
    expect(normalizeTgPhone('salom')).toBeNull();
    expect(normalizeTgPhone('')).toBeNull();
  });
});

describe('telegram errors folded to screen words', () => {
  it('names the cases a person can act on', () => {
    expect(connectErrorCode('SESSION_PASSWORD_NEEDED')).toBe('password_needed');
    expect(connectErrorCode('400: PHONE_CODE_INVALID (caused by auth.SignIn)')).toBe(
      'code_invalid',
    );
    expect(connectErrorCode('PHONE_CODE_EXPIRED')).toBe('code_invalid');
    expect(connectErrorCode('PASSWORD_HASH_INVALID')).toBe('password_invalid');
    expect(connectErrorCode('PHONE_NUMBER_INVALID')).toBe('phone_invalid');
    expect(connectErrorCode('A wait of 30 seconds is required (FLOOD_WAIT_30)')).toBe(
      'flood_wait',
    );
  });

  it('everything else is an honest "failed", never a crash', () => {
    expect(connectErrorCode('TIMEOUT')).toBe('failed');
    expect(connectErrorCode('')).toBe('failed');
  });
});

describe('a half-finished login expires', () => {
  it('lives exactly as long as the code does', () => {
    const t0 = 1_700_000_000_000;
    expect(pendingExpired(t0, t0 + PENDING_TTL_MS - 1)).toBe(false);
    expect(pendingExpired(t0, t0 + PENDING_TTL_MS + 1)).toBe(true);
  });
});

describe('the server must be set up before anybody types a code', () => {
  it('refuses without the API pair — checked FIRST, wasting nobody`s code', () => {
    expect(connectConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(connectConfig({ TELEGRAM_API_ID: '123' } as NodeJS.ProcessEnv)).toBeNull();
    expect(
      // The API pair alone is still not enough: without TG_SESSION_KEY the
      // finished login could not be stored, and finding that out AFTER the
      // code is typed is the tg-login mistake this guards against.
      connectConfig({ TELEGRAM_API_ID: '123', TELEGRAM_API_HASH: 'abc' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});
