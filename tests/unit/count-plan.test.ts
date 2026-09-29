import { describe, expect, it } from 'vitest';
import {
  planCountMove,
  shelfStatus,
  type CountMove,
  type CountRow,
} from '@/modules/wms/scanning/count-plan';

/**
 * The count press's arithmetic on plain arrays (0112, «sanab yuklash»). The
 * service reads the lot's cartons under their locks and does exactly what
 * this answers, so the rules live — and are proven — here.
 */

function row(seq: number, over: Partial<CountRow> = {}): CountRow {
  return {
    id: `b${seq}`,
    shortCode: `C-${String(seq).padStart(5, '0')}`,
    seq,
    status: 'in_stock',
    onTruck: false,
    over: false,
    byCount: false,
    qrless: false,
    loadedFrom: null,
    grown: false,
    ...over,
  };
}
const reserved = (seq: number, o: Partial<CountRow> = {}) => row(seq, { status: 'planned', onTruck: true, ...o });
const aboard = (seq: number, o: Partial<CountRow> = {}) =>
  row(seq, { status: 'loading', onTruck: true, byCount: true, ...o });
const opts = (o: Partial<Parameters<typeof planCountMove>[2]> = {}) => ({
  hasPlan: true,
  planN: 0,
  overReason: null,
  growMax: 1000,
  ...o,
});
const ids = (rows: CountRow[]) => rows.map((r) => r.seq);
function move(rows: CountRow[], target: number, o = opts()): CountMove {
  const plan = planCountMove(rows, target, o);
  if (plan.kind !== 'move') throw new Error(`refused: ${plan.code}`);
  return plan;
}

describe('going up', () => {
  it('the truck’s reservation first, lowest seq, loaded plain', () => {
    const rows = [reserved(3), reserved(1), reserved(2), row(4)];
    const m = move(rows, 2, opts({ planN: 3 }));
    expect(ids(m.load)).toEqual([1, 2]);
    expect([m.reReserve, m.loadOver, m.grow]).toEqual([[], [], 0]);
  });

  it('a «tayyor» shelf carton goes back onto the plan like an in_stock one — no ⚠, no reason', () => {
    // A UZ collection warehouse: row 4 stands «tayyor» for its client, and an
    // Andijan → Tashkent plan is reserved out of exactly such cargo. Review
    // cargo-6 made it ride as an extra because «yuklash tugadi» brought it
    // back `in_stock`; every give-back now returns it as it stood
    // (`shelfBefore`), and the extra would put a false ⚠ on a carton the plan
    // counted. No reason is passed — the press must not ask for one.
    const rows = [row(4, { status: 'ready_for_pickup' }), row(5)];
    const m = move(rows, 2, opts({ planN: 2 }));
    expect(ids(m.reReserve)).toEqual([4, 5]);
    expect(m.loadOver).toEqual([]);
    expect(m.grow).toBe(0);
  });

  it('cartons the plan counted but the shelf got back are reserved again — no mark', () => {
    // «yuklash tugadi» sent 4 and 5 home; the plan still says 5.
    const rows = [aboard(1), aboard(2), aboard(3), row(4), row(5), row(6)];
    const m = move(rows, 5, opts({ planN: 5 }));
    expect(ids(m.reReserve)).toEqual([4, 5]);
    expect(m.loadOver).toEqual([]);
  });

  it('beyond the plan: from the shelf, stickerless first, then the lowest seq — and it needs a reason', () => {
    const rows = [reserved(1), reserved(2), row(5), row(3), row(4, { qrless: true })];
    const refused = planCountMove(rows, 4, opts({ planN: 2 }));
    expect(refused).toEqual({ kind: 'refuse', code: 'over_reason_required', plan: 2, stock: 5 });
    const m = move(rows, 4, opts({ planN: 2, overReason: 'zavod berdi' }));
    expect(ids(m.load)).toEqual([1, 2]);
    expect(ids(m.loadOver)).toEqual([4, 3]);
  });

  it('beyond the prixod: the missing number grows the lot, with a reason, within the cap', () => {
    const rows = [reserved(1), reserved(2)];
    expect(planCountMove(rows, 5, opts({ planN: 2 }))).toMatchObject({ code: 'over_reason_required' });
    const m = move(rows, 5, opts({ planN: 2, overReason: 'ortiq keldi' }));
    expect([ids(m.load), m.grow]).toEqual([[1, 2], 3]);
    expect(planCountMove(rows, 2 + 11, opts({ planN: 2, overReason: 'ortiq', growMax: 10 }))).toEqual({
      kind: 'refuse',
      code: 'grow_too_many',
      max: 10,
    });
  });

  it('a lot not on the plan (plan 0) rides beyond it from the first carton', () => {
    const m = move([row(1), row(2)], 1, opts({ planN: 0, overReason: 'kerak' }));
    expect([ids(m.loadOver), m.load, m.reReserve]).toEqual([[1], [], []]);
  });

  it('a quick truck takes from the shelf plainly, and only growth needs a reason', () => {
    const rows = [row(2), row(1), row(3)];
    const m = move(rows, 2, opts({ hasPlan: false }));
    expect([ids(m.loadSpare), m.loadOver, m.plan]).toEqual([[1, 2], [], null]);
    expect(planCountMove(rows, 4, opts({ hasPlan: false }))).toEqual({
      kind: 'refuse',
      code: 'over_reason_required',
      plan: null,
      stock: 3,
    });
    expect(move(rows, 4, opts({ hasPlan: false, overReason: 'bor' })).grow).toBe(1);
  });
});

