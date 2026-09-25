import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePeriod } from '@/modules/wms/accounting/period';
import { latestTxDate } from '@/modules/wms/finance/dates';
import { calendarDay } from '@/modules/platform/time/tashkent';

/**
 * R5 (owner's answer a): the money screens' «today» is Tashkent's. The server
 * runs in UTC, so at 01:00 on 1 October in Tashkent (20:00 UTC on the 30th)
 * the old code still answered 30 September — a payment typed then was filed
 * in last month's P&L, and on 1 January before 05:00 the P&L's default
 * period was still last year's.
 */
const SMALL_HOURS = new Date('2026-09-30T20:00:00Z');

describe("money defaults in Tashkent's first five hours", () => {
  it("the accounting period runs to Tashkent's today, from its year's January", () => {
    expect(resolvePeriod({}, SMALL_HOURS)).toEqual({ from: '2026-01-01', to: '2026-10-01' });
    // 19:00 UTC on New Year's Eve is midnight in Tashkent: the office is in
    // 2027 while UTC is still in 2026.
    expect(resolvePeriod({}, new Date('2026-12-31T19:00:00Z'))).toEqual({
      from: '2027-01-01',
      to: '2027-01-01',
    });
    // A typed period is obeyed whatever the clock says.
    expect(resolvePeriod({ from: '2026-02-01', to: '2026-02-28' }, SMALL_HOURS)).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
  });

  it('an impossible calendar day in the URL is DROPPED, never sent to postgres (U43)', () => {
    // 2026 is not a leap year: 22008 on every report and export before.
    expect(resolvePeriod({ from: '2026-02-01', to: '2026-02-30' }, SMALL_HOURS)).toEqual({
      from: '2026-02-01',
      to: '2026-10-01',
    });
    expect(resolvePeriod({ from: '2026-02-01', to: '2026-02-29' }, SMALL_HOURS).to).toBe('2026-10-01');
    expect(resolvePeriod({ from: '2028-02-01', to: '2028-02-29' }, SMALL_HOURS).to).toBe('2028-02-29');
    // Year 0000 round-trips through V8 and postgres refuses it.
    expect(resolvePeriod({ from: '0000-01-01', to: '2026-02-28' }, SMALL_HOURS).from).toBe('2026-01-01');
    // The backwards range still swaps.
    expect(resolvePeriod({ from: '2026-03-01', to: '2026-02-01' }, SMALL_HOURS)).toEqual({
      from: '2026-02-01',
      to: '2026-03-01',
    });
  });

  it('calendarDay keeps real days and drops the rest', () => {
    for (const day of ['2026-02-28', '2028-02-29', '1700-01-01', '9999-12-31']) {
      expect(calendarDay(day), day).toBe(day);
    }
    for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-01-32', '0000-01-01', 'abc', '']) {
      expect(calendarDay(bad), bad).toBeNull();
    }
    expect(calendarDay(undefined)).toBeNull();
    expect(calendarDay(null)).toBeNull();
  });

  it("the ledger's latest date is Tashkent's today plus the one day of grace", () => {
    // Tashkent is already on the 1st (UTC still on the 30th); the grace —
    // China is three hours further ahead — allows the 2nd and not the 3rd.
    expect(latestTxDate(SMALL_HOURS)).toBe('2026-10-02');
    expect(latestTxDate(new Date('2026-09-30T18:59:00Z'))).toBe('2026-10-01');
  });
});

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('batch pricing posts a visible Tashkent date (audit A13)', () => {
  const form = read('src/app/(protected)/batches/[id]/pricing/pricing-form.tsx');
  const page = read('src/app/(protected)/batches/[id]/pricing/page.tsx');

  it('the charge date is a date input the person can see, not a hidden stamp', () => {
    expect(form).not.toMatch(/type="hidden"\s+name="txDate"/);
    expect(form).toMatch(/name="txDate"\s+type="date"/);
  });

  it("the page seeds it with Tashkent's day", () => {
    expect(page).toContain('const today = tashkentDay();');
    expect(page).not.toContain('new Date().toISOString().slice(0, 10)');
  });
});

/**
 * The derived fence: a NEW «today» read off the UTC clock is the defect this
 * round removed from ~60 places, and it compiles, renders and passes every
 * test written in the daytime. Comments are stripped first — the helper's own
 * explanation quotes the forbidden expression (#725).
 */
describe('no UTC «today» outside the deliberate exceptions', () => {
  // Deliberately UTC, stated in the R5 brief: the backup file stamp, and the
  // task calendar, whose all-day convention (23:59:59.999Z, round 47) moves
  // only with a data migration of every all-day task.
  const ALLOWED = new Set(['src/modules/platform/backup/run.ts', 'src/app/(protected)/kalendar/page.tsx']);
  const UTC_TODAY = /new Date\(\)\.toISOString\(\)\.slice\(0, (?:7|10)\)/;
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === 'migrations' ? [] : walk(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });

  it('finds none', () => {
    const offenders = walk(path.join(ROOT, 'src'))
      .map((full) => path.relative(ROOT, full))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => UTC_TODAY.test(strip(read(rel))));
    expect(offenders).toEqual([]);
  });

  it('still sees the exceptions it allows (the fence is not blind)', () => {
    for (const rel of ALLOWED) expect(UTC_TODAY.test(strip(read(rel)))).toBe(true);
  });
});
