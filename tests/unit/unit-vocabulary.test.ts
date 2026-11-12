import { describe, expect, it } from 'vitest';
import {
  FIELD_LABELS,
  NET_LABELS,
  PER_PACKAGE_TAIL,
  PER_PIECE_TAIL,
  SCALED_KG,
  VOLUME_LABELS,
  WEIGHT_LABELS,
  routeAmount,
  scaledKg,
  scaledKgValue,
  tailAt,
  unitOf,
  unitPattern,
  unitWords,
} from '@/modules/wms/calc/units';
import { parseManualFacts } from '@/modules/wms/calc/intake-manual';
import { looksLikeTableAnswer, parseTableAnswer, type TableRef, type TableTarget } from '@/modules/wms/calc/line-address';

/**
 * docs/AI-SORAYDI.md §2.4 — ONE unit vocabulary.
 *
 * His sentence was «"cbm" degan yozuvni o‘qiy olmayapti»: the row kernel knew
 * the word, the shipment-totals reader and the totals-shaped test each kept a
 * shorter private list. This file pins the list itself, and then the READERS
 * (review JB-20): every word of the list read as a shipment's total and as a
 * table answer.
 */
describe('the words of a unit', () => {
  it('the cube in the trade’s spellings — the ones a packing list and a seller actually write', () => {
    for (const word of ['cbm', 'CBM', 'm3', 'м3', 'm³', 'kub', 'куб', 'куба', 'кубов', 'кбм', 'кубометр', 'кубометров', 'kubometr', 'kubov', 'cu.m', 'CUM', '立方', '方']) {
      expect(unitOf(word), word).toBe('m3');
    }
  });

  it('the kilo likewise', () => {
    for (const word of ['kg', 'KGS', 'kgs', 'кг', 'кило', 'kilo', 'килограмм', 'килограмма', 'килограммов', '公斤']) {
      expect(unitOf(word), word).toBe('kg');
    }
  });

  it('a word that is no unit stays none: «件» is absent on purpose, and a label is not a unit', () => {
    for (const word of ['件', 'meas', 'gw', 'brutto', 'pkgs', 'volume']) expect(unitOf(word), word).toBeNull();
  });

  it('unitPattern is longest-first, so «kgs» is never «kg» + a stray «s» and «кубов» never «куб» + «ов»', () => {
    const kg = new RegExp(`^(?:${unitPattern('kg')})$`, 'iu');
    const m3 = new RegExp(`(\\d+)\\s*(${unitPattern('m3')})`, 'iu');
    expect(kg.test('kgs')).toBe(true);
    expect(m3.exec('12 кубов')?.[2]).toBe('кубов');
    expect(m3.exec('5.9 cbm')?.[2]?.toLowerCase()).toBe('cbm');
    // A dot inside a word is optional: «cu.m» and «cum» are one word.
    expect(m3.exec('5 cu.m')?.[2]).toBe('cu.m');
    expect(m3.exec('5 cum')?.[2]).toBe('cum');
    // Every word of the list is matched whole by its own pattern.
    for (const unit of ['kg', 'm3'] as const) {
      const whole = new RegExp(`^(?:${unitPattern(unit)})$`, 'iu');
      for (const word of unitWords(unit)) expect(whole.test(word), `${unit}: ${word}`).toBe(true);
    }
  });
});

/**
 * The READERS' half of the fence (review JB-20, JN-22): the list above is one
 * list only while every reader of a total asks IT. Three private lists were
 * the defect — the row kernel knew «cbm», the shipment-totals reader and the
 * table's totals answer each kept a shorter one of their own, so «5.9 cbm»
 * typed as the answer to the bot's own cube question was «jadvalda bunday
 * qator yo‘q». A word added to `WORDS` tomorrow is read by every reader
 * below, or this test names it.
 */
