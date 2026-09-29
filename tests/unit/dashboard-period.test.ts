import { describe, expect, it } from 'vitest';
import {
  DASH_PERIODS,
  dashboardWindows,
  dashPeriod,
  niceTicks,
  planPace,
  pnlMonthParts,
  pnlParts,
  signedTicks,
  weeksBetween,
} from '@/modules/wms/reports/dashboard-math';

/**
 * The dashboard's period arithmetic (Round B, the money package): the radio's
 * five windows and what each is compared with, the weekly and 30-day windows,
 * the plan's pace, the signed axis and the «Xarajat» parts. All pure — every
 * figure is still the report's own; this only decides the windows and the
 * sums the screen prints beside it.
 */

describe('the dashboard windows grow a week, twelve weeks and thirty days', () => {
  it('on Sunday 27 September 2026', () => {
    const w = dashboardWindows('2026-09-27');
    expect(w.weekStart).toBe('2026-09-21');
    expect(w.w12Start).toBe('2026-07-06');
    expect(w.d30Start).toBe('2026-08-29');
    // Twelve weeks, this one included, and thirty days with today last.
    expect(weeksBetween(w.w12Start, w.today)).toHaveLength(12);
    expect(weeksBetween(w.w12Start, w.today).at(-1)).toBe(w.weekStart);
  });

  it('on a Monday the week starts today', () => {
    const w = dashboardWindows('2026-09-21');
    expect(w.weekStart).toBe('2026-09-21');
    expect(w.w12Start).toBe('2026-07-06');
  });
});

describe('weeksBetween — the weekly chart\'s keys', () => {
  it('ISO Mondays from the week of `from` to the week of `to`, both clipped weeks kept', () => {
    // 1657-07-01 is a Sunday, so its week began on 06-25; 07-31 is a Tuesday.
    expect(weeksBetween('1657-07-01', '1657-07-31')).toEqual([
      '1657-06-25',
      '1657-07-02',
      '1657-07-09',
      '1657-07-16',
      '1657-07-23',
      '1657-07-30',
    ]);
  });
  it('one day is one week, a backwards range is none', () => {
    expect(weeksBetween('2026-09-23', '2026-09-23')).toEqual(['2026-09-21']);
    expect(weeksBetween('2026-09-30', '2026-09-01')).toEqual([]);
  });
});

describe('dashPeriod — the radio is a closed set, each window compared by the P&L page\'s rule', () => {
  it('draws the six in order', () => {
    expect(DASH_PERIODS).toEqual(['bugun', '7', 'hafta', '30', 'oy', 'otgan']);
  });

  it('anything but the six reads as «Bu oy»', () => {
    for (const raw of [undefined, null, '', '07', 'OY', 'xx', ' oy', 'toString', '__proto__', '31']) {
      expect(dashPeriod(raw, '2026-09-27').key, String(raw)).toBe('oy');
    }
  });

  it('«Bu oy» is the month to date, against the same days of the month before', () => {
    expect(dashPeriod('oy', '2026-09-27')).toEqual({
      key: 'oy',
      from: '2026-09-01',
      to: '2026-09-27',
      prior: { from: '2026-08-01', to: '2026-08-27', kind: 'monthToDate' },
      month: '2026-09',
      closedMonth: false,
      dom: 27,
      daysInMonth: 30,
    });
    // On its last day it is a whole month, read against the whole month before.
    expect(dashPeriod('oy', '2026-09-30').prior).toEqual({ from: '2026-08-01', to: '2026-08-31', kind: 'wholeMonth' });
    // January keeps the P&L page's year rule (the owner's default).
    expect(dashPeriod('oy', '2026-01-27').prior).toEqual({ from: '2025-01-01', to: '2025-01-27', kind: 'year' });
  });

  it('«O\'tgan oy» seen in January is December, whole, against the whole November', () => {
    expect(dashPeriod('otgan', '2026-01-15')).toEqual({
      key: 'otgan',
      from: '2025-12-01',
      to: '2025-12-31',
      prior: { from: '2025-11-01', to: '2025-11-30', kind: 'wholeMonth' },
      month: '2025-12',
      closedMonth: true,
      dom: 31,
      daysInMonth: 31,
    });
    // Seen in October: September 1–30 against August 1–31, the 31st no longer dropped.
    expect(dashPeriod('otgan', '2026-10-05').prior).toEqual({ from: '2026-08-01', to: '2026-08-31', kind: 'wholeMonth' });
    // Seen in February: a whole January keeps the year rule, as on the P&L page.
    const feb = dashPeriod('otgan', '2026-02-10');
    expect([feb.from, feb.to, feb.prior.kind]).toEqual(['2026-01-01', '2026-01-31', 'year']);
  });

  it('«Bugun» is today alone — on the 1st the P&L page\'s rule reads the 1st before, printed as dates', () => {
    expect(dashPeriod('bugun', '2026-10-01')).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-01',
      prior: { from: '2026-09-01', to: '2026-09-01', kind: 'monthToDate' },
      month: null,
      closedMonth: false,
    });
    expect(dashPeriod('bugun', '2026-10-02').prior).toEqual({ from: '2026-10-01', to: '2026-10-01', kind: 'span' });
  });

  it('«O\'tgan hafta» is the whole week that ENDED, Monday to Sunday — the same seen from any day of this one', () => {
    // Monday 2026-09-28: the week of 21–27; Sunday 2026-10-04 still reads it.
    for (const today of ['2026-09-28', '2026-10-01', '2026-10-04']) {
      expect(dashPeriod('hafta', today), today).toMatchObject({
        key: 'hafta',
        from: '2026-09-21',
        to: '2026-09-27',
        prior: { from: '2026-09-14', to: '2026-09-20', kind: 'span' },
        month: null,
        closedMonth: false,
      });
    }
    // Across a year: the week of Monday 2025-12-29 ends on 2026-01-04.
    expect(dashPeriod('hafta', '2026-01-07')).toMatchObject({ from: '2025-12-29', to: '2026-01-04' });
  });

  it('«7» and «30» end today and include it', () => {
    expect(dashPeriod('7', '2026-09-27')).toMatchObject({
      from: '2026-09-21',
      to: '2026-09-27',
      prior: { from: '2026-09-14', to: '2026-09-20', kind: 'span' },
      month: null,
    });
    expect(dashPeriod('30', '2026-09-27')).toMatchObject({
      from: '2026-08-29',
      to: '2026-09-27',
      prior: { from: '2026-07-30', to: '2026-08-28', kind: 'span' },
      month: null,
    });
  });
});

