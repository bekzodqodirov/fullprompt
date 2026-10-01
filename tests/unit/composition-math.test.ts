import { describe, expect, it } from 'vitest';
import {
  checkSums,
  compositionMode,
  fillRest,
  fitSegments,
  fromUnits,
  isStale,
  largestRemainder,
  lotSegments,
  nameKey,
  paperLines,
  parseDraft,
  planSegments,
  prefillByCartons,
  remainderOf,
  roundHalfUp,
  scaleToLot,
  seatsPrefix,
  toCount,
  toUnits,
  truckSegments,
  type DraftLine,
  type LotTruck,
  type LotTotals,
  type PaperPortion,
  type Segment,
  type StoredLine,
} from '@/modules/wms/receipts/composition-math';
import { productKey } from '@/modules/wms/tnved/service';

/**
 * Lot tarkibi's arithmetic (docs/LOT-TARKIBI.md §2). The worked example is
 * the owner's own case: GS777-A, 100 cartons, 1000.000 kg, 2.5000 m³, found
 * on the client's papers to be 50 keyboards + 50 mice.
 */

const LOT: LotTotals = { boxCount: 100, kg: '1000.000', m3: '2.5000' };
const KB: StoredLine = { seq: 1, name: 'Клавиатура', pieces: 500, cartons: 50, kg: '600.000', m3: '1.5000', tnvedCode: null };
const MS: StoredLine = { seq: 2, name: 'Мышь', pieces: 1000, cartons: 50, kg: '400.000', m3: '1.0000', tnvedCode: null };
const SEP = { seenBoxCount: 100, lines: [KB, MS] };
const MIX = {
  seenBoxCount: 100,
  lines: [
    { ...KB, cartons: null },
    { ...MS, cartons: null },
  ],
};

const draft = (over: Partial<DraftLine> = {}): DraftLine => ({
  name: 'Клавиатура',
  pieces: '',
  cartons: '',
  kg: '1',
  m3: '1',
  tnved: '',
  ...over,
});

// A small deterministic PRNG so a failure reproduces.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('largestRemainder', () => {
  it('always hands out exactly the total', () => {
    const r = rng(7);
    for (let k = 0; k < 1000; k += 1) {
      const total = Math.floor(r() * 100000);
      const n = 1 + Math.floor(r() * 6);
      const w = Array.from({ length: n }, () => BigInt(1 + Math.floor(r() * 10000)));
      const out = largestRemainder(total, w);
      expect(out.reduce((s, v) => s + v, 0)).toBe(total);
      expect(out.every((v) => v >= 0)).toBe(true);
    }
  });

  it('70.0 over 333.333 / 333.333 / 333.334 → 23.3 / 23.3 / 23.4', () => {
    expect(largestRemainder(700, [333333n, 333333n, 333334n])).toEqual([233, 233, 234]);
  });

  it('a tie goes to the lower index', () => {
    expect(largestRemainder(3, [1n, 1n])).toEqual([2, 1]);
    expect(largestRemainder(1, [5n, 5n, 5n])).toEqual([1, 0, 0]);
  });

  it('stays exact at the columns’ limits (a float version cannot)', () => {
    // 999 999 999.999 kg in units × a target of 9 999 999.9 at one decimal:
    // total·w ≈ 1e20, far past 2^53.
    const w = [999_999_999_999n, 999_999_999_998n, 1n];
    const out = largestRemainder(99_999_999, w);
    expect(out.reduce((s, v) => s + v, 0)).toBe(99_999_999);
    expect(out).toEqual([50_000_000, 49_999_999, 0]);
    // A deliberate tie (two lines with one residue against W = T·20000): the
    // integers break it to the lower index; floats misorder the two
    // remainders at this magnitude and give the unit to the wrong line
    // (found by search, measured: [24999999, 49999999, 25000001]).
    expect(largestRemainder(99_999_999, [499_999_986_642n, 999_999_986_679n, 500_000_006_679n])).toEqual([
      24_999_999, 50_000_000, 25_000_000,
    ]);
  });
});

