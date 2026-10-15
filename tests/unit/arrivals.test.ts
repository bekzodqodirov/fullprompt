import { describe, expect, it } from 'vitest';
import {
  arrivalBlockLabel,
  arrivalKey,
  arrivalLabel,
  foldArrivals,
  groupByArrival,
  type ArrivalPickup,
  type ArrivalRow,
} from '@/modules/wms/documents/arrivals';
import { docDate } from '@/modules/wms/documents/labels';

/**
 * «Qaysi partiyada Qashqarga kelgan» — the two decisions behind the agent
 * sheet's new order. The SQL that feeds them is exercised by the m3 planning
 * integration test; these are the rules a person can argue with.
 */

const row = (lotId: string, batchCode: string | null, day: string, boxes = 1): ArrivalRow => ({
  lotId,
  batchCode,
  arrivedAt: new Date(`2026-07-${day}T08:00:00Z`),
  boxes,
});

describe('what a lot says about how it got here', () => {
  it('names the truck that brought it', () => {
    const map = foldArrivals([row('lot-a', 'KAS-012', '20')]);
    expect(map.get('lot-a')).toEqual({
      codes: ['KAS-012'],
      sources: [{ kind: 'batch', id: null, code: 'KAS-012' }],
      labels: ['KAS-012'],
      arrivedAt: new Date('2026-07-20T08:00:00Z'),
    });
  });

  it('names both trucks when a lot came in two halves, earliest first', () => {
    const map = foldArrivals([row('lot-a', 'KAS-020', '25', 3), row('lot-a', 'KAS-012', '20', 7)]);
    expect(map.get('lot-a')!.codes).toEqual(['KAS-012', 'KAS-020']);
  });

  it('dates a split lot from the FIRST truck — that is when it started waiting', () => {
    const map = foldArrivals([row('lot-a', 'KAS-020', '25'), row('lot-a', 'KAS-012', '20')]);
    expect(map.get('lot-a')!.arrivedAt).toEqual(new Date('2026-07-20T08:00:00Z'));
  });

  it('carries no code for cargo that reached the warehouse on no truck of ours', () => {
    const map = foldArrivals([row('lot-b', null, '18')]);
    expect(map.get('lot-b')).toEqual({
      codes: [],
      sources: [],
      labels: [],
      arrivedAt: new Date('2026-07-18T08:00:00Z'),
    });
  });

  it('prints the trucks it does have when only part of a lot came on one', () => {
    // Half received here, half trucked in: the untrucked half is not a code
    // and cannot be printed, but it must not blank the half that is.
    const map = foldArrivals([row('lot-c', null, '10'), row('lot-c', 'KAS-012', '20')]);
    expect(map.get('lot-c')!.codes).toEqual(['KAS-012']);
  });

  it('dates a half-trucked lot from the TRUCK, never from the half that walked in', () => {
    // The untrucked half landed on the 10th and the truck on the 20th. Taking
    // the earliest row of any kind prints «KAS-012 · 10.07» — a date that
    // truck was not here — and, because the block heading is the minimum over
    // its rows, back-dates every OTHER client's cargo in that block with it.
    const map = foldArrivals([row('lot-c', null, '10'), row('lot-c', 'KAS-012', '20')]);
    expect(map.get('lot-c')!.arrivedAt).toEqual(new Date('2026-07-20T08:00:00Z'));
  });
});

describe('the day a document says something happened', () => {
  // 23:10 UTC on the 19th is 07:10 on the 20th in Kashgar, and the truck was
  // unloaded in Kashgar. Printed in the server's zone it carries a date the
  // warehouse was shut.
  const earlyShift = new Date('2026-07-19T23:10:00Z');

  it('prints the warehouse\'s own day', () => {
    expect(docDate(earlyShift, 'Asia/Shanghai')).toBe('20.07.2026');
  });

  it('would print the day before without one — which is the whole point', () => {
    expect(docDate(earlyShift)).toBe('19.07.2026');
  });

  it('falls back rather than throwing in the middle of a document', () => {
    expect(docDate(earlyShift, 'Mars/Olympus')).toBe('19.07.2026');
  });

  it('is dd.mm.yyyy, the format the other documents already use', () => {
    expect(docDate(new Date('2026-01-05T12:00:00Z'), 'Asia/Tashkent')).toBe('05.01.2026');
  });
});

