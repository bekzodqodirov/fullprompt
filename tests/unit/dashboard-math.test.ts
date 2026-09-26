import { describe, expect, it } from 'vitest';
import {
  dashboardWindows,
  monthEnd,
  niceTicks,
  pctDelta,
  planProgress,
  daysSince,
  rankAttention,
  tripKind,
  tripTotals,
} from '@/modules/wms/reports/dashboard-math';
import {
  agingTotals,
  balanceLines,
  unplacedCostsTakenOff,
  unpricedNotesCount,
  unpricedNotesDrawn,
} from '@/modules/wms/accounting/balance-lines';
import { compactUsd, pct, signedUsd, usd } from '@/components/charts/format';
import { tashkentDay } from '@/modules/platform/time/tashkent';

describe('dashboard windows', () => {
  it('compares the 31st of March with the 29th of February in a leap year', () => {
    const w = dashboardWindows('2028-03-31');
    expect(w.prevSameDay).toBe('2028-02-29');
    expect(w.prevStart).toBe('2028-02-01');
    expect(w.daysInMonth).toBe(31);
    expect(w.dom).toBe(31);
  });

  it('clamps the 31st of October to the 30th of September', () => {
    expect(dashboardWindows('2026-10-31').prevSameDay).toBe('2026-09-30');
  });

  it('crosses the year on the first of January, and twelve months start eleven back', () => {
    const w = dashboardWindows('2027-01-01');
    expect(w.prevMonth).toBe('2026-12');
    expect(w.prevSameDay).toBe('2026-12-01');
    expect(w.m12Start).toBe('2026-02-01');
    expect(w.nextMonthStart).toBe('2027-02-01');
  });

  it('is built from Tashkent’s day, not the server’s UTC one (R5)', () => {
    // 20:00 UTC on the 30th is already the 1st in Tashkent.
    const late = new Date('2026-09-30T20:00:00Z');
    expect(dashboardWindows(tashkentDay(late)).month).toBe('2026-10');
  });

  it('ends the current month at today and a past month at its last day', () => {
    expect(monthEnd('2026-09', '2026-09-12')).toBe('2026-09-12');
    expect(monthEnd('2026-02', '2026-09-12')).toBe('2026-02-28');
  });
});

describe('plan progress', () => {
  it('has no meter without a positive plan — «reja yo’q» is not a $0 plan', () => {
    expect(planProgress(500, null, 10, 30)).toBeNull();
    expect(planProgress(500, 0, 10, 30)).toBeNull();
    expect(planProgress(500, -2000, 10, 30)).toBeNull();
  });

  it('is behind when the fact trails the calendar’s share of the plan', () => {
    expect(planProgress(20_000, 90_000, 15, 30)).toMatchObject({ pct: 22.2, pace: 0.5, behind: true, done: false });
    expect(planProgress(50_000, 90_000, 15, 30)).toMatchObject({ behind: false });
    expect(planProgress(95_000, 90_000, 30, 30)).toMatchObject({ done: true, pct: 105.6 });
  });
});

describe('deltas and ticks', () => {
  it('prints no percentage against zero or a loss', () => {
    expect(pctDelta(100, 0)).toBeNull();
    expect(pctDelta(100, -50)).toBeNull();
    expect(pctDelta(112, 100)).toBe(12);
  });

  it('rounds the axis to clean steps', () => {
    expect(niceTicks(17_352)).toEqual({ ticks: [0, 5000, 10000, 15000, 20000], top: 20000 });
    expect(niceTicks(0)).toEqual({ ticks: [0], top: 1 });
  });
});

describe('attention ranking', () => {
  it('orders bad before warn, then by money, drops empty rows, and does not count info rows', () => {
    const ranked = rankAttention([
      { kind: 'a', level: 'warn', count: 5, usd: 100 },
      { kind: 'b', level: 'bad', count: 1, usd: 10 },
      { kind: 'c', level: 'warn', count: 2, usd: 900 },
      { kind: 'd', level: 'bad', count: 0, usd: 0 },
      { kind: 'e', level: 'info', count: 3 },
    ]);
    expect(ranked.visible.map((row) => row.kind)).toEqual(['b', 'c', 'a', 'e']);
    expect(ranked.visibleCount).toBe(3);
    expect(ranked.worst).toBe('bad');
  });

  it('folds past the visible limit', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ kind: `k${i}`, level: 'warn' as const, count: i + 1 }));
    const ranked = rankAttention(items, 7);
    expect(ranked.visible).toHaveLength(7);
    expect(ranked.hidden).toHaveLength(2);
  });
});

