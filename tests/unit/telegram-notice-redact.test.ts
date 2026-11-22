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

  it('the new-login alert: its lines and fields stay readable — his name and where he signed in do not', () => {
    const out = redactNotice(
      'New login. Dear Aziz, we detected a login into your account from a new device on 19/11/2026 at 07:16:02 UTC.\n\n' +
        'Device: Telegram Desktop, 5.8.1, Windows 11\nLocation: Tashkent, Uzbekistan',
    );
    expect(out).toBe(
      'New login. Dear ‹…›, we detected a login into your account from a new device on ##/##/#### at ##:##:## UTC. ⏎  ⏎ ' +
        'Device: Telegram Desktop, #.#.#, Windows ## ⏎ Location: ‹…›',
    );
    // The fields written inline: the location's value goes, the next field's name stays; a «St.» is no field's end.
    expect(redactNotice('Dear Aziz Karimov, new login. Location: St. Petersburg, Russia. Device: Telegram Web')).toBe(
      'Dear ‹…›, new login. Location: ‹…›. Device: Telegram Web',
    );
    expect(redactNotice('Уважаемый Азиз, новый вход.\nМестоположение: Ташкент, Узбекистан')).toBe(
      'Уважаемый ‹…›, новый вход. ⏎ Местоположение: ‹…›',
    );
    expect(redactNotice('新登录。\n位置：塔什干')).toBe('新登录。 ⏎ 位置：‹…›');
  });

  /**
   * The independent check's survivors (2026-11-21): my.telegram.org's code is eleven of [A-Za-z0-9_-], and these
   * read back whole or in pieces — cut at «-» and «_», or letters alone with no small letter before a capital.
   */
  const SURVIVORS = ['fFyIb-grNZv', 'aBcDe-FgHiJ', 'pgtVb_XTAZu', 'Zx_Qw-Er_Ty', 'Hw-KZ3yHsMY', 'WYBJEPLZXVE', 'TNqrgsxgqaq', 'yfssilqzwzk'];
  const WEB_LOGIN = (code: string) =>
    'Web login code. Dear Aziz, we received a request from your account to log in on my.telegram.org. ' +
    `This is your login code:\n${code}\n\nDo not give this code to anyone, even if they say they're from Telegram!`;
  /** Every run of three letters of a code — a fragment that long, kept in the output, is a piece of it read back. */
  const pieces = (code: string) => {
    const runs = code.match(/[A-Za-z]{3,}/gu) ?? [];
    return runs.flatMap((run) => [...run].slice(0, -2).map((_, at) => run.slice(at, at + 3)));
  };

  it('my.telegram.org’s code on its own line goes whole, whatever its shape', () => {
    for (const code of SURVIVORS) {
      const out = redactNotice(WEB_LOGIN(code));
      expect(out, code).toContain('This is your login code: ⏎ ‹…› ⏎  ⏎ Do not give this code to anyone');
      for (const piece of pieces(code)) expect(out, `${code}: ${piece}`).not.toContain(piece);
    }
    expect(redactNotice('  WYBJEPLZXVE  ')).toBe('  ‹…›  ');
    // A no-break space glues and does not part: neither half of a code written with one inside is left behind.
    expect(redactNotice(WEB_LOGIN('aBcDe\u00a0FgHiJ'))).toContain('code: ⏎ ‹…› ⏎ ');
    expect(redactNotice('Your code: aBcDe\u00a0FgHiJ')).toBe('Your code: ‹…›');
    expect(redactNotice('aBcDe\u00a0FgHiJ')).toBe('‹…›');
    // A line of one token that is a link (already cut to its host) or a field's name (its value below) stays.
    expect(redactNotice('Log in here:\nhttps://my.telegram.org/auth?x=1')).toBe('Log in here: ⏎ https://my.telegram.org/…');
    expect(redactNotice('Location:\nTashkent, Uzbekistan')).toBe('Location: ⏎ ‹…›');
  });

  it('…and after «code:» or «code is» on the same line, whatever its shape', () => {
    for (const code of SURVIVORS) {
      for (const text of [`Your login code: ${code}. Do not give it to anyone.`, `Your login code is ${code}`, `Kirish kodingiz: ${code}`]) {
        const out = redactNotice(text);
        expect(out, text).not.toContain(code);
        for (const piece of pieces(code)) expect(out, `${text}: ${piece}`).not.toContain(piece);
      }
    }
    expect(redactNotice('Login code for Telegram Desktop: WYBJEPLZXVE now')).toBe('Login code for Telegram Desktop: ‹…› now');
    expect(redactNotice('登录代码：五二八一四')).toBe('登录代码：‹…›');
    expect(redactNotice('Код: yfssilqzwzk')).toBe('Код: ‹…›');
    // A code of digits keeps its count — the digits say nothing, the count is what the rule reads.
    expect(redactNotice('Your login code: 52814.')).toBe('Your login code: #####.');
    // A colon with no code word before it on its line announces nothing.
    expect(redactNotice('Login code: 52814\nDevice: Telegram Desktop')).toBe('Login code: ##### ⏎ Device: Telegram Desktop');
  });

  it('…and in the middle of a sentence, when its shape is a code’s: a «-» or «_» beside a code-shaped part, a digit', () => {
    const out = redactNotice('We got fFyIb-grNZv, aBcDe-FgHiJ, pgtVb_XTAZu, Zx_Qw-Er_Ty and Hw-KZ3yHsMY from you.');
    expect(out).toBe('We got ‹…›, ‹…›, ‹…›, ‹…› and ‹…› from you.');
    expect(redactNotice('Send abcde_fghij here')).toBe('Send ‹…› here');
  });

  it('an ordinary warning keeps every word, the hyphenated ones too — the shape is the point', () => {
    for (const text of [
      'Your account has been limited. Unfortunately, some Telegram users found your messages annoying and reported them as spam. ' +
        'While the account is limited, you will not be able to send messages to people who do not have your number.',
      'Using unofficial third-party apps may violate the Terms of Service. Third-party clients can put your e-mail at risk.',
      'Ваш аккаунт временно ограничен из-за жалоб пользователей на спам. Кто-то пытался войти в ваш Telegram-аккаунт.',
      "Hisobingiz vaqtincha cheklandi. Foydalanuvchilar spam haqida shikoyat qilishdi. Qo'llab-quvvatlash xizmatiga yozing.",
    ]) {
      expect(redactNotice(text), text).toBe(text);
    }
  });

  it('at most 400 characters', () => {
    const out = redactNotice(`Your account was limited. ${'Spam reports. '.repeat(80)}`);
    expect([...out].length).toBe(400);
    expect(out.endsWith('…')).toBe(true);
    expect(redactNotice('Login code: 52814')).toBe('Login code: #####');
  });
});
