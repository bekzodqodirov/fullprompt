import { describe, expect, it } from 'vitest';
import { roadScanVerdict } from '@/offline/road-scan';

/*
 * The loader's phone on a carton of a lot the plan still owes from the road
 * (docs/YOLDAGI-YUK.md §9, §11): it must never be accepted green and taken
 * back at a LATE flush — a carton physically loaded would go unrecorded
 * (#221, review numbers#5) — and it must never be refused when the server
 * would take it: at Horgos the landing that reserved it onto this truck is
 * seconds old, and the snapshot is up to fifteen (review of the fixes, locks#0).
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
const offline = { online: false, queuedUnloads: new Set<string>() };
const online = { online: true, queuedUnloads: new Set<string>() };

describe('roadScanVerdict', () => {
  it('accepts a carton standing here while the phone has taken fewer of its lot than the lot owes', () => {
    expect(roadScanVerdict('GS7-1', snap, new Set(), offline)).toEqual({ kind: 'accept' });
    expect(roadScanVerdict('gs7-2', snap, new Set(['GS7-1']), offline)).toEqual({ kind: 'accept' });
  });

  it('the one past what the lot owes is an extra — the red confirm, never a green mark the server takes back', () => {
    expect(roadScanVerdict('GS7-3', snap, new Set(['GS7-1', 'gs7-2']), offline)).toBeNull();
    expect(roadScanVerdict('GS7-3', snap, new Set(['GS7-1', 'gs7-2']), online)).toBeNull();
  });

  it('offline, with no landing of its own queued, a carton the snapshot lists on the inbound truck is refused, naming the truck', () => {
    expect(roadScanVerdict('GS7-4', snap, new Set(), offline)).toEqual({ kind: 'inbound', truck: 'YW-0012' });
  });

  it('online, the snapshot’s inbound list is not the last word — the server answers at once (landed and claimed, or still on the truck)', () => {
    expect(roadScanVerdict('GS7-4', snap, new Set(), online)).toEqual({ kind: 'accept' });
  });

  it('offline, a carton this phone landed itself goes in — the sync lands it before it loads', () => {
    expect(roadScanVerdict('gs7-4', snap, new Set(), { online: false, queuedUnloads: new Set(['GS7-4']) })).toEqual({
      kind: 'accept',
    });
  });

  it('a code of no owed lot, and an older snapshot with none of the fields, decide nothing', () => {
    expect(roadScanVerdict('GS9-1', snap, new Set(), online)).toBeNull();
    expect(roadScanVerdict('GS7-1', {}, new Set(), online)).toBeNull();
  });
});
