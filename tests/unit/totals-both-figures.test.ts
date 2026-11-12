import { describe, expect, it } from 'vitest';
import { parseManualFacts, readTypedTotals } from '@/modules/wms/calc/intake-manual';
import { parseTableAnswer, type TableRef, type TableSegment, type TableTarget } from '@/modules/wms/calc/line-address';
import { amountsIn } from '@/modules/wms/calc/units';

/**
 * docs/AI-SORAYDI.md §3.1 T2 — both figures of one answer, and nothing
 * dropped (dg3-03).
 *
 * The table asked the brutto and the cube; the seller typed «507 kg 5.92
 * cbm»; the kilos were written, the cube was dropped, and the message got a
 * 👍 — the request was stored with no volume. Phase 1 taught the reader the
 * word «cbm», so that answer writes both now. What is pinned HERE is the rule
 * behind it: a totals answer accounts for EVERY figure it holds. What a total
 * takes is written; what it cannot take is a refusal that names it, beside
 * the totals that were written — neither half is lost to the other.
 *
 * Every literal is by hand.
 */

const TOTALS: TableTarget[] = [{ totals: 'weightKg' }, { totals: 'volumeM3' }];
// One complete row; the brutto and the cube are the table's two questions.
const table: TableRef = {
  rows: [{ no: 1, index: 0, seq: null, name: 'Kurtka', needs: [] }],
  open: TOTALS,
  preferred: TOTALS,
  stage: 'review',
};
const read = (text: string, ref: TableRef = table) => {
  const out = parseTableAnswer(text, ref);
  expect(out.material, text).toBe(false);
  return out.segments;
};
const written = (seg: TableSegment | undefined) => seg?.totals ?? null;
const left = (seg: TableSegment | undefined) => (seg?.refused?.left ?? []).map((l) => [l.why, l.text]);

describe('a totals answer writes every total it states', () => {
  it('both figures, in either order and in the trade’s words', () => {
    for (const text of ['507 kg 5.92 cbm', '5.92 cbm 507 kg', 'jami 507 kgs 5.92 kub', '507kg 5.92cbm']) {
      const segments = read(text);
      expect(segments, text).toHaveLength(1);
      expect(segments[0]!.refused, text).toBeNull();
      expect(written(segments[0]), text).toEqual({ weightKg: 507, volumeM3: 5.92, ambiguous: [] });
    }
  });

  it('a bare figure beside a worded one is the field the lead word names', () => {
    // «og‘irligi» says which total the bare 3500 is; the cube says its own.
    for (const text of ['og‘irligi 3500, 12 kub', 'og‘irligi 3500 12 kub', 'vazni 3500 12 m3']) {
      const segments = read(text);
      expect(segments, text).toHaveLength(1);
      expect(written(segments[0]), text).toEqual({ weightKg: 3500, volumeM3: 12, ambiguous: [] });
    }
    // «hajmi 12 3500 kg»: the bare 12 is the cube the word names.
    expect(written(read('hajmi 12 3500 kg')[0])).toEqual({ weightKg: 3500, volumeM3: 12, ambiguous: [] });
  });

  it('…but a word that says only «all of it» names no field: the bare figure is asked, the worded one written', () => {
    const segments = read('jami 507 kg 5.9');
    expect(segments).toHaveLength(2);
    expect(written(segments[0])).toEqual({ weightKg: 507, volumeM3: null, ambiguous: [] });
    expect(segments[1]!.refused?.reason).toBe('totals_unit');
    expect(left(segments[1])).toEqual([['bare', '5.9']]);
  });
});

