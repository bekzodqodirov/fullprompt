import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGoodsLines, parseManualFacts } from '@/modules/wms/calc/intake-manual';
import { parseTableAnswer, TOTALS_WORDS, type TableRef, type TableTarget } from '@/modules/wms/calc/line-address';
import {
  NET_LABELS,
  parseGoodsLine,
  TOTALS_LEAD_LABELS,
  UNIT_FREE_LABELS,
  unitOf,
  unitWords,
  VOLUME_LABELS,
  WEIGHT_LABELS,
} from '@/modules/wms/calc/units';

/**
 * docs/AI-SORAYDI.md §3.1 T1 — totals in the trade's words (dg3-01…08; review
 * JN-21, JN-22).
 *
 * His sentence: «"cbm" degan yozuvni o‘qiy olmayapti». The row kernel knew
 * «cbm» and «kgs»; the reader of the SHIPMENT's totals kept two lists of its
 * own — kub / куб / m3 and kg / кг / kilo / килограмм — so the forwarder's
 * line «TOTAL: 15 CTNS, G.W.: 507 KGS, MEAS: 5.92 CBM» stated nothing, the
 * bot's own cube question refused «5.9 cbm», and the per-carton «34kg» beside
 * «507 KGS» was the only weight it saw (34 kg landed under ✅). It reads
 * through the one vocabulary now. Every literal here is by hand.
 */

const totals = (text: string, section?: 'yolkira' | 'rastamojka' | 'podklyuch') => {
  const f = parseManualFacts(text, section);
  return { kg: f.weightKg ?? null, m3: f.volumeM3 ?? null, netto: f.weightNetto === true, asked: f.ambiguous };
};
const none = { kg: null, m3: null, netto: false, asked: [] };

describe('parseManualFacts reads, as the shipment’s (T1)', () => {
  it('the cube in the trade’s words', () => {
    for (const [text, m3] of [
      ['5 cbm', 5],
      ['5.92 CBM', 5.92],
      ['5,9 cbm', 5.9],
      ['5.9cbm', 5.9],
      ['MEAS: 5.92 CBM', 5.92],
      ['hajmi 5 cbm', 5],
      ['5 кбм', 5],
      ['5 куба', 5],
      ['12 кубов', 12],
      ['5 кубометров', 5],
      ['5.9 CU.M', 5.9],
      ['5.92 cubic meters', 5.92],
      ['5.92立方', 5.92],
    ] as const) {
      expect(totals(text), text).toEqual({ ...none, m3 });
    }
  });

  it('the kilos likewise', () => {
    for (const [text, kg] of [
      ['507 kgs', 507],
      ['507kgs', 507],
      ['G.W. 507 KGS', 507],
      ['gross 507 kg', 507],
      ['507 кило', 507],
      ['507 килограммов', 507],
      ['507公斤', 507],
    ] as const) {
      expect(totals(text), text).toEqual({ ...none, kg });
    }
  });

  it('both figures of one line — the forwarder’s totals line, the Chinese one, the seller’s', () => {
    expect(totals('TOTAL: 15 CTNS, G.W.: 507 KGS, MEAS: 5.92 CBM')).toEqual({ ...none, kg: 507, m3: 5.92 });
    // «体积 5.92立方» was lost: the weight landed and the cube was asked again.
    expect(totals('毛重 507kg 体积 5.92立方')).toEqual({ ...none, kg: 507, m3: 5.92 });
    expect(totals('15箱 507KG 5.92CBM')).toEqual({ ...none, kg: 507, m3: 5.92 });
    expect(totals('15件 507公斤 5.92方')).toEqual({ ...none, kg: 507, m3: 5.92 });
    expect(totals('jami 507 kgs 5.9 cbm')).toEqual({ ...none, kg: 507, m3: 5.9 });
    expect(totals('Hajmi 5.92 cbm, og‘irligi 507 kg')).toEqual({ ...none, kg: 507, m3: 5.92 });
    expect(totals('вес 507 кг объем 5,9 cbm')).toEqual({ ...none, kg: 507, m3: 5.9 });
    // A Han label glued to its figure is still a label and a figure.
    expect(totals('毛重507kg')).toEqual({ ...none, kg: 507 });
  });

  it('a figure written label-first with no unit, after a label that names nothing but that measure', () => {
    expect(totals('CBM: 5.92')).toEqual({ ...none, m3: 5.92 });
    expect(totals('G.W.: 507')).toEqual({ ...none, kg: 507 });
    expect(totals('G.W. = 507')).toEqual({ ...none, kg: 507 });
    expect(totals('Brutto: 507')).toEqual({ ...none, kg: 507 });
    expect(totals('Og‘irligi: 507')).toEqual({ ...none, kg: 507 });
    expect(totals('Вес брутто: 507')).toEqual({ ...none, kg: 507 });
    expect(totals('毛重：507')).toEqual({ ...none, kg: 507 });
    expect(totals('体积: 5.92')).toEqual({ ...none, m3: 5.92 });
    expect(totals('Hajmi: 12')).toEqual({ ...none, m3: 12 });
    // Grouped thousands after its own label are whole.
    expect(totals('G.W.: 12 500')).toEqual({ ...none, kg: 12500 });
    // Two labels on one line, and a line each.
    expect(totals('G.W.: 507 MEAS: 5.92')).toEqual({ ...none, kg: 507, m3: 5.92 });
    expect(totals('G.W.: 507, CBM: 5.92')).toEqual({ ...none, kg: 507, m3: 5.92 });
    expect(totals('Kurtka 300 dona\nG.W.: 507\nCBM: 5.92')).toEqual({ ...none, kg: 507, m3: 5.92 });
  });

  it('…or with the unit written between the label and the figure — there any label of the measure will do', () => {
    expect(totals('Hajmi (m3): 12')).toEqual({ ...none, m3: 12 });
    expect(totals('Объем (м3): 12')).toEqual({ ...none, m3: 12 });
    expect(totals('G.W. (KGS) 507')).toEqual({ ...none, kg: 507 });
    expect(totals('Вес, кг: 150')).toEqual({ ...none, kg: 150 });
    expect(totals('Gross (kg): 507')).toEqual({ ...none, kg: 507 });
    expect(totals('Vol (m3): 3')).toEqual({ ...none, m3: 3 });
  });
});