describe('seatsPrefix — the cumulative carton rule', () => {
  it('sums to x, is house-monotone and returns w at x = Σw', () => {
    const r = rng(11);
    for (let k = 0; k < 2000; k += 1) {
      const n = 2 + Math.floor(r() * 5);
      const w = Array.from({ length: n }, () => 1 + Math.floor(r() * 60));
      const W = w.reduce((s, v) => s + v, 0);
      // Five random steps x → x+1 per vector (every x of every vector is
      // O(W²) and buys nothing the sample does not).
      for (let j = 0; j < 5; j += 1) {
        const x = Math.floor(r() * W);
        const s = seatsPrefix(x, w);
        const t = seatsPrefix(x + 1, w);
        expect(s.reduce((a, v) => a + v, 0)).toBe(x);
        expect(t.reduce((a, v) => a + v, 0)).toBe(x + 1);
        t.forEach((v, i) => expect(v).toBeGreaterThanOrEqual(s[i]!));
      }
      expect(seatsPrefix(W, w)).toEqual(w);
    }
  });

  it('U4: 50/50 over trucks of 33/33/34 declares 50/50, not 51/49', () => {
    const w = [50, 50];
    const at = [0, 33, 66, 100].map((x) => seatsPrefix(x, w));
    const trucks = [1, 2, 3].map((t) => at[t]!.map((s, i) => s - at[t - 1]![i]!));
    expect(trucks).toEqual([
      [17, 16],
      [16, 17],
      [17, 17],
    ]);
    expect(trucks.reduce((s, t) => s + t[0]!, 0)).toBe(50);
    expect(trucks.reduce((s, t) => s + t[1]!, 0)).toBe(50);
  });
});

describe('toUnits / fromUnits / toCount', () => {
  it('reads a person’s numbers, comma = decimal', () => {
    expect(toUnits('12,5', 3)).toBe(12500);
    expect(toUnits('1 200', 3)).toBe(1_200_000);
    expect(toUnits('2,125', 4)).toBe(21250);
    expect(toUnits('450,500', 3)).toBe(450500);
    expect(toUnits('1,200.5', 3)).toBe(1_200_500);
    expect(toUnits('1.200,5', 3)).toBe(1_200_500);
    expect(toUnits('1 200', 3)).toBe(1_200_000);
    expect(toUnits("1'200", 3)).toBe(1_200_000);
  });

  it('refuses what is not a measure', () => {
    for (const bad of ['0.0001', '-1', 'abc', 'NaN', '1e3', '1,2,3', '', '0', '1,20.5', '12.', '.5']) {
      expect(toUnits(bad, 3), bad).toBeNull();
    }
  });

  it('adds in units: 0.1 + 0.2 = 0.3', () => {
    expect(toUnits('0.1', 3)! + toUnits('0.2', 3)!).toBe(toUnits('0.3', 3));
  });

  it('prints the column’s spelling', () => {
    expect(fromUnits(600000, 3)).toBe('600.000');
    expect(fromUnits(15000, 4)).toBe('1.5000');
    expect(fromUnits(-100000, 3)).toBe('-100.000');
  });

  it('counts whole positive numbers only', () => {
    expect(toCount('1 000')).toBe(1000);
    expect(toCount('1.5')).toBeNull();
    expect(toCount('0')).toBeNull();
    expect(toCount('-3')).toBeNull();
    expect(toCount('3000000000')).toBeNull();
  });

  it('nameKey is tnved/service productKey', () => {
    for (const s of [' Мышь ', 'МЫШЬ', 'a  b', '键盘　x']) expect(nameKey(s)).toBe(productKey(s));
  });

  it('roundHalfUp', () => {
    expect(roundHalfUp(5n, 2n)).toBe(3);
    expect(roundHalfUp(4n, 10n)).toBe(0);
    expect(roundHalfUp(5n, 10n)).toBe(1);
  });
});

describe('compositionMode', () => {
  it('all null → mixed, all set → separate, mixed → invalid', () => {
    expect(compositionMode([{ cartons: null }, { cartons: null }])).toBe('mixed');
    expect(compositionMode([{ cartons: 1 }, { cartons: 2 }])).toBe('separate');
    expect(compositionMode([{ cartons: 1 }, { cartons: null }])).toBe('invalid');
  });
});