describe('trip kinds', () => {
  it('never draws an unpriced truck as a loss', () => {
    expect(tripKind({ internal: false, revenueUsd: 0, profitUsd: -1200 })).toBe('unpriced');
    expect(tripKind({ internal: false, revenueUsd: 900, profitUsd: -300 })).toBe('loss');
    expect(tripKind({ internal: true, revenueUsd: 0, profitUsd: null })).toBe('internal');
    expect(tripKind({ internal: false, revenueUsd: 900, profitUsd: 300 })).toBe('profit');
  });
});

describe('money formatting', () => {
  it('puts the sign before the dollar and compacts within seven characters', () => {
    expect(usd(-1875)).toBe('−$1,875');
    expect(signedUsd(4200)).toBe('+$4,200');
    expect(compactUsd(950)).toBe('$950');
    expect(compactUsd(12_400)).toBe('$12.4K');
    expect(compactUsd(1_240_000)).toBe('$1.24M');
    expect(compactUsd(-2_100)).toBe('−$2.1K');
    expect(compactUsd(124_500)).toBe('$124.5K');
    expect(compactUsd(999_999_999).length).toBeLessThanOrEqual(7);
    expect(pct(4.52)).toBe('4.5%');
    expect(pct(-27.4)).toBe('−27%');
  });
});

describe('trip totals — the profit page\'s JAMI and the dashboard strip', () => {
  const rows = [
    { internal: false, revenueUsd: 1000, costUsd: 700, profitUsd: 300, kg: 100 },
    { internal: false, revenueUsd: 500, costUsd: 600, profitUsd: -100, kg: 50 },
    // Unpriced: summed at −cost, exactly as the page does, and counted apart.
    { internal: false, revenueUsd: 0, costUsd: 400, profitUsd: -400, kg: 40 },
    // Internal: a cost row with no profit, already inside the export truck.
    { internal: true, revenueUsd: 0, costUsd: 250, profitUsd: null, kg: 30 },
  ];
  it('keeps internal legs out and counts unpriced trucks at −cost', () => {
    const t = tripTotals(rows);
    expect(t).toMatchObject({ trips: 3, revenue: 1500, cost: 1700, profit: -200, losses: 1, unpriced: 1, internal: 1 });
    expect(t.marginPct).toBe(-13.3);
    // Per kg over PRICED trucks only: (300 − 100) / 150.
    expect(t.perKg).toBe(1.33);
  });
  it('has no margin and no per-kg with nothing priced', () => {
    const t = tripTotals([{ internal: false, revenueUsd: 0, costUsd: 10, profitUsd: -10 }]);
    expect(t.marginPct).toBeNull();
    expect(t.perKg).toBeNull();
  });
});

describe('daysSince — Tashkent calendar days', () => {
  it('counts the day an instant falls on in Tashkent, not in UTC', () => {
    // 20:30 UTC on the 24th is 01:30 on the 25th in Tashkent: arrived today.
    expect(daysSince('2026-09-24T20:30:00Z', '2026-09-25')).toBe(0);
    expect(daysSince('2026-09-23T10:00:00Z', '2026-09-25')).toBe(2);
    expect(daysSince(null, '2026-09-25')).toBe(0);
    // A date after today (a clock skew) is never a negative wait.
    expect(daysSince('2026-09-27T10:00:00Z', '2026-09-25')).toBe(0);
  });
});