describe('the order the agent reads the sheet in', () => {
  const arrivals = foldArrivals([
    row('new', 'KAS-020', '25'),
    row('old', 'KAS-012', '20'),
    row('here', null, '05'),
    row('alsoOld', 'KAS-012', '20'),
  ]);
  const lines = [
    { lotId: 'new', code: 'GS100' },
    { lotId: 'here', code: 'GS200' },
    { lotId: 'old', code: 'GS300' },
    { lotId: 'alsoOld', code: 'GS050' },
  ];
  const groups = groupByArrival(lines, (l) => ({
    arrival: arrivals.get(l.lotId),
    within: l.code,
  }));

  it('puts the oldest truck first — a consolidator ships what has waited longest', () => {
    expect(groups.map((g) => g.code)).toEqual(['KAS-012', 'KAS-020', '']);
  });

  it('puts everything one truck brought in one block', () => {
    expect(groups[0]!.rows.map((r) => r.lotId).sort()).toEqual(['alsoOld', 'old']);
  });

  it('sorts inside a block by client code, so a client is found by eye', () => {
    expect(groups[0]!.rows.map((r) => r.code)).toEqual(['GS050', 'GS300']);
  });

  it('leaves the truckless block undated — its rows span whatever dates they have', () => {
    const truckless = groups.at(-1)!;
    expect(truckless.code).toBe('');
    expect(truckless.arrivedAt).toBeNull();
  });

  it('dates a block from its earliest landing', () => {
    expect(groups[0]!.arrivedAt).toEqual(new Date('2026-07-20T08:00:00Z'));
  });

  it('keeps the truckless block last even when it is the oldest cargo on the sheet', () => {
    // 05.07 is older than either truck. It still goes last: the sheet is read
    // to answer «which truck brought this», and «none» is not an answer to it.
    expect(groups.at(-1)!.code).toBe('');
  });

  it('files a lot that came in two halves under the EARLIEST truck, not in a block of its own', () => {
    // Keyed on the joined list, KAS-012's cargo ends up in two places with two
    // subtotals to add up by hand — on a sheet whose whole promise is one
    // block per truck.
    const split = foldArrivals([
      row('split', 'KAS-012', '20'),
      row('split', 'KAS-020', '25'),
      row('plain', 'KAS-012', '20'),
    ]);
    const blocks = groupByArrival(
      [
        { lotId: 'split', code: 'GS900' },
        { lotId: 'plain', code: 'GS100' },
      ],
      (l) => ({ arrival: split.get(l.lotId), within: l.code }),
    );
    expect(blocks.map((b) => b.code)).toEqual(['KAS-012']);
    expect(blocks[0]!.rows.map((r) => r.lotId).sort()).toEqual(['plain', 'split']);
  });
});

/**
 * «Shu zavoddan, shu mashinada» (docs/ZAVOD-YOPISH.md §5, the owner's item
 * 6): a prixod received off a factory trip names the TRIP — its code, the
 * factory, the plate — on every surface, where it used to read «Принято на
 * складе / Received here». The rules a person can argue with; the SQL is the
 * integration test's (zavod-arrivals).
 */
const trip = (seq: number, factory: string, over: Partial<ArrivalPickup> = {}): ArrivalPickup => ({
  id: 'trip-12',
  code: 'ZR-00012',
  stopId: `stop-${seq}`,
  seq,
  factory,
  plate: '01A123BC',
  ...over,
});
const tripRow = (lotId: string, day: string, pickup: ArrivalPickup): ArrivalRow => ({
  lotId,
  batchCode: null,
  pickup,
  arrivedAt: new Date(`2026-07-${day}T08:00:00Z`),
  boxes: 1,
});

describe('a factory trip is a truck the documents name', () => {
  it('prints code · factory · plate, and a batch prints its code alone', () => {
    expect(arrivalLabel({ kind: 'pickup', code: 'ZR-00012', factory: 'Yiwu toys', plate: '01A123BC' })).toBe(
      'ZR-00012 · Yiwu toys · 01A123BC',
    );
    expect(arrivalLabel({ kind: 'batch', code: 'KAS-012' })).toBe('KAS-012');
  });

  it('omits a plate nobody typed rather than printing a dash', () => {
    expect(arrivalLabel({ kind: 'pickup', code: 'ZR-00012', factory: 'Yiwu toys', plate: null })).toBe(
      'ZR-00012 · Yiwu toys',
    );
    expect(arrivalLabel({ kind: 'pickup', code: 'ZR-00012', factory: 'Yiwu toys', plate: '  ' })).toBe(
      'ZR-00012 · Yiwu toys',
    );
  });

  it('a lot off a trip names the trip — its code among the codes, its label among the labels', () => {
    const map = foldArrivals([tripRow('lot-z', '15', trip(1, 'Yiwu toys'))]);
    expect(map.get('lot-z')).toEqual({
      codes: ['ZR-00012'],
      sources: [{ kind: 'pickup', ...trip(1, 'Yiwu toys') }],
      labels: ['ZR-00012 · Yiwu toys · 01A123BC'],
      arrivedAt: new Date('2026-07-15T08:00:00Z'),
    });
  });
});

