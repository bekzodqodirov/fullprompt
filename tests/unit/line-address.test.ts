import { describe, expect, it } from 'vitest';
import {
  looksLikeLineAnswer,
  looksLikeTableAnswer,
  parseTableAnswer,
  TOTALS_WORDS,
  type TableRef,
  type TableRow,
  type TableTarget,
} from '@/modules/wms/calc/line-address';
import { tableOpenOf, tableRowsOf } from '@/modules/wms/calc/intake';
import type { NeedUnit } from '@/modules/wms/calc/needs';

/**
 * How a typed answer names its row in the bot's table (docs/SAKKIZ-R3.md
 * §8.2.4, his 1.10 c and 1.11 c) — the probe table, every literal by hand.
 * A figure on the wrong row is a duty on goods nobody stated, so every
 * address that cannot be placed is ASKED (a refusal), never guessed.
 */

const row = (no: number, name: string, needs: NeedUnit[] = [], seq: number | null = null): TableRow => ({
  no,
  index: no - 1,
  seq,
  name,
  needs,
});

/** The five-row probe table: rows 2, 3 and 4 are ⚠️. */
const FIVE: TableRow[] = [
  row(1, 'Kurtka qishki'),
  row(2, 'Krossovka', ['juft']),
  row(3, 'Sumka', ['dona', 'kg']),
  row(4, 'Shapka', ['dona', 'kg']),
  row(5, 'Shim'),
];

function table(
  rows: TableRow[],
  open: TableTarget[] = rows.filter((r) => r.needs.length > 0).map((r) => ({ line: r.no })),
  opts: { preferred?: TableTarget[]; stage?: TableRef['stage'] } = {},
): TableRef {
  return { rows, open, preferred: opts.preferred ?? open, stage: opts.stage ?? 'review' };
}

const T5 = table(FIVE);
const one = (text: string, ref: TableRef = T5) => {
  const out = parseTableAnswer(text, ref);
  expect(out.material, text).toBe(false);
  expect(out.segments, text).toHaveLength(1);
  return out.segments[0]!;
};
const figures = (seg: ReturnType<typeof one>) => (seg.answer?.kind === 'figures' ? seg.answer.figures : null);

