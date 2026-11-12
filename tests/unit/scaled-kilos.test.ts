import { describe, expect, it } from 'vitest';
import { goodsEvidence, looksLikeMaterial, parseLineAnswer, parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { looksLikeTableAnswer, parseTableAnswer, type TableRef, type TableSegment, type TableTarget } from '@/modules/wms/calc/line-address';
import { AMOUNT_NUMBER, parseGoodsLine, readAmountText, routeAmount, unitOf } from '@/modules/wms/calc/units';
import { bareTotalsNumber, TOTALS_NUMBER, totalsFigureCount } from '@/modules/platform/telegram/totals-shape';

/**
 * docs/AI-SORAYDI.md §3.1 T14 — the cube's siblings (CR-7; review JN-9,
 * JR-22).
 *
 * «cbm» was one of three: a TONNE was no unit to any reader («yuk 2 tonna 12
 * kub» stated a cube and no weight), and a weight written the packing-list
 * way — «1,136.5 kg» — was asked «1.136 mi yoki 1136 mi?», neither of which
 * it is. An apostrophe between digit groups cut the number («1'200 kg» was
 * 200 kg).
 *
 * The tonne and the gram are SCALED words of the kilo, never a unit of their
 * own, and only the bot's typed readers ask for them (JR-22). Only the
 * spellings that can be nothing else are read (JN-9): a lone «t» / «g» is a
 * capacity or a generation as often — «Domkrat 5T», «Fleshka 128G», «2024 г».
 *
 * Every figure is by hand: 2 t × 1000 = 2000 kg; 2,5 т = 2500; 20 т = 20000;
 * 500 g × 0.001 = 0.5; 1.5 t = 1500; 0,5 t = 500; 2000 g = 2.
 */

const totals = (text: string, section?: 'podklyuch' | 'rastamojka') => {
  const f = parseManualFacts(text, section);
  return { kg: f.weightKg ?? null, m3: f.volumeM3 ?? null, asked: f.ambiguous };
};
const rows = (text: string) => readGoodsLines(text).map((g) => ({ name: g.name, q: g.quantity ?? null, kg: g.weightKg ?? null, m3: g.volumeM3 ?? null }));
const typed = (text: string) => parseGoodsLine(text, { scaled: true });

describe('a number the packing-list way is ONE number — at every door', () => {
  it('comma groups AND a decimal point, its mirror, an apostrophe between groups', () => {
    expect(readAmountText('1,136.5')).toEqual({ state: 'ok', value: 1136.5 });
    expect(readAmountText('12,500.00')).toEqual({ state: 'ok', value: 12500 });
    expect(readAmountText('1.136,5')).toEqual({ state: 'ok', value: 1136.5 });
    expect(readAmountText("1'200")).toEqual({ state: 'ok', value: 1200 });
    expect(readAmountText('1’200,5')).toEqual({ state: 'ok', value: 1200.5 });
  });

  it('what has two readings still has two, and is still asked', () => {
    expect(readAmountText('1,200')).toEqual({ state: 'ambiguous', decimal: 1.2, thousands: 1200 });
    expect(readAmountText('1.200')).toEqual({ state: 'ambiguous', decimal: 1.2, thousands: 1200 });
    expect(readAmountText('2,5')).toEqual({ state: 'ok', value: 2.5 });
  });

  it('the row kernel reads the whole figure — no «1.136 mi yoki 1136 mi?», no «.5 kg» left in the name', () => {
    // The card form and the VED's paste box read through this, bare.
    for (const [line, kg] of [
      ['Kurtka 1,136.5 kg', 1136.5],
      ['Kurtka; 1,136.5; kg', 1136.5],
      ['Kurtka 12,500.00 kg', 12500],
      ['Kurtka 1.136,5 kg', 1136.5],
      ["Kurtka 1'200 kg", 1200],
    ] as const) {
      const read = parseGoodsLine(line);
      expect(read.problems, line).toEqual([]);
      expect([read.name, read.weightKg], line).toEqual(['Kurtka', kg]);
    }
    // «1,200 dona» beside it is still asked — and the weight is still read whole.
    const both = parseGoodsLine('Kurtka 1,200 dona 1,136.5 kg');
    expect(both.weightKg).toBe(1136.5);
    expect(both.problems).toEqual([{ kind: 'ambiguous', text: '1,200', decimal: 1.2, thousands: 1200 }]);
  });

  it('the shipment’s totals likewise', () => {
    expect(totals('G.W. 1,136.5 kg, 7.19 CBM')).toEqual({ kg: 1136.5, m3: 7.19, asked: [] });
    expect(totals('jami 12,500.00 kg')).toEqual({ kg: 12500, m3: null, asked: [] });
    expect(totals('jami 1.136,5 kg')).toEqual({ kg: 1136.5, m3: null, asked: [] });
    // Was 200: the apostrophe ended the number and «200 kg» was read.
    expect(totals("jami 1'200 kg")).toEqual({ kg: 1200, m3: null, asked: [] });
    expect(totals('jami 12,500 kg')).toEqual({ kg: null, m3: null, asked: [{ field: 'weightKg', text: '12,500', decimal: 12.5, thousands: 12500 }] });
  });

  it('the platform’s figure counter agrees with the kernel’s grammar on every such spelling', () => {
    // totals-shape.ts imports nothing, so its `TOTALS_NUMBER` restates the
    // grammar: held here to `AMOUNT_NUMBER`. Counted as two figures, a bare
    // «1,136.5» answering the brutto question was «two numbers» and refused.
    const whole = new RegExp(`^(?:${AMOUNT_NUMBER})$`, 'u');
    for (const number of ['1,136.5', '12,500.00', '1.136,5', "1'200", '1’200', "1'200,5", '1 200', '3500', '2,5', '0.5']) {
      expect(whole.test(number), number).toBe(true);
      expect(number.match(TOTALS_NUMBER), number).toEqual([number]);
      expect(totalsFigureCount(number), number).toBe(1);
      expect(bareTotalsNumber(number), number).toBe(true);
    }
    // Two figures are still two.
    expect(totalsFigureCount('12 3500')).toBe(2);
    expect(totalsFigureCount('1,136.5 7.19')).toBe(2);
  });
});

describe('a tonne and a gram are kilos in another scale — for the bot’s typed readers ONLY (review JR-22)', () => {
  it('every other door reads what it read: the kernel, asked for nothing, knows no tonne', () => {
    expect(unitOf('tonna')).toBeNull();
    expect(routeAmount(2, 'tonna')).toEqual({ unknownUnit: 'tonna', value: 2 });
    const bare = parseGoodsLine('Sement 2 tonna 12 kub');
    expect([bare.name, bare.weightKg, bare.volumeM3]).toEqual(['Sement 2 tonna', null, 12]);
    expect(parseGoodsLine('Цемент 20 тонн').problems).toEqual([{ kind: 'unknown_unit', word: 'тонн', value: 20 }]);
  });

  it('`routeAmount` on request: the kilos, and what they were written as', () => {
    expect(routeAmount(2, 'tonna', { scaled: true })).toEqual({ weightKg: 2000, scaled: { value: 2, word: 'tonna' } });
    expect(routeAmount(500, 'gr', { scaled: true })).toEqual({ weightKg: 0.5, scaled: { value: 500, word: 'gr' } });
    // A lone letter is never routed: it is the caller's to place (JN-9).
    expect(routeAmount(2, 't', { scaled: true })).toEqual({ unknownUnit: 't', value: 2 });
    expect(routeAmount(500, 'g', { scaled: true })).toEqual({ unknownUnit: 'g', value: 500 });
    // A unit stays a unit.
    expect(routeAmount(2, 'kg', { scaled: true })).toEqual({ weightKg: 2 });
  });

  it('a typed goods line states its weight in tonnes or grams', () => {
    expect(rows('Sement 2 tonna 12 kub')).toEqual([{ name: 'Sement', q: null, kg: 2000, m3: 12 }]);
    expect(rows('Цемент 20 тонн')).toEqual([{ name: 'Цемент', q: null, kg: 20000, m3: null }]);
    expect(rows('Арматура 2,5 тн 3 куб')).toEqual([{ name: 'Арматура', q: null, kg: 2500, m3: 3 }]);
    expect(rows('Zafaron 500 gr')).toEqual([{ name: 'Zafaron', q: null, kg: 0.5, m3: null }]);
    expect(rows('Sement 20тонн')).toEqual([{ name: 'Sement', q: null, kg: 20000, m3: null }]);
    // Under a label too: the tonne is one of the line's figures, not a word of its name…
    expect(rows('Tovar: sement 2 tonna 12 kub')).toEqual([{ name: 'sement', q: null, kg: 2000, m3: 12 }]);
    // …and with the figures FIRST it does not split their run in two («2 tonna 12 kub» is one run).
    expect(rows('Tovar nomi: 2 tonna 12 kub sement')).toEqual([{ name: 'sement', q: null, kg: 2000, m3: 12 }]);
    expect(rows('Un 2 tonna\nShakar 1 tonna')).toEqual([
      { name: 'Un', q: null, kg: 2000, m3: null },
      { name: 'Shakar', q: null, kg: 1000, m3: null },
    ]);
    // …and such a line is goods at the customer question, never the customer's name.
    expect(goodsEvidence('Sement 2 tonna')).toBe(true);
    expect(looksLikeMaterial('Sement 2 tonna')).toBe(true);
  });

  it('the shipment’s totals: «yuk 2 tonna 12 kub» states BOTH', () => {
    expect(totals('yuk 2 tonna 12 kub')).toEqual({ kg: 2000, m3: 12, asked: [] });
    expect(totals('jami 2 tonna 12 kub')).toEqual({ kg: 2000, m3: 12, asked: [] });
    expect(totals('毛重 2吨 体积 12立方')).toEqual({ kg: 2000, m3: 12, asked: [] });
    // One weight in two scales is one weight; two different ones are none.
    expect(totals('Sement 2 tonna 2000 kg')).toEqual({ kg: 2000, m3: null, asked: [] });
    expect(totals('jami 2 tonna 1500 kg')).toEqual({ kg: null, m3: null, asked: [] });
    // A doubted figure in tonnes is asked in KILOS: 1.2 t or 1200 t.
    expect(totals('jami 1,200 тн').asked).toEqual([{ field: 'weightKg', text: '1,200', decimal: 1200, thousands: 1200000 }]);
  });

  it('one weight in two scales on a LINE is no question; the same unit twice still is', () => {
    expect(typed('Sement 2 tonna 2000 kg').problems).toEqual([]);
    expect(typed('Sement 2 tonna 2000 kg').weightKg).toBe(2000);
    expect(typed('Sement 2 tonna 1500 kg').problems).toEqual([{ kind: 'repeated', unit: 'kg' }]);
    // «300 kg, ya’ni 300 kg» is refused, deliberately (line-answer.test.ts): only another SCALE excuses a repeat.
    expect(typed('Sement 300 kg 300 kg').problems).toEqual([{ kind: 'repeated', unit: 'kg' }]);
  });
});

describe('what a tonne or a gram is NOT (review JN-9)', () => {
  it('the five lines of the ruling read as they did — the letter stays in the name', () => {
    for (const [line, name, q, kg] of [
      ['Fleshka 128G 500 dona', 'Fleshka 128G', 500, null],
      ['Router 5G 100 dona', 'Router 5G', 100, null],
      ['Domkrat 5T 20 dona', 'Domkrat 5T', 20, null],
      ['Domkrat 5 t 20 dona', 'Domkrat 5 t', 20, null],
      ['Модель 2024 г 300 кг', 'Модель 2024 г', null, 300],
    ] as const) {
      for (const read of [parseGoodsLine(line), typed(line)]) {
        expect([read.name, read.quantity, read.weightKg], line).toEqual([name, q, kg]);
        expect(read.problems, line).toEqual([]);
      }
    }
  });

  it('a lone letter is no weight in free material — not even after a weight’s label: the weight is asked', () => {
    // Read there, «Sement 1.5 t» is fine and «Model X 5 t» is five tonnes of
    // a five-tonne jack. Narrower than the ruling allows, on purpose (c3275).
    for (const text of ['Sement 1.5 t', 'jami 2 t', 'vazni 2 t', 'G.W. 2.5 MT', 'G.W.: 2.5 MT', 'og‘irligi 500 g']) {
      expect(totals(text), text).toEqual({ kg: null, m3: null, asked: [] });
      expect(rows(text), text).toEqual([]);
    }
    expect(typed('Sement 1.5 t').problems).toEqual([{ kind: 'unknown_unit', word: 't', value: 1.5 }]);
  });

  it('beside a piece count the figure is what ONE piece is — a jack’s tonnes, a pack’s grams: it stays in the name', () => {
    expect(rows('Domkrat 5 tonna 20 dona')).toEqual([{ name: 'Domkrat 5 tonna', q: 20, kg: null, m3: null }]);
    expect(rows('chay 500 gr 2000 dona')).toEqual([{ name: 'chay 500 gr', q: 2000, kg: null, m3: null }]);
    // Never the shipment's weight either: 5000 kg for twenty jacks, 0.5 kg for two thousand packs.
    expect(totals('Domkrat 5 tonna 20 dona').kg).toBeNull();
    expect(totals('chay 500 gr 2000 dona').kg).toBeNull();
    expect(totals('ruchka 5000 dona har biri 20 gr').kg).toBeNull();
  });

  it('…unless the line speaks of the whole shipment: «jami 2 tonna 300 dona» is 2000 kg — and no product called «jami 2 tonna»', () => {
    expect(totals('jami 2 tonna 300 dona')).toEqual({ kg: 2000, m3: null, asked: [] });
    expect(rows('jami 2 tonna 300 dona')).toEqual([]);
  });

  it('a figure before a slash is a rate: «180 gr/m2» is a density, the line’s weight is its kilos', () => {
    expect(rows('Mato 180 gr/m2 500 kg')).toEqual([{ name: 'Mato 180 gr/m2', q: null, kg: 500, m3: null }]);
    expect(totals('Mato 180 gr/m2 500 kg')).toEqual({ kg: 500, m3: null, asked: [] });
  });
});

describe('the answer to the bot’s own question', () => {
  const WEIGHT: TableTarget[] = [{ totals: 'weightKg' }];
  const BOTH: TableTarget[] = [{ totals: 'weightKg' }, { totals: 'volumeM3' }];
  const table = (open: TableTarget[], needs: TableRef['rows'][number]['needs'] = []): TableRef => ({
    rows: [{ no: 1, index: 0, seq: null, name: 'Sement', needs }],
    open,
    preferred: open,
    stage: 'review',
  });
  const one = (text: string, ref: TableRef): TableSegment => {
    const out = parseTableAnswer(text, ref);
    expect(out.material, text).toBe(false);
    expect(out.segments, text).toHaveLength(1);
    return out.segments[0]!;
  };
  const kilos = (text: string, ref: TableRef) => {
    const seg = one(text, ref);
    expect(seg.refused, text).toBeNull();
    expect(seg.at, text).toEqual({ totals: 'weightKg' });
    return seg.totals?.weightKg ?? null;
  };

  it('the totals in tonnes — spelled out, and (here, where nothing names goods) in a lone letter', () => {
    for (const [text, kg] of [
      ['jami 2 tonna', 2000],
      ['2 tonna', 2000],
      ['jami 2,5 тн', 2500],
      ['jami 2 t', 2000],
      ['vazni 2 t', 2000],
      ['og‘irligi 500 g', 0.5],
      ['G.W. 2.5 MT', 2500],
      ['2 t', 2000],
      ['500 g', 0.5],
    ] as const) {
      expect(kilos(text, table(WEIGHT)), text).toBe(kg);
    }
    expect(one('jami 2 tonna 12 kub', table(BOTH)).totals).toEqual({ weightKg: 2000, volumeM3: 12, ambiguous: [] });
  });

  it('the packing-list number, bare or worded — never «1.136 mi yoki 1136 mi?»', () => {
    expect(kilos('jami 1,136.5 kg', table(BOTH))).toBe(1136.5);
    expect(kilos('1,136.5 kg', table(WEIGHT))).toBe(1136.5);
    // Bare, to the one open total: ONE figure, in that total's unit.
    expect(kilos('1,136.5', table(WEIGHT))).toBe(1136.5);
    expect(kilos("jami 1'200 kg", table(BOTH))).toBe(1200);
  });

  it('a row’s weight in tonnes or grams — a lone letter only when it is the WHOLE answer', () => {
    const row = table([{ line: 1 }], ['kg']);
    for (const [text, kg] of [
      ['1: 2 tonna', 2000],
      ['1: 20 тонн', 20000],
      ['1: 2000 gr', 2],
      ['1: 1.5 t', 1500],
      ['1: 0,5 t', 500],
      ['1: 500 g', 0.5],
      ['1: 1,136.5 kg', 1136.5],
      ['Sement 2 tonna', 2000],
    ] as const) {
      const seg = one(text, row);
      expect(seg.refused, text).toBeNull();
      expect(seg.at, text).toEqual({ line: 1 });
      expect(seg.answer, text).toMatchObject({ kind: 'figures', figures: { weightKg: kg } });
    }
    // The line answer's own reader, alone: the letter is spelled out and read.
    expect(parseLineAnswer('1.5 t')).toEqual({ kind: 'figures', figures: { quantity: null, weightKg: 1500, volumeM3: null, measureUnit: null, measureQty: null }, code: null });
    // Beside anything else a lone letter is a model's, and is asked as before.
    expect(parseLineAnswer('128G 500 dona')).toMatchObject({ kind: 'figures', figures: { quantity: 500, weightKg: null } });
    expect(parseLineAnswer('5 t domkrat')).toEqual({ kind: 'refused', reason: 'unknown_unit', detail: 't' });
  });

  it('a name with its figure the house’s own way — a decimal comma — names its row', () => {
    // Found on the way: the name's tokens were cut at commas, so «2,5» was a
    // «2» of the NAME and the answer was refused as another product's.
    const row = table([{ line: 1 }], ['kg']);
    for (const text of ['Sement 2,5 kg', 'Sement 1,136.5 kg', "Sement 1'200 kg"]) {
      const seg = one(text, row);
      expect(seg.refused, text).toBeNull();
      expect(seg.at, text).toEqual({ line: 1 });
    }
    expect(one('Sement 2,5 kg', row).answer).toMatchObject({ kind: 'figures', figures: { weightKg: 2.5 } });
  });

  it('a letter glued to its digits is read by nobody — asked as the tonne it would be', () => {
    const glued = one('jami 2T', table(BOTH));
    expect(glued.totals).toBeNull();
    expect(glued.refused).toEqual({
      reason: 'totals_unit',
      detail: '2T',
      left: [{ why: 'unit', text: '2T', figure: '2T', number: '2', word: 'T', near: 'tonna' }],
    });
    expect(one('2T', table(WEIGHT)).refused?.left?.[0]).toMatchObject({ why: 'unit', word: 'T', near: 'tonna' });
    expect(one('jami 500g', table(BOTH)).refused?.left?.[0]).toMatchObject({ why: 'unit', word: 'g', near: 'gr' });
  });

  it('two different weights, one of them in tonnes: named as written', () => {
    const seg = one('jami 2 tonna 1500 kg', table(BOTH));
    expect(seg.totals).toBeNull();
    expect((seg.refused?.left ?? []).map((l) => [l.why, l.figure])).toEqual([
      ['weight', '2 tonna'],
      ['weight', '1500 kg'],
    ]);
  });

  it('a brutto and a netto in lone letters: the brutto is written, the netto named — with ITS figure for the row', () => {
    const out = parseTableAnswer('G.W. 2.5 MT N.W. 2.3 MT', table(BOTH));
    expect(out.segments).toHaveLength(2);
    expect(out.segments[0]!.totals).toEqual({ weightKg: 2500, volumeM3: null, ambiguous: [] });
    expect(out.segments[1]!.refused?.left).toEqual([{ why: 'netto', text: 'N.W. 2.3 MT', figure: '2.3 MT', number: '2.3' }]);
  });

  it('«jami 2 tonna» is a table-shaped answer — an orphaned one never reaches the paid assistant', () => {
    expect(looksLikeTableAnswer('jami 2 tonna')).toBe(true);
    expect(looksLikeTableAnswer('2 tonna')).toBe(true);
    expect(looksLikeTableAnswer('jami 2 tonna 12 kub')).toBe(true);
  });
});
