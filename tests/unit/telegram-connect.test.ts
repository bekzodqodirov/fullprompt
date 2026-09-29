import { readFileSync } from 'node:fs';
import { Api } from 'telegram';
import { RPCMessageToError } from 'telegram/errors';
import { describe, expect, it } from 'vitest';
import {
  connectConfig,
  connectErrorCode,
  describeError,
  finishLogin,
  normalizeTgCode,
  normalizeTgPhone,
  PENDING_TTL_MS,
  pendingExpired,
  type LoginSteps,
} from '@/modules/wms/crm/telegram-connect';
import { afterFinish } from '@/app/(protected)/suhbatlar/ulash/connect-state';

/**
 * An error exactly as gramjs hands it to us — built by the LIBRARY from the
 * RPC name, never a string typed here. gramjs rewrites some of them (a
 * FLOOD_WAIT_n arrives as «A wait of n seconds is required»), and a test
 * that types its own message tests the typist, not the folding: the first
 * version of this file asserted «(FLOOD_WAIT_30)», a string gramjs never
 * produces, and stayed green while every real flood wait read «Bo'lmadi».
 */
function tgError(name: string): Error {
  return RPCMessageToError(
    new Api.RpcError({ errorCode: 400, errorMessage: name }),
    new Api.auth.SignIn({ phoneNumber: '+998901234567', phoneCodeHash: 'hash', phoneCode: '1' }),
  );
}

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
  });

  it('everything else is an honest "failed", never a crash', () => {
    expect(connectErrorCode('TIMEOUT')).toBe('failed');
    expect(connectErrorCode('')).toBe('failed');
  });

  it('a flood wait is a flood wait however gramjs words it', () => {
    // The long wait is the one a person must be told about: gramjs sleeps
    // through short ones by itself and throws only these.
    const long = tgError('FLOOD_WAIT_3600');
    expect(long.message).not.toContain('FLOOD'); // the premise: the name is gone from the message
    expect(connectErrorCode(describeError(long))).toBe('flood_wait');
    expect(describeError(long)).toContain('3600'); // …and the log still says how long
    expect(connectErrorCode(describeError(tgError('PHONE_PASSWORD_FLOOD')))).toBe('flood_wait');
    expect(connectErrorCode(describeError(tgError('PHONE_NUMBER_FLOOD')))).toBe('flood_wait');
  });

  it('the library-built names fold as their strings do', () => {
    expect(connectErrorCode(describeError(tgError('PHONE_CODE_EXPIRED')))).toBe('expired');
    expect(connectErrorCode(describeError(tgError('PASSWORD_HASH_INVALID')))).toBe(
      'password_invalid',
    );
    expect(connectErrorCode(describeError(new Error('socket hang up')))).toBe('failed');
    expect(describeError('plain')).toBe('plain');
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
 * code is taken and answered SESSION_PASSWORD_NEEDED. Its refusals are the
 * library's own errors (`tgError`), and a number with no Telegram account
 * gets the library's own sign-up ANSWER — a result, not a throw.
 */
function telegram(
  opts: { twoStep?: boolean; code?: string; password?: string; noAccount?: boolean } = {},
) {
  const { twoStep = true, code = '12345', password = 'sirli', noAccount = false } = opts;
  const calls: string[] = [];
  const steps: LoginSteps = {
    async signIn(given) {
      calls.push(`signIn:${given}`);
      if (given === '') throw tgError('PHONE_CODE_EMPTY');
      if (given !== code) throw tgError('PHONE_CODE_INVALID');
      if (noAccount) return new Api.auth.AuthorizationSignUpRequired({});
      if (twoStep) throw tgError('SESSION_PASSWORD_NEEDED');
      return undefined;
    },
    async checkPassword(given) {
      calls.push(`checkPassword:${given}`);
      if (given !== password) throw tgError('PASSWORD_HASH_INVALID');
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
    expect(await finishLogin(login, tg.steps, '', 'notog')).toMatchObject({
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
    expect(await finishLogin(login, tg.steps, '54321', undefined)).toMatchObject({
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
        throw tgError('PHONE_CODE_EXPIRED');
      },
      async checkPassword() {},
    };
    expect(await finishLogin({ codeAccepted: false }, steps, '12345', undefined)).toMatchObject({
      ok: false,
      error: 'expired',
      alive: false,
    });
  });

  it('a number with no Telegram account is refused — not stored, not ✅', async () => {
    // Telegram does not THROW for it: the right code comes back with a
    // request to sign up, and treating any answer as a login stored an
    // unauthorised session as `active`.
    const tg = telegram({ noAccount: true });
    expect(await finishLogin({ codeAccepted: false }, tg.steps, '12345', undefined)).toEqual({
      ok: false,
      error: 'phone_unregistered',
      alive: false,
      raw: 'auth.AuthorizationSignUpRequired',
    });
  });

  it('a long flood wait on the code ends the attempt and is called by its name', async () => {
    const steps: LoginSteps = {
      async signIn() {
        throw tgError('FLOOD_WAIT_3600');
      },
      async checkPassword() {},
    };
    const done = await finishLogin({ codeAccepted: false }, steps, '12345', undefined);
    expect(done).toMatchObject({ ok: false, error: 'flood_wait', alive: false });
    expect(done.ok === false && done.raw).toContain('3600');
  });

  it('every refusal Telegram gave carries its words for the log', async () => {
    // The log line is how a «Bo'lmadi» on a manager's screen gets explained;
    // the finish step used to log the folded code alone.
    const tg = telegram();
    const login = { codeAccepted: false };
    await finishLogin(login, tg.steps, '12345', undefined);
    const wrong = await finishLogin(login, tg.steps, '', 'notog');
    expect(wrong.ok === false && wrong.raw).toContain('PASSWORD_HASH_INVALID');
    const code = await finishLogin({ codeAccepted: false }, telegram().steps, '99999', undefined);
    expect(code.ok === false && code.raw).toContain('PHONE_CODE_INVALID');
  });
});

describe('the screen after a refused press — from where the server says the login is', () => {
  const refused = (
    error: Parameters<typeof afterFinish>[1]['error'],
    next: Parameters<typeof afterFinish>[1]['next'],
    holder?: string,
  ) => ({ ok: false as const, error, next, holder });

  it('the first ask for the password is news, not an error', () => {
    expect(afterFinish({ stage: 'code' }, refused('password_needed', 'password'))).toEqual({
      stage: 'code',
      needPassword: true,
      error: undefined,
    });
  });

  it('a press on the password box with nothing in it says so', () => {
    expect(
      afterFinish({ stage: 'code', needPassword: true }, refused('password_needed', 'password')),
    ).toEqual({ stage: 'code', needPassword: true, error: 'password_needed' });
  });

  it('a wrong password stays on the password; a wrong code on the code', () => {
    expect(
      afterFinish({ stage: 'code', needPassword: true }, refused('password_invalid', 'password')),
    ).toEqual({ stage: 'code', needPassword: true, error: 'password_invalid' });
    expect(afterFinish({ stage: 'code' }, refused('code_invalid', 'code'))).toEqual({
      stage: 'code',
      error: 'code_invalid',
    });
  });

  it('the step comes from the server, never from the error name', () => {
    // A refusal whose name would once have kept the code step, sent by a
    // server that has already dropped the login: the phone step, and the
    // number is still in its box.
    expect(afterFinish({ stage: 'code' }, refused('code_invalid', 'phone'))).toEqual({
      stage: 'phone',
      error: 'code_invalid',
      holder: undefined,
    });
    expect(afterFinish({ stage: 'code' }, refused('phone_taken', 'phone', 'Ali'))).toEqual({
      stage: 'phone',
      error: 'phone_taken',
      holder: 'Ali',
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

  it('a refused password leaves the box, and the site`s own saved password is not offered for it', () => {
    // Telegram counts wrong passwords; an identical second press is the
    // likeliest one after a refusal that kept the box full.
    expect(form).toMatch(/next\.error === 'password_invalid'\) setPassword\(''\)/);
    const input =
      /<input(?:(?!\/>).)*?name="password"(?:(?!\/>).)*\/>/s.exec(form)?.[0] ?? '';
    expect(input).toContain('autoComplete="off"');
    expect(input).not.toContain('current-password');
  });
});
