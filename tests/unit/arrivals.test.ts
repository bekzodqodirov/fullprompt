import { describe, expect, it } from 'vitest';
import { foldArrivals, groupByArrival, type ArrivalRow } from '@/modules/wms/documents/arrivals';
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
    expect(map.get('lot-b')).toEqual({ codes: [], arrivedAt: new Date('2026-07-18T08:00:00Z') });
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
