import { describe, expect, it } from 'vitest';
import { guessedZoneFor, guessZone } from '@/modules/wms/calc/workspace';

/**
 * The workspace's zone HINT (the Horgos round, 2026-09-29). A hint and never
 * a decision — the picker demands an answer and the seal refuses
 * `freight_zone_required` whatever the city says — but a wrong hint is still
 * a wrong suggestion on a 36-58 % difference in the road's price.
 */
describe('guessZone', () => {
  it('reads Horgos in the spellings a seller types', () => {
    for (const city of ['Horgos', 'Khorgos', 'Xorgos sklad', 'Хоргос', 'Коргас', 'Қорғас', '霍尔果斯']) {
      expect(guessZone(city), city).toBe('horgos');
    }
  });

  it('keeps Yiwu cargo on the China price whichever border it crosses (his 21a)', () => {
    // «cn» is asked BEFORE «horgos»: this is Yiwu cargo that happens to go
    // out through Horgos, not cargo that starts at Horgos.
    expect(guessZone('Yiwu (Horgos orqali)')).toBe('cn');
    expect(guessZone('Guangzhou → Horgos')).toBe('cn');
    expect(guessZone('Kashgar')).toBe('kashgar');
    expect(guessZone('Almaty')).toBeNull();
  });
});

describe('guessedZoneFor — a hint only for a zone the tariff prices', () => {
  it('stays silent about Horgos until he has typed its prices', () => {
    expect(guessedZoneFor('Хоргос', ['cn', 'kashgar'])).toBeNull();
    expect(guessedZoneFor('Хоргос', ['cn', 'horgos', 'kashgar'])).toBe('horgos');
    expect(guessedZoneFor('Yiwu', ['cn', 'kashgar'])).toBe('cn');
    expect(guessedZoneFor(null, ['cn'])).toBeNull();
  });
});
