import { describe, expect, it } from 'vitest';
import { clientMapKeyboard } from '@/modules/platform/telegram/map-link';

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
