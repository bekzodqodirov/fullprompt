import { describe, expect, it } from 'vitest';
import { dropLotFrom, keepsPickup, NO_PICKUP, postedPickupFields } from '@/app/(protected)/receive/pickup-draft';

/**
 * The receive draft's factory-trip rules (docs/ZAVOD-YOPISH.md §3), held to
 * the judges' findings: a partial delivery must not answer the line whose lot
 * the skladchi deleted (the trip would close on cargo still at the factory),
 * a mis-picked client must not answer another client's lines, and the post
 * never pairs line ids with «the rest of the same cargo».
 */
const base = {
  pickupStopId: 'stop-1',
  pickupLabel: '🏭 ZR-1 · 1. A',
  pickupLines: [
    { id: 'L-toys', goods: 'toys' },
    { id: 'L-bags', goods: 'bags' },
  ],
  pickupLineIds: ['L-toys', 'L-bags'],
  pickupOwnerClientId: 'client-A' as string | null,
  lots: [
    { id: 'lot-toys', pickupLineId: 'L-toys' },
    { id: 'lot-bags', pickupLineId: 'L-bags' },
    { id: 'lot-own' },
  ],
};

describe('the receive draft and its factory trip', () => {
  it('a deleted line-built lot takes its line out of the answer; the last one takes the trip', () => {
    const one = dropLotFrom(base, 'lot-bags');
    expect(one.pickupLineIds).toEqual(['L-toys']);
    expect(one.pickupStopId).toBe('stop-1');
    expect(postedPickupFields(one).pickupLineIds).toEqual(['L-toys']);

    const none = dropLotFrom(one, 'lot-toys');
    expect(none).toMatchObject(NO_PICKUP);
    expect(postedPickupFields(none)).toEqual({ pickupStopId: null });

    // A lot the operator added himself answers nothing and changes nothing.
    expect(dropLotFrom(base, 'lot-own').pickupLineIds).toEqual(['L-toys', 'L-bags']);
  });

  it('a client switch keeps the trip only for marking lines or the same client', () => {
    expect(keepsPickup(base, 'client-A')).toBe(true);
    expect(keepsPickup(base, 'client-B')).toBe(false);
    expect(keepsPickup(base, null)).toBe(false);
    expect(keepsPickup({ ...base, pickupOwnerClientId: null }, 'client-B')).toBe(true);
    expect(keepsPickup({ ...base, pickupStopId: null }, 'client-B')).toBe(true);
  });

  it('posts ids only beside a trip, never beside «the rest», and always the door’s «Yo’q»', () => {
    expect(postedPickupFields(base)).toEqual({ pickupStopId: 'stop-1', pickupLineIds: ['L-toys', 'L-bags'] });
    expect(postedPickupFields({ ...base, pickupExtra: true })).toEqual({ pickupStopId: 'stop-1', pickupExtra: true });
    expect(postedPickupFields({ ...base, pickupLineIds: [] })).toEqual({ pickupStopId: 'stop-1' });
    expect(postedPickupFields({ pickupStopId: null, pickupLineIds: ['L-x'], pickupDeclined: ['stop-9'] })).toEqual({
      pickupStopId: null,
      pickupDeclined: ['stop-9'],
    });
  });
});
