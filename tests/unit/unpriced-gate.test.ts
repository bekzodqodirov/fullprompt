import { describe, expect, it } from 'vitest';
import { parseDayOrInstant } from '@/modules/platform/time/tashkent';
import { SETTING_VALIDATORS } from '@/modules/platform/settings/service';
import { gatedAt, parseGateSince } from '@/modules/wms/finance/unpriced';

/**
 * The unpriced-cargo ban's instant (0104): what the setting may say, how it
 * is read, and which landing it stops. The reader FAILS CLOSED — a value no
 * parser understands gates everything — because only a hand edit of the
 * database can put one there, and a typo must not silently lift the owner's
 * «taqiq tursin».
 */
describe('parseDayOrInstant', () => {
  it('reads empty as switched off', () => {
    expect(parseDayOrInstant('')).toBe('empty');
    expect(parseDayOrInstant('   ')).toBe('empty');
  });

  it('reads a real day as that Tashkent day’s start', () => {
    expect((parseDayOrInstant('2026-09-25') as Date).toISOString()).toBe('2026-09-24T19:00:00.000Z');
  });

  it('reads an instant WITH its offset, in either spelling', () => {
    expect((parseDayOrInstant('2026-09-25T18:03:11+05:00') as Date).toISOString()).toBe('2026-09-25T13:03:11.000Z');
    expect((parseDayOrInstant('2026-09-25T13:03:11Z') as Date).toISOString()).toBe('2026-09-25T13:03:11.000Z');
    expect((parseDayOrInstant('2026-09-25T18:03+05:00') as Date).toISOString()).toBe('2026-09-25T13:03:00.000Z');
  });

  it('refuses everything else — including an instant with no offset (the server is UTC)', () => {
    for (const bad of ['25.09.2026', '2026-9-25', 'off', '2026-02-30', '2026-09-25T18:03:11', '2026-09-25T25:00+05:00']) {
      expect([bad, parseDayOrInstant(bad)]).toEqual([bad, null]);
    }
  });
});

describe('parseGateSince', () => {
  it('empty → off, a day or an instant → on', () => {
    expect(parseGateSince('')).toEqual({ state: 'off' });
    expect(parseGateSince('2026-09-25')).toEqual({ state: 'on', since: new Date('2026-09-24T19:00:00.000Z') });
  });

  it('FAILS CLOSED on anything it cannot read — a hand-edited typo does not lift the ban', () => {
    expect(parseGateSince('25.09.2026')).toEqual({ state: 'invalid' });
    expect(parseGateSince(20260925)).toEqual({ state: 'invalid' });
    expect(parseGateSince(null)).toEqual({ state: 'invalid' });
  });
});

describe('gatedAt', () => {
  const since = new Date('2026-09-25T13:00:00Z');
  const on = { state: 'on' as const, since };

  it('stops a landing at or after the instant and not one a minute before', () => {
    expect(gatedAt(new Date(since.getTime() - 60_000), on)).toBe(false);
    expect(gatedAt(since, on)).toBe(true);
    expect(gatedAt(new Date(since.getTime() + 60_000), on)).toBe(true);
  });

  it('never stops a walk-in, never stops anything while off, stops every road landing while invalid', () => {
    expect(gatedAt(null, on)).toBe(false);
    expect(gatedAt(new Date(), { state: 'off' })).toBe(false);
    expect(gatedAt(new Date('2000-01-01'), { state: 'invalid' })).toBe(true);
  });

  it('refuses a raw text timestamp rather than comparing it (NaN would open the gate)', () => {
    expect(() => gatedAt('2026-09-25 13:00:00+00' as unknown as Date, on)).toThrow(TypeError);
  });
});

describe('the setting’s save-time validator', () => {
  it('refuses a value the reader would fail closed on, and accepts empty (= off)', () => {
    const validate = SETTING_VALIDATORS.unpriced_gate_since!;
    expect(validate('25.09.2026')).toBe(false);
    expect(validate('')).toBe(true);
    expect(validate('2026-09-25')).toBe(true);
    expect(validate('2026-09-25T19:50:40+05:00')).toBe(true);
  });
});