describe('a number address (§8.2.4)', () => {
  it('«3: 50 dona», «3 - 50 dona», «3-qatorga 50 dona» — line 3, fifty pieces', () => {
    for (const text of ['3: 50 dona', '3 - 50 dona', '3-qatorga 50 dona', '3) 50 dona', '#3 50 dona', '№3: 50 dona']) {
      const seg = one(text);
      expect(seg.at, text).toEqual({ line: 3 });
      expect(figures(seg)?.quantity, text).toBe(50);
    }
  });

  it('«3-qator 40 juft» — line 3, forty pairs', () => {
    const seg = one('3-qator 40 juft');
    expect(seg.at).toEqual({ line: 3 });
    expect(figures(seg)).toMatchObject({ measureUnit: 'juft', measureQty: 40 });
  });

  it('«3: 6403990000 40 juft» — the code and the pairs, never q = 3 (probe)', () => {
    const seg = one('3: 6403990000 40 juft');
    expect(seg.at).toEqual({ line: 3 });
    expect(seg.answer).toMatchObject({ kind: 'figures', code: '6403990000' });
    expect(figures(seg)).toMatchObject({ quantity: null, measureUnit: 'juft', measureQty: 40 });
  });

  it('«3: 1,200 kg» — both readings, asked', () => {
    expect(one('3: 1,200 kg').answer).toEqual({ kind: 'ambiguous', decimal: 1.2, thousands: 1200, unit: 'kg' });
  });

  it('two lines, two segments', () => {
    const out = parseTableAnswer('3: 50 dona\n5: 20 kg', T5);
    expect(out.segments.map((s) => s.at)).toEqual([{ line: 3 }, { line: 5 }]);
    expect(out.segments.map((s) => figures(s))).toMatchObject([{ quantity: 50 }, { weightKg: 20 }]);
  });

  it('«3.5 kg» is a figure, never line 3 — a full stop addresses only with a space after it', () => {
    const ref = table(FIVE, [{ line: 4 }]);
    const seg = one('3.5 kg', ref);
    expect(seg.at).toEqual({ line: 4 });
    expect(figures(seg)?.weightKg).toBe(3.5);
  });

  it('«3 50 dona» — the row or a count? asked, never guessed', () => {
    expect(one('3 50 dona').refused).toMatchObject({ reason: 'address_unclear', detail: '3' });
  });

  it('a number no row carries', () => {
    expect(one('7: 5 kg').refused).toMatchObject({ reason: 'no_line', detail: '7' });
  });

  it('every suffix after «qator», the ordinals and the Russian forms (product-fit-13)', () => {
    for (const text of ['3-qatordagi Sumka 50 dona', '3-chi qator 50 dona', '3chi: 50 dona', '3-nchi: 50 dona', 'строка 3: 50 шт', '3 строка 50 шт', '3 qator 50 dona']) {
      const seg = one(text);
      expect(seg.at, text).toEqual({ line: 3 });
      expect(figures(seg)?.quantity, text).toBe(50);
    }
  });

  it('a stored row is named by its seq — gaps after a VED deletion stay gaps', () => {
    const facts = {
      goods: [
        { name: 'Kurtka', seq: 1, itemId: 'i1' },
        { name: 'Krossovka', seq: 3, itemId: 'i3' },
        { name: 'Shim', seq: 4, itemId: 'i4' },
      ],
    };
    const ref = table(tableRowsOf({ section: 'rastamojka', facts, laws: new Map() }));
    expect(ref.rows.map((r) => r.no)).toEqual([1, 3, 4]);
    const seg = one('3: 40 juft', ref);
    expect(seg.at).toEqual({ line: 3 });
    expect(ref.rows.find((r) => r.no === 3)?.name).toBe('Krossovka');
  });

  it('the words after the number must not name ANOTHER row (regression-3)', () => {
    expect(one('3: Sumka 50 dona').at).toEqual({ line: 3 });
    const seg = one('1. Kurtka 300 dona', table([row(1, 'Krossovka', ['juft']), row(2, 'Sumka', ['dona', 'kg'])]));
    expect(seg.refused).toMatchObject({ reason: 'name_mismatch', candidates: [1] });
  });
});

describe('a name address — before or after the figure', () => {
  it('«sumka 50 dona, kurtka 20 kg» — two segments by name', () => {
    const out = parseTableAnswer('sumka 50 dona, kurtka 20 kg', T5);
    expect(out.segments.map((s) => s.at)).toEqual([{ line: 3 }, { line: 1 }]);
  });

  it('«Kurtka (qora, XL) 50 dona» stays one segment — a comma splits only when every part is addressed', () => {
    expect(parseTableAnswer('Kurtka (qora, XL) 50 dona', T5).segments).toHaveLength(1);
  });

  it('«50 dona sumka», «40 juft krossovka» — ordinary Uzbek word order', () => {
    expect(one('50 dona sumka').at).toEqual({ line: 3 });
    const seg = one('40 juft krossovka');
    expect(seg.at).toEqual({ line: 2 });
    expect(figures(seg)).toMatchObject({ measureUnit: 'juft', measureQty: 40 });
  });

  it('a name two rows carry is asked by number', () => {
    const ref = table([row(1, 'Shim'), row(2, 'Kurtka', ['kg']), row(3, 'Sumka'), row(4, 'Shapka'), row(5, 'Kurtka', ['kg'])]);
    expect(one('kurtka 20 kg', ref).refused).toMatchObject({ reason: 'name_many', candidates: [2, 5] });
  });

  it('«sumka» finds «Сумка женская (Ladies bag)» — one fold for both scripts', () => {
    const ref = table([row(1, 'Kurtka'), row(2, 'Сумка женская (Ladies bag)', ['dona', 'kg'])]);
    expect(one('sumka 50 dona', ref).at).toEqual({ line: 2 });
  });

  it('a model number and its tier (#1468): «iPhone 15 Pro» is not «iPhone 14», nor «iPhone 15»', () => {
    expect(one('iPhone 15 Pro 40 dona', table([row(1, 'Chexol'), row(2, 'iPhone 14', ['dona'])])).refused).toMatchObject({
      reason: 'name_mismatch',
    });
    const both = table([row(1, 'iPhone 15', ['dona']), row(2, 'iPhone 15 Pro', ['dona'])]);
    expect(one('iPhone 15 Pro 40 dona', both).at).toEqual({ line: 2 });
  });
});