describe('what is NOT a total (review JN-21)', () => {
  it('a bare figure, a label with neither a colon nor a unit', () => {
    expect(totals('5.92')).toEqual(none);
    expect(totals('G.W. 507')).toEqual(none);
    expect(totals('cbm 5.92')).toEqual(none);
  });

  it('a label that is also money, a product’s noun, or a weight nobody called brutto needs its unit', () => {
    // An invoice's «Gross: 12 500» and «Net: 4 500» are sums.
    for (const text of ['Gross: 12 500', 'Net: 4500', 'Vol: 3', 'Cube: 3', 'Kub: 3', 'Куб: 3', 'Вес: 507', 'Масса: 507', 'Total weight: 507']) {
      expect(totals(text), text).toEqual(none);
    }
    // …and with it they are read.
    expect(totals('Вес: 507 кг').kg).toBe(507);
    expect(totals('Gross: 507 kg').kg).toBe(507);
  });

  it('a currency on the line, or a unit of its own after the figure', () => {
    expect(totals('Brutto: 12 500 $')).toEqual(none);
    expect(totals('Invoice total: 12 500 USD, G.W.: 507')).toEqual(none);
    // 2.5 tonnes are not 2.5 kg; 507 lbs are not 507 kg.
    expect(totals('G.W.: 2.5 MT')).toEqual(none);
    expect(totals('G.W.: 507 lbs')).toEqual(none);
    // Two numbers after one label: which is it? (A second group of THREE
    // digits is the same number — «G.W.: 507 480» is 507 480 kg.)
    expect(totals('G.W.: 507 48')).toEqual(none);
    expect(totals('G.W.: 507 480')).toEqual({ ...none, kg: 507480 });
  });

  it('a label a NAME word possesses names that thing’s measure — never the shipment’s', () => {
    // An engine's displacement, a tank's litres, one jacket's weight: with no
    // unit after the figure, only the word before the label says whose it is.
    for (const text of ['Dvigatel hajmi: 1.6', 'Bak hajmi: 50', 'Kurtka og‘irligi: 0.5', 'folding chair G.W.: 15', 'Двигатель объём (м3): 2']) {
      expect(totals(text), text).toEqual(none);
    }
    expect(totals('Kurtka sof og‘irligi: 0.5', 'rastamojka')).toEqual(none);
    // The shipment's own: the label opens its clause, or follows a totals
    // word, the cargo itself, a code, the previous label's figure.
    for (const [text, kg, m3] of [
      ['Yuk hajmi: 12', null, 12],
      ['Yukning hajmi: 12', null, 12],
      ['Umumiy hajmi: 12', null, 12],
      ['Jami og‘irligi: 507', 507, null],
      ['Tovarlar og‘irligi: 507', 507, null],
      ['Tovar og‘irligi: 507, hajmi: 12', 507, 12],
      ['GS777 G.W.: 507', 507, null],
      ['货物毛重: 507', 507, null],
    ] as const) {
      expect(totals(text), text).toEqual({ ...none, kg, m3 });
    }
  });

  it('a figure and a unit on two lines are two lines', () => {
    // «507» ends its line and «CBM» opens the next: no cube of 507.
    expect(totals('G.W.: 507\nCBM: 5.92')).toEqual({ ...none, kg: 507, m3: 5.92 });
    expect(totals('jami 507\nkg')).toEqual(none);
  });
});

