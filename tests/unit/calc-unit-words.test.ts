import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import uz from '../../messages/uz.json';
import ru from '../../messages/ru.json';
import en from '../../messages/en.json';
import zh from '../../messages/zh-CN.json';
import {
  UNIT_WORD_KEYS,
  countText,
  normalizeRowUnit,
  normalizeTnved,
  unitLabel,
  unitWordKey,
  type UnitWords,
} from '@/modules/wms/calc/units';
import { needPhraseUz, needWhyUz, type RowNeed } from '@/modules/wms/calc/needs';
import { BAZA_BASES, DUTY_UNITS } from '@/modules/wms/calc/pricing';
import { measureNeedText } from '@/app/(protected)/hisoblash/[id]/words';

/**
 * The words a unit is printed in and the sentence a missing figure is told
 * in (2026-10-09). Anchored OUTSIDE the bundles (#163): the key set is the
 * code's `UNIT_WORD_KEYS`, every storage spelling the engine can name is
 * walked through `unitWordKey`, and every sentence is FORMATTED in all four
 * locales — existence of a key cannot see an ICU string that does not parse
 * (#520).
 */
const LOCALES = [
  ['uz', uz],
  ['ru', ru],
  ['en', en],
  ['zh-CN', zh],
] as const;
const HALVES: RowNeed['why'][] = ['baza', 'duty', 'excise'];

describe('every storage spelling has a word, in every language', () => {
  it('the engine’s units all map to a key, and the key set is the bundles’ set', () => {
    for (const u of [...BAZA_BASES, ...DUTY_UNITS]) expect(unitWordKey(u), u).not.toBeNull();
    for (const [locale, messages] of LOCALES) {
      const calc = (messages as { calc: Record<string, unknown> }).calc;
      expect(Object.keys(calc.units as object).sort(), locale).toEqual([...UNIT_WORD_KEYS].sort());
      const needs = calc.needs as { what: object; why: object };
      expect(Object.keys(needs.what).sort(), locale).toEqual([...UNIT_WORD_KEYS].filter((k) => k !== 'kgNet').sort());
      expect(Object.keys(needs.why).sort(), locale).toEqual([...HALVES].sort());
    }
  });

  it('an unknown spelling prints as itself rather than vanishing', () => {
    const words = uz.calc.units as UnitWords;
    expect(unitLabel('unit', words)).toBe('dona');
    expect(unitLabel('1000_dona', words)).toBe('1000 dona');
    expect(unitLabel('karobka', words)).toBe('karobka');
  });
});

describe('the missing-figure sentence formats in all four languages', () => {
  it('names the row, the figure and why — never a brace left over', () => {
    for (const [locale, messages] of LOCALES) {
      const t = createTranslator({ locale, messages, namespace: 'calc' });
      for (const unit of [...BAZA_BASES, ...DUTY_UNITS]) {
        for (const half of HALVES) {
          const text = measureNeedText(t as never, {
            reason: 'measure_missing',
            itemSeq: 3,
            itemLabel: 'Kurtka',
            unit,
            half,
            rate: 3,
          });
          expect(text, `${locale} ${unit} ${half}`).not.toBeNull();
          expect(text!, locale).toContain('3');
          expect(text!, locale).toContain('Kurtka');
          expect(text!, locale).not.toContain('{');
          if (half !== 'baza') expect(text!, `${locale} ${unit} ${half}`).toContain('$3/');
        }
      }
    }
  });

  it('another refusal is not dressed as a missing figure', () => {
    const t = createTranslator({ locale: 'uz', messages: uz, namespace: 'calc' });
    expect(measureNeedText(t as never, { reason: 'baza_missing', unit: 'kg', half: 'baza' })).toBeNull();
    expect(measureNeedText(t as never, { reason: 'measure_missing' })).toBeNull();
  });
});

