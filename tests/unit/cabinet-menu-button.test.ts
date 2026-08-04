import { describe, expect, it } from 'vitest';
import { cabinetInlineKeyboard, cabinetMenuButton } from '@/modules/platform/telegram/menu-button';

/**
 * The corner button is the ONLY way into the Mini App that carries a signed
 * `initData`, so a button that is wrong is a cabinet nobody can open — and the
 * symptom is a client tapping a button that does nothing, which reads as a
 * broken app rather than as a misconfiguration.
 */

describe('the Mini App button is only offered when it can work', () => {
  it('refuses plain http — Telegram will not open a Mini App on it', () => {
    // The live server ran on http:// for months. Sending the button anyway
    // fails the API call, and any button that HAD been set stays behind
    // pointing at a URL Telegram refuses to load.
    expect(cabinetMenuButton('http://gsrwms.uz', 'uz')).toBeNull();
  });

  it('refuses an unset APP_URL rather than building `undefined/cabinet`', () => {
    expect(cabinetMenuButton(undefined, 'uz')).toBeNull();
    expect(cabinetMenuButton('', 'uz')).toBeNull();
    expect(cabinetMenuButton('   ', 'uz')).toBeNull();
  });

  it('does not double the slash on an APP_URL that ends in one', () => {
    expect(cabinetMenuButton('https://gsrwms.uz/', 'uz')?.web_app.url).toBe(
      'https://gsrwms.uz/cabinet',
    );
  });
});

describe('the button speaks the client’s language', () => {
  it('is written in the language the client chose', () => {
    expect(cabinetMenuButton('https://gsrwms.uz', 'uz')?.text).toBe('Mening yuklarim');
    expect(cabinetMenuButton('https://gsrwms.uz', 'ru')?.text).toBe('Мои грузы');
    expect(cabinetMenuButton('https://gsrwms.uz', 'en')?.text).toBe('My cargo');
  });

  it('still says something for a client who has never picked one', () => {
    const text = cabinetMenuButton('https://gsrwms.uz', null)?.text;
    expect(text).toBeTruthy();
    // Telegram caps the menu button text; anything longer is rejected outright.
    expect(text!.length).toBeLessThanOrEqual(16);
  });
});

/**
 * The BIG button (owner: "buttonga urg'u ber … glavniy katta button bo'lib
 * ko'rinib tursin"). Same URL, different placement — under a message, at full
 * width, where the thumb already is.
 */
describe('the wide button under a message', () => {
  it('points at the same cabinet as the corner button', () => {
    const wide = cabinetInlineKeyboard('https://gsrwms.uz', 'uz');
    const corner = cabinetMenuButton('https://gsrwms.uz', 'uz');
    expect(wide?.inline_keyboard[0]![0]!.web_app.url).toBe(corner?.web_app.url);
    // Two doors into one room: a client who used the corner yesterday and the
    // button today must not land on two different screens.
    expect(wide?.inline_keyboard[0]![0]!.web_app.url).toBe('https://gsrwms.uz/cabinet');
  });

  it('is one wide button, not a row of small ones', () => {
    const wide = cabinetInlineKeyboard('https://gsrwms.uz', 'ru');
    // Telegram divides a row evenly between its buttons — a second button on
    // this row would halve the one the owner asked to be prominent.
    expect(wide?.inline_keyboard).toHaveLength(1);
    expect(wide?.inline_keyboard[0]).toHaveLength(1);
  });

  it('says what pressing it does, in the client’s language', () => {
    expect(cabinetInlineKeyboard('https://gsrwms.uz', 'uz')?.inline_keyboard[0]![0]!.text).toContain(
      'ochish',
    );
    expect(cabinetInlineKeyboard('https://gsrwms.uz', 'ru')?.inline_keyboard[0]![0]!.text).toContain(
      'Открыть',
    );
    expect(cabinetInlineKeyboard('https://gsrwms.uz', 'en')?.inline_keyboard[0]![0]!.text).toContain(
      'Open',
    );
  });

  it('is withheld on the same terms as the corner button', () => {
    // A button Telegram refuses to open is worse than no button: the client
    // presses it, nothing happens, and they conclude the system is broken.
    for (const url of [undefined, '', 'http://gsrwms.uz']) {
      expect(cabinetInlineKeyboard(url, 'uz')).toBeNull();
      expect(cabinetMenuButton(url, 'uz')).toBeNull();
    }
  });
});
