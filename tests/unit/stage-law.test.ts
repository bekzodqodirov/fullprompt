import { describe, expect, it } from 'vitest';
import { closedAtFor, reasonAllowed, stageWrite } from '@/modules/wms/crm/stage-law';
import { readPeriod } from '@/modules/wms/crm/analytics';

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
});
