import { describe, expect, it } from 'vitest';
import {
  FIELD_LABELS,
  NET_LABELS,
  PER_PACKAGE_TAIL,
  PER_PIECE_TAIL,
  VOLUME_LABELS,
  WEIGHT_LABELS,
  tailAt,
  unitOf,
  unitPattern,
  unitWords,
} from '@/modules/wms/calc/units';

/**
 * docs/AI-SORAYDI.md §2.4 — ONE unit vocabulary.
 *
 * His sentence was «"cbm" degan yozuvni o‘qiy olmayapti»: the row kernel knew
 * the word, the shipment-totals reader and the totals-shaped test each kept a
 * shorter private list. This file pins the list itself; the readers' halves
 * (every word read as a total and as a table answer) stand beside their
 * readers' own tests.
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

describe('the labels of a totals line and of a supplier’s spec block', () => {
  it('holds the Latin, Cyrillic and Chinese forms a forwarded message carries', () => {
    expect(WEIGHT_LABELS).toEqual(expect.arrayContaining(['g.w.', 'gw', 'brutto', 'брутто', '毛重']));
    expect(NET_LABELS).toEqual(expect.arrayContaining(['n.w.', 'netto', 'нетто', '净重']));
    expect(VOLUME_LABELS).toEqual(expect.arrayContaining(['cbm', 'meas', 'volume', 'hajm', 'объём', '体积']));
    expect(FIELD_LABELS.name).toEqual(expect.arrayContaining(['品名', 'product', 'наименование', 'nomi']));
    expect(FIELD_LABELS.size).toEqual(expect.arrayContaining(['尺寸', 'carton size', 'размер']));
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
