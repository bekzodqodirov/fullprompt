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

describe('a person who never signs in (0120, his 2b)', () => {
  it('the list is the pure rule over every person, the due list’s «owed» included', () => {
    expect(page).toContain('visibleStaff(');
    expect(page).toContain('owedEmployeeIds(');
    expect(page).toContain('loginEnabled: users.loginEnabled');
  });

  it('a failed salary read is SAID — each read its own flag — and never reads «nobody has a salary»', () => {
    const templatesCatch = /staffTemplates\([^)]*\)\.catch\(\(err\) => \{([\s\S]*?)\}\)/.exec(page);
    const owedCatch = /owedEmployeeIds\([^)]*\)\.catch\(\(err\) => \{([\s\S]*?)\}\)/.exec(page);
    expect(templatesCatch, 'templates catch').not.toBeNull();
    expect(owedCatch, 'owed catch').not.toBeNull();
    expect(templatesCatch![1]).toContain('failed.salary = true');
    // The review's F3: «the leavers are shown too» is the OWED read's failure
    // alone — it sets its own flag and never the templates' one.
    expect(owedCatch![1]).toContain('failed.owed = true');
    expect(owedCatch![1]).not.toContain('failed.salary');
    expect(page).toMatch(/failed\.salary \|\| failed\.owed \? \(\s*<p[^>]*data-testid="hodimlar-salary-failed"/);
    expect(page).toMatch(/failed\.salary \? <span data-testid="hodimlar-templates-failed">\{t\('salaryFailed'\)\}/);
    expect(page).toMatch(/failed\.owed \? <span data-testid="hodimlar-owed-failed">\{t\('owedFailed'\)\}/);
    expect(page).toMatch(/const noSalaryYet = !failed\.salary &&/);
    // An owed failure does not hide «Oylik kiritish»: the templates were read.
    expect(page).toContain('salaryUnavailable={failed.salary}');
  });

  it('«Ketganlar (N)»: the way back to a leaver the list let go, on the whole page only (UI-2)', () => {
    expect(page).toMatch(/const leavers = hodim === null \? droppedLeavers\(people, new Set\(visible\.map/);
    expect(page).toMatch(/leavers\.length > 0 \? \(\s*<details[^>]*data-testid="hodimlar-leavers"/);
    expect(page).toMatch(/href=\{`\/hodimlar\?hodim=\$\{person\.id\}`\}[\s\S]{0,120}data-testid="hodimlar-leaver"/);
  });

  it('the card names it, and its tools hang on the same flag', () => {
    expect(card).toMatch(/!person\.loginEnabled \? \(\s*<span[^>]*data-testid="staff-no-login"/);
    expect(card).toMatch(/!person\.loginEnabled \? \(\s*<NoLoginPersonTools/);
    expect(card).toMatch(/!person\.loginEnabled \? \(\s*<NoLoginPersonActive/);
    expect(card).toMatch(/mayGiveLogin \? \(\s*<Link[\s\S]{0,200}data-testid="staff-enable-login"/);
  });

  it('no «Oylik kiritish» while the salary read is down; the fold opens where it was asked for', () => {
    expect(card).toMatch(/!salaryUnavailable && salary\.length === 0/);
    expect(card).toMatch(/data-testid="staff-salary-new" open=\{openSalaryForm\}/);
  });

  it('no «Oylik kiritish» on a leaver — the way back is named instead (the review’s F1)', () => {
    expect(card).toMatch(
      /!salaryUnavailable && salary\.length === 0 && person\.active && options\.categories\.length > 0 \? \(\s*<details data-testid="staff-salary-new"/,
    );
    expect(card).toMatch(
      /!salaryUnavailable && salary\.length === 0 && !person\.active \? \(\s*<p[^>]*data-testid="staff-salary-inactive"/,
    );
    expect(card).toContain("person.loginEnabled ? t('salaryInactiveLogin') : t('salaryInactive')");
    expect(page).toContain('openSalaryForm={hodim === person.id && person.active && !failed.salary}');
  });

  it('a same-name leaver is pointed at reactivation, never at «the salary goes on that card»', () => {
    const forms = strip(readFileSync('src/app/(protected)/hodimlar/forms.tsx', 'utf8'));
    expect(forms).toMatch(/\.some\(\(m\) => m\.active\) \? \(\s*<p[^>]*>\{t\('personSameNameAgain'\)\}/);
    expect(forms).toMatch(/\.some\(\(m\) => !m\.active\) \? \(\s*<p[^>]*data-testid="hodimlar-person-same-return"/);
  });
});

describe('the table editor edits the version in force THIS month', () => {
  it('prefilled from the current month’s version, never the viewed month’s', () => {
    expect(page).toContain('const editVersion = versionFor(versions, thisMonth);');
    expect(page).toMatch(/<KpiTableForm\s+tiers=\{editTops\.tiers\}/);
  });
});