describe('going down', () => {
  it('the office’s own before a phone’s; beyond-plan before planned; highest seq first', () => {
    const rows = [
      aboard(1, { byCount: false }),
      aboard(2, { byCount: false }),
      aboard(3),
      aboard(4),
      aboard(5, { over: true, loadedFrom: 'in_stock' }),
    ];
    const m = move(rows, 1, opts({ planN: 4 }));
    expect(ids(m.backToShelf)).toEqual([5]);
    expect(ids(m.backToPlan)).toEqual([4, 3, 2]);
    // No reason is asked for taking cartons OFF, beyond-plan ones included.
    expect(m.loadOver).toEqual([]);
  });

  it('a quick truck reserves nothing: everything goes back where it stood', () => {
    const rows = [aboard(1, { loadedFrom: 'ready_for_pickup' }), aboard(2, { loadedFrom: 'in_stock' })];
    const m = move(rows, 0, opts({ hasPlan: false }));
    expect(ids(m.backToShelf)).toEqual([2, 1]);
    expect(m.backToShelf.map((r) => shelfStatus(r.loadedFrom))).toEqual(['in_stock', 'ready_for_pickup']);
    expect(shelfStatus(null)).toBe('in_stock');
    expect(shelfStatus('planned')).toBe('in_stock');
  });
});

describe('the same number twice', () => {
  it('is an empty move (the service writes nothing for it)', () => {
    const m = move([aboard(1), aboard(2), reserved(3)], 2, opts({ planN: 3 }));
    expect([m.load, m.reReserve, m.loadSpare, m.loadOver, m.grow, m.backToPlan, m.backToShelf]).toEqual([
      [],
      [],
      [],
      [],
      0,
      [],
      [],
    ]);
  });

  it('counts the phones’ cartons into the total (Q1 = b)', () => {
    const rows = [aboard(1, { byCount: false }), aboard(2, { byCount: false }), reserved(3), reserved(4)];
    const m = move(rows, 3, opts({ planN: 4 }));
    expect([m.aboard, m.phoneScanned, ids(m.load)]).toEqual([2, 2, [3]]);
  });
});

/**
 * The state a move leaves, the way the service writes it — so two presses
 * can be compared with one.
 */