describe('the bot’s Uzbek is the same three facts', () => {
  it('a per-piece floor, a per-kg baza and a per-litre excise', () => {
    expect(needPhraseUz({ unit: 'dona', why: 'duty', rate: 3 })).toBe('soni (dona) kiritilmagan — boj kamida $3/dona');
    expect(needPhraseUz({ unit: 'kg', why: 'baza', rate: null })).toBe('sof og‘irligi (kg) kiritilmagan — baza kg bo‘yicha');
    expect(needWhyUz({ unit: 'litr', why: 'excise', rate: 0.5 })).toBe('aksiz $0.5/litr');
    expect(needWhyUz({ unit: '1000_dona', why: 'duty', rate: 5 })).toBe('boj kamida $5/1000 dona');
  });
});

describe('normalizeRowUnit — the number moves to the column its word names, once', () => {
  const row = (over: Partial<Parameters<typeof normalizeRowUnit>[0]> = {}) => ({
    quantity: null,
    unit: null,
    weightKg: null,
    volumeM3: null,
    measureUnit: null,
    measureQty: null,
    ...over,
  });

  it('«500 kg» in the piece column moves to the weight and leaves the seller’s words in the note', () => {
    const r = normalizeRowUnit(row({ quantity: 500, unit: 'kg' }));
    expect(r).toMatchObject({ moved: true, to: 'kg', conflict: false, note: 'sotuvchi: 500 kg' });
    if (!r.moved) throw new Error('unreachable');
    expect(r.patch).toMatchObject({ quantity: null, unit: null, weightKg: 500 });
    // The word is gone, so the rule cannot fire twice (judge MR-4).
    expect(normalizeRowUnit(row({ ...r.patch, quantity: 300 }))).toEqual({ moved: false });
  });

  it('a filled target keeps its figure, the piece column is still cleared, and both are in the note', () => {
    const r = normalizeRowUnit(row({ quantity: 500, unit: 'кг', weightKg: 480 }));
    expect(r).toMatchObject({ moved: true, to: 'kg', conflict: true, note: 'sotuvchi: 500 кг (qatorda 480 kg)' });
    if (!r.moved) throw new Error('unreachable');
    expect(r.patch).toMatchObject({ quantity: null, weightKg: 480 });
  });

  it('m² goes to the pair; a count word stays where it is; cartons owe their count', () => {
    const m2 = normalizeRowUnit(row({ quantity: 120, unit: 'm2' }));
    expect(m2).toMatchObject({ moved: true, to: 'm2' });
    if (!m2.moved) throw new Error('unreachable');
    expect(m2.patch).toMatchObject({ quantity: null, measureUnit: 'm2', measureQty: 120 });
    expect(normalizeRowUnit(row({ quantity: 10, unit: 'шт' }))).toEqual({ moved: false });
    expect(normalizeRowUnit(row({ quantity: 10, unit: null }))).toEqual({ moved: false });
    const ctn = normalizeRowUnit(row({ quantity: 12, unit: 'karobka' }));
    expect(ctn).toMatchObject({ moved: true, to: 'cartons', note: 'sotuvchi: 12 karobka' });
    if (!ctn.moved) throw new Error('unreachable');
    expect(ctn.patch.quantity).toBeNull();
  });
});

describe('normalizeTnved and countText', () => {
  it('a code is digits only, a 9-digit Excel number gets its lost leading zero', () => {
    expect(normalizeTnved('6201.10.000.0')).toEqual({ code: '6201100000' });
    expect(normalizeTnved(' 6907 ')).toEqual({ code: '6907' });
    // Excel turned 0401100000 into a NUMBER and dropped the zero — the only
    // shape where padding is a fact rather than a guess (judge MR-18).
    expect(normalizeTnved(401100000)).toEqual({ code: '0401100000' });
    // A TYPED nine digits is a person's typo: asked, never padded.
    expect(normalizeTnved('401100000')).toEqual({ problem: 'code_short', text: '401100000' });
    expect(normalizeTnved('kurtka')).toBeNull();
  });

  it('a count prints as pieces — never glued to a word that names another column', () => {
    const words = uz.calc.units as UnitWords;
    expect(countText(120, 'kg', words)).toBe('120 dona');
    expect(countText(120, 'шт', words)).toBe('120 шт');
    expect(countText(null, 'kg', words)).toBe('');
  });
});