describe('planPace — what a live month still needs a day', () => {
  it('counts today among the days left: the 27th of 30 leaves 4', () => {
    expect(planPace(51_000, 60_000, 27, 30)).toEqual({ daysLeft: 4, perDay: 2250 });
    expect(planPace(0, 31_000, 1, 31)).toEqual({ daysLeft: 31, perDay: 1000 });
    expect(planPace(100, 400, 30, 30)).toEqual({ daysLeft: 1, perDay: 300 });
  });
  it('has no pace without a positive plan, or once the plan is met', () => {
    expect(planPace(500, null, 10, 30)).toBeNull();
    expect(planPace(500, undefined, 10, 30)).toBeNull();
    expect(planPace(500, 0, 10, 30)).toBeNull();
    expect(planPace(500, -2000, 10, 30)).toBeNull();
    expect(planPace(60_000, 60_000, 27, 30)).toBeNull();
    expect(planPace(Number.NaN, 60_000, 27, 30)).toBeNull();
  });
});

describe('signedTicks — an axis for a line that goes below zero', () => {
  it('a loss month and a profit month on one clean scale that holds zero', () => {
    const axis = signedTicks(-1200, 5300);
    expect(axis).toEqual({ ticks: [-2000, 0, 2000, 4000, 6000], bottom: -2000, top: 6000 });
    expect(axis.bottom).toBeLessThanOrEqual(-1200);
    expect(axis.top).toBeGreaterThanOrEqual(5300);
  });
  it('nothing below zero answers exactly what niceTicks does', () => {
    const plain = niceTicks(17_352);
    expect(signedTicks(0, 17_352)).toEqual({ ticks: plain.ticks, bottom: 0, top: plain.top });
    expect(signedTicks(4000, 17_352)).toEqual({ ticks: plain.ticks, bottom: 0, top: plain.top });
  });
  it('an all-loss year ends at a +0 top, never −0', () => {
    const axis = signedTicks(-500, -100);
    expect(axis).toEqual({ ticks: [-600, -400, -200, 0], bottom: -600, top: 0 });
    expect(Object.is(axis.top, 0)).toBe(true);
  });
  it('no float drift adds a step, and an empty year is the flat axis', () => {
    expect(signedTicks(-0.1, 0.3)).toEqual({ ticks: [-0.1, 0, 0.1, 0.2, 0.3], bottom: -0.1, top: 0.3 });
    // 0.1 + 0.2 is 0.30000000000000004: one division must not buy a fourth step.
    expect(signedTicks(0, 0.1 + 0.2)).toEqual({ ticks: [0, 0.1, 0.2, 0.3], bottom: 0, top: 0.3 });
    expect(signedTicks(0, 0)).toEqual({ ticks: [0], bottom: 0, top: 1 });
    expect(signedTicks(Number.NaN, Number.NaN)).toEqual({ ticks: [0], bottom: 0, top: 1 });
  });
});

describe('pnlParts — the ONE «Xarajat»: direct + opex − kurs farqi, so revenue − cost = net', () => {
  // Two months, and range totals that are the P&L's own (its `.total`).
  const row = (a: number, b: number, total = a + b) => ({ byPeriod: { '1657-06': a, '1657-07': b }, total });
  const pnl = {
    revenue: row(10_000, 4_000),
    directTotal: row(6_000, 2_500),
    opexTotal: row(1_000, 700),
    fxTotal: row(-50, 120),
    netProfit: row(2_950, 920),
  };

  it('the whole range reads each row\'s total, the kurs farqi folded into the cost', () => {
    const parts = pnlParts(pnl, 'total');
    expect(parts).toEqual({ revenue: 14_000, direct: 8_500, opex: 1_700, fx: 70, cost: 10_130, net: 3_870 });
    expect(parts.revenue - parts.cost).toBeCloseTo(parts.net, 2);
  });

  it('a month reads its own column, and pnlMonthParts is the same function', () => {
    const june = pnlParts(pnl, '1657-06');
    expect(june).toEqual({ revenue: 10_000, direct: 6_000, opex: 1_000, fx: -50, cost: 7_050, net: 2_950 });
    expect(june.revenue - june.cost).toBeCloseTo(june.net, 2);
    expect(pnlMonthParts(pnl, '1657-07')).toEqual(pnlParts(pnl, '1657-07'));
    // A month outside the P&L is zeros, never undefined.
    expect(pnlParts(pnl, '1657-08')).toEqual({ revenue: 0, direct: 0, opex: 0, fx: 0, cost: 0, net: 0 });
  });

  it('«total» is the P&L\'s own figure, not a re-sum of its rounded months', () => {
    const odd = { ...pnl, netProfit: row(2_950, 920, 3_870.01) };
    expect(pnlParts(odd, 'total').net).toBe(3_870.01);
  });
});