describe('the rules that stood, stand', () => {
  it('one distinct figure per field, in every spelling of the unit — two are no total', () => {
    // dg3-01: one carton's «34kg» was the only weight this reader saw, and
    // typed beats read — 34 kg landed over the model's 507. Two weights now:
    // the typed reader answers nothing and the model's reading stands. (The
    // case as dg3-01 wrote it, «34kg/ctn», is ONE carton's and no total at
    // all since T4 — per-package.test.ts; here the second weight is unmarked.)
    expect(totals('Stul 20 dona\n15 CTNS 507 KGS 5.92 CBM, 34kg')).toEqual({ ...none, m3: 5.92 });
    expect(totals('taxminan 6 kub\nMEAS: 5.92 CBM')).toEqual(none);
    // «5 kub» beside «6 m3»: the first spelling in a list used to win.
    expect(totals('jami 5 kub 6 m3')).toEqual(none);
    // The same figure said twice is one statement.
    expect(totals('5.92 kub\nMEAS: 5.92 CBM')).toEqual({ ...none, m3: 5.92 });
    expect(totals('G.W. 507 KGS\njami 507 kg')).toEqual({ ...none, kg: 507 });
  });

  it('a netto weight never answers the brutto a freight section asks — whichever label says it', () => {
    for (const label of NET_LABELS) {
      const text = `${label} 480 kg`;
      expect(totals(text, 'podklyuch'), text).toEqual(none);
      expect(totals(text, 'yolkira'), text).toEqual(none);
      expect(totals(text), text).toEqual(none);
      // On a customs-only job it stands, and says it is netto.
      expect(totals(text, 'rastamojka'), text).toEqual({ ...none, kg: 480, netto: true });
    }
    // In the trade's kilos too — «KGS» is readable now, and stays netto.
    expect(totals('N.W. 480 KGS', 'podklyuch')).toEqual(none);
    expect(totals('N/W 480 KGS', 'podklyuch')).toEqual(none);
    expect(totals('N.W.: 480', 'podklyuch')).toEqual(none);
    expect(totals('净重: 480', 'rastamojka')).toEqual({ ...none, kg: 480, netto: true });
    // Beside the brutto, the brutto answers everywhere.
    expect(totals('N.W. 480 KGS\nG.W. 507 KGS', 'podklyuch')).toEqual({ ...none, kg: 507 });
    expect(totals('N.W.: 480 G.W.: 507', 'rastamojka')).toEqual({ ...none, kg: 507 });
  });

  it('no weight label is read as netto', () => {
    for (const label of WEIGHT_LABELS) {
      const text = `${label} 507 kg`;
      expect(totals(text, 'podklyuch').kg, text).toBe(507);
    }
  });

  it('a goods line’s own figure is not the shipment’s', () => {
    const text = 'Kurtka 300 dona 150 kgs 2 cbm\nShim 200 dona 120 kgs 1.5 cbm\nTOTAL: G.W. 290 KGS, MEAS 3.6 CBM';
    // The two rows' figures are theirs; the totals line states the shipment.
    expect(totals(text)).toEqual({ ...none, kg: 290, m3: 3.6 });
  });
});