describe('THE DATE RULE: the earliest NAMED landing, batch or trip; else the earliest of any', () => {
  it('a trip dates its half like a truck, never the walk-in half before it', () => {
    // Walked in on the 05th, the rest off the trip on the 15th: «ZR-00012 ·
    // 05.07» would be a date that truck was not here.
    const map = foldArrivals([row('lot', null, '05'), tripRow('lot', '15', trip(1, 'A'))]);
    expect(map.get('lot')!.arrivedAt).toEqual(new Date('2026-07-15T08:00:00Z'));
  });

  it('a trip before a batch dates the lot by the trip — sources[0] decides', () => {
    const map = foldArrivals([row('lot', 'KAS-020', '25'), tripRow('lot', '15', trip(1, 'A'))]);
    expect(map.get('lot')!.codes).toEqual(['ZR-00012', 'KAS-020']);
    expect(map.get('lot')!.arrivedAt).toEqual(new Date('2026-07-15T08:00:00Z'));
  });

  it('nothing named: the earliest row of any kind', () => {
    const map = foldArrivals([row('lot', null, '09'), row('lot', null, '05')]);
    expect(map.get('lot')!.arrivedAt).toEqual(new Date('2026-07-05T08:00:00Z'));
  });
});

describe('one block per TRUCK', () => {
  it('a two-stop trip is ONE block: the heading names both factories in stop order, each row its own', () => {
    // The truck called at Jinhua (stop 1) and then Yiwu toys (stop 2). Keyed
    // on the label, it would be two blocks for one truck; keyed on the stop,
    // the same.
    const arrivals = foldArrivals([
      tripRow('yiwu', '15', trip(2, 'Yiwu toys')),
      tripRow('jinhua', '15', trip(1, 'Jinhua')),
      tripRow('jinhua2', '16', trip(1, 'Jinhua')),
    ]);
    const lines = [
      { lotId: 'yiwu', code: 'GS100' },
      { lotId: 'jinhua', code: 'GS200' },
      { lotId: 'jinhua2', code: 'GS300' },
    ];
    const blocks = groupByArrival(lines, (l) => ({ arrival: arrivals.get(l.lotId), within: l.code }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.key).toBe('pickup:trip-12');
    expect(blocks[0]!.factories).toEqual(['Jinhua', 'Yiwu toys']);
    expect(arrivalBlockLabel(blocks[0]!)).toBe('ZR-00012 · Jinhua, Yiwu toys · 01A123BC');
    expect(blocks[0]!.arrivedAt).toEqual(new Date('2026-07-15T08:00:00Z'));
    expect(blocks[0]!.rows.map((l) => arrivals.get(l.lotId)!.labels[0])).toEqual([
      'ZR-00012 · Yiwu toys · 01A123BC',
      'ZR-00012 · Jinhua · 01A123BC',
      'ZR-00012 · Jinhua · 01A123BC',
    ]);
  });

  it('two trips that share nothing but a factory are two blocks', () => {
    const arrivals = foldArrivals([
      tripRow('a', '15', trip(1, 'Jinhua')),
      tripRow('b', '16', trip(1, 'Jinhua', { id: 'trip-13', code: 'ZR-00013' })),
    ]);
    const blocks = groupByArrival(
      [
        { lotId: 'a', code: 'GS1' },
        { lotId: 'b', code: 'GS2' },
      ],
      (l) => ({ arrival: arrivals.get(l.lotId), within: l.code }),
    );
    expect(blocks.map((b) => b.code)).toEqual(['ZR-00012', 'ZR-00013']);
  });

  it('two batch rows read with NO id stay two trucks — the key falls back to the code', () => {
    // `batch:${undefined}` would have merged KAS-012 and KAS-020 into one
    // block with one heading.
    expect(arrivalKey({ kind: 'batch', id: null, code: 'KAS-012' })).toBe('batch:KAS-012');
    const arrivals = foldArrivals([row('one', 'KAS-012', '20'), row('two', 'KAS-020', '21')]);
    const blocks = groupByArrival(
      [
        { lotId: 'one', code: 'GS1' },
        { lotId: 'two', code: 'GS2' },
      ],
      (l) => ({ arrival: arrivals.get(l.lotId), within: l.code }),
    );
    expect(blocks.map((b) => b.key)).toEqual(['batch:KAS-012', 'batch:KAS-020']);
  });

  it('a batch and a trip with the same code are still two trucks', () => {
    expect(arrivalKey({ kind: 'batch', id: 'x', code: 'ZR-00012' })).not.toBe(
      arrivalKey({ kind: 'pickup', id: 'x', code: 'ZR-00012', stopId: 's', seq: 1, factory: 'A', plate: null }),
    );
  });

  it('the walk-in block stays last and unlabelled beside a trip block', () => {
    const arrivals = foldArrivals([row('here', null, '01'), tripRow('z', '15', trip(1, 'A'))]);
    const blocks = groupByArrival(
      [
        { lotId: 'here', code: 'GS1' },
        { lotId: 'z', code: 'GS2' },
      ],
      (l) => ({ arrival: arrivals.get(l.lotId), within: l.code }),
    );
    expect(blocks.map((b) => b.key)).toEqual(['pickup:trip-12', '']);
    expect(arrivalBlockLabel(blocks[1]!)).toBe('');
    expect(blocks[1]!.arrivedAt).toBeNull();
  });
});