describe('parseDraft + checkSums', () => {
  const good = [
    draft({ name: 'Клавиатура', cartons: '50', kg: '600', m3: '1.5', pieces: '500' }),
    draft({ name: 'Мышь', cartons: '50', kg: '400', m3: '1', pieces: '1000' }),
  ];

  it('accepts the owner’s case', () => {
    const p = parseDraft(good);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(checkSums(p.lines, LOT)).toBeNull();
    expect(p.lines.map((l) => [l.seq, l.kgUnits, l.m3Units])).toEqual([
      [1, 600000, 15000],
      [2, 400000, 10000],
    ]);
  });

  it('lines_count: 1 line and 21 lines refused; blank rows dropped', () => {
    expect(parseDraft([good[0]!])).toEqual({ ok: false, refusal: { code: 'lines_count' } });
    const many = Array.from({ length: 21 }, (_, i) => draft({ name: `Tovar ${i}` }));
    expect(parseDraft(many)).toEqual({ ok: false, refusal: { code: 'lines_count' } });
    const blank = draft({ name: '', kg: '', m3: '' });
    expect(parseDraft([good[0]!, blank, good[1]!]).ok).toBe(true);
  });

  it('bad_line names the row', () => {
    expect(parseDraft([good[0]!, draft({ name: 'x' })])).toEqual({
      ok: false,
      refusal: { code: 'bad_line', seq: 2 },
    });
    // «📦» is ONE character for the CHECK's char_length.
    expect(parseDraft([good[0]!, draft({ name: '📦' })])).toEqual({ ok: false, refusal: { code: 'bad_line', seq: 2 } });
    expect(parseDraft([good[0]!, draft({ name: '📦x' })]).ok).toBe(true);
  });

  it('bad_number names the row AND the field', () => {
    expect(parseDraft([good[0]!, draft({ name: 'Мышь', kg: 'abc' })])).toEqual({
      ok: false,
      refusal: { code: 'bad_number', seq: 2, field: 'kg' },
    });
    expect(parseDraft([draft({ m3: '1.00001' }), good[1]!])).toEqual({
      ok: false,
      refusal: { code: 'bad_number', seq: 1, field: 'm3' },
    });
    expect(parseDraft([good[0]!, draft({ name: 'Мышь', pieces: '1.5' })])).toEqual({
      ok: false,
      refusal: { code: 'bad_number', seq: 2, field: 'pieces' },
    });
    expect(parseDraft([good[0]!, draft({ name: 'Мышь', cartons: '0' })])).toEqual({
      ok: false,
      refusal: { code: 'bad_number', seq: 2, field: 'cartons' },
    });
  });

  it('bad_tnved: «8471 60 7000» accepted, «847» refused', () => {
    const p = parseDraft([draft({ tnved: '8471 60 7000' }), draft({ name: 'Мышь' })]);
    expect(p.ok && p.lines[0]!.tnvedCode).toBe('8471607000');
    expect(parseDraft([draft({ tnved: '847' }), draft({ name: 'Мышь' })])).toEqual({
      ok: false,
      refusal: { code: 'bad_tnved', seq: 1 },
    });
  });

  it('duplicate_name: «Мышь» and « мышь » are one good', () => {
    expect(parseDraft([draft({ name: 'Мышь' }), draft({ name: ' мышь ' })])).toEqual({
      ok: false,
      refusal: { code: 'duplicate_name', seq: 2 },
    });
  });

  const sums = (lines: DraftLine[]) => {
    const p = parseDraft(lines);
    if (!p.ok) throw new Error(JSON.stringify(p.refusal));
    return checkSums(p.lines, LOT);
  };

  it('cartons_partial and cartons_sum', () => {
    expect(sums([draft({ cartons: '50', kg: '600', m3: '1.5' }), draft({ name: 'Мышь', kg: '400', m3: '1' })])).toEqual({
      code: 'cartons_partial',
    });
    expect(
      sums([draft({ cartons: '50', kg: '600', m3: '1.5' }), draft({ name: 'Мышь', cartons: '49', kg: '400', m3: '1' })]),
    ).toEqual({ code: 'cartons_sum', sum: 99, lot: 100 });
  });

  it('kg off by 0.001 refused; m³ off by 0.0001 refused; «12,5» equals «12.500»', () => {
    expect(sums([draft({ kg: '600.001', m3: '1.5' }), draft({ name: 'Мышь', kg: '400', m3: '1' })])).toEqual({
      code: 'kg_sum',
      sum: '1000.001',
      lot: '1000.000',
    });
    expect(sums([draft({ kg: '600', m3: '1.5001' }), draft({ name: 'Мышь', kg: '400', m3: '1' })])).toEqual({
      code: 'm3_sum',
      sum: '2.5001',
      lot: '2.5000',
    });
    const small: LotTotals = { boxCount: 2, kg: '25.000', m3: '0.2000' };
    const p = parseDraft([draft({ kg: '12,5', m3: '0.1' }), draft({ name: 'Мышь', kg: '12.500', m3: '0,1' })]);
    expect(p.ok && checkSums(p.lines, small)).toBeNull();
  });
});