describe('the vocabulary’s new words (review JN-22)', () => {
  it('«Куба» after a word of the name is the name — «Сигары Куба: 5» is five pieces, not 5 m³', () => {
    expect(parseGoodsLine('Сигары Куба: 5')).toMatchObject({ name: 'Сигары Куба', quantity: 5, volumeM3: null });
    // Where it opens its clause, or follows a figure, a unit or a total word, it is a field.
    expect(parseGoodsLine('Куба: 50')).toMatchObject({ volumeM3: 50, quantity: null });
    expect(parseGoodsLine('Kurtka, kub: 5')).toMatchObject({ name: 'Kurtka', volumeM3: 5 });
    expect(parseGoodsLine('Kg: 150')).toMatchObject({ weightKg: 150, quantity: null });
    expect(parseGoodsLine('Jami kg: 150')).toMatchObject({ weightKg: 150 });
    expect(parseGoodsLine('Kurtka 300 dona, kg: 150')).toMatchObject({ quantity: 300, weightKg: 150 });
    // After its own measure's label it is that label's unit.
    expect(parseGoodsLine('Вес кг: 150')).toMatchObject({ weightKg: 150, quantity: null });
    // The ruling's own cost, pinned so it is seen: a kilo word after a NAME
    // word and before a colon is the name too.
    expect(parseGoodsLine('Kurtka kg: 150')).toMatchObject({ name: 'Kurtka kg', quantity: 150, weightKg: null });
    // The other units keep their field form wherever they stand.
    expect(parseGoodsLine('Kafel m2: 120')).toMatchObject({ measureUnit: 'm2', measureQty: 120 });
  });

  it('«N кубов» beside a piece count is what the toy is made of — it stays in the name', () => {
    expect(parseGoodsLine('Набор 4 кубов 20 шт')).toMatchObject({ name: 'Набор 4 кубов', quantity: 20, volumeM3: null, problems: [] });
    expect(parseGoodsLine('Konstruktor 12 kubov, 50 dona')).toMatchObject({ quantity: 50, volumeM3: null });
    expect(totals('Набор 4 кубов 20 шт').m3).toBeNull();
    expect(readGoodsLines('Набор 4 кубов 20 шт')).toMatchObject([{ name: 'Набор 4 кубов', quantity: 20, volumeM3: null }]);
    // Alone, or on a totals line, it is cubic metres.
    expect(parseGoodsLine('Игра 12 кубов')).toMatchObject({ name: 'Игра', volumeM3: 12 });
    expect(totals('jami 12 кубов').m3).toBe(12);
    // «куб» / «kub» beside a count is the ordinary «count and cube» line.
    expect(parseGoodsLine('Kurtka 300 dona 5 kub')).toMatchObject({ quantity: 300, volumeM3: 5 });
  });

  it('«cubic meters» is one unit of two words', () => {
    for (const word of ['cubic meter', 'cubic meters', 'cubic metre', 'cubic metres', 'CUBIC  METERS', 'cubicmeters']) {
      expect(parseGoodsLine(`5.92 ${word}`), word).toMatchObject({ volumeM3: 5.92, problems: [] });
      expect(unitOf(word), word).toBe('m3');
    }
    // In a name with no figure before it, it is the name.
    expect(parseGoodsLine('Cubic meter gauge 20 dona')).toMatchObject({ name: 'Cubic meter gauge', quantity: 20, volumeM3: null });
  });
});

