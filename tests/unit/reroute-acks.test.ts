import { describe, expect, it } from 'vitest';
import { rerouteVerdict, snapshotRerouted } from '@/offline/reroute-acks';
import type { SyncAck } from '@/offline/scan-outbox';

/**
 * Whose «rerouted» is it (the reroute review). The phone's outbox is one
 * queue for every truck, so truck A's leftover rows — rerouted away while
 * they waited — come back on truck B's screen. The first build took ANY such
 * ack as its own: B's screen read «this truck goes to HOR, the cargo does not
 * land here» and refused every scan of B until a reload, while B was coming
 * exactly where the operator stood. Pressed here through the pure verdict
 * both scan screens ask, over a MIXED list, as the flush hands it over.
 */

const A = '00000000-0000-4000-8000-00000000a0aa'; // rerouted away while its rows waited
const B = '00000000-0000-4000-8000-00000000b0bb'; // the truck on this screen

let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
const ok = (batchId: string): SyncAck => ({ clientEventUuid: uuid(), result: 'ok', batchId });
const rerouted = (batchId: string | undefined, to: string, batchCode?: string): SyncAck => ({
  clientEventUuid: uuid(),
  result: 'rejected',
  detail: 'batch_rerouted',
  rerouteTo: to,
  ...(batchId ? { batchId } : {}),
  ...(batchCode ? { batchCode } : {}),
});

describe('rerouteVerdict', () => {
  it('another truck’s rerouted rows never latch this screen — they are named, once per truck', () => {
    const acks = [ok(B), rerouted(A, 'HOR', 'KA-7'), ok(B), rerouted(A, 'HOR', 'KA-7'), rerouted(A, 'HOR', 'KA-7')];
    expect(rerouteVerdict(acks, B)).toEqual({ own: null, elsewhere: [{ code: 'KA-7', to: 'HOR', n: 3 }] });
  });

  it('this truck’s own rerouted row latches, and a neighbour in the same flush is still only named', () => {
    const acks = [rerouted(A, 'HOR', 'KA-7'), rerouted(B, 'UCH', 'KA-9')];
    expect(rerouteVerdict(acks, B)).toEqual({ own: 'UCH', elsewhere: [{ code: 'KA-7', to: 'HOR', n: 1 }] });
  });

  it('an ack nobody tagged with a truck is never taken as this screen’s', () => {
    // A wrong «not coming here» blocks a real unload; a missed one only waits
    // for the next /planned tick to say it.
    expect(rerouteVerdict([rerouted(undefined, 'HOR')], B).own).toBeNull();
  });

  it('nothing rerouted, nothing said', () => {
    expect(rerouteVerdict([ok(A), ok(B)], B)).toEqual({ own: null, elsewhere: [] });
  });
});

describe('snapshotRerouted', () => {
  const RRA = '00000000-0000-4000-8000-0000000000a1';
  const RRB = '00000000-0000-4000-8000-0000000000b1';

  it('a snapshot naming another destination than the one this screen opened for — for EVERY viewer', () => {
    // An unscoped logist gets a 200 at the new warehouse, never the 409.
    expect(snapshotRerouted(RRA, { destWarehouseId: RRB, destCode: 'RRB' })).toBe('RRB');
  });

  it('the truck sent back to the screen’s own destination clears it', () => {
    expect(snapshotRerouted(RRA, { destWarehouseId: RRA, destCode: 'RRA' })).toBeNull();
  });

  it('nothing to compare — an older cached snapshot, or a screen that never had one — says nothing', () => {
    expect(snapshotRerouted(null, { destWarehouseId: RRB, destCode: 'RRB' })).toBeNull();
    expect(snapshotRerouted(RRA, {})).toBeNull();
  });
});