describe('the editor’s helpers', () => {
  it('prefillByCartons splits kg and m³ by the typed cartons', () => {
    const out = prefillByCartons(
      [draft({ cartons: '50' }), draft({ name: 'Мышь', cartons: '50' })],
      LOT,
    );
    expect(out).toEqual([
      { kg: '500.000', m3: '1.2500' },
      { kg: '500.000', m3: '1.2500' },
    ]);
    expect(prefillByCartons([draft({ cartons: '50' }), draft({ name: 'Мышь', cartons: '49' })], LOT)).toBeNull();
    expect(prefillByCartons([draft({ cartons: '50' }), draft({ name: 'Мышь' })], LOT)).toBeNull();
  });

  it('scaleToLot puts the client’s figures onto the warehouse scale', () => {
    const lines = [draft({ kg: '450', m3: '2.1' }), draft({ name: 'Мышь', kg: '450', m3: '2.1' })];
    expect(scaleToLot(lines, LOT, 'kg')).toEqual(['500.000', '500.000']);
    expect(scaleToLot(lines, LOT, 'm3')).toEqual(['1.2500', '1.2500']);
    const exact = [draft({ kg: '600' }), draft({ name: 'Мышь', kg: '400' })];
    expect(scaleToLot(exact, LOT, 'kg')).toBeNull();
    expect(scaleToLot([draft({ kg: 'x' }), draft({ name: 'Мышь' })], LOT, 'kg')).toBeNull();
  });

  it('fillRest balances ONE field of one row', () => {
    const lines = [draft({ kg: '600', m3: '1.5' }), draft({ name: 'Мышь', kg: '', m3: '1' })];
    expect(fillRest(lines, 1, 'kg', LOT)).toBe('400.000');
    expect(fillRest(lines, 1, 'm3', LOT)).toBe('1.0000');
    expect(fillRest([draft({ kg: '1000' }), draft({ name: 'Мышь', kg: '' })], 1, 'kg', LOT)).toBeNull();
  });

  it('remainderOf is per measure', () => {
    const half = remainderOf([draft({ kg: '600', m3: '1.5' }), draft({ name: 'Мышь', kg: '', m3: '1' })], LOT);
    expect(half).toEqual({ kgUnits: 400000, m3Units: 0, cartons: null, incomplete: true });
    const over = remainderOf(
      [draft({ kg: '700', m3: '1.5', cartons: '50' }), draft({ name: 'Мышь', kg: '400', m3: '1', cartons: '50' })],
      LOT,
    );
    expect(over).toEqual({ kgUnits: -100000, m3Units: 0, cartons: 0, incomplete: false });
  });

  it('isStale: each of the three triggers alone', () => {
    expect(isStale(SEP, LOT)).toBe(false);
    expect(isStale(SEP, { ...LOT, boxCount: 101 })).toBe(true);
    expect(isStale(SEP, { ...LOT, kg: '1000.001' })).toBe(true);
    expect(isStale(SEP, { ...LOT, m3: '2.5001' })).toBe(true);
  });

  it('truckSegments: departed by time, then forming by creation; internal → from 0; own n never counted', () => {
    const trucks = [
      { batchId: 'c', departedAt: null, createdAt: '2026-09-01T00:00:00Z', crosses: true, n: 7 },
      { batchId: 'b', departedAt: '2026-09-10T00:00:00Z', crosses: true, n: 20 },
      { batchId: 'a', departedAt: '2026-09-05T00:00:00Z', crosses: true, n: 33 },
      { batchId: 'i', departedAt: '2026-09-01T00:00:00Z', crosses: false, n: 100 },
      { batchId: 'd', departedAt: null, createdAt: '2026-09-20T00:00:00Z', crosses: true, n: 40 },
    ].map((t) => ({ createdAt: '2026-08-01T00:00:00Z', ...t }));
    expect(truckSegments(trucks, 'a')).toEqual([[0, 33]]);
    expect(truckSegments(trucks, 'b')).toEqual([[33, 53]]);
    expect(truckSegments(trucks, 'c')).toEqual([[53, 60]]);
    expect(truckSegments(trucks, 'd')).toEqual([[60, 100]]);
    expect(truckSegments(trucks, 'i')).toEqual([]);
    expect(truckSegments(trucks, 'zz')).toEqual([]);
    // The truckless plan of the agent file: after every crossing truck.
    expect(planSegments(trucks, 5, true)).toEqual([[100, 105]]);
    expect(planSegments(trucks, 5, false)).toEqual([]);
  });

  it('fitSegments: trimmed to the document, extended past the end, the old clamp past the lot', () => {
    expect(fitSegments([[0, 33], [66, 83]], 40, 100)).toEqual({ segs: [[0, 33], [66, 73]], clamped: false });
    expect(fitSegments([[10, 20]], 12, 100)).toEqual({ segs: [[10, 22]], clamped: false });
    expect(fitSegments([], 30, 100, 40)).toEqual({ segs: [[40, 70]], clamped: false });
    expect(fitSegments([], 40, 100, 80)).toEqual({ segs: [[60, 100]], clamped: true });
  });
});