describe('every kg and m³ word is read by the totals readers', () => {
  const TOTALS: TableTarget[] = [{ totals: 'weightKg' }, { totals: 'volumeM3' }];
  // One complete row and both totals open: the table that asks «umumiy
  // brutto og‘irligi» and «umumiy hajmi», nothing else.
  const table: TableRef = {
    rows: [{ no: 1, index: 0, seq: null, name: 'Kurtka', needs: [] }],
    open: TOTALS,
    preferred: TOTALS,
    stage: 'review',
  };
  const answered = (text: string) => {
    const out = parseTableAnswer(text, table);
    expect(out.material, text).toBe(false);
    expect(out.segments, text).toHaveLength(1);
    return out.segments[0]!;
  };

  // 507 and 5.9 are written by hand below; no figure is the code's own output.
  for (const word of unitWords('kg')) {
    it(`kg «${word}»: a shipment total and a table answer`, () => {
      // Both ways a person writes it: spaced, and glued to the number.
      for (const text of [`jami 507 ${word}`, `507${word}`, `507 ${word.toUpperCase()}`]) {
        expect(parseManualFacts(text).weightKg, text).toBe(507);
        expect(parseManualFacts(text).volumeM3, text).toBeNull();
      }
      const seg = answered(`507 ${word}`);
      expect(seg.refused, word).toBeNull();
      expect(seg.at, word).toEqual({ totals: 'weightKg' });
      expect(seg.totals, word).toEqual({ weightKg: 507, volumeM3: null, ambiguous: [] });
      expect(looksLikeTableAnswer(`507 ${word}`), word).toBe(true);
    });
  }

  for (const word of unitWords('m3')) {
    it(`m³ «${word}»: a shipment total and a table answer`, () => {
      for (const text of [`jami 5.9 ${word}`, `5.9${word}`, `5.9 ${word.toUpperCase()}`]) {
        expect(parseManualFacts(text).volumeM3, text).toBe(5.9);
        expect(parseManualFacts(text).weightKg, text).toBeNull();
      }
      const seg = answered(`5.9 ${word}`);
      expect(seg.refused, word).toBeNull();
      expect(seg.at, word).toEqual({ totals: 'volumeM3' });
      expect(seg.totals, word).toEqual({ weightKg: null, volumeM3: 5.9, ambiguous: [] });
      expect(looksLikeTableAnswer(`5.9 ${word}`), word).toBe(true);
    });
  }

  it('both figures of one answer, in the packing list’s words (T2)', () => {
    const seg = answered('507 kgs 5.9 cbm');
    expect(seg.refused).toBeNull();
    expect(seg.totals).toEqual({ weightKg: 507, volumeM3: 5.9, ambiguous: [] });
  });
});

/**
 * The tonne and the gram (§3.1 T14, review JN-9, JR-22) — the VOCABULARY:
 * the words and their factors. Who reads them, and where, is
 * tests/unit/scaled-kilos.test.ts.
 */
describe('the scaled kilo words', () => {
  it('a tonne is a thousand kilos and a gram a thousandth — in the spellings that can be nothing else', () => {
    for (const word of ['tonna', 'ton', 'tons', 'тн', 'тонн', 'тонна', 'тонны', '吨']) expect(scaledKg(word), word).toEqual({ factor: 1000, lone: false });
    for (const word of ['gr', 'gramm', 'гр', 'грамм', 'граммов', '克']) expect(scaledKg(word), word).toEqual({ factor: 0.001, lone: false });
    expect(scaledKg('TONNA')).toEqual({ factor: 1000, lone: false });
    // 2.5 × 1000 and 20 × 0.001, by hand: no 0.020000000000000004.
    expect(scaledKgValue(2.5, 1000)).toBe(2500);
    expect(scaledKgValue(20, 0.001)).toBe(0.02);
    expect(scaledKgValue(500, 0.001)).toBe(0.5);
  });

  it('the single letters are marked `lone` — «128G», «5T» and «2024 г» are no weights', () => {
    for (const word of ['t', 'т', 'mt']) expect(scaledKg(word), word).toEqual({ factor: 1000, lone: true });
    for (const word of ['g', 'г']) expect(scaledKg(word), word).toEqual({ factor: 0.001, lone: true });
  });

  it('a scaled word is never a unit of its own: every other door reads what it read', () => {
    for (const { words, lone } of SCALED_KG) {
      for (const word of [...words, ...lone]) {
        expect(unitOf(word), word).toBeNull();
        expect(routeAmount(2, word), word).toEqual({ unknownUnit: word, value: 2 });
      }
    }
    expect(scaledKg('kg')).toBeNull();
    expect(scaledKg('kub')).toBeNull();
    // Re-anchored when T14 wired the words (this line read «Until T14 wires
    // it, “2 tonna” states no weight to any reader» — weightKg: null): the
    // bot's totals reader reads the tonne now. 2 × 1000 = 2000, by hand.
    expect(parseManualFacts('jami 2 tonna 12 kub')).toMatchObject({ weightKg: 2000, volumeM3: 12 });
  });
});

