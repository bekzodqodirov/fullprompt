import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  connectConfig,
  connectErrorCode,
  finishLogin,
  normalizeTgCode,
  normalizeTgPhone,
  PENDING_TTL_MS,
  pendingExpired,
  type LoginSteps,
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
    // An expired code cannot be fixed by retyping it — the attempt ends and
    // the screen asks for a new code (it used to say «check and retype»).
    expect(connectErrorCode('PHONE_CODE_EXPIRED')).toBe('expired');
    expect(connectErrorCode('AUTH_RESTART')).toBe('expired');
    expect(connectErrorCode('PHONE_CODE_EMPTY')).toBe('code_invalid');
    expect(connectErrorCode('PHONE_NUMBER_UNOCCUPIED')).toBe('phone_unregistered');
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
    expect(connectConfig({})).toBeNull();
    expect(connectConfig({ TELEGRAM_API_ID: '123' })).toBeNull();
    expect(
      // The API pair alone is still not enough: without TG_SESSION_KEY the
      // finished login could not be stored, and finding that out AFTER the
      // code is typed is the tg-login mistake this guards against.
      connectConfig({ TELEGRAM_API_ID: '123', TELEGRAM_API_HASH: 'abc' }),
    ).toBeNull();
  });
});

describe('the code a login may be finished with', () => {
  it('is its digits — the space in «12 345» and a pasted dot are not part of it', () => {
    expect(normalizeTgCode('12345')).toBe('12345');
    expect(normalizeTgCode(' 12 345. ')).toBe('12345');
    expect(normalizeTgCode('')).toBe('');
  });
});

/**
 * A stand-in for Telegram's two network steps, recording what it was asked.
 * `signIn` behaves like a two-step account unless told otherwise: the right
 * code is taken and answered SESSION_PASSWORD_NEEDED.
 */
function telegram(opts: { twoStep?: boolean; code?: string; password?: string } = {}) {
  const { twoStep = true, code = '12345', password = 'sirli' } = opts;
  const calls: string[] = [];
  const steps: LoginSteps = {
    async signIn(given) {
      calls.push(`signIn:${given}`);
      if (given === '') throw new Error('400: PHONE_CODE_EMPTY (caused by auth.SignIn)');
      if (given !== code) throw new Error('400: PHONE_CODE_INVALID (caused by auth.SignIn)');
      if (twoStep) throw new Error('401: SESSION_PASSWORD_NEEDED (caused by auth.SignIn)');
    },
    async checkPassword(given) {
      calls.push(`checkPassword:${given}`);
      if (given !== password) throw new Error('400: PASSWORD_HASH_INVALID (caused by auth.CheckPassword)');
    },
  };
  return { steps, calls };
}

describe('finishing a login — which step a press is', () => {
  it('a two-step account: the code is taken once, then the password ALONE finishes it', async () => {
    const tg = telegram();
    const login = { codeAccepted: false };
    // First press: the right code, no password yet.
    expect(await finishLogin(login, tg.steps, '12345', undefined)).toEqual({
      ok: false,
      error: 'password_needed',
      alive: true,
    });
    expect(login.codeAccepted).toBe(true);
    // Second press: the form's code box was emptied by the first press, and
    // the password is what the person typed. The code must NOT go again.
    expect(await finishLogin(login, tg.steps, '', 'sirli')).toEqual({ ok: true });
    expect(tg.calls).toEqual(['signIn:12345', 'checkPassword:sirli']);
  });

  it('a wrong password keeps the login for another try, and the code is still not resent', async () => {
    const tg = telegram();
    const login = { codeAccepted: false };
    await finishLogin(login, tg.steps, '12345', undefined);
    expect(await finishLogin(login, tg.steps, '', 'notog')).toEqual({
      ok: false,
      error: 'password_invalid',
      alive: true,
    });
    expect(await finishLogin(login, tg.steps, '', 'sirli')).toEqual({ ok: true });
    expect(tg.calls.filter((c) => c.startsWith('signIn'))).toEqual(['signIn:12345']);
  });

  it('an account with no password finishes on the code, and is never asked for one', async () => {
    const tg = telegram({ twoStep: false });
    expect(await finishLogin({ codeAccepted: false }, tg.steps, '12 345', undefined)).toEqual({
      ok: true,
    });
    expect(tg.calls).toEqual(['signIn:12345']);
  });

  it('a wrong code keeps the login; an empty one is refused without asking Telegram', async () => {
    const tg = telegram({ twoStep: false });
    const login = { codeAccepted: false };
    expect(await finishLogin(login, tg.steps, '  ', undefined)).toEqual({
      ok: false,
      error: 'code_invalid',
      alive: true,
    });
    expect(await finishLogin(login, tg.steps, '54321', undefined)).toEqual({
      ok: false,
      error: 'code_invalid',
      alive: true,
    });
    expect(await finishLogin(login, tg.steps, '12345', undefined)).toEqual({ ok: true });
    expect(tg.calls).toEqual(['signIn:54321', 'signIn:12345']);
  });

  it('an expired code ends the attempt', async () => {
    const steps: LoginSteps = {
      async signIn() {
        throw new Error('400: PHONE_CODE_EXPIRED (caused by auth.SignIn)');
      },
      async checkPassword() {},
    };
    expect(await finishLogin({ codeAccepted: false }, steps, '12345', undefined)).toEqual({
      ok: false,
      error: 'expired',
      alive: false,
    });
  });
});

describe('every refusal has a sentence on the screen', () => {
  const source = readFileSync('src/modules/wms/crm/telegram-connect.ts', 'utf8');
  const union = /export type ConnectError =([^;]+);/.exec(source)?.[1] ?? '';
  const members = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

  it('the list is read out of the code, not restated', () => {
    expect(members).toContain('phone_taken');
    expect(members).toContain('failed');
  });

  it.each(['ru', 'uz', 'en', 'zh-CN'])('%s carries each one', (locale) => {
    const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as {
      crm: { connectErrors: Record<string, string> };
    };
    for (const member of members) {
      expect(bundle.crm.connectErrors[member], `${locale} connectErrors.${member}`).toBeTruthy();
    }
    // The taken number's sentence names the person holding it.
    expect(bundle.crm.connectErrors.phone_taken).toContain('{name}');
  });
});

describe('the connect form keeps what was typed', () => {
  // React resets an uncontrolled form when its action returns (#463): the
  // first press on a two-step account emptied the code box before the
  // password press. Source-shape on purpose — both versions render.
  const form = readFileSync('src/app/(protected)/suhbatlar/ulash/connect-form.tsx', 'utf8');
  it.each(['phone', 'code', 'password'])('the %s box is controlled', (name) => {
    // Up to the element's own `/>` — `onChange={(e) => …}` has a `>` inside.
    const input =
      new RegExp(`<input(?:(?!/>).)*?name="${name}"(?:(?!/>).)*/>`, 's').exec(form)?.[0] ?? '';
    expect(input, name).toContain('value={');
    expect(input, name).toContain('onChange=');
  });
});
