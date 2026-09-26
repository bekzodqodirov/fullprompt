import { describe, expect, it } from 'vitest';
import { clientAnswerKeyboard, clientMapKeyboard, telegramPhoneUrl } from '@/modules/platform/telegram/map-link';

describe('«🗺 Xaritada» under a client-code answer (item 12)', () => {
  it('points at the site map narrowed to that client', () => {
    const kb = clientMapKeyboard('https://gsrwms.uz/', 'GS777');
    expect(kb?.inline_keyboard[0]?.[0]?.url).toBe('https://gsrwms.uz/map?mijoz=GS777');
  });

  it('is a URL button — the map is a login page and a Mini App carries no cookie', () => {
    const button = clientMapKeyboard('https://gsrwms.uz', 'GS777')!.inline_keyboard[0]![0]!;
    expect(Object.keys(button).sort()).toEqual(['text', 'url']);
  });

  it('is withheld off public HTTPS, so a refused keyboard never takes the answer down', () => {
    expect(clientMapKeyboard(undefined, 'GS777')).toBeNull();
    expect(clientMapKeyboard('http://localhost:3000', 'GS777')).toBeNull();
    expect(clientMapKeyboard('https://gsrwms.uz', '')).toBeNull();
  });
});

describe('the «💬» phone buttons under a client answer (2026-09-26, item 2)', () => {
  it('opens a Telegram chat with the number, a bare Uzbek number gaining 998', () => {
    expect(telegramPhoneUrl('+998 90 123-45-67')).toBe('https://t.me/+998901234567');
    expect(telegramPhoneUrl('901234567')).toBe('https://t.me/+998901234567');
    expect(telegramPhoneUrl('12345')).toBeNull();
  });

  it('puts the map first, then one button per reachable phone', () => {
    const kb = clientAnswerKeyboard('https://gsrwms.uz', {
      mapClientCode: 'GS777',
      phones: ['+998901234567', 'x'],
    })!;
    expect(kb.inline_keyboard.map((r) => r[0]!.url)).toEqual([
      'https://gsrwms.uz/map?mijoz=GS777',
      'https://t.me/+998901234567',
    ]);
  });

  it('offers no keyboard when there is nothing to offer', () => {
    expect(clientAnswerKeyboard('http://localhost', { mapClientCode: 'GS777' })).toBeNull();
    expect(clientAnswerKeyboard(undefined, {})).toBeNull();
  });
});
