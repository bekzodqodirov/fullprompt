import { describe, expect, it } from 'vitest';
import { parseGoods, type Cell } from '@/modules/wms/deals/goods-import';

/**
 * «AI so‘raydi», package P-excel — the column reader (docs/AI-SORAYDI.md
 * §3.2, X0-X4, X6, X7; rulings JN-11, JN-13, JN-14, JR-1 of
 * docs/AI-SORAYDI-REVIEW.md). The corpus (c3400+) pins the diagnosis' own
 * sheets; these pin where each rule stops, on both sides. Every figure below
 * is worked out by hand in the comment beside it.
 */

const sheet = (header: Cell[], ...rows: Cell[][]) => parseGoods([header, ...rows]);
const first = (header: Cell[], ...rows: Cell[][]) => sheet(header, ...rows).goods[0]!;

describe('X6 — a volume header’s own unit (review JN-13)', () => {
  const volume = (header: string, value: Cell) => first(['Description', 'Qty', header], ['Chair', 10, value]).volumeM3;

  it('cubic centimetres are divided by a million, in every spelling', () => {
    // 120 000 cm³ ÷ 1 000 000 = 0.12 m³.
    for (const header of ['Volume (cm3)', 'Volume, cm³', '体积(cm³)', 'Объем (см3)', 'Объем, куб.см', 'Hajmi (sm3)', 'Volume cm3', '体积（立方厘米）']) {
      expect(volume(header, 120000), header).toBe(0.12);
    }
  });

  it('cubic decimetres and litres are divided by a thousand', () => {
    // 250 dm³ = 250 l = 0.25 m³.
    for (const header of ['Объем, дм3', 'Volume (dm3)', 'Объем, л', 'Объём (литр)', 'Volume (L)', 'Hajmi (litr)', 'Объём в литрах', 'Volume / L', '体积(升)']) {
      expect(volume(header, 250), header).toBe(0.25);
    }
  });

  it('cubic metres stay cubic metres — the unit part names them, or names no unit', () => {
    for (const header of ['CBM', 'Volume (CBM)', 'MEAS.(CBM)', 'Объем, м3', 'Общий объём, м³', 'Hajmi (m3)', '体积(m³)', 'Объем (куб.м)', 'Объем, м.куб', 'Volume (total)', 'Объем (всего)', 'Hajmi (jami)', 'Volume/m3']) {
      expect(volume(header, 1.2), header).toBe(1.2);
    }
  });

  it('a unit nobody converts refuses the column: no volume, the figure on the note', () => {
    for (const header of ['Volume (ft3)', 'Volume (cu.ft)', 'CBM (cm)', 'Volume, ml', 'Объем (мл)', 'Volume (inch)', 'Hajmi (sm)']) {
      const row = first(['Description', 'Qty', header], ['Chair', 10, 42]);
      expect(row.volumeM3, header).toBeNull();
      expect(row.note, header).toBe(`«${header}»: 42`);
    }
  });

  it('on the abbreviation rung a litre and a millilitre stay a bottle’s own (the corpus’ c1936, c1937)', () => {
    for (const header of ['Vol (L)', 'Vol, ml', 'MEAS (L)']) expect(volume(header, 4), header).toBeNull();
  });

  it('a column in cubic metres outranks a converted one, wherever each stands', () => {
    // «Volume (cm3)» 120000 would be 0.12; the «CBM» beside it says 1.2.
    expect(first(['Description', 'Volume (cm3)', 'CBM'], ['Chair', 120000, 1.2]).volumeM3).toBe(1.2);
    expect(first(['Description', 'CBM', 'Volume (cm3)'], ['Chair', 1.2, 120000]).volumeM3).toBe(1.2);
    // …and a «MEAS.» with no unit outranks it too, though it is the weaker rung.
    expect(first(['Description', 'Volume (cm3)', 'MEAS.'], ['Chair', 120000, 1.2]).volumeM3).toBe(1.2);
  });

  it('a converted figure says what the file wrote, and a glued unit is not guessed at', () => {
    expect(first(['Description', 'Qty', 'Volume (cm3)'], ['Chair', 10, 120000]).note).toBe('«Volume (cm3)»: 120000');
    const glued = first(['Description', 'Qty', 'Объем, л'], ['Бак', 10, '250 л']);
    expect(glued.volumeM3).toBeNull();
    expect(glued.note).toContain('hajm «250 л» — aniq emas');
  });

  it('the sheet’s own TOTAL row is read in the column’s unit: it agrees with the converted Σ, or refuses it', () => {
    // 120000 + 60000 = 180000 cm³ = 0.18 m³: the TOTAL row says the same.
    const agrees = sheet(['Description', 'Qty', 'G.W.', 'Volume (cm3)'], ['Jacket', 200, 120, 120000], ['Toy', 480, 260, 60000], ['TOTAL', 680, 380, 180000]);
    expect(agrees.volumeM3).toBe(0.18);
    // …and 3 800 000 cm³ (3.8 m³) against a 0.18 m³ Σ is a contradiction: no Σ.
    const refuses = sheet(['Description', 'Qty', 'G.W.', 'Volume (cm3)'], ['Jacket', 200, 120, 120000], ['Toy', 480, 260, 60000], ['TOTAL', 680, 380, 3800000]);
    expect(refuses.volumeM3).toBeNull();
    expect(refuses.goods.map((g) => g.volumeM3)).toEqual([0.12, 0.06]);
  });

  it('volumetric kilos and a density are neither the cube nor the weight', () => {
    for (const header of ['Объемный вес, кг', 'Объёмный вес', 'Volume weight (kg)', 'Volumetric weight', 'Chargeable weight (kg)', '体积重', 'Плотность, кг/м3']) {
      const row = first(['Description', 'Qty', header, 'G.W. (kg)', 'CBM'], ['Jacket', 300, 200, 150, 1.2]);
      // 150 is the gross column's; 200 — the heavier «plain» candidate — is the carrier's.
      expect([row.weightKg, row.volumeM3], header).toEqual([150, 1.2]);
      expect(row.note, header).toBe(`«${header}»: 200`);
    }
  });

  it('a real weight beside a real volume is untouched', () => {
    const row = first(['Наименование', 'Кол-во', 'Вес, кг', 'Объем, м3'], ['Куртка', 300, 150, 1.2]);
    expect([row.weightKg, row.volumeM3, row.note]).toEqual([150, 1.2, null]);
  });
});
