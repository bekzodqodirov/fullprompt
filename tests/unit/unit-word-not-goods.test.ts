import { describe, expect, it } from 'vitest';
import { notGoodsWord } from '@/modules/wms/calc/intake';
import { parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { parseTableAnswer, type TableRef, type TableSegment, type TableTarget } from '@/modules/wms/calc/line-address';
import { nearUnit, unitOf } from '@/modules/wms/calc/units';

/**
 * docs/AI-SORAYDI.md §3.1 T3 — a unit word is never a product (dg3-04,
 * dg3-05, dg2-10, DIM-10; review JN-21).
 *
 * Two halves of one defect. With the model silent, a forwarder's line «MEAS:
 * 5.92 CBM» was a PRODUCT «MEAS — 5.92 m³» on the table, to be coded and
 * priced. And at the table, a figure with a word nobody's list knew — «5.9
 * kubik» — was «“kubik” — jadvalda bunday qator yo‘q», as if the seller had
 * named goods the table lacked; the plain door filed it as material and took
 * a paid re-read for a unit word.
 *
 * Every literal is by hand.
 */

const names = (text: string) => readGoodsLines(text).map((g) => g.name);
const totals = (text: string, section?: 'podklyuch' | 'rastamojka') => {
  const f = parseManualFacts(text, section);
  return { kg: f.weightKg ?? null, m3: f.volumeM3 ?? null, netto: f.weightNetto === true };
};

describe('with the model silent, a totals line in the forwarder’s words is no row', () => {
  it('the lines the trace met as products', () => {
    for (const line of [
      'MEAS: 5.92 CBM',
      'Meas. 5.92 cbm',
      'Measurement: 5.92 CBM',
      'Vol: 5.92 cbm',
      'G.W. 1136.5 kg CBM 7.19',
      'KGS 507 kg',
      'CBM 5.92 m3',
      'PKGS 15 pcs',
      'Dims 60x40x50 cm 300 kg',
      'Cubic 5.92 cbm',
    ]) {
      expect(names(line), line).toEqual([]);
    }
  });

  it('…and its figures are the SHIPMENT’s', () => {
    expect(totals('MEAS: 5.92 CBM')).toEqual({ kg: null, m3: 5.92, netto: false });
    // «CBM 7.19» has neither a colon nor a unit after it: not read (T1, JN-21) — the cube is asked.
    expect(totals('G.W. 1136.5 kg CBM 7.19')).toEqual({ kg: 1136.5, m3: null, netto: false });
  });

  it('beside real goods the rows stay rows, and the forwarder’s line states the totals', () => {
    const text = 'Kurtka 300 dona 150 kg\nShim 200 dona 80 kg\nTOTAL: 15 CTNS, G.W.: 507 KGS, MEAS: 5.92 CBM';
    expect(names(text)).toEqual(['Kurtka', 'Shim']);
    // 150 and 80 are their lines' own (PF-2); 507 and 5.92 the shipment's.
    expect(totals(text)).toEqual({ kg: 507, m3: 5.92, netto: false });
  });

  it('the supplier’s mark block: no row called «Measurement», and the brutto is the G.W. — not lost to the N.W. under it', () => {
    const block = 'Description: LED lamp\nQuantity: 3000 PCS\nPackages: 15 CTNS\nG.W.: 507 KGS\nN.W.: 480 KGS\nMeasurement: 5.92 CBM';
    expect(names(block)).toEqual([]);
    // A freight section asks the brutto: 507. The netto 480 answers nothing there.
    expect(totals(block, 'podklyuch')).toEqual({ kg: 507, m3: 5.92, netto: false });
    // Customs-only: the brutto is stated, so the netto does not stand in for it.
    expect(totals(block, 'rastamojka')).toEqual({ kg: 507, m3: 5.92, netto: false });
  });
});

describe('a netto label labels the figure it stands WITH (found while reading the mark block)', () => {
  it('«N.W.» opening the next figure is that figure’s label — the dot of the label is the label’s', () => {
    // Was null on every one: «N.W» matched, its dot stopped the look for the
    // number after it, and the BRUTTO before it was taken for the netto.
    for (const text of ['G.W.: 507 KGS\nN.W.: 480 KGS', 'G.W. 507 kg\nN.W. 480 kg', 'Brutto 507 kg N.W.: 480 kg', '507 kg N.W. 480 kg', 'G.W. 507 kg N/W 480 kg']) {
      expect(totals(text, 'podklyuch'), text).toEqual({ kg: 507, m3: null, netto: false });
    }
  });

  it('…and a netto label AFTER its figure still labels it', () => {
    for (const text of ['1200 kg netto', '1200 kg (netto)', '1200 kg N.W.', '1200 kgs n.w']) {
      expect(totals(text, 'podklyuch'), text).toEqual({ kg: null, m3: null, netto: false });
      expect(totals(text, 'rastamojka'), text).toEqual({ kg: 1200, m3: null, netto: true });
    }
    // «1300 kg netto 1200 kg»: the label is the NEXT figure's.
    expect(totals('1300 kg netto 1200 kg', 'podklyuch')).toEqual({ kg: 1300, m3: null, netto: false });
  });
});

describe('what stays a product (review JN-21)', () => {
  it('the rule is every word of the name: a product that only CONTAINS such a word is a product', () => {
    expect(names('Rubik cube 300 dona')).toEqual(['Rubik cube']);
    expect(names('Cubic zirconia 300 dona')).toEqual(['Cubic zirconia']);
    expect(names('Dim lamp 300 dona')).toEqual(['Dim lamp']);
    expect(names('Vol bass kolonka 20 dona')).toEqual(['Vol bass kolonka']);
  });

  it('«cube», «package» and «size» are no not-goods words — a product may be called so', () => {
    for (const word of ['cube', 'package', 'size']) expect(notGoodsWord(word), word).toBe(false);
    expect(names('Cube 300 dona')).toEqual(['Cube']);
    expect(names('Package 300 dona')).toEqual(['Package']);
  });

  it('the words that were added, and no other', () => {
    for (const word of ['meas', 'measurement', 'vol', 'cubic', 'cbm', 'kgs', 'pkgs', 'pkg', 'packages', 'dim', 'dims', 'MEAS', 'Vol']) {
      expect(notGoodsWord(word), word).toBe(true);
    }
    // A dotted abbreviation reaches the list through the name's words: «Meas.» is «meas».
    expect(names('Meas. 5.92 cbm')).toEqual([]);
  });
});

describe('`nearUnit` — the kilo or the cube a word that is no unit most likely means', () => {
  it('a word of the vocabulary with an ending on it', () => {
    for (const word of ['kubik', 'кубик', 'кубометры', 'kubometrov', 'cbms', 'kublar', 'KUBIK']) expect(nearUnit(word), word).toBe('m3');
    for (const word of ['kilogr', 'килограммы', 'kilolar']) expect(nearUnit(word), word).toBe('kg');
  });

  it('never a unit itself, never a long tail, never a two-letter stem, never «cumin»', () => {
    // A unit is READ, not resembled.
    for (const word of ['kub', 'kg', 'cbm', 'кубов']) {
      expect(unitOf(word), word).not.toBeNull();
      expect(nearUnit(word), word).toBeNull();
    }
    // «kilometr» is «kilo» + four letters, «кубатура» «куб» + five: no ending is that long.
    // «кгс» is «кг» + a letter — but two letters are too short a stem to resemble anything.
    for (const word of ['banka', 'metr', 'kilometr', 'кубатура', 'cumin', 'kubokchalar', 'кгс', 'xil', 'Pro']) {
      expect(nearUnit(word), word).toBeNull();
    }
  });
});

describe('at the table, a figure and a word that is no unit is asked AS A UNIT', () => {
  const TOTALS: TableTarget[] = [{ totals: 'weightKg' }, { totals: 'volumeM3' }];
  const table: TableRef = {
    rows: [
      { no: 1, index: 0, seq: null, name: 'Kurtka', needs: ['dona'] },
      { no: 2, index: 1, seq: null, name: 'iPhone 15', needs: ['dona'] },
    ],
    open: [{ line: 1 }, { line: 2 }, ...TOTALS],
    preferred: [{ line: 1 }, { line: 2 }, ...TOTALS],
    stage: 'review',
  };
  const one = (text: string, ref: TableRef = table): TableSegment => {
    const out = parseTableAnswer(text, ref);
    expect(out.material, text).toBe(false);
    expect(out.segments, text).toHaveLength(1);
    return out.segments[0]!;
  };

  it('the reason stays what it was (every door files the segment as before) — the refusal says it is about a unit', () => {
    expect(one('5.9 kubik').refused).toEqual({ reason: 'name_none', detail: 'kubik', unit: { word: 'kubik', number: '5.9', near: 'm3' } });
    expect(one('507 kilogr').refused).toEqual({ reason: 'name_none', detail: 'kilogr', unit: { word: 'kilogr', number: '507', near: 'kg' } });
    expect(one('5.9 кубик').refused?.unit).toEqual({ word: 'кубик', number: '5.9', near: 'm3' });
    // A word that resembles nothing: still asked as a unit, with no guess.
    expect(one('300 banka').refused).toEqual({ reason: 'name_none', detail: 'banka', unit: { word: 'banka', number: '300', near: null } });
    // Beside a figure the table DID read: the word is still nobody's goods.
    expect(one('507 kg 5.9 kubik').refused?.unit).toEqual({ word: 'kubik', number: '5.9', near: 'm3' });
  });

  it('a word too short to be anybody’s name, and addressed to a row', () => {
    expect(one('5 kb').refused).toEqual({ reason: 'no_address', detail: '5 kb', unit: { word: 'kb', number: '5', near: null } });
    const addressed = one('1: 5.9 kubik');
    expect(addressed.at).toEqual({ line: 1 });
    expect(addressed.refused).toEqual({
      reason: 'name_mismatch',
      detail: 'kubik',
      candidates: [1],
      unit: { word: 'kubik', number: '5.9', near: 'm3' },
    });
  });

  it('a NAME beside the word is goods, and a model’s number is the model’s — those keep the refusal they had', () => {
    expect(one('Shapka 5 banka').refused).toEqual({ reason: 'name_none', detail: 'Shapka banka' });
    expect(one('iPhone 14 Pro 30 dona').refused?.unit).toBeUndefined();
    expect(one('1: Shim 5.9 kubik').refused?.unit).toBeUndefined();
    // A unit the table knows names its row as it always did.
    expect(one('iPhone 15 30 dona').at).toEqual({ line: 2 });
  });

  it('a measure’s label says which figure, never which goods: «MEAS: 5.92 CBM» is the cube (dg3-08)', () => {
    for (const text of ['MEAS: 5.92 CBM', 'Meas. 5.92 cbm', 'Measurement: 5.92 CBM', '体积 5.92立方', '体积5.92立方']) {
      const seg = one(text);
      expect(seg.refused, text).toBeNull();
      expect(seg.at, text).toEqual({ totals: 'volumeM3' });
      expect(seg.totals, text).toEqual({ weightKg: null, volumeM3: 5.92, ambiguous: [] });
    }
  });

  it('…but a label that is also a product’s noun still names a row (review JN-21)', () => {
    const nets: TableRef = {
      rows: [
        { no: 1, index: 0, seq: null, name: 'Fishing net', needs: ['dona'] },
        { no: 2, index: 1, seq: null, name: 'Magic cube', needs: ['dona'] },
        { no: 3, index: 2, seq: null, name: 'Kurtka', needs: ['dona'] },
      ],
      open: [{ line: 1 }, { line: 2 }, { line: 3 }],
      preferred: [{ line: 1 }, { line: 2 }, { line: 3 }],
      stage: 'review',
    };
    expect(one('Net 30 dona', nets).at).toEqual({ line: 1 });
    expect(one('Cube 30 dona', nets).at).toEqual({ line: 2 });
    // …and «Vol 30 dona» names no row there: asked, never written to row 3.
    expect(one('Vol 30 dona', nets).refused?.reason).toBe('name_none');
  });
});

describe('the shipment’s own line, typed at the table without «jami»', () => {
  const TOTALS: TableTarget[] = [{ totals: 'weightKg' }, { totals: 'volumeM3' }];
  const table: TableRef = { rows: [{ no: 1, index: 0, seq: null, name: 'Kurtka', needs: [] }], open: TOTALS, preferred: TOTALS, stage: 'review' };
  const read = (text: string) => parseTableAnswer(text, table).segments;

  it('the forwarder’s line with a brutto AND a netto: the totals are written, the netto named (T2)', () => {
    // Two kilos are no ONE row's answer («repeated») — but they are a totals line.
    const segments = read('G.W.: 507 KGS N.W.: 480 KGS MEAS: 5.92 CBM');
    expect(segments).toHaveLength(2);
    expect(segments[0]!.totals).toEqual({ weightKg: 507, volumeM3: 5.92, ambiguous: [] });
    expect(segments[1]!.refused?.left).toEqual([{ why: 'netto', text: 'N.W. 480 KGS', number: '480' }]);
  });

  it('the same on three lines, as it is pasted', () => {
    const segments = read('G.W.: 507 KGS\nN.W.: 480 KGS\nMEAS: 5.92 CBM');
    expect(segments.map((s) => s.totals)).toEqual([
      { weightKg: 507, volumeM3: null, ambiguous: [] },
      null,
      { weightKg: null, volumeM3: 5.92, ambiguous: [] },
    ]);
    // The netto line alone is no total (PF-1): refused, never written as the brutto.
    expect(segments[1]!.refused).not.toBeNull();
  });

  it('a Han label glued to its figure — no amount to the row kernel — is read by the totals reader', () => {
    const [seg] = read('毛重507kg');
    expect(seg!.refused).toBeNull();
    expect(seg!.totals).toEqual({ weightKg: 507, volumeM3: null, ambiguous: [] });
    expect(read('毛重507kg 体积5.92立方')[0]!.totals).toEqual({ weightKg: 507, volumeM3: 5.92, ambiguous: [] });
  });
});
