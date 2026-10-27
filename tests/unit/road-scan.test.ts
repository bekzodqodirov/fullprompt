import { describe, expect, it } from 'vitest';
import { roadScanVerdict } from '@/offline/road-scan';

/*
 * The loader's phone on a carton of a lot the plan still owes from the road
 * (docs/YOLDAGI-YUK.md §9, review numbers#5): it must never be accepted green
 * and taken back at the flush — a carton physically loaded would go
 * unrecorded (#221).
 */
const snap = {
  roadOwed: [{ lotId: 'L', owed: 2 }],
  roadShelf: [
    { code: 'GS7-1', lotId: 'L' },
    { code: 'GS7-2', lotId: 'L' },
    { code: 'GS7-3', lotId: 'L' },
  ],
  roadInbound: [{ code: 'GS7-4', truck: 'YW-0012' }],
};

describe('roadScanVerdict', () => {
  it('accepts a carton standing here while the phone has taken fewer of its lot than the lot owes', () => {
    expect(roadScanVerdict('GS7-1', snap, new Set())).toEqual({ kind: 'accept' });
    expect(roadScanVerdict('gs7-2', snap, new Set(['GS7-1']))).toEqual({ kind: 'accept' });
  });

  it('the one past what the lot owes is an extra — the red confirm, never a green mark the server takes back', () => {
    expect(roadScanVerdict('GS7-3', snap, new Set(['GS7-1', 'gs7-2']))).toBeNull();
  });

  it('a carton still on the inbound truck is refused at once, naming that truck', () => {
    expect(roadScanVerdict('GS7-4', snap, new Set())).toEqual({ kind: 'inbound', truck: 'YW-0012' });
  });

  it('a code of no owed lot, and an older snapshot with none of the fields, decide nothing', () => {
    expect(roadScanVerdict('GS9-1', snap, new Set())).toBeNull();
    expect(roadScanVerdict('GS7-1', {}, new Set())).toBeNull();
  });
});