describe('ONE vocabulary: the subsets are subsets, and no reader keeps a list (review JB-20)', () => {
  it('a label read with no unit, and a label a table answer may open with, are words of the label lists', () => {
    for (const label of UNIT_FREE_LABELS.weightKg) expect(WEIGHT_LABELS, label).toContain(label);
    for (const label of UNIT_FREE_LABELS.netKg) expect(NET_LABELS, label).toContain(label);
    for (const label of UNIT_FREE_LABELS.volumeM3) expect(VOLUME_LABELS, label).toContain(label);
    for (const label of TOTALS_LEAD_LABELS.weightKg) expect(WEIGHT_LABELS, label).toContain(label);
    for (const label of TOTALS_LEAD_LABELS.volumeM3) expect(VOLUME_LABELS, label).toContain(label);
    // …and the words JN-21 named stay out of the unit-free set.
    for (const label of ['gross', 'вес', 'масса', 'vazn', 'total weight']) expect(UNIT_FREE_LABELS.weightKg as readonly string[], label).not.toContain(label);
    for (const label of ['net']) expect(UNIT_FREE_LABELS.netKg as readonly string[], label).not.toContain(label);
    for (const label of ['vol', 'cube', 'kub', 'куб', 'volume']) expect(UNIT_FREE_LABELS.volumeM3 as readonly string[], label).not.toContain(label);
    // The table's field words are the vocabulary's.
    for (const label of [...TOTALS_LEAD_LABELS.weightKg, ...TOTALS_LEAD_LABELS.volumeM3]) expect(TOTALS_WORDS, label).toContain(label);
  });

  it('every unit-free label reads its figure, with a colon and nothing else', () => {
    for (const label of UNIT_FREE_LABELS.weightKg) expect(totals(`${label}: 507`), label).toEqual({ ...none, kg: 507 });
    for (const label of UNIT_FREE_LABELS.volumeM3) expect(totals(`${label}: 5.92`), label).toEqual({ ...none, m3: 5.92 });
    for (const label of UNIT_FREE_LABELS.netKg) {
      expect(totals(`${label}: 480`, 'podklyuch'), label).toEqual(none);
      expect(totals(`${label}: 480`, 'rastamojka'), label).toEqual({ ...none, kg: 480, netto: true });
    }
  });

  it('the three readers hold no unit word of their own', () => {
    // Comments out: the words are explained there. What is left is code, and
    // in code a kilo or a cube word may come only from units.ts. («kg» and
    // «m3» are also the units' KEYS — `unitPattern('kg')` — so they are not
    // looked for; every other spelling is.)
    const code = (file: string) =>
      readFileSync(path.join(process.cwd(), file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    const words = [...unitWords('kg'), ...unitWords('m3')].filter((w) => w !== 'kg' && w !== 'm3');
    // A word standing as a string or as a member of a regex alternation.
    const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const listed = new RegExp(`['"\`|(:](?:${words.map(esc).join('|')})['"\`|)]`, 'iu');
    for (const file of [
      'src/modules/wms/calc/intake-manual.ts',
      'src/modules/wms/calc/line-address.ts',
      'src/modules/platform/telegram/totals-shape.ts',
    ]) {
      const hit = listed.exec(code(file));
      expect(hit?.[0] ?? null, `${file} lists a unit word of its own`).toBeNull();
    }
    // The platform's shape test imports nothing — the words are handed to it.
    expect(code('src/modules/platform/telegram/totals-shape.ts')).not.toMatch(/\bimport\b/);
    // The names of the three lists are gone.
    expect(code('src/modules/wms/calc/line-address.ts')).not.toMatch(/WEIGHT_WORDS|VOLUME_WORDS/);
    expect(code('src/modules/platform/telegram/totals-shape.ts')).not.toMatch(/TOTALS_UNIT\b/);
  });
});

describe('the table’s totals answer, in the trade’s words (dg3-02, dg3-04)', () => {
  const TOTALS: TableTarget[] = [{ totals: 'weightKg' }, { totals: 'volumeM3' }];
  // One complete row; the brutto and the cube are the table's two questions.
  const table: TableRef = { rows: [{ no: 1, index: 0, seq: null, name: 'Kurtka', needs: [] }], open: TOTALS, preferred: TOTALS, stage: 'review' };
  const answer = (text: string) => {
    const out = parseTableAnswer(text, table);
    expect(out.material, text).toBe(false);
    expect(out.segments, text).toHaveLength(1);
    return out.segments[0]!;
  };

  it('every answer the trace met with «Umumiy uchun birlik bilan yozing…» is written', () => {
    for (const text of ['5.9 cbm', '5.9 CBM', '5,9 cbm', '5.9cbm', 'cbm: 5.9', 'jami 5.9 cbm', 'hajmi 5.9 cbm', 'umumiy hajmi 5.9 cbm', '5.9 立方', '5.9 кубов', '5.9 куба', '5.9 кбм', '5.9 kubometr']) {
      const seg = answer(text);
      expect(seg.refused, text).toBeNull();
      expect(seg.at, text).toEqual({ totals: 'volumeM3' });
      expect(seg.totals, text).toEqual({ weightKg: null, volumeM3: 5.9, ambiguous: [] });
    }
    for (const text of ['507 kgs', '507kgs', 'jami 507 kgs', 'brutto 507 kgs', 'G.W. 507 kgs', 'gross 507 kgs', '507 公斤', '507 kilogramm', '507 кило', 'G.W.: 507']) {
      const seg = answer(text);
      expect(seg.refused, text).toBeNull();
      expect(seg.at, text).toEqual({ totals: 'weightKg' });
      expect(seg.totals, text).toEqual({ weightKg: 507, volumeM3: null, ambiguous: [] });
    }
  });

  it('a bare figure after a field word takes that field’s unit — every word of the vocabulary’s lead labels', () => {
    // Both totals are open, so only the WORD can say which a bare «3500» is:
    // «vazni 3500» the kilos, «hajmi 12» the cube. The words are units.ts's
    // (`TOTALS_LEAD_LABELS`) — this file's own two lists are gone.
    for (const label of TOTALS_LEAD_LABELS.weightKg) {
      const seg = answer(`${label} 3500`);
      expect(seg.refused, label).toBeNull();
      expect(seg.at, label).toEqual({ totals: 'weightKg' });
      expect(seg.totals, label).toEqual({ weightKg: 3500, volumeM3: null, ambiguous: [] });
    }
    for (const label of TOTALS_LEAD_LABELS.volumeM3) {
      const seg = answer(`${label} 12`);
      expect(seg.refused, label).toBeNull();
      expect(seg.at, label).toEqual({ totals: 'volumeM3' });
      expect(seg.totals, label).toEqual({ weightKg: null, volumeM3: 12, ambiguous: [] });
    }
    // A word that says only «all of it» names neither: with both open it is asked.
    expect(answer('jami 3500').refused?.reason).toBe('totals_unit');
  });

  it('both figures of one answer are written (dg3-03: the cube was dropped under a 👍)', () => {
    for (const text of ['507 kg 5.92 cbm', '507 kgs 5.92 kub', '5.92 cbm 507 kgs']) {
      expect(answer(text).totals, text).toEqual({ weightKg: 507, volumeM3: 5.92, ambiguous: [] });
    }
    // The pasted forwarder's line is ONE answer, and states both.
    const pasted = answer('TOTAL: 15 CTNS, G.W.: 507 KGS, MEAS: 5.92 CBM');
    expect(pasted.refused).toBeNull();
    expect(pasted.totals).toEqual({ weightKg: 507, volumeM3: 5.92, ambiguous: [] });
  });

  it('a netto figure is never written as the brutto — «N/W» and «净重» included', () => {
    for (const text of ['N.W. 480 kgs', 'N/W 480 kgs', 'netto 480 kg', '净重 480 kg']) {
      const seg = answer(text);
      expect(seg.totals, text).toBeNull();
      expect(seg.refused, text).not.toBeNull();
    }
  });

  it('…it is the ROW’s weight: beside one row that owes its kilos, a netto-labelled answer goes there', () => {
    // The brutto and row 1's own weight are both open. A plain «480 kg» could
    // be either (asked); «N/W 480 kgs» says which — the label is the
    // vocabulary's, and «N/W» was on no list of the table's.
    const owing: TableRef = {
      rows: [{ no: 1, index: 0, seq: null, name: 'Kurtka', needs: ['kg'] }],
      open: [{ line: 1 }, { totals: 'weightKg' }],
      preferred: [{ line: 1 }, { totals: 'weightKg' }],
      stage: 'review',
    };
    for (const text of ['netto 480 kg', 'N.W. 480 kgs', 'N/W 480 kgs', 'NW 480 kgs', 'sof 480 kg']) {
      const [seg] = parseTableAnswer(text, owing).segments;
      expect(seg!.refused, text).toBeNull();
      expect(seg!.at, text).toEqual({ line: 1 });
      expect(seg!.answer, text).toMatchObject({ kind: 'figures', figures: { weightKg: 480 } });
    }
    expect(parseTableAnswer('480 kg', owing).segments[0]!.refused?.reason).toBe('no_address');
  });
});
