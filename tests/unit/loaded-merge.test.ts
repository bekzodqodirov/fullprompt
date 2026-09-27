import { describe, expect, it } from 'vitest';
import { mergeLoaded } from '@/offline/loaded-merge';
import type { CountOnlyLot } from '@/offline/count-only';

/**
 * The loading screen's «what is on the truck» after a snapshot (0112): a
 * phone's own marks only grow between snapshots, a lot the office counts
 * follows the server both ways.
 */

const counted: CountOnlyLot = { lotId: 'L-office', mode: 'counted', label: 'GS777-A', siblings: ['YW26-000099'] };
const qrless: CountOnlyLot = { lotId: 'L-qrless', mode: 'qrless', label: 'GS777-B', siblings: [] };

describe('mergeLoaded', () => {
  it('adds what the server says is aboard', () => {
    const next = mergeLoaded(new Set(), [
      { shortCode: 'A-1', status: 'loading', lotId: 'L1' },
      { shortCode: 'A-2', status: 'planned', lotId: 'L1' },
      { shortCode: 'A-3', status: 'in_transit', lotId: 'L1' },
    ]);
    expect([...next].sort()).toEqual(['A-1', 'A-3']);
  });

  it('keeps a scanned lot’s local mark the snapshot has not heard of yet', () => {
    const next = mergeLoaded(new Set(['A-2']), [{ shortCode: 'A-2', status: 'planned', lotId: 'L1' }], [counted]);
    expect(next.has('A-2')).toBe(true);
  });

  it('follows the office DOWN: a counted lot’s carton the server no longer has aboard comes off', () => {
    const prev = new Set(['C-1', 'C-2', 'C-3']);
    const next = mergeLoaded(
      prev,
      [
        { shortCode: 'C-1', status: 'loading', lotId: 'L-office' },
        { shortCode: 'C-2', status: 'planned', lotId: 'L-office' },
        { shortCode: 'C-3', status: 'planned', lotId: 'L-office' },
      ],
      [counted],
    );
    expect([...next]).toEqual(['C-1']);
    // …and does not mutate what it was given.
    expect(prev.size).toBe(3);
  });

  it('a QR-siz lot is the office’s too', () => {
    const next = mergeLoaded(new Set(['Q-1']), [{ shortCode: 'Q-1', status: 'planned', lotId: 'L-qrless' }], [qrless]);
    expect(next.size).toBe(0);
  });

  it('a crated carton stays the phone’s — a crate is scanned as the crate', () => {
    const next = mergeLoaded(
      new Set(['K-1']),
      [{ shortCode: 'K-1', status: 'planned', lotId: 'L-office', crateCode: 'CR-7' }],
      [counted],
    );
    expect(next.has('K-1')).toBe(true);
  });

  it('a counted lot’s sibling at the origin is never on this truck’s screen', () => {
    const next = mergeLoaded(new Set(['YW26-000099']), [], [counted]);
    expect(next.size).toBe(0);
  });

  it('an old cached snapshot without the field changes nothing', () => {
    const next = mergeLoaded(new Set(['A-9']), [{ shortCode: 'A-9', status: 'planned', lotId: 'L1' }], undefined);
    expect([...next]).toEqual(['A-9']);
  });
});
