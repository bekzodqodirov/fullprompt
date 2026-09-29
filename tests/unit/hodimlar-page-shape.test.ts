import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * /hodimlar's degraded paths (0117's fixer round). Each is a page that
 * RENDERS — and renders the wrong thing only when a read fails or a list is
 * cut, which no happy-path test reaches — so the shape is pinned here.
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const page = strip(readFileSync('src/app/(protected)/hodimlar/page.tsx', 'utf8'));
const card = strip(readFileSync('src/app/(protected)/hodimlar/staff-card.tsx', 'utf8'));
const upsalePage = strip(readFileSync('src/app/(protected)/upsale/page.tsx', 'utf8'));

describe('a KPI read that ran out of its budget is SAID, never a missing section', () => {
  it('the card’s flag does not hang on the maps the failure emptied', () => {
    const prop = /kpiUnavailable=\{([^}]*)\}/.exec(page);
    expect(prop, 'kpiUnavailable prop on StaffCard').not.toBeNull();
    expect(prop![1]).toContain('failed.kpi');
    expect(prop![1]).not.toMatch(/kpiLines|payables/);
  });

  it('the card draws the KPI block on the flag alone', () => {
    const show = /const showKpi =([\s\S]*?);/.exec(card);
    expect(show).not.toBeNull();
    expect(show![1]).toMatch(/^\s*kpiUnavailable \|\|/);
  });

  it('the page says it once, above the cards', () => {
    expect(page).toMatch(/failed\.kpi \? \(\s*<p[^>]*data-testid="hodimlar-kpi-failed"/);
  });

  it('both heavy reads carry a budget for the WHOLE read, not per statement', () => {
    expect(page.match(/deadlineMs: KPI_BUDGET_MS/g)?.length).toBe(2);
    expect(page).not.toMatch(/timeoutMs:/);
  });
});

describe('the upsale column is never a silently cut list', () => {
  it('one person asked for is one seller’s offers', () => {
    expect(page).toMatch(/upsaleRows\('all', actor\.id, \{[\s\S]{0,120}?sellerId: hodim \?\? undefined/);
  });

  it('a cut list is said on the page', () => {
    expect(page).toMatch(/upsale\?\.truncated \?/);
  });

  // His 3a: «to'lanadi» comes from the ONE per-seller fold /upsale reads too,
  // and a seller whose jobs the walk could not finish says so on the card —
  // never a short figure that looks whole (the KPI's own per-card pattern).
  it('the card’s upsale is the shared fold, and its unknown is said on the card', () => {
    expect(page).toContain('bySeller(');
    expect(page).not.toContain("row.state === 'payable'");
    expect(card).toMatch(/upsale\.notComputed > 0 \? \(\s*<span[^>]*data-testid="staff-upsale-unknown"/);
    expect(page).toMatch(/upsale\?\.rows\.some\(\(r\) => r\.state === 'not_computed'\) \? \(\s*<p[^>]*data-testid="hodimlar-upsale-not-computed"/);
  });
});

describe('a link is drawn only where its page admits the reader', () => {
  it('/upsale links to /hodimlar only for the payroll door', () => {
    expect(upsalePage).toMatch(/scope === 'all' && maySeeStaffMoney\(actor\.permissions\) \?/);
  });
});

describe('the table editor edits the version in force THIS month', () => {
  it('prefilled from the current month’s version, never the viewed month’s', () => {
    expect(page).toContain('const editVersion = versionFor(versions, thisMonth);');
    expect(page).toMatch(/<KpiTableForm\s+tiers=\{editTops\.tiers\}/);
  });
});
