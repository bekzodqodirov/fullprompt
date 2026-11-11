import { describe, expect, it } from 'vitest';
import {
  paperLines,
  paperLinesByPart,
  type LotTotals,
  type PaperView,
  type Segment,
  type StoredLine,
} from '@/modules/wms/receipts/composition-math';

/**
 * One document printing a composed lot in several consecutive PARTS — the
 * agent file's «here», «В пути» and «Не пришло» blocks
 * (docs/TARKIB-TUZATISH.md §4). The worked example is the owner's own case:
 * GS777-A, 100 cartons, 1000.000 kg, 2.5000 m³ — 50 keyboards + 50 mice.
 */

const LOT: LotTotals = { boxCount: 100, kg: '1000.000', m3: '2.5000' };
const KB: StoredLine = { seq: 1, name: 'Клавиатура', pieces: 500, cartons: 50, kg: '600.000', m3: '1.5000', tnvedCode: null };
const MS: StoredLine = { seq: 2, name: 'Мышь', pieces: 1000, cartons: 50, kg: '400.000', m3: '1.0000', tnvedCode: null };
const SEP = { seenBoxCount: 100, lines: [KB, MS] };
const MIX = { seenBoxCount: 100, lines: [{ ...KB, cartons: null }, { ...MS, cartons: null }] };

const cartonsOf = (views: (PaperView | null)[]) => views.map((v) => (v ? v.lines.map((l) => l.cartons) : null));
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 10_000) / 10_000;
/** Per line (by seq): the figure summed over every part that prints it. */
function perLine(views: (PaperView | null)[], pick: (l: PaperView['lines'][number]) => number | null): Map<number, number> {
  const out = new Map<number, number>();
  for (const v of views) for (const l of v?.lines ?? []) out.set(l.seq, (out.get(l.seq) ?? 0) + (pick(l) ?? 0));
  return out;
}