describe('an unaddressed answer (product-fit-1, -3)', () => {
  it('a bare «300» with one ⚠️ row whose law pins juft goes to that row — its unit is the law’s', () => {
    const seg = one('300', table(FIVE, [{ line: 2 }]));
    expect(seg.at).toEqual({ line: 2 });
    expect(seg.answer).toEqual({ kind: 'bare', value: 300, code: null });
  });

  it('a bare «300» with two ⚠️ rows is asked', () => {
    expect(one('300').refused?.reason).toBe('no_address');
  });

  it('«40 juft» with one ⚠️ row is an ANSWER, never material', () => {
    const out = parseTableAnswer('40 juft', table(FIVE, [{ line: 2 }]));
    expect(out.material).toBe(false);
    expect(out.segments[0]!.at).toEqual({ line: 2 });
  });

  it('«3500 kg» beside a juft row and the open brutto is the brutto', () => {
    const ref = table(FIVE, [{ line: 2 }, { totals: 'weightKg' }]);
    const seg = one('3500 kg', ref);
    expect(seg.at).toEqual({ totals: 'weightKg' });
    expect(seg.totals).toMatchObject({ weightKg: 3500, volumeM3: null });
  });

  it('«40 juft» with a juft row and a dona row open goes to the juft one', () => {
    expect(one('40 juft', table(FIVE, [{ line: 2 }, { line: 3 }])).at).toEqual({ line: 2 });
  });

  it('«40 juft» answers the asked row first (the 2.8 b block)', () => {
    const ref = table(FIVE, [{ line: 2 }, { line: 4 }, { totals: 'weightKg' }], { preferred: [{ line: 2 }] });
    expect(one('40 juft', ref).at).toEqual({ line: 2 });
  });

  it('«sof og‘irligi 20 kg» is the row’s netto, never the brutto total', () => {
    const ref = table([row(1, 'Kurtka'), row(2, 'Shim', ['kg'])], [{ line: 2 }, { totals: 'weightKg' }]);
    const seg = one('sof og‘irligi 20 kg', ref);
    expect(seg.at).toEqual({ line: 2 });
    expect(figures(seg)?.weightKg).toBe(20);
  });

  it('a bare «12 3500» to the single open total is refused — the 12 is never dropped (R2 P3-R7)', () => {
    expect(one('12 3500', table(FIVE, [{ totals: 'weightKg' }])).refused?.reason).toBe('totals_unit');
  });
});

describe('a totals address (product-fit-14)', () => {
  const weight = table(FIVE, [{ totals: 'weightKg' }]);
  const both = table(FIVE, [{ totals: 'weightKg' }, { totals: 'volumeM3' }]);

  it('«jami 3500 kg» and the forms the table itself teaches', () => {
    for (const text of ['jami 3500 kg', 'og‘irligi 3500 kg', "og'irligi 3500 kg", 'брутто 3500 кг', 'vazni 3500', 'jami 3 500', 'umumiy brutto og‘irligi: 3500']) {
      const seg = one(text, weight);
      expect(seg.at, text).toEqual({ totals: 'weightKg' });
      expect(seg.totals?.weightKg, text).toBe(3500);
    }
  });

  it('«hajmi 12 kub», «объём 12 м3» — the cube', () => {
    for (const text of ['hajmi 12 kub', 'объём 12 м3', 'hajmi 12']) {
      expect(one(text, both).totals?.volumeM3, text).toBe(12);
    }
  });

  it('two figures are never one weight', () => {
    expect(one('jami 12 3500', weight).refused?.reason).toBe('totals_unit');
  });

  it('a bare total with both rows open names no unit — asked', () => {
    expect(one('jami 3500', both).refused?.reason).toBe('totals_unit');
  });

  it('«jami netto 1200 kg» answers no brutto (PF-1)', () => {
    const seg = one('jami netto 1200 kg', weight);
    expect(seg.refused?.reason).toBe('totals_unit');
    expect(seg.totals).toBeNull();
  });

  it('the table’s own labels are in the list', () => {
    for (const word of ['umumiy', 'og‘irligi', 'hajmi', 'jami', 'brutto']) expect(TOTALS_WORDS).toContain(word);
  });
});

