import { describe, expect, it } from 'vitest';
import { closedAtFor, reasonAllowed, stageWrite } from '@/modules/wms/crm/stage-law';
import { readAnalyticsFilters, readPeriod } from '@/modules/wms/crm/analytics';

/**
 * Round 98 part 2 — the pure halves of the analytics round: when `closed_at`
 * is stamped, when a typed reason passes the owner's list, and how the
 * period comes out of the address bar.
 */

describe('closedAtFor', () => {
  const now = new Date('2026-08-12T10:00:00Z');

  it('stamps a decision and clears a revival', () => {
    expect(closedAtFor('won', now)).toBe(now);
    expect(closedAtFor('lost', now)).toBe(now);
    expect(closedAtFor('open', now)).toBeNull();
  });

  it('an unknown kind is not a decision', () => {
    expect(closedAtFor('frozen', now)).toBeNull();
  });
});

describe('reasonAllowed', () => {
  it('an empty dictionary keeps free text legal (day one)', () => {
    expect(reasonAllowed('narx qimmat', [])).toBe(true);
  });

  it('a non-empty dictionary admits only its own labels', () => {
    expect(reasonAllowed('Narx qimmat', ['Narx qimmat', 'Javob bermadi'])).toBe(true);
    expect(reasonAllowed('boshqa narsa', ['Narx qimmat', 'Javob bermadi'])).toBe(false);
  });
});

describe('the law and the stamp agree about what a decision is', () => {
  it('every kind stageWrite refuses a bare move into also stamps closed_at', () => {
    // `lost` needs a reason and stamps; `won` needs none and stamps; `open`
    // needs none and clears. If a new closed kind ever appears in one
    // function and not the other, a card will close without a date or date
    // without closing — this pins the pair.
    const now = new Date();
    expect(stageWrite('lost', 'sabab').ok && closedAtFor('lost', now) !== null).toBe(true);
    expect(stageWrite('won', null).ok && closedAtFor('won', now) !== null).toBe(true);
    expect(stageWrite('open', null).ok && closedAtFor('open', now) === null).toBe(true);
  });
});

describe('readPeriod', () => {
  it('reads a valid pair and makes the end exclusive of the next day', () => {
    const p = readPeriod({ dan: '2026-08-01', gacha: '2026-08-12' });
    expect(p.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    // «gacha 12th» includes the 12th — the bound is the 13th's midnight.
    expect(p.to.toISOString()).toBe('2026-08-13T00:00:00.000Z');
    expect(p.dan).toBe('2026-08-01');
    expect(p.gacha).toBe('2026-08-12');
  });

  it('drops garbage instead of obeying it (#514)', () => {
    const junk = readPeriod({ dan: "1' OR 1=1", gacha: '20260812' });
    const fallback = readPeriod({});
    expect(junk.dan).toBe(fallback.dan);
  });

  it('an end before the start collapses to one day rather than a negative range', () => {
    const p = readPeriod({ dan: '2026-08-10', gacha: '2026-08-01' });
    expect(p.dan).toBe('2026-08-10');
    expect(p.gacha).toBe('2026-08-10');
  });

  it('an impossible calendar day falls back instead of reaching the SQL', () => {
    const p = readPeriod({ dan: '2026-02-30', gacha: '2026-02-30' });
    expect(p.dan).toBe(readPeriod({}).dan);
  });
});

describe('readAnalyticsFilters', () => {
  const UUID = '019ff7ca-a06e-77fd-be1e-7024630bc56d';

  it('takes a uuid or the literal none, and drops everything else (#514)', () => {
    expect(readAnalyticsFilters({ hodim: UUID }).owner).toBe(UUID);
    expect(readAnalyticsFilters({ hodim: 'none' }).owner).toBe('none');
    // A garbage hodim reaching eq(uuid_col, …) is a 22P02 500, not a filter.
    expect(readAnalyticsFilters({ hodim: 'Karim' }).owner).toBeUndefined();
    expect(readAnalyticsFilters({ hodim: ['a', 'b'] }).owner).toBeUndefined();
    expect(readAnalyticsFilters({ manba: 'none' }).source).toBe('none');
    expect(readAnalyticsFilters({ manba: 'tiktok' }).source).toBeUndefined();
  });

  it('numbers: comma decimals in, negatives and NaN out', () => {
    const f = readAnalyticsFilters({ kub_min: '2,5', narx_min: '-3', kg_max: 'abc' });
    expect(f.volMin).toBe(2.5);
    expect(f.amountMin).toBeUndefined();
    expect(f.kgMax).toBeUndefined();
  });

  it('carried echoes ONLY validated values, so links cannot walk garbage', () => {
    const f = readAnalyticsFilters({ hodim: UUID, narx_min: 'abc', kub_max: '10' });
    expect(f.carried).toEqual({ hodim: UUID, kub_max: '10' });
    expect(f.active).toBe(2);
  });

  it('the period cannot leak in: dan/gacha are not filter keys', () => {
    // The filter shape must be structurally unable to carry a created_at
    // range — the closed-clock queries would silently drop leads that
    // arrived before the period and closed inside it (the two-clock rule).
    const f = readAnalyticsFilters({ dan: '2026-01-01', gacha: '2026-02-01' });
    expect(f.active).toBe(0);
    expect(f.carried).toEqual({});
  });
});
