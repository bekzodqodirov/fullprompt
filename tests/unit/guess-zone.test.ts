import { describe, expect, it } from 'vitest';
import { guessedZoneFor, guessZone, zoneGuessOf } from '@/modules/wms/calc/zone-guess';
import { AI_ZONE_ROUTES } from '@/modules/platform/telegram/staff-bot';

/**
 * The workspace's zone HINT (the Horgos round, 2026-09-29), and since round 2
 * the bot's own guess (his 2.6 b: «shahardan taxmin qilsin, taxmin deb
 * yozsin»). A hint and never a decision — the picker demands an answer and
 * the seal refuses `freight_zone_required` whatever the city says — but a
 * wrong guess is a wrong price on a 36-58 % difference in the road.
 */
describe('guessZone', () => {
  it('reads Horgos in the spellings a seller types', () => {
    for (const city of ['Horgos', 'Khorgos', 'Xorgos sklad', 'Хоргос', 'Коргас', 'Қорғас', '霍尔果斯']) {
      expect(guessZone(city), city).toBe('horgos');
    }
  });

  it('reads Kashgar in every script, the apostrophe whichever key typed it', () => {
    for (const city of ['Kashgar', 'Qashqar', 'Qashg‘ar', "Qashg'ar", 'Qashgʻar', 'Кашгар', 'Қашқар', 'Қашғар', 'Кашкар', '喀什', 'Kashi']) {
      expect(guessZone(city), city).toBe('kashgar');
    }
  });

  it('reads Yiwu and Guangzhou in every script', () => {
    for (const city of ['Yiwu', 'Yivu', 'Iwu', 'Ivu', 'Иву', 'Иу', '义乌', 'Guangzhou', 'Guanchjou', 'Guanjou', 'Gonchjou', 'Гуанчжоу', '广州', 'YW', 'GZ sklad']) {
      expect(guessZone(city), city).toBe('cn');
    }
    // A shorthand inside another word is not the shorthand.
    expect(guessZone('Angzu')).toBeNull();
  });

  it('keeps Yiwu cargo on the China price whichever border it crosses (his 21a)', () => {
    expect(guessZone('Yiwu (Horgos orqali)')).toBe('cn');
    expect(guessZone('Horgos (Yiwu yuki)')).toBe('cn');
    expect(guessZone('Guangzhou → Horgos')).toBe('cn');
    // The red proof's case (21a): decided by leftmost, Kashgar would win here.
    expect(guessZone('Qashqar orqali Yiwu')).toBe('cn');
    expect(guessZone('Yiwu (Qashqar orqali)')).toBe('cn');
  });

  it('a country word means China only when no city answered (tier 2)', () => {
    // The ordinary Russian address shape: country, then city. Folding the
    // country into the city tier with a leftmost rule reads this as cn.
    expect(guessZone('Китай, Кашгар')).toBe('kashgar');
    expect(guessZone('中国喀什')).toBe('kashgar');
    expect(guessZone('Хитой, Қашғар')).toBe('kashgar');
    expect(guessZone('Xitoy, Qashqar')).toBe('kashgar');
    expect(guessZone('Xitoy')).toBe('cn');
    expect(guessZone('Китая')).toBe('cn');
    expect(zoneGuessOf('Xitoy')).toEqual({ zone: 'cn', tier: 2 });
    expect(zoneGuessOf('Yiwu')).toEqual({ zone: 'cn', tier: 1 });
  });

  it('another Chinese city is not guessed — named, never priced as China (his Question 3 ⭐)', () => {
    expect(guessZone('Foshan')).toBeNull();
    expect(guessZone('Shenzhen')).toBeNull();
    // …unless the seller wrote the country too, and then only by tier 2.
    expect(zoneGuessOf('Foshan, Xitoy')).toEqual({ zone: 'cn', tier: 2 });
    expect(guessZone('Almaty')).toBeNull();
    expect(guessZone(null)).toBeNull();
    expect(guessZone('')).toBeNull();
  });

  it('every zone button the bot offers is guessed back from its own city (derived)', () => {
    // DERIVED from the bot's buttons, not a list retyped here: the podklyuch
    // door writes `fromCity` from these, and a guess that could not read the
    // bot's own words would price a job differently from the button pressed.
    const routes = Object.values(AI_ZONE_ROUTES);
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) expect(guessZone(r.fromCity), r.fromCity).toBe(r.zone);
  });
});

describe('the words stand where a word stands (R2 late pass, review P1-R5)', () => {
  it('the country word is anchored: «china» inside another word is not China', () => {
    for (const text of ['Chinaz', 'Machinaga', 'Indochina', 'ChinaTown', 'Mashinada']) {
      expect(guessZone(text), text).toBeNull();
    }
    // …while the word itself, and its Uzbek and Russian forms, still read it.
    for (const text of ['China', 'from China', 'Xitoydan', 'Хитойдан', 'Китаю', 'из Китая']) {
      expect(zoneGuessOf(text), text).toEqual({ zone: 'cn', tier: 2 });
    }
  });

  it('the Cyrillic Yiwu stem takes a case ending, never the rest of a street name', () => {
    expect(guessZone('Ивушкина ул. 5')).toBeNull();
    for (const city of ['Иву', 'Ивудан', 'Ивуга', 'Ивуда']) expect(guessZone(city), city).toBe('cn');
  });

  it('Horgos in the Kazakh side’s own spellings', () => {
    for (const city of ['Khorgas', 'Horgas', 'Хоргас', 'Qorg‘as', 'Qorgas']) expect(guessZone(city), city).toBe('horgos');
    // «Qo‘rg‘oshin» (lead, the metal) is not a city.
    expect(guessZone('Qo‘rg‘oshin')).toBeNull();
  });

  it('«Xitoy» alone still means the Xitoy zone — the ⭐ of his Question 3 asked it in those words (review law-money-9)', () => {
    expect(zoneGuessOf('Xitoy')).toEqual({ zone: 'cn', tier: 2 });
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