describe('the labels of a totals line and of a supplier’s spec block', () => {
  it('holds the Latin, Cyrillic and Chinese forms a forwarded message carries', () => {
    expect(WEIGHT_LABELS).toEqual(expect.arrayContaining(['g.w.', 'gw', 'brutto', 'брутто', '毛重']));
    expect(NET_LABELS).toEqual(expect.arrayContaining(['n.w.', 'netto', 'нетто', '净重']));
    expect(VOLUME_LABELS).toEqual(expect.arrayContaining(['cbm', 'meas', 'volume', 'hajm', 'объём', '体积']));
    expect(FIELD_LABELS.name).toEqual(expect.arrayContaining(['品名', 'product', 'наименование', 'nomi']));
    // WHOSE size a label names is two lists (review JN-11): only a package's is multiplied.
    expect(FIELD_LABELS.packageSize).toEqual(expect.arrayContaining(['外箱尺寸', '箱规', 'carton size', 'ctn size', 'размер коробки']));
    expect(FIELD_LABELS.size).toEqual(expect.arrayContaining(['尺寸', 'size', 'dimensions', 'размер', 'габариты']));
    for (const label of FIELD_LABELS.packageSize) expect(FIELD_LABELS.size as readonly string[], label).not.toContain(label);
    // «/件» marks nothing: «件» is a piece as often as a package (JN-8).
    expect(PER_PACKAGE_TAIL).not.toContain('/件');
    expect(tailAt('15kg/件', 4, PER_PACKAGE_TAIL)).toBe(0);
    expect(FIELD_LABELS.cartons).toEqual(expect.arrayContaining(['箱数', 'ctns', 'мест']));
  });

  it('no word is both a gross and a net label, and a label list is lower-case', () => {
    for (const net of NET_LABELS) expect(WEIGHT_LABELS, net).not.toContain(net);
    for (const list of [WEIGHT_LABELS, NET_LABELS, VOLUME_LABELS, ...Object.values(FIELD_LABELS)]) {
      for (const label of list) expect(label).toBe(label.toLowerCase());
    }
  });
});

describe('a per-package / per-piece tail', () => {
  it('«15kg/箱», «0.12 cbm / ctn», «15 кг/место» are ONE package’s', () => {
    expect(tailAt('15kg/箱', 4, PER_PACKAGE_TAIL)).toBe(2);
    expect(tailAt('0.12 cbm / ctn', 8, PER_PACKAGE_TAIL)).toBe(6);
    expect(tailAt('15 кг/место 20 мест', 5, PER_PACKAGE_TAIL)).toBe(6);
    expect(tailAt('15 kg/CTN', 5, PER_PACKAGE_TAIL)).toBe(4);
  });

  it('«4.5 kg/шт», «4.5kg/pc» are ONE piece’s', () => {
    expect(tailAt('4.5 kg/шт', 6, PER_PIECE_TAIL)).toBe(3);
    expect(tailAt('4.5kg/pc', 5, PER_PIECE_TAIL)).toBe(3);
  });

  it('no slash, another word, or a longer word is no tail', () => {
    expect(tailAt('15 kg ctn', 5, PER_PACKAGE_TAIL)).toBe(0);
    expect(tailAt('15 kg/m3', 5, PER_PACKAGE_TAIL)).toBe(0);
    expect(tailAt('15 kg/ctnr', 5, PER_PACKAGE_TAIL)).toBe(0);
    expect(tailAt('3000pcs/15ctns', 7, PER_PACKAGE_TAIL)).toBe(0);
  });
});
