import { describe, expect, it } from 'vitest';
import { COARSE_FIX_M, POSITION_BOUNDS, positionBatchSchema, readPosition } from '@/modules/wms/tracking/devices';

/**
 * One fix is judged on its own (the owner's report of 2026-11-10: the driver
 * app sent its first position and then «HTTP 400» for ever). The phone keeps
 * its queue on any non-2xx and re-sends it OLDEST FIRST, so a refusal of one
 * point was a refusal of every point after it. These pin what the reader
 * keeps, what it clears and what it drops.
 */
const at = '2026-11-10T08:00:00Z';

describe('readPosition', () => {
  it('reads exactly what the Android app sends (seconds, Z, optional measures)', () => {
    const read = readPosition({ lat: 41.31, lon: 69.24, recordedAt: at, accuracyM: 12, speedKmh: 78.5 });
    expect(read).toEqual({
      ok: true,
      position: { lat: 41.31, lon: 69.24, accuracyM: 12, speedKmh: 78.5, recordedAt: new Date(at) },
      trimmed: [],
    });
    // The app leaves both measures out when it has none.
    const bare = readPosition({ lat: 41.31, lon: 69.24, recordedAt: at });
    expect(bare.ok && bare.position).toMatchObject({ accuracyM: null, speedKmh: null });
  });

  it('KEEPS a fix whose speed no truck reaches and clears only the speed', () => {
    // A GPS chip's glitch: the place is still where the truck was.
    const read = readPosition({ lat: 41.31, lon: 69.24, recordedAt: at, speedKmh: POSITION_BOUNDS.speedKmh + 112.3 });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.position.speedKmh).toBeNull();
    expect(read.position.lat).toBe(41.31);
    expect(read.trimmed).toEqual(['speedKmh']);
  });

  it('an accuracy it cannot believe becomes the COARSEST, never null — null reads as a good fix', () => {
    // Every reader takes `accuracy_m IS NULL` as a fix that can place the
    // truck; a 5,000 km cell guess cleared to null would be drawn as one.
    const wild = readPosition({ lat: 41, lon: 69, recordedAt: at, accuracyM: 5_000_000 });
    expect(wild.ok && wild.position.accuracyM).toBe(POSITION_BOUNDS.accuracyM);
    expect(wild.ok && wild.trimmed).toEqual(['accuracyM']);
    expect(POSITION_BOUNDS.accuracyM).toBeGreaterThan(COARSE_FIX_M);
    const neg = readPosition({ lat: 41, lon: 69, recordedAt: at, speedKmh: -1, accuracyM: 'x' });
    expect(neg.ok && neg.trimmed).toEqual(['accuracyM', 'speedKmh']);
    expect(neg.ok && neg.position).toMatchObject({ accuracyM: POSITION_BOUNDS.accuracyM, speedKmh: null });
    const frac = readPosition({ lat: 41, lon: 69, recordedAt: at, accuracyM: 7.6 });
    expect(frac.ok && frac.position.accuracyM).toBe(8);
  });

  it('reads an offset time or epoch milliseconds as the same instant', () => {
    const offset = readPosition({ lat: 41, lon: 69, recordedAt: '2026-11-10T13:00:00+05:00' });
    expect(offset.ok && offset.position.recordedAt.toISOString()).toBe('2026-11-10T08:00:00.000Z');
    const epoch = readPosition({ lat: 41, lon: 69, recordedAt: Date.parse(at) });
    expect(epoch.ok && epoch.position.recordedAt.toISOString()).toBe('2026-11-10T08:00:00.000Z');
  });

  it('drops a fix with no readable place', () => {
    expect(readPosition({ lat: 91, lon: 69, recordedAt: at })).toEqual({ ok: false, why: 'bad_coords' });
    expect(readPosition({ lat: 41, lon: -181, recordedAt: at })).toEqual({ ok: false, why: 'bad_coords' });
    expect(readPosition({ lat: '41', lon: 69, recordedAt: at })).toEqual({ ok: false, why: 'bad_coords' });
    expect(readPosition({ lon: 69, recordedAt: at })).toEqual({ ok: false, why: 'bad_coords' });
  });

  it('drops a fix with no readable time, or one postgres cannot store', () => {
    expect(readPosition({ lat: 41, lon: 69 })).toEqual({ ok: false, why: 'bad_time' });
    expect(readPosition({ lat: 41, lon: 69, recordedAt: 'kecha' })).toEqual({ ok: false, why: 'bad_time' });
    expect(readPosition({ lat: 41, lon: 69, recordedAt: -1 })).toEqual({ ok: false, why: 'bad_time' });
    // Past year 9999 postgres refuses the timestamp, which would turn the
    // whole batch into a 500 and jam the queue all over again.
    expect(readPosition({ lat: 41, lon: 69, recordedAt: Date.UTC(10000, 0, 1) })).toEqual({ ok: false, why: 'bad_time' });
    expect(readPosition({ lat: 41, lon: 69, recordedAt: '+010000-01-01T00:00:00Z' })).toEqual({ ok: false, why: 'bad_time' });
    expect(readPosition({ lat: 41, lon: 69, recordedAt: 9e15 })).toEqual({ ok: false, why: 'bad_time' });
  });

  it('drops what is not a fix at all', () => {
    for (const raw of [null, 5, 'x', [41, 69]]) {
      expect(readPosition(raw)).toEqual({ ok: false, why: 'not_a_fix' });
    }
  });
});

describe('positionBatchSchema', () => {
  it('judges the envelope only: a batch holding a bad fix is still a batch', () => {
    const body = {
      positions: [
        { lat: 41, lon: 69, recordedAt: at },
        { lat: 41, lon: 69, recordedAt: at, speedKmh: 9_999 },
        { nonsense: true },
      ],
    };
    expect(positionBatchSchema.safeParse(body).success).toBe(true);
  });

  it('still refuses what is not a batch', () => {
    expect(positionBatchSchema.safeParse({}).success).toBe(false);
    expect(positionBatchSchema.safeParse({ positions: [] }).success).toBe(false);
    expect(positionBatchSchema.safeParse({ positions: 'x' }).success).toBe(false);
    expect(positionBatchSchema.safeParse({ positions: Array(501).fill({}) }).success).toBe(false);
  });
});
