import { describe, expect, it } from 'vitest';
import { spendDateOf } from '@/modules/wms/accounting/spend-date';

/**
 * A rasxod xabari is filed under the day the warehouse spent the money, in
 * that warehouse's clock (audit A29) — not under the accountant's today, and
 * not under the server's UTC date.
 */
describe('spendDateOf', () => {
  it("a report sent at 00:30 in Yiwu is Yiwu's day, the UTC day before", () => {
    // 2026-08-29 00:30 +08:00 = 2026-08-28 16:30Z.
    const sent = new Date('2026-08-28T16:30:00Z');
    expect(spendDateOf(sent, 'Asia/Shanghai')).toBe('2026-08-29');
    expect(sent.toISOString().slice(0, 10)).toBe('2026-08-28');
  });

  it('a late-evening Tashkent report stays on its evening', () => {
    // 2026-08-31 23:10 +05:00 = 2026-08-31 18:10Z — August, not September.
    expect(spendDateOf(new Date('2026-08-31T18:10:00Z'), 'Asia/Tashkent')).toBe('2026-08-31');
  });

  it('an unknown zone falls back to the UTC day rather than failing the page', () => {
    expect(spendDateOf(new Date('2026-08-31T18:10:00Z'), 'Mars/Olympus')).toBe('2026-08-31');
  });

  it('a report with no warehouse (filed from /profile) takes the office day, Tashkent', () => {
    // 2026-08-31 19:30Z = 2026-09-01 00:30 in Tashkent: September, where the
    // UTC day would still say August.
    expect(spendDateOf(new Date('2026-08-31T19:30:00Z'), null)).toBe('2026-09-01');
  });
});