describe('paperLinesByPart — the parts tile the document', () => {
  it('the trap it exists for: 67 here + 30 on the road + 3 not come is [34,33] [15,15] [1,2] — per-part positions restarted gave [2,1] and 51/49', () => {
    const parts = [
      { cartons: 67, kg: 670, m3: 1.675 },
      { cartons: 30, kg: 300, m3: 0.75 },
      { cartons: 3, kg: 30, m3: 0.075 },
    ];
    const tiled = paperLinesByPart(SEP, LOT, { parts });
    expect(cartonsOf(tiled)).toEqual([
      [34, 33],
      [15, 15],
      [1, 2],
    ]);
    // The defect, kept as the oracle of what NOT to print: each part from 0.
    const restarted = parts.map((p) => paperLines(SEP, LOT, { segments: [], ...p }));
    expect(cartonsOf(restarted)).toEqual([
      [34, 33],
      [15, 15],
      [2, 1],
    ]);
    // The typed composition, exactly, over the parts.
    expect([...perLine(tiled, (l) => l.cartons)]).toEqual([
      [1, 50],
      [2, 50],
    ]);
    expect([...perLine(tiled, (l) => l.pieces)]).toEqual([
      [1, 500],
      [2, 1000],
    ]);
  });

  it('every split of 7 cartons into three parts: Σ cartons and Σ pieces per line are the single-portion view’s, Σ kg / m³ per part is the part’s own figure', () => {
    const lot: LotTotals = { boxCount: 7, kg: '70.000', m3: '0.7000' };
    const comp = {
      seenBoxCount: 7,
      lines: [
        { seq: 1, name: 'A', pieces: 33, cartons: 3, kg: '31.000', m3: '0.3000', tnvedCode: null },
        { seq: 2, name: 'B', pieces: null, cartons: 4, kg: '39.000', m3: '0.4000', tnvedCode: null },
      ] satisfies StoredLine[],
    };
    for (const mixed of [false, true]) {
      const c = mixed ? { ...comp, lines: comp.lines.map((l) => ({ ...l, cartons: null })) } : comp;
      const one = paperLines(c, lot, { before: 0, cartons: 7, kg: 70, m3: 0.7 });
      for (let a = 0; a <= 7; a += 1) {
        for (let b = 0; a + b <= 7; b += 1) {
          const counts = [a, b, 7 - a - b];
          const parts = counts.map((n) => ({ cartons: n, kg: n * 10, m3: n / 10 }));
          const views = paperLinesByPart(c, lot, { parts });
          expect(views.map((v) => v === null)).toEqual(counts.map((n) => n === 0));
          if (!mixed) {
            expect([...perLine(views, (l) => l.cartons)].sort()).toEqual(
              one.lines.map((l) => [l.seq, l.cartons] as [number, number | null]).sort(),
            );
          }
          expect([...perLine(views, (l) => l.pieces)].filter(([seq]) => seq === 1)).toEqual([[1, 33]]);
          views.forEach((v, i) => {
            if (!v) return;
            expect(sum(v.lines.map((l) => l.kg))).toBe(parts[i]!.kg);
            expect(sum(v.lines.map((l) => l.m3 ?? 0))).toBe(Math.round(parts[i]!.m3 * 1000) / 1000);
          });
        }
      }
    }
  });

  it('ONE part is exactly paperLines', () => {
    const portion = { cartons: 100, kg: 1000, m3: 2.5 };
    expect(paperLinesByPart(SEP, LOT, { parts: [portion] })).toEqual([paperLines(SEP, LOT, { segments: [], ...portion })]);
    const runs: Segment[] = [[40, 100]];
    const tail = { cartons: 60, kg: 600, m3: 1.5 };
    expect(paperLinesByPart(SEP, LOT, { segments: runs, parts: [tail] })).toEqual([paperLines(SEP, LOT, { segments: runs, ...tail })]);
  });

  it('the document’s own positions are honoured: a plan after a truck that took the first 40 starts its parts at 40', () => {
    const views = paperLinesByPart(SEP, LOT, {
      segments: [[40, 100]],
      parts: [
        { cartons: 45, kg: 450 },
        { cartons: 15, kg: 150 },
      ],
    });
    // Positions 40..85 and 85..100 of a 50/50 lot: the seats after 40, 85 and
    // 100 positions are [20,20], [43,42] and [50,50] (a tie goes to the lower
    // line), so the parts hold the differences.
    const whole = paperLines(SEP, LOT, { segments: [[40, 100]], cartons: 60, kg: 600 });
    expect([...perLine(views, (l) => l.cartons)]).toEqual(whole.lines.map((l) => [l.seq, l.cartons]));
    expect(cartonsOf(views)).toEqual([
      [23, 22],
      [7, 8],
    ]);
  });

  it('positions in TWO runs (a sent truck sits between them) are cut in order across the gap', () => {
    const views = paperLinesByPart(SEP, LOT, {
      segments: [
        [0, 10],
        [50, 60],
      ],
      parts: [
        { cartons: 15, kg: 150 },
        { cartons: 5, kg: 50 },
      ],
    });
    const whole = paperLines(SEP, LOT, {
      segments: [
        [0, 10],
        [50, 60],
      ],
      cartons: 20,
      kg: 200,
    });
    expect([...perLine(views, (l) => l.cartons)]).toEqual(whole.lines.map((l) => [l.seq, l.cartons]));
  });

  it('a carton counted on two trucks («clamped») is decided on the WHOLE fit and said by every part', () => {
    // 90 already crossed; a plan of 30 would end at 120 > 100.
    const views = paperLinesByPart(SEP, LOT, {
      segments: [[90, 120]],
      parts: [
        { cartons: 20, kg: 200 },
        { cartons: 10, kg: 100 },
      ],
    });
    expect(views.map((v) => v!.reasons.includes('clamped'))).toEqual([true, true]);
    expect(views.every((v) => v!.estimate)).toBe(true);
    // …and the reason is listed once.
    expect(views[0]!.reasons.filter((r) => r === 'clamped')).toHaveLength(1);
  });

  it('a share of a fully planned lot is still a share: each part of a split lot is «≈», the whole lot in one part is exact', () => {
    const whole = paperLinesByPart(SEP, LOT, { parts: [{ cartons: 100, kg: 1000 }] });
    expect(whole[0]!.estimate).toBe(false);
    const split = paperLinesByPart(SEP, LOT, {
      parts: [
        { cartons: 60, kg: 600 },
        { cartons: 40, kg: 400 },
      ],
    });
    expect(split.map((v) => v!.reasons)).toEqual([['share'], ['share']]);
  });

  it('«aralash»: every part prints every line, kg by the lines’ weights, cartons null', () => {
    const views = paperLinesByPart(MIX, LOT, {
      parts: [
        { cartons: 70, kg: 700 },
        { cartons: 30, kg: 300 },
      ],
    });
    expect(views.map((v) => v!.lines.map((l) => [l.name, l.cartons, l.kg]))).toEqual([
      [
        ['Клавиатура', null, 420],
        ['Мышь', null, 280],
      ],
      [
        ['Клавиатура', null, 180],
        ['Мышь', null, 120],
      ],
    ]);
  });

  it('the sheet’s own precision: three decimals of kg and four of m³ add up to the part’s stored figure', () => {
    const lot: LotTotals = { boxCount: 3, kg: '100.000', m3: '0.1000' };
    const comp = {
      seenBoxCount: 3,
      lines: [
        { seq: 1, name: 'A', pieces: null, cartons: null, kg: '33.333', m3: '0.0333', tnvedCode: null },
        { seq: 2, name: 'B', pieces: null, cartons: null, kg: '33.333', m3: '0.0333', tnvedCode: null },
        { seq: 3, name: 'C', pieces: null, cartons: null, kg: '33.334', m3: '0.0334', tnvedCode: null },
      ] satisfies StoredLine[],
    };
    const [view] = paperLinesByPart(comp, lot, { parts: [{ cartons: 3, kg: 100, m3: 0.1 }] }, { kgDecimals: 3, m3Decimals: 4 });
    expect(view!.lines.map((l) => l.kg)).toEqual([33.333, 33.333, 33.334]);
    expect(view!.lines.map((l) => l.m3)).toEqual([0.0333, 0.0333, 0.0334]);
    // At the default single decimal the same lot reads 33.3 + 33.3 + 33.4.
    const [rounded] = paperLinesByPart(comp, lot, { parts: [{ cartons: 3, kg: 100, m3: 0.1 }] });
    expect(sum(rounded!.lines.map((l) => l.kg))).toBe(100);
  });
});
