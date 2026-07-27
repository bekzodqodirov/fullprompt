import { describe, expect, it } from 'vitest';
import { cabinetMenuButton } from '@/modules/platform/telegram/menu-button';

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
