import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import { mayClassifyFx } from '@/modules/wms/finance/fx-door';

/**
 * F7 + F8 (0103, owner-4 and owner-6): who may say money is «kurs farqi»,
 * pinned on both sides of every door — the button that draws and the action
 * that obeys — and the legacy walk paid only where it is shown.
 */
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));
const slice = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  expect(start, from).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(to, start + from.length);
  return text.slice(start, end < 0 ? undefined : end);
};

describe('F7 — the classifier’s audience over the SEEDED roles', () => {
  // A composite of grants he edits with checkboxes: the honest question is
  // what each of his actual roles gets (the upsale-scope test's shape).
  const EXPECTED: Record<RoleCode, boolean> = {
    super_admin: true,
    admin: true,
    accountant: true,
    // finance.manage without finance.reports: types the correction, never its kind (Q19 B).
    ved_manager: false,
    logist: false,
    sales_manager: false,
    warehouse_manager: false,
    warehouse_operator: false,
    viewer: false,
  };
  for (const role of Object.keys(EXPECTED) as RoleCode[]) {
    it(role, () => {
      expect(mayClassifyFx(new Set<string>(ROLE_MATRIX[role]))).toBe(EXPECTED[role]);
    });
  }
});

describe('F7 — both sides of each door', () => {
  it('the partner form draws the kind only inside the classifier’s branch', () => {
    const form = read('src/app/(protected)/kontragentlar/[id]/tx-form.tsx');
    const branch = form.indexOf("{type === 'adjust' && mayClassify && (");
    expect(branch).toBeGreaterThan(0);
    const radio = form.indexOf('name="adjustKind"');
    expect(radio).toBeGreaterThan(branch);
    expect(form.indexOf('name="adjustKind"', radio + 1)).toBe(-1);
  });

  it('the actions pass the predicate, and the classify door asks it after authorize', () => {
    const actions = read('src/app/(protected)/kontragentlar/actions.ts');
    expect(slice(actions, 'export async function addPartnerTxAction', 'export async function setAdjustKindAction')).toContain(
      'mayClassify: mayClassifyFx(actor.permissions)',
    );
    const classify = slice(actions, 'export async function setAdjustKindAction', 'export async function voidPartnerTxAction');
    expect(classify).toContain('mayClassifyFx(actor.permissions) ?');
    expect(classify).toContain('mayClassify: mayClassifyFx(actor.permissions)');
    // `run` authorizes finance.manage first — the predicate adds finance.reports.
    expect(actions).toMatch(/async function run\([\s\S]*?authorize\('finance\.manage'\)/);
    const finance = read('src/app/(protected)/finance/actions.ts');
    expect(slice(finance, 'export async function closeFxResidueAction', 'export async function voidFxCloseAction')).toContain(
      '{ mayClassify: mayClassifyFx(actor.permissions) }',
    );
    const legacy = read('src/app/(protected)/accounting/kurs-farqi/actions.ts');
    expect(legacy).toMatch(/authorize\('finance\.manage'\);\s*if \(!mayClassifyFx\(actor\.permissions\)\)/);
  });

  it('every link to «Kurs qoldiqlari» is drawn on the predicate', () => {
    for (const [path, guard] of [
      ['src/app/(protected)/finance/[clientId]/page.tsx', '{mayClassify && legacy && ('],
      ['src/app/(protected)/kontragentlar/[id]/page.tsx', '{mayClassify && legacy && ('],
      ['src/app/(protected)/accounting/pnl-gaps.tsx', '{mayOpenFx && ('],
    ] as const) {
      const text = read(path);
      let at = text.indexOf('/accounting/kurs-farqi');
      expect(at, path).toBeGreaterThan(0);
      while (at >= 0) {
        expect(text.lastIndexOf(guard, at), `${path} @${at}`).toBeGreaterThan(-1);
        at = text.indexOf('/accounting/kurs-farqi', at + 1);
      }
    }
    expect(read('src/app/(protected)/accounting/kurs-farqi/page.tsx')).toContain('if (!mayClassifyFx(actor.permissions)) redirect');
    expect(read('src/app/(protected)/accounting/layout.tsx')).toMatch(
      /mayClassifyFx\(actor\.permissions\)\s*\?\s*\(\[\{ href: '\/accounting\/kurs-farqi'/,
    );
  });
});

describe('F8 — the legacy walk is paid only where it is shown (regression-8)', () => {
  it('legacyFxCount has two callers, and pnlGaps is not one', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return walk(path);
        return /\.(ts|tsx)$/.test(name) ? [path] : [];
      });
    const callers = walk('src')
      .filter((path) => !path.endsWith('finance/fx-legacy.ts'))
      .filter((path) => /legacyFxCount\(/.test(read(path)))
      .sort();
    expect(callers).toEqual([
      'src/app/(protected)/accounting/kurs-farqi/page.tsx',
      'src/app/(protected)/accounting/pnl/page.tsx',
    ]);
    const reports = read('src/modules/wms/accounting/reports.ts');
    expect(slice(reports, 'export async function pnlGaps', '\nexport ')).not.toContain('legacyFx');
  });
});