describe('a typed list is goods, not answers', () => {
  const C1524 = '1. Kurtka 300 dona\n2. Shim 200 dona\nKarobka 45 ta';

  it('in the table stage, over rows that do NOT carry those names: the numbered lines are asked, nothing written', () => {
    const ref = table([row(1, 'Krossovka', ['juft']), row(2, 'Sumka', ['dona', 'kg']), row(3, 'Monitor', ['dona'])]);
    const out = parseTableAnswer(C1524, ref);
    expect(out.material).toBe(false);
    expect(out.segments.map((s) => s.refused?.reason)).toEqual(['name_mismatch', 'name_mismatch', 'no_address']);
    for (const text of ['1) Kurtka 300 dona', '1. Kurtka 300 dona']) {
      expect(one(text, ref).refused?.reason, text).toBe('name_mismatch');
    }
  });

  it('in the material stage after a reading: «N.» is not an address — the list is material', () => {
    const ref = table([row(1, 'Kurtka', ['dona']), row(2, 'Shim', ['dona'])], undefined, { stage: 'material' });
    for (const text of [C1524, '1) Kurtka 300 dona', '1. Kurtka 300 dona']) {
      expect(parseTableAnswer(text, ref), text).toEqual({ segments: [], material: true });
    }
    // An explicit «N:» is still an answer there.
    expect(parseTableAnswer('1: 300 dona', ref).material).toBe(false);
  });

  it('several lines of goods no row carries — a typed goods list', () => {
    const list = ['Kurtka erkaklar 300 dona', 'Shim jinsi 200 dona', 'Futbolka 500 dona', 'Kepka 100 dona', 'Sharf 50 dona', 'Paypoq 1000 juft'].join('\n');
    expect(parseTableAnswer(list, table([row(1, 'Monitor', ['dona']), row(2, 'Klaviatura', ['dona'])])).material).toBe(true);
  });
});

describe('the shape guards (regression-21, product-fit-14)', () => {
  const cases: [string, boolean, boolean][] = [
    ['3: 50 dona\n5: 20 kg', true, true],
    ['1) 2026 oktyabr hisoboti', false, false],
    ['1. Kurtka 300 dona, 2. Shim 200 dona — boj qancha?', false, false],
    ['jami 3500 kg', false, true],
    ['og‘irligi 3500 kg', false, true],
    ['3500 kg', false, true],
    ['777', false, false],
  ];
  for (const [text, line, tableShaped] of cases) {
    it(JSON.stringify(text), () => {
      expect(looksLikeLineAnswer(text)).toBe(line);
      expect(looksLikeTableAnswer(text)).toBe(tableShaped);
    });
  }
});

describe('the table the parser reads is the table the seller reads', () => {
  it('a rastamojka job with no brutto: the weight row is open, and a bare «3500» goes to it as kg (regression-22)', () => {
    const facts = { volumeM3: 12, goods: [{ name: 'Kurtka', quantity: 300, weightKg: 150 }] };
    const input = { section: 'rastamojka' as const, facts, laws: new Map(), amend: null };
    const ref = table(tableRowsOf(input), tableOpenOf(input));
    expect(ref.open).toEqual([{ totals: 'weightKg' }]);
    expect(one('3500', ref).totals?.weightKg).toBe(3500);
  });
});
