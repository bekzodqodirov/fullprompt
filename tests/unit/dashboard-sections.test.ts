import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dayRange, shortDay } from '@/app/(protected)/dashboard/sections/day-format';

/**
 * Round B's dashboard, pinned where behaviour cannot see it (source shape) and
 * where it can (the date words). The money gate itself is pinned in
 * money-reader-fence.test.ts; the rules here are the ones a later edit to one
 * card would break silently on another.
 */

const read = (path: string) => readFileSync(path, 'utf8');
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SECTIONS = 'src/app/(protected)/dashboard/sections';

describe('the comparison window is printed as dates (judge O1)', () => {
  it('drops the year only for this year', () => {
    expect(shortDay('2026-08-01', '2026-09-27')).toBe('01.08');
    expect(shortDay('2025-01-01', '2026-01-15')).toBe('01.01.2025');
  });

  it('prints one day once and a range with both ends', () => {
    expect(dayRange('2026-09-26', '2026-09-26', '2026-09-27')).toBe('26.09');
    expect(dayRange('2026-08-01', '2026-08-26', '2026-09-27')).toBe('01.08 – 26.08');
  });
});

describe('every chart on the dashboard has its table twin', () => {
  it('a section file drawing a chart also renders a TableTwin', () => {
    const charts = /<(AreaLine|MirrorColumns|DayColumns|ColumnPairs)\b/;
    const files = globSync(`${SECTIONS}/*.tsx`);
    expect(files.length).toBeGreaterThan(4);
    for (const path of files) {
      const source = strip(read(path));
      if (!charts.test(source)) continue;
      expect(source, path).toContain('<TableTwin');
    }
  });
});

describe('the trucks are ranked once, and three places read that one ranking', () => {
  it('the trucks card, the stock tile and the attention row read loadTrucks, never inTransitBatches', () => {
    for (const file of ['cargo.tsx', 'hero.tsx', 'attention.tsx']) {
      const source = strip(read(`${SECTIONS}/${file}`));
      expect(source, file).not.toMatch(/inTransitBatches|loadTransit\b/);
    }
    expect(strip(read(`${SECTIONS}/attention.tsx`))).toContain('trucks.counts.stuck');
    expect(strip(read(`${SECTIONS}/cargo.tsx`))).toContain('loadTrucks(scopeKey)');
  });
});

describe('the period and the warehouse are the page’s two questions', () => {
  it('period words are a literal map in every file that prints them (#163)', () => {
    for (const path of globSync(`${SECTIONS}/*.tsx`)) {
      const source = strip(read(path));
      expect(source, path).not.toMatch(/t\(`(period|hero|truckStage|truckKind|level)\./);
    }
  });

  it('the warehouse comes through the shared scope rule, validated against the viewer’s own options', () => {
    const page = strip(read('src/app/(protected)/dashboard/page.tsx'));
    expect(page).toContain('const scope = reportScope(actor, params.ombor, options);');
    expect(page).toContain('const options = await loadWarehouseOptions(scopeKeyOf(base.baseIds));');
    // The list of trucks with no cost is company-wide: never under a warehouse.
    expect(page).toContain('const seesCostMissing = allWh && !scope.scoped && seesBatches && !company;');
  });

  it('the money cards say «Butun kompaniya» while a warehouse is chosen', () => {
    for (const file of ['hero.tsx', 'money.tsx', 'sales.tsx']) {
      expect(strip(read(`${SECTIONS}/${file}`)), file).toContain("t('scope.company')");
    }
  });
});

describe('the fixed windows the cards name', () => {
  it('the truck cells of «Bugun» are drawn only for a viewer who may open a truck (O26)', () => {
    const cargo = strip(read(`${SECTIONS}/cargo.tsx`));
    expect(cargo).toContain("{seesBatches && <TodayCell label={t('todayDeparted')}");
    expect(cargo).toContain("{seesBatches && <TodayCell label={t('todayArrived')}");
  });
});