/**
 * The review of the freeze (7a): the tick copied the LINES and not the
 * offset, so a sent truck's paper still moved with its siblings. The owner's
 * numbers: lot 100 = 50 keyboards / 600 kg / 500 pcs + 50 mice / 400 kg /
 * 1000 pcs; truck B created first and forming with 33 cartons; truck T
 * created later with 33 and ticked.
 */
describe('the freeze holds a sent truck’s positions', () => {
  const B0: LotTruck = { batchId: 'B', departedAt: null, createdAt: '2026-09-28T08:00:00Z', crosses: true, n: 33 };
  const T0: LotTruck = { batchId: 'T', departedAt: null, createdAt: '2026-09-28T09:00:00Z', crosses: true, n: 33 };
  const print = (segments: readonly Segment[]) =>
    rows(paperLines(SEP, LOT, { segments, cartons: 33, kg: 330, places: { loose: 33, pallets: 0 } }));

  it('T departs while B still forms: T prints what it sent', () => {
    const atTick = truckSegments([B0, T0], 'T');
    expect(atTick).toEqual([[33, 66]]);
    const sent = print(atTick);
    expect(sent).toEqual([
      ['Клавиатура', 16, 193.2, 160, 16],
      ['Мышь', 17, 136.8, 340, 17],
    ]);
    const T1 = { ...T0, departedAt: '2026-09-29T10:00:00Z', frozenSegments: atTick };
    expect(truckSegments([B0, T1], 'T')).toEqual([[33, 66]]);
    expect(print(truckSegments([B0, T1], 'T'))).toEqual(sent);
    // …and B, which now departs after it, takes the positions T left free.
    expect(truckSegments([B0, T1], 'B')).toEqual([[0, 33]]);
  });

  it('a later-created truck departing first, or B dialled down, never moves the sent truck', () => {
    const T1 = { ...T0, frozenSegments: [[33, 66]] as Segment[] };
    const C: LotTruck = { batchId: 'C', departedAt: '2026-09-29T07:00:00Z', createdAt: '2026-09-28T10:00:00Z', crosses: true, n: 34 };
    expect(truckSegments([B0, T1, C], 'T')).toEqual([[33, 66]]);
    expect(truckSegments([{ ...B0, n: 20 }, T1], 'T')).toEqual([[33, 66]]);
    // C, departed first, fills what is free around the sent truck: two runs.
    expect(truckSegments([B0, T1, C], 'C')).toEqual([[0, 33], [66, 67]]);
    expect(truckSegments([B0, T1, C], 'B')).toEqual([[67, 100]]);
  });

  it('every order of ticks and departures: a sent truck never moves, a departed one never moves, the lot adds up', () => {
    const typed = [3, 2, 2];
    const comp = {
      seenBoxCount: 7,
      lines: typed.map((cartons, i) => ({
        seq: i + 1,
        name: `L${i}`,
        pieces: [31, 17, 5][i]!,
        cartons,
        kg: `${cartons * 10}.000`,
        m3: `0.${cartons}000`,
        tnvedCode: null,
      })),
    };
    const lot: LotTotals = { boxCount: 7, kg: '70.000', m3: '0.7000' };
    const sizes = [3, 2, 2];
    const events = sizes.flatMap((_, i) => [`tick${i}`, `depart${i}`]);
    const random = rng(7);
    for (let run = 0; run < 400; run += 1) {
      const order = [...events].sort(() => random() - 0.5);
      const trucks: LotTruck[] = sizes.map((n, i) => ({
        batchId: `t${i}`,
        departedAt: null,
        createdAt: `2026-09-2${i}T00:00:00Z`,
        crosses: true,
        n,
      }));
      const pinned = new Map<string, Segment[]>();
      let clock = 0;
      for (const event of order) {
        const i = Number(event.slice(-1));
        const t = trucks[i]!;
        clock += 1;
        if (event.startsWith('tick') && !t.frozenSegments) t.frozenSegments = truckSegments(trucks, t.batchId);
        if (event.startsWith('depart') && t.departedAt === null) {
          t.departedAt = `2026-10-01T00:00:${String(clock).padStart(2, '0')}Z`;
        }
        const all = lotSegments(trucks);
        for (const x of trucks) {
          const now = all.get(x.batchId)!;
          if (x.frozenSegments || x.departedAt !== null) {
            const was = pinned.get(x.batchId);
            if (was) expect(now, `${order} — ${x.batchId}`).toEqual(was);
            else pinned.set(x.batchId, now);
          }
        }
        // The positions tile the lot: nothing counted twice, nothing dropped.
        const covered = [...all.values()].flat().flatMap(([s, e]) => Array.from({ length: e - s }, (_, k) => s + k));
        expect(covered.sort((a, b) => a - b), `${order}`).toEqual([0, 1, 2, 3, 4, 5, 6]);
        const cartons = [0, 0, 0];
        const pieces = [0, 0, 0];
        for (const x of trucks) {
          const v = paperLines(comp, lot, { segments: all.get(x.batchId)!, cartons: x.n, kg: x.n * 10 });
          for (const l of v.lines) {
            cartons[l.seq - 1]! += l.cartons!;
            pieces[l.seq - 1]! += l.pieces!;
          }
        }
        expect(cartons, `${order}`).toEqual(typed);
        expect(pieces, `${order}`).toEqual([31, 17, 5]);
      }
    }
  });
});

