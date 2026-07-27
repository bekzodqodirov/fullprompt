import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyInitData } from '@/modules/platform/telegram/init-data';

/**
 * The signature is the whole of the client cabinet's security.
 *
 * A Mini App runs in a webview the client controls, so every field it sends is
 * editable by whoever holds the phone. If this check is wrong in the
 * permissive direction, one client reads another's cargo, photographs and
 * debt by editing a number.
 *
 * The fixtures are SIGNED here rather than pasted, using Telegram's documented
 * construction, so the test proves the algorithm rather than agreeing with the
 * implementation's own idea of it.
 */

const TOKEN = '8817164343:TEST-TOKEN-NOT-A-REAL-ONE';

/** Telegram's own construction, written out independently of the source. */
function sign(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

/** The refusal reason, or 'accepted' — so a test can assert on one value. */
function refusal(result: ReturnType<typeof verifyInitData>): string {
  return result.ok ? 'accepted' : result.reason;
}

const NOW = new Date('2026-07-27T21:00:00Z');
const authDate = String(Math.floor(NOW.getTime() / 1000) - 60);
const USER = JSON.stringify({ id: 555001, first_name: 'Bekzod', language_code: 'uz' });

describe('a genuine Mini App open', () => {
  it('is accepted, and yields the user', () => {
    const data = sign({ auth_date: authDate, query_id: 'AAH', user: USER });
    const result = verifyInitData(data, TOKEN, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.id).toBe(555001);
    expect(result.user.language_code).toBe('uz');
  });

  it('keeps `signature` INSIDE the checked string', () => {
    /**
     * Telegram excludes `signature` only from its separate third-party Ed25519
     * check. A validator written from that recipe passes every hand-made
     * fixture and then rejects every real user on a Bot API 8.0+ client — a
     * silent, total auth outage. Signing WITH the field and expecting success
     * is what pins the behaviour.
     */
    const data = sign({ auth_date: authDate, signature: 'abc123', user: USER });
    expect(verifyInitData(data, TOKEN, NOW).ok).toBe(true);
  });

  it('survives values that need URL encoding', () => {
    // The user blob is JSON full of quotes and braces; decoding it twice, or
    // not at all, changes the check string and breaks every login.
    const data = sign({
      auth_date: authDate,
      user: JSON.stringify({ id: 7, first_name: 'Ali & Co', username: 'a+b' }),
    });
    expect(verifyInitData(data, TOKEN, NOW).ok).toBe(true);
  });
});

describe('everything that must be refused', () => {
  it('a page opened outside Telegram, with no initData at all', () => {
    expect(verifyInitData('', TOKEN, NOW)).toEqual({ ok: false, reason: 'empty' });
  });

  it('a blob with no hash', () => {
    expect(refusal(verifyInitData(`auth_date=${authDate}&user=${USER}`, TOKEN, NOW))).toBe('no_hash');
  });

  it('THE attack: a client editing the user id to read somebody else', () => {
    // The whole reason this file exists. The signature covers `user`, so
    // swapping the id invalidates it — and the request must die here rather
    // than at some ownership check further in.
    const data = sign({ auth_date: authDate, user: USER });
    const tampered = data.replace('555001', '555002');
    expect(tampered).not.toBe(data);
    expect(refusal(verifyInitData(tampered, TOKEN, NOW))).toBe('bad_signature');
  });

  it('a blob signed with somebody else’s bot token', () => {
    const data = sign({ auth_date: authDate, user: USER }, 'another:token');
    expect(refusal(verifyInitData(data, TOKEN, NOW))).toBe('bad_signature');
  });

  it('a stale blob — replayed a day and a half later', () => {
    const old = String(Math.floor(NOW.getTime() / 1000) - 36 * 3600);
    const data = sign({ auth_date: old, user: USER });
    expect(refusal(verifyInitData(data, TOKEN, NOW))).toBe('expired');
  });

  it('a blob with no auth_date, which would otherwise never expire', () => {
    const data = sign({ user: USER });
    expect(refusal(verifyInitData(data, TOKEN, NOW))).toBe('expired');
  });

  it('a valid signature over no user', () => {
    const data = sign({ auth_date: authDate });
    expect(refusal(verifyInitData(data, TOKEN, NOW))).toBe('no_user');
  });

  it('a valid signature over unparseable user JSON', () => {
    const data = sign({ auth_date: authDate, user: 'not json' });
    expect(refusal(verifyInitData(data, TOKEN, NOW))).toBe('no_user');
  });

  it('an extra field smuggled in after signing', () => {
    // Adding anything changes the check string, so appending a field cannot
    // be used to slip a value past the signature.
    const data = sign({ auth_date: authDate, user: USER });
    expect(refusal(verifyInitData(`${data}&chat_id=999`, TOKEN, NOW))).toBe('bad_signature');
  });
});

describe('the constant and the token are not interchangeable', () => {
  it('rejects a hash built with the arguments the other way round', () => {
    /**
     * The commonest implementation error: `HMAC(token, "WebAppData")` instead
     * of `HMAC("WebAppData", token)`. Telegram's pseudocode writes the message
     * first, which reads like the opposite of Node's API. It fails closed —
     * nobody can log in — but it is worth a test that names it, because the
     * symptom ("the cabinet does not open") points nowhere near the cause.
     */
    const check = `auth_date=${authDate}\nuser=${USER}`;
    const wrongSecret = createHmac('sha256', TOKEN).update('WebAppData').digest();
    const wrongHash = createHmac('sha256', wrongSecret).update(check).digest('hex');
    const data = new URLSearchParams({ auth_date: authDate, user: USER, hash: wrongHash });
    expect(refusal(verifyInitData(data.toString(), TOKEN, NOW))).toBe('bad_signature');
  });
});
