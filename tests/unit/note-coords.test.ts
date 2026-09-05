import { describe, expect, it } from 'vitest';
import { formatLatLon, parseLatLon } from '@/modules/platform/notes/coords';

/**
 * One box for the point, because what the owner has in his hand is what a map
 * app put on his clipboard — and `coordField`'s `.replace(',', '.')` replaces
 * only the FIRST comma, so a pasted pair is refused by the helper the
 * warehouse form uses.
 */
describe('parseLatLon', () => {
  it('reads the pair a map app puts on the clipboard', () => {
    expect(parseLatLon('41.311081, 69.240562')).toEqual({ lat: 41.311081, lon: 69.240562 });
    expect(parseLatLon('41.311081,69.240562')).toEqual({ lat: 41.311081, lon: 69.240562 });
    expect(parseLatLon('  41.311081   69.240562 ')).toEqual({ lat: 41.311081, lon: 69.240562 });
  });

  it('reads a comma decimal, which is how the office types', () => {
    expect(parseLatLon('41,311081; 69,240562')).toEqual({ lat: 41.311081, lon: 69.240562 });
  });

  it('reads a Yandex link, where the LON comes first', () => {
    expect(parseLatLon('https://yandex.uz/maps/?pt=69.240562,41.311081&z=17')).toEqual({
      lat: 41.311081,
      lon: 69.240562,
    });
    expect(parseLatLon('https://yandex.uz/maps/10335/tashkent/?ll=69.24,41.31&z=12')).toEqual({
      lat: 41.31,
      lon: 69.24,
    });
  });

  it('reads a Google link, where the LAT comes first', () => {
    expect(parseLatLon('https://www.google.com/maps/@41.311081,69.240562,17z')).toEqual({
      lat: 41.311081,
      lon: 69.240562,
    });
    expect(parseLatLon('https://maps.google.com/?q=41.311081,69.240562')).toEqual({
      lat: 41.311081,
      lon: 69.240562,
    });
  });

  it('an EMPTY box is not a point, and neither is a typo — and they differ', () => {
    // Two answers, never one: storing nothing for a typo is how a note's pin
    // silently never arrives.
    expect(parseLatLon('')).toBeNull();
    expect(parseLatLon('   ')).toBeNull();
    expect(parseLatLon('sklad manzili')).toBe(false);
  });

  it('refuses 0°N 0°E, which is a real place in the Atlantic and nobody means it', () => {
    expect(parseLatLon('0, 0')).toBe(false);
    expect(parseLatLon('0.0,0.0')).toBe(false);
  });

  it('refuses a pair outside the world', () => {
    expect(parseLatLon('91, 10')).toBe(false);
    expect(parseLatLon('41, 181')).toBe(false);
  });

  it('prints back what it stored', () => {
    expect(formatLatLon('41.311081', '69.240562')).toBe('41.311081, 69.240562');
    expect(formatLatLon(null, null)).toBe('');
  });
});