describe('the Balans lines, one home for two screens', () => {
  const base = {
    cashUsd: 1000,
    unplacedUsd: 0,
    unplacedCount: 0,
    receivableUsd: 500,
    partnerReceivableUsd: 0,
    payableUsd: 300,
    clientAdvancesUsd: 0,
    unplacedCostCount: 0,
    unplacedCostUsd: 0,
    unplacedCostInCountCount: 0,
    unplacedCostInCountUsd: 0,
    sellerCommissionsUsd: 0,
    recurringArrearsUsd: 0,
    recurringArrearsCount: 0,
    unpricedCargoUsd: 0,
  };
  // REQUIRED since U03: an optional href fell back to a page some viewers bounce off.
  const hrefs = { cash: '/accounting/accounts', cargo: '#balance-unpriced' };
  it('leaves out the lines that are empty by nature and signs what we owe', () => {
    expect(balanceLines(base, hrefs).map((l) => [l.key, l.value])).toEqual([
      ['balCash', 1000],
      ['balReceivable', 500],
      ['balPartnerReceivable', 0],
      ['balPayable', -300],
    ]);
  });
  it('adds the unplaced payments and the advances when there are any', () => {
    const lines = balanceLines({ ...base, unplacedCount: 2, unplacedUsd: 80, clientAdvancesUsd: 40 }, { ...hrefs, cash: '/accounting/balance' });
    expect(lines.find((l) => l.key === 'balUnplaced')?.value).toBe(80);
    expect(lines.find((l) => l.key === 'balClientAdvances')?.value).toBe(-40);
    expect(lines[0]?.href).toBe('/accounting/balance');
  });
  it('subtracts the kassa-less cargo costs and the owed commissions as lines of their own (U02, U10)', () => {
    const lines = balanceLines({ ...base, unplacedCostCount: 1, unplacedCostUsd: 350, sellerCommissionsUsd: 600 }, hrefs);
    expect(lines.find((l) => l.key === 'balUnplacedCostsLine')).toMatchObject({
      value: -350,
      href: '/accounting/xarajat-kassa',
    });
    expect(lines.find((l) => l.key === 'balSellerCommissions')).toMatchObject({ value: -600, href: '/upsale' });
    // Nothing waiting, nothing owed: no permanent $0 lines.
    expect(balanceLines(base, hrefs).some((l) => l.key === 'balUnplacedCostsLine' || l.key === 'balSellerCommissions')).toBe(false);
  });
  it('the cost line is what the net took off — not the part every kassa count already holds (#528)', () => {
    const queue = { ...base, unplacedCostCount: 3, unplacedCostUsd: 650, unplacedCostInCountCount: 1, unplacedCostInCountUsd: 300 };
    expect(unplacedCostsTakenOff(queue)).toEqual({ count: 2, usd: 350 });
    expect(balanceLines(queue, hrefs).find((l) => l.key === 'balUnplacedCostsLine')?.value).toBe(-350);
    // Every queued cost inside the counts: nothing taken off, no $0 line.
    const allCounted = { ...queue, unplacedCostInCountCount: 3, unplacedCostInCountUsd: 650 };
    expect(balanceLines(allCounted, hrefs).some((l) => l.key === 'balUnplacedCostsLine')).toBe(false);
  });
  it('subtracts the due, unpaid rent and salaries on a line of their own, and none when nothing is due (owner Q6)', () => {
    const lines = balanceLines({ ...base, recurringArrearsCount: 2, recurringArrearsUsd: 1300 }, hrefs);
    expect(lines.find((l) => l.key === 'balRecurringArrears')).toMatchObject({
      value: -1300,
      href: '/accounting/expenses#recurring',
      tone: 'text-bad',
    });
    expect(balanceLines(base, hrefs).some((l) => l.key === 'balRecurringArrears')).toBe(false);
  });
  it('adds the money spent on cargo not priced yet right after the receivable, as an asset (U03, owner Q16 A)', () => {
    const lines = balanceLines({ ...base, unpricedCargoUsd: 1234.5 }, { ...hrefs, cargo: '/accounting/balance#balance-unpriced' });
    const keys = lines.map((l) => l.key);
    expect(keys.indexOf('balUnpricedCargo')).toBe(keys.indexOf('balReceivable') + 1);
    // text-good like every other asset line: most of it is cargo on the road
    // nobody can price before rastamojka, and a permanent orange line teaches
    // the owner to ignore orange.
    expect(lines.find((l) => l.key === 'balUnpricedCargo')).toEqual({
      key: 'balUnpricedCargo',
      value: 1234.5,
      tone: 'text-good',
      href: '/accounting/balance#balance-unpriced',
    });
    // Nothing spent on unpriced cargo: no permanent $0 line.
    expect(balanceLines(base, hrefs).some((l) => l.key === 'balUnpricedCargo')).toBe(false);
  });
  it('counts the notes the Balans card prints beside the arithmetic — the dashboard\'s one line (U03)', () => {
    const quiet = {
      grossUsd: 900,
      cardUsd: 0,
      elsewhereUsd: 0,
      unclaimed: { usd: 0 },
      oldNoKassa: { count: 0 },
      tillUnrated: { count: 0 },
      noDebt: { count: 0 },
      pickupNoBox: { count: 0 },
      noBox: { count: 0 },
      unconverted: 0,
      gate: 'on' as const,
    };
    // Arithmetic alone is the card, not a note.
    expect(unpricedNotesCount(quiet)).toBe(0);
    expect(unpricedNotesDrawn(quiet)).toBe(true);
    expect(unpricedNotesDrawn({ ...quiet, grossUsd: 0 })).toBe(false);
    expect(unpricedNotesCount({ ...quiet, cardUsd: 50, oldNoKassa: { count: 2 }, gate: 'off' })).toBe(3);
    // A left-out figure alone draws the card even with nothing on the line.
    expect(unpricedNotesDrawn({ ...quiet, grossUsd: 0, unclaimed: { usd: 340 } })).toBe(true);
  });
  it('sums the aging buckets the receivables page prints', () => {
    expect(
      agingTotals([
        { balance: 100, buckets: [100, 0, 0, 0] },
        { balance: 50, buckets: [0, 20, 0, 30] },
      ]),
    ).toEqual({ balance: 150, buckets: [100, 20, 0, 30] });
  });
});