function apply(rows: CountRow[], m: CountMove, hasPlan: boolean): CountRow[] {
  const by = new Map(rows.map((r) => [r.id, { ...r }]));
  const on = (r: CountRow, over: boolean) => {
    const cur = by.get(r.id)!;
    by.set(r.id, { ...cur, status: 'loading', onTruck: true, byCount: true, over, loadedFrom: cur.status });
  };
  m.load.forEach((r) => on(r, false));
  m.reReserve.forEach((r) => on(r, false));
  m.loadSpare.forEach((r) => on(r, false));
  m.loadOver.forEach((r) => on(r, true));
  for (const r of m.backToPlan) by.set(r.id, { ...by.get(r.id)!, status: 'planned', over: false });
  for (const r of m.backToShelf) {
    by.set(r.id, { ...by.get(r.id)!, status: shelfStatus(r.loadedFrom), onTruck: false, over: false });
  }
  if (!hasPlan) for (const r of m.backToPlan) throw new Error(`a quick truck reserved ${r.id}`);
  return [...by.values()];
}
const aboardSet = (rows: CountRow[]) =>
  rows
    .filter((r) => r.onTruck && r.status === 'loading')
    .map((r) => `${r.seq}${r.over ? '!' : ''}`)
    .sort();

describe('path independence', () => {
  it('any press then any other lands where the second alone lands — planned and quick trucks', () => {
    let cases = 0;
    for (const hasPlan of [true, false]) {
      for (let planN = 0; planN <= 3; planN += 1) {
        for (let shelfN = 0; shelfN <= 3; shelfN += 1) {
          // Every mix of stickerless and «tayyor» shelf cartons: a collection
          // warehouse's shelf holds both statuses at once.
          for (let mask = 0; mask < 1 << (2 * shelfN); mask += 1) {
            const start = [
              ...Array.from({ length: hasPlan ? planN : 0 }, (_, i) => reserved(i + 1)),
              ...Array.from({ length: shelfN }, (_, i) =>
                row(10 + ((i * 7) % 5) + i, {
                  qrless: !!(mask & (1 << i)),
                  status: mask & (1 << (shelfN + i)) ? 'ready_for_pickup' : 'in_stock',
                }),
              ),
            ];
            const most = start.length;
            const o = opts({ hasPlan, planN, overReason: 'sabab' });
            for (let t1 = 0; t1 <= most; t1 += 1) {
              for (let t2 = 0; t2 <= most; t2 += 1) {
                const label = `plan=${hasPlan}/${planN} shelf=${shelfN}/${mask} ${t1}→${t2}`;
                const direct = apply(start, move(start, t2, o), hasPlan);
                const first = apply(start, move(start, t1, o), hasPlan);
                const second = apply(first, move(first, t2, o), hasPlan);
                expect(aboardSet(second), label).toEqual(aboardSet(direct));
                // A carton off the truck both ways stands as it stood: a
                // trip on and back never turns «tayyor» into `in_stock`.
                const alone = new Map(direct.map((r) => [r.id, r]));
                for (const r of second) {
                  const d = alone.get(r.id)!;
                  if (!r.onTruck && !d.onTruck) expect(`${r.seq}:${r.status}`, label).toBe(`${d.seq}:${d.status}`);
                }
                cases += 1;
              }
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(500);
  });
});

describe('taking the prixod’s own growth back (review money-3)', () => {
  it('a carton the count minted comes off FIRST and goes out of the prixod, never to a shelf', () => {
    // 3 planned aboard, 2 minted by the press that typed «5».
    const rows = [
      aboard(1),
      aboard(2),
      aboard(3),
      aboard(4, { over: true, grown: true, loadedFrom: 'in_stock' }),
      aboard(5, { over: true, grown: true, loadedFrom: 'in_stock' }),
    ];
    const three = move(rows, 3, opts({ planN: 3 }));
    expect([ids(three.shrink), ids(three.backToShelf), ids(three.backToPlan)]).toEqual([[5, 4], [], []]);
    const two = move(rows, 2, opts({ planN: 3 }));
    expect([ids(two.shrink), ids(two.backToPlan)]).toEqual([[5, 4], [3]]);
  });
});
