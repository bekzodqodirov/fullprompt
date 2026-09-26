import { describe, expect, it } from 'vitest';
import { tillUsd } from '@/modules/wms/costing/service';
import { apportionUsd } from '@/modules/wms/accounting/cost-merge';
import { cashMonthParts, pnlMonthParts } from '@/modules/wms/reports/dashboard-math';

/**
 * The pure halves of «Kurs farqi (kassa)» (0103): the kassa side's dollars,
 * a merge's dollar shares, and the dashboard's parts that must add up to the
 * net they sit beside (the owner judge's finding).
 */
describe('tillUsd — what left a kassa of another currency, in dollars', () => {
  it('a dollar kassa is its own amount at rate 1', () => {
    expect(tillUsd('USD', 2850, null)).toEqual({ usd: 2850, rate: 1 });
  });
  it('another currency converts at the kassa currency\'s rate', () => {
    expect(tillUsd('ZKB', 1_352_000, 0.000076923077)).toEqual({ usd: 104, rate: 0.000076923077 });
  });
  it('no rate yet → null (the nightly sweep fills it once), never a guess', () => {
    expect(tillUsd('ZKC', 2_600_000, null)).toBeNull();
    expect(tillUsd('ZKC', 2_600_000, 0)).toBeNull();
  });
});

describe('apportionUsd — a merge\'s kassa dollars add up to the expense\'s to the cent', () => {
  it('three shares of a $1,000 expense', () => {
    const shares = apportionUsd([3_333_333.33, 3_333_333.33, 3_333_333.34], { amount: 10_000_000, amountUsd: 1000 });
    expect(shares).toEqual([333.33, 333.33, 333.34]);
    expect(Math.round(shares.reduce((a, b) => a + b, 0) * 100) / 100).toBe(1000);
  });
  it('an odd split still closes on the expense\'s dollars (the last share takes the remainder)', () => {
    const shares = apportionUsd([1, 1, 1], { amount: 3, amountUsd: 0.1 });
    expect(Math.round(shares.reduce((a, b) => a + b, 0) * 100) / 100).toBe(0.1);
  });
});

describe('the dashboard\'s parts add up to its net (0103)', () => {
  const row = (month: string, value: number) => ({ byPeriod: { [month]: value } });
  it('P&L: the kurs farqi folds into the cost bar — revenue − cost = net', () => {
    const m = '1611-02';
    const parts = pnlMonthParts(
      {
        revenue: row(m, 10_000),
        directTotal: row(m, 6000),
        opexTotal: row(m, 1000),
        fxTotal: row(m, -50),
        netProfit: row(m, 2950),
      },
      m,
    );
    expect(parts.cost).toBe(7050);
    expect(parts.revenue - parts.cost).toBe(parts.net);
    const gain = pnlMonthParts(
      { revenue: row(m, 100), directTotal: row(m, 80), opexTotal: row(m, 0), fxTotal: row(m, 20), netProfit: row(m, 40) },
      m,
    );
    expect(gain.revenue - gain.cost).toBe(gain.net);
  });
  it('cash flow: every line, the exchange and unrated rows included, adds up to the net', () => {
    const parts = cashMonthParts({
      clientPayments: 5000,
      partnerIn: 100,
      fxGain: 200,
      cargoCosts: 2800,
      cargoUnrated: 50,
      fxLoss: 37.04,
      partnerOut: 300,
      clientRefunds: 10,
      cashOpex: 1000,
      net: 1102.96,
    });
    const sum = Math.round(parts.lines.reduce((a, line) => a + line.value, 0) * 100) / 100;
    expect(sum).toBe(parts.net);
  });
});