describe('a figure a total cannot take is NAMED — and the totals beside it are still written', () => {
  it('a count or a pair: a row’s figure', () => {
    for (const [text, figure] of [
      ['jami 507 kg 300 dona', '300 dona'],
      ['jami 507 kg 40 juft', '40 juft'],
      // «120 ta juft» is 120 pairs — the counter and its unit are ONE figure.
      ['jami 507 kg 120 ta juft', '120 ta juft'],
    ] as const) {
      const segments = read(text);
      expect(segments, text).toHaveLength(2);
      expect(segments[0]!.at, text).toEqual({ totals: 'weightKg' });
      expect(written(segments[0]), text).toEqual({ weightKg: 507, volumeM3: null, ambiguous: [] });
      expect(segments[1]!.at, text).toBeNull();
      expect(segments[1]!.totals, text).toBeNull();
      expect(left(segments[1]), text).toEqual([['row', figure]]);
    }
  });

  it('a netto kilo — the total is asked as BRUTTO (PF-1) — is said, never silently skipped', () => {
    // 507 is the brutto; the 480 kg netto went nowhere, under a 👍.
    for (const text of ['brutto 507 kg netto 480 kg', 'jami 507 kg (480 kg netto)']) {
      const segments = read(text);
      expect(segments, text).toHaveLength(2);
      expect(written(segments[0]), text).toEqual({ weightKg: 507, volumeM3: null, ambiguous: [] });
      expect(left(segments[1]), text).toEqual([['netto', 'netto 480 kg']]);
    }
    // Beside a cube only: the cube is written, the netto named.
    const beside = read('jami 12 kub netto 480 kg');
    expect(written(beside[0])).toEqual({ weightKg: null, volumeM3: 12, ambiguous: [] });
    expect(left(beside[1])).toEqual([['netto', 'netto 480 kg']]);
    // Alone it writes nothing — and the refusal is about IT, not about «a unit».
    const alone = read('jami netto 480 kg');
    expect(alone).toHaveLength(1);
    expect(alone[0]!.totals).toBeNull();
    expect(left(alone[0])).toEqual([['netto', 'netto 480 kg']]);
  });

  it('two different figures for one field: neither is the total, both are named, the other field is written', () => {
    const segments = read('jami 507 kg 480 kg 5.9 kub');
    expect(written(segments[0])).toEqual({ weightKg: null, volumeM3: 5.9, ambiguous: [] });
    expect(left(segments[1])).toEqual([
      ['weight', '507 kg'],
      ['weight', '480 kg'],
    ]);
    const cubes = read('jami 507 kg 12 kub 13 kub');
    expect(written(cubes[0])).toEqual({ weightKg: 507, volumeM3: null, ambiguous: [] });
    expect(left(cubes[1])).toEqual([
      ['volume', '12 kub'],
      ['volume', '13 kub'],
    ]);
    // With nothing else stated, the one refusal names them.
    const only = read('jami 507 kg 480 kg');
    expect(only).toHaveLength(1);
    expect(left(only[0])).toEqual([
      ['weight', '507 kg'],
      ['weight', '480 kg'],
    ]);
  });

  it('a figure whose word is no unit is asked as a unit — with the kilo or cube it most likely means', () => {
    const segments = read('jami 507 kg 5.9 kubik');
    expect(written(segments[0])).toEqual({ weightKg: 507, volumeM3: null, ambiguous: [] });
    expect(segments[1]!.refused).toEqual({
      reason: 'totals_unit',
      detail: '5.9 kubik',
      left: [{ why: 'unit', text: '5.9 kubik', figure: '5.9 kubik', number: '5.9', word: 'kubik', near: 'm3' }],
    });
    const alone = read('jami 5.9 kubik');
    expect(alone).toHaveLength(1);
    expect(left(alone[0])).toEqual([['unit', '5.9 kubik']]);
  });

  it('the pasted forwarder’s line with a piece total: the kilos and the cube are written, the pieces named', () => {
    const segments = read('TOTAL: 3000 PCS, 15 CTNS, G.W.: 507 KGS, MEAS: 5.92 CBM');
    expect(segments).toHaveLength(2);
    expect(written(segments[0])).toEqual({ weightKg: 507, volumeM3: 5.92, ambiguous: [] });
    expect(left(segments[1])).toEqual([['row', '3000 PCS']]);
  });
});

