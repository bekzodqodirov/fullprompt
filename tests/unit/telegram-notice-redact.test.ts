import { describe, expect, it } from 'vitest';
import { redactNotice } from '@/modules/wms/agent/listener-hooks';

/**
 * The shape of a 777000 line the listener logs (`redactNotice`, beside `telegramNoticeKind`): nobody here can see the
 * texts Telegram really sends his account, so the rule was written from reconstructions and the logged shapes are
 * how the real ones get read. The line may be a login code — so the one thing this file pins hardest is that no code
 * survives the redaction, in any shape Telegram writes one, while a warning keeps the words the rule reads.
 */

/** Any digit, in any script — what a login code is made of. */
const DIGIT = /\p{N}/u;

describe('a 777000 line, redacted for the log', () => {
  it('his login code: no digit survives, the count and the words stay', () => {
    const out = redactNotice('Login code: 52814. Do not give this code to anyone, even if they say they are from Telegram!');
    expect(out).not.toMatch(DIGIT);
    expect(out).toBe('Login code: #####. Do not give this code to anyone, even if they say they are from Telegram!');
  });

  it('a code spaced or dashed, in another script, or glued to letters: gone', () => {
    for (const [text, shape] of [
      ['Ваш код для входа: 12 345', 'Ваш код для входа: ## ###'],
      ['Sizning kodingiz: 52-814', 'Sizning kodingiz: ##-###'],
      ['Login code: 528140', 'Login code: ######'],
      ['کد ورود: ۵۲۸۱۴', 'کد ورود: #####'],
      ['رمز تسجيل الدخول: ٥٢٨١٤', 'رمز تسجيل الدخول: #####'],
      ['Login code: GS52814', 'Login code: ‹…›'],
      ['Login code: 5​2814', 'Login code: #####'],
    ]) {
      const out = redactNotice(text!);
      expect(out, text).not.toMatch(DIGIT);
      expect(out, text).toBe(shape);
    }
  });

  it('my.telegram.org’s code — letters and digits, or letters alone in mixed case — goes whole', () => {
    const out = redactNotice(
      'Web login code. Dear Aziz, we received a request from your account to log in on my.telegram.org. This is your login code:\n' +
        'aB3dE9fG2\n\nDo not give this code to anyone.',
    );
    expect(out).not.toMatch(DIGIT);
    expect(out).not.toMatch(/aB|dE|fG/u);
    expect(out).toContain('This is your login code: ⏎ ‹…› ⏎  ⏎ Do not give this code to anyone.');
    for (const code of ['AbCdEfGh', 'xkQzPwRt']) expect(redactNotice(`Your code: ${code}`), code).toBe('Your code: ‹…›');
    // An invisible mark inside it must not split it into pieces too short to look like a code.
    expect(redactNotice('Your code: aBc​DeFg')).toBe('Your code: ‹…›');
  });

  it('a link keeps only its host — the code in its path and the token in its query are gone', () => {
    const out = redactNotice('Telegram code 52814\n\nYou can also tap on this link to log in:\nhttps://t.me/login/52814');
    expect(out).toBe('Telegram code ##### ⏎  ⏎ You can also tap on this link to log in: ⏎ https://t.me/…');
    expect(redactNotice('tg://login?token=AQABxyzDEF')).toBe('tg://login/…');
    expect(redactNotice('Open my.telegram.org/auth?code=aB3dE9fG2 now')).toBe('Open my.telegram.org/… now');
    expect(redactNotice('token=AQABxyzdef here')).toBe('token=‹…› here');
  });

  it('a warning keeps its words — the rule reads words — and only its numbers lose their value', () => {
    const out = redactNotice(
      'Your account was limited for violating the Telegram Terms of Service (section 1.5). Until 25.10.2026 you can only…',
    );
    expect(out).toBe('Your account was limited for violating the Telegram Terms of Service (section #.#). Until ##.##.#### you can only…');
    expect(redactNotice('Аккаунт ограничен. Мы получили жалобы на спам с Вашего аккаунта.')).toBe(
      'Аккаунт ограничен. Мы получили жалобы на спам с Вашего аккаунта.',
    );
    expect(redactNotice('Hisobingiz cheklandi. Spam haqida shikoyatlar keldi.')).toBe('Hisobingiz cheklandi. Spam haqida shikoyatlar keldi.');
  });

  it('the new-login alert: its lines and fields stay readable', () => {
    const out = redactNotice(
      'New login. Dear Aziz, we detected a login into your account from a new device on 19/11/2026 at 07:16:02 UTC.\n\n' +
        'Device: Telegram Desktop, 5.8.1, Windows 11\nLocation: Tashkent, Uzbekistan',
    );
    expect(out).toBe(
      'New login. Dear Aziz, we detected a login into your account from a new device on ##/##/#### at ##:##:## UTC. ⏎  ⏎ ' +
        'Device: Telegram Desktop, #.#.#, Windows ## ⏎ Location: Tashkent, Uzbekistan',
    );
  });

  it('at most 400 characters', () => {
    const out = redactNotice(`Your account was limited. ${'Spam reports. '.repeat(80)}`);
    expect([...out].length).toBe(400);
    expect(out.endsWith('…')).toBe(true);
    expect(redactNotice('Login code: 52814')).toBe('Login code: #####');
  });
});
