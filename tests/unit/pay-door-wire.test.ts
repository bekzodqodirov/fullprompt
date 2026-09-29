import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Two doors pay a seller — the upsale's and the KPI's — and both ask ONE
 * predicate (0117, staff/door.ts `mayPayCommission`), so they cannot
 * disagree about who may press. Source shape because both actions call
 * `getActor`, which no integration test can press (#531); comments stripped
 * (#725).
 */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const bodyOf = (source: string, name: string) => {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const next = source.indexOf('export async function', start + 10);
  return source.slice(start, next === -1 ? undefined : next);
};

describe('both pay actions ask mayPayCommission', () => {
  it('the upsale payout', () => {
    expect(bodyOf(code('src/app/(protected)/upsale/actions.ts'), 'payUpsaleAction')).toContain(
      'if (!mayPayCommission(actor))',
    );
  });

  it('the KPI payout', () => {
    expect(bodyOf(code('src/app/(protected)/hodimlar/actions.ts'), 'payKpiAction')).toContain(
      'if (!mayPayCommission(actor))',
    );
  });

  it('the predicate is the PAIR — the kassa AND the upsale’s whole audience', () => {
    const door = code('src/modules/wms/staff/door.ts');
    expect(door).toMatch(/actor\.permissions\.has\('finance\.expenses'\) && upsaleScopeFor\(actor\) === 'all'/);
  });

  it('the page draws «KPI to’lash» for exactly the people the action admits', () => {
    const page = code('src/app/(protected)/hodimlar/page.tsx');
    expect(page).toContain('const mayPay = mayPayCommission(actor);');
    expect(page).toContain('if (!maySeeStaffMoney(actor.permissions)) redirect(');
  });

  it('the table and the two categories are the settings power', () => {
    const actions = code('src/app/(protected)/hodimlar/actions.ts');
    expect(bodyOf(actions, 'saveKpiTableAction')).toContain('if (!mayEditKpiTable(actor))');
    expect(bodyOf(actions, 'setStaffCategoryAction')).toContain('if (!mayEditKpiTable(actor))');
  });
});