describe('what is NOT left over', () => {
  it('a carton count — how the cargo is packed, no total asks it and no row’s figure', () => {
    for (const text of ['TOTAL: 15 CTNS, G.W.: 507 KGS, MEAS: 5.92 CBM', 'jami 15 karobka 507 kg 5.92 kub', '15箱 507KG 5.92CBM']) {
      const segments = read(text);
      expect(segments, text).toHaveLength(1);
      expect(written(segments[0]), text).toEqual({ weightKg: 507, volumeM3: 5.92, ambiguous: [] });
    }
  });

  it('a TNVED code and a size are no figures of a total', () => {
    expect(read('jami 507 kg kod 6403990000')).toHaveLength(1);
    expect(read('jami 507 kg 60x40x50 sm')).toHaveLength(1);
  });

  it('a figure the reading DOUBTS is the question’s, not a left-over', () => {
    // «1,200 kg» is asked «1.2 mi yoki 1200 mi?»; it is not also «unplaced».
    const segments = read('jami 1,200 kg 12 kub');
    expect(segments).toHaveLength(1);
    expect(written(segments[0])).toEqual({
      weightKg: null,
      volumeM3: 12,
      ambiguous: [{ field: 'weightKg', text: '1,200', decimal: 1.2, thousands: 1200 }],
    });
  });

  it('a bare figure alone keeps its own sentence — the unit is asked, nothing is «left»', () => {
    for (const text of ['jami 3500', 'jami 12 3500']) {
      const segments = read(text);
      expect(segments, text).toHaveLength(1);
      expect(segments[0]!.refused, text).toEqual({ reason: 'totals_unit', detail: text });
    }
  });
});

describe('the left-over rides the stage’s own rules', () => {
  it('collecting after a reading, a totals answer still answers — its left-over is a refusal, never material', () => {
    const material: TableRef = { ...table, stage: 'material' };
    const out = parseTableAnswer('jami 507 kg 300 dona', material);
    expect(out.material).toBe(false);
    expect(out.segments.map((s) => s.refused?.reason ?? null)).toEqual([null, 'totals_unit']);
  });

  it('a left-over is no «goods named nowhere»: a list of them is not filed as a typed goods list', () => {
    // Rule 3 files several unaddressed, unnamed segments as material; a totals
    // answer with a left-over is neither.
    const out = parseTableAnswer('jami 507 kg 300 dona\njami 12 kub 40 juft', table);
    expect(out.material).toBe(false);
    expect(out.segments).toHaveLength(4);
  });
});

describe('`readTypedTotals` says WHERE the figures it took stand', () => {
  const spans = (text: string) => readTypedTotals(text).taken.map(([a, b]) => text.slice(a, b));

  it('a figure with its unit, a label with its figure', () => {
    expect(spans('jami 507 kg 5.92 cbm')).toEqual(['507 kg', '5.92 cbm']);
    expect(spans('G.W.: 507, MEAS: 5.92')).toEqual(['G.W.: 507', 'MEAS: 5.92']);
  });

  it('a netto figure, and each of two different ones, is taken by nobody', () => {
    expect(spans('brutto 507 kg netto 480 kg')).toEqual(['507 kg']);
    expect(spans('507 kg 480 kg')).toEqual([]);
  });

  it('a doubted field’s figures are all the question’s', () => {
    expect(spans('1,200 kg')).toEqual(['1,200 kg']);
  });

  it('`parseManualFacts` is the same reading without the spans — its shape did not move', () => {
    const text = 'jami 507 kg 5.92 cbm';
    expect(parseManualFacts(text)).toEqual(readTypedTotals(text).facts);
    expect(Object.keys(parseManualFacts(text)).sort()).toEqual(['ambiguous', 'fromCity', 'goods', 'toCity', 'volumeM3', 'weightKg']);
  });
});

describe('`amountsIn` — every amount of a line and the word that names it', () => {
  const amounts = (line: string) => amountsIn(line).map((a) => [line.slice(a.start, a.end), a.number, a.word]);

  it('a number and its word, a bare number, a counter and its unit', () => {
    expect(amounts('jami 507 kg 300 dona 5.9')).toEqual([
      ['507 kg', '507', 'kg'],
      ['300 dona', '300', 'dona'],
      ['5.9', '5.9', null],
    ]);
    expect(amounts('120 ta juft')).toEqual([['120 ta juft', '120', 'juft']]);
    expect(amounts('1 200 kg')).toEqual([['1 200 kg', '1 200', 'kg']]);
  });

  it('a size and a code glued to letters are no amounts', () => {
    expect(amounts('60x40x50 sm 300 kg')).toEqual([['300 kg', '300', 'kg']]);
    expect(amounts('GS777 300 kg')).toEqual([['300 kg', '300', 'kg']]);
  });
});