/** One row as a compact tuple, for the worked-example table. */
const rows = (v: ReturnType<typeof paperLines>) =>
  v.lines.map((l) => [l.name, l.cartons, l.kg, l.pieces, l.places]);

describe('paperLines — the worked example of §2', () => {
  const whole: PaperPortion = { before: 0, cartons: 100, kg: 1000, m3: 2.5, places: { loose: 100, pallets: 0 } };

  it('U1 whole lot, loose', () => {
    const v = paperLines(SEP, LOT, whole);
    expect(rows(v)).toEqual([
      ['Клавиатура', 50, 600, 500, 50],
      ['Мышь', 50, 400, 1000, 50],
    ]);
    expect(v.lines.map((l) => l.m3)).toEqual([1.5, 1]);
    expect(v.estimate).toBe(false);
  });

  it('U2/U3: trucks of 40 then 60', () => {
    const t1 = paperLines(SEP, LOT, { before: 0, cartons: 40, kg: 400, places: { loose: 40, pallets: 0 } });
    expect(rows(t1)).toEqual([
      ['Клавиатура', 20, 240, 200, 20],
      ['Мышь', 20, 160, 400, 20],
    ]);
    expect(t1.reasons).toEqual(['share']);
    const t2 = paperLines(SEP, LOT, { before: 40, cartons: 60, kg: 600, places: { loose: 60, pallets: 0 } });
    expect(rows(t2)).toEqual([
      ['Клавиатура', 30, 360, 300, 30],
      ['Мышь', 30, 240, 600, 30],
    ]);
  });

  it('U4: trucks 33/33/34 add up to the typed cartons and pieces', () => {
    const at = [
      { before: 0, cartons: 33, kg: 330 },
      { before: 33, cartons: 33, kg: 330 },
      { before: 66, cartons: 34, kg: 340 },
    ].map((p) => paperLines(SEP, LOT, p));
    expect(at.map((v) => v.lines.map((l) => l.cartons))).toEqual([
      [17, 16],
      [16, 17],
      [17, 17],
    ]);
    expect(at.map((v) => v.lines.map((l) => l.pieces))).toEqual([
      [170, 320],
      [160, 340],
      [170, 340],
    ]);
  });

  it('U5/U6: pallet places split by cartons and flagged', () => {
    const u5 = paperLines(SEP, LOT, { ...whole, places: { loose: 80, pallets: 1 } });
    expect(u5.lines.map((l) => l.places)).toEqual([41, 40]);
    expect(u5.reasons).toEqual(['pallet']);
    const u6 = paperLines(SEP, LOT, { ...whole, places: { loose: 0, pallets: 4 } });
    expect(u6.lines.map((l) => l.places)).toEqual([2, 2]);
    expect(u6.estimate).toBe(true);
  });

  it('a lot on ANOTHER lot’s pallet: places split by cartons, flagged (it owns no pallet)', () => {
    const v = paperLines(SEP, LOT, { ...whole, places: { loose: 90, pallets: 0, onPallets: 10 } });
    expect(v.lines.map((l) => l.places)).toEqual([45, 45]);
    expect(v.reasons).toEqual(['pallet']);
  });

  it('U7: aralash — all places on the first line, the rest «part»', () => {
    const v = paperLines(MIX, LOT, whole);
    expect(rows(v)).toEqual([
      ['Клавиатура', null, 600, 500, 100],
      ['Мышь', null, 400, 1000, 'part'],
    ]);
    expect(v.estimate).toBe(false);
  });

  it('U8: stale — grew to 102 / 1020.000 kg, all aboard', () => {
    const grown: LotTotals = { boxCount: 102, kg: '1020.000', m3: '2.5500' };
    const v = paperLines(SEP, grown, { before: 0, cartons: 102, kg: 1020 });
    expect(rows(v)).toEqual([
      ['Клавиатура', 51, 612, 510, null],
      ['Мышь', 51, 408, 1020, null],
    ]);
    expect(v.reasons).toEqual(['stale']);
  });

  it('U9: one-carton lot, aralash', () => {
    const one: LotTotals = { boxCount: 1, kg: '10.000', m3: '0.0500' };
    const comp = {
      seenBoxCount: 1,
      lines: [
        { ...KB, cartons: null, kg: '6.000', m3: '0.0300', pieces: 5 },
        { ...MS, cartons: null, kg: '4.000', m3: '0.0200', pieces: 5 },
      ],
    };
    const v = paperLines(comp, one, { before: 0, cartons: 1, kg: 10, places: { loose: 1, pallets: 0 } });
    expect(v.lines.map((l) => l.places)).toEqual([1, 'part']);
  });

  it('U10: a 1-carton truck of a separate lot prints only the line it carries', () => {
    const v = paperLines(SEP, LOT, { before: 0, cartons: 1, kg: 10, places: { loose: 1, pallets: 0 } });
    expect(rows(v)).toEqual([['Клавиатура', 1, 10, 10, 1]]);
    expect(v.reasons).toEqual(['share']);
  });

  it('U11: aralash pieces that round to 0 on a truck', () => {
    const comp = {
      seenBoxCount: 100,
      lines: [
        { seq: 1, name: 'Клавиатура', pieces: 2000, cartons: null, kg: '999.000', m3: '2.4000', tnvedCode: null },
        { seq: 2, name: 'Принтер', pieces: 1, cartons: null, kg: '1.000', m3: '0.1000', tnvedCode: null },
      ],
    };
    const t1 = paperLines(comp, LOT, { before: 0, cartons: 40, kg: 400 });
    expect(rows(t1)).toEqual([
      ['Клавиатура', null, 399.6, 800, null],
      ['Принтер', null, 0.4, 0, null],
    ]);
    const t2 = paperLines(comp, LOT, { before: 40, cartons: 60, kg: 600 });
    expect(rows(t2)).toEqual([
      ['Клавиатура', null, 599.4, 1200, null],
      ['Принтер', null, 0.6, 1, null],
    ]);
  });

  it('U12: the 333.350 tie lands on the lower seq; Σ = 1000.0', () => {
    const comp = {
      seenBoxCount: 100,
      lines: ['333.350', '333.350', '333.300'].map((kg, i) => ({
        seq: i + 1,
        name: `T${i}`,
        pieces: null,
        cartons: null,
        kg,
        m3: i === 2 ? '0.8334' : '0.8333',
        tnvedCode: null,
      })),
    };
    const v = paperLines(comp, LOT, { before: 0, cartons: 100, kg: 1000 });
    expect(v.lines.map((l) => l.kg)).toEqual([333.4, 333.3, 333.3]);
    expect(v.estimate).toBe(false);
  });

  it('«invalid» prints as mixed with estimate', () => {
    const comp = { seenBoxCount: 100, lines: [KB, { ...MS, cartons: null }] };
    const v = paperLines(comp, LOT, whole);
    expect(v.lines.map((l) => l.cartons)).toEqual([null, null]);
    expect(v.reasons).toEqual(['invalid']);
  });

  it('a carton counted on two trucks clamps', () => {
    const v = paperLines(SEP, LOT, { before: 80, cartons: 40, kg: 400 });
    expect(v.reasons).toContain('clamped');
    expect(v.lines.reduce((s, l) => s + (l.cartons ?? 0), 0)).toBe(40);
  });

  it('every split of 7 cartons (3/2/2) into two and three trucks adds up, and no separate row has 0 cartons', () => {
    const lot: LotTotals = { boxCount: 7, kg: '70.000', m3: '0.7000' };
    const comp = {
      seenBoxCount: 7,
      lines: [
        { seq: 1, name: 'A', pieces: 31, cartons: 3, kg: '30.000', m3: '0.3000', tnvedCode: null },
        { seq: 2, name: 'B', pieces: 17, cartons: 2, kg: '20.000', m3: '0.2000', tnvedCode: null },
        { seq: 3, name: 'C', pieces: 5, cartons: 2, kg: '20.000', m3: '0.2000', tnvedCode: null },
      ],
    };
    const splits: number[][] = [];
    for (let a = 1; a < 7; a += 1) splits.push([a, 7 - a]);
    for (let a = 1; a < 6; a += 1) for (let b = 1; a + b < 7; b += 1) splits.push([a, b, 7 - a - b]);
    for (const split of splits) {
      const cartons = [0, 0, 0];
      const pieces = [0, 0, 0];
      let before = 0;
      for (const n of split) {
        const kg = Math.round(n * 10 * 10) / 10;
        const v = paperLines(comp, lot, { before, cartons: n, kg, places: { loose: n, pallets: 0 } });
        expect(Math.round(v.lines.reduce((s, l) => s + l.kg, 0) * 10)).toBe(Math.round(kg * 10));
        expect(v.lines.reduce((s, l) => s + (typeof l.places === 'number' ? l.places : 0), 0)).toBe(n);
        for (const l of v.lines) {
          expect(l.cartons, `split ${split}`).toBeGreaterThanOrEqual(1);
          cartons[l.seq - 1]! += l.cartons!;
          pieces[l.seq - 1]! += l.pieces!;
        }
        before += n;
      }
      expect(cartons, `split ${split}`).toEqual([3, 2, 2]);
      expect(pieces, `split ${split}`).toEqual([31, 17, 5]);
    }
  });
});
