import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The halves of the unpriced-cargo ban (0104) that call `authorize()` or live
 * in a component, and so cannot be pressed from an integration test (#531 —
 * a service-level test of a form-fed path proves the service, not the
 * system). Source-shape on purpose; comments are stripped first, or a fence
 * matches the sentence explaining itself (#725).
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));
const between = (src: string, from: string, to: string) => {
  const start = src.indexOf(from);
  expect(start, from).toBeGreaterThanOrEqual(0);
  const end = src.indexOf(to, start + from.length);
  return src.slice(start, end === -1 ? undefined : end);
};

describe('the ban at the counter', () => {
  it('the action refuses the price tick to anyone without finance.debt_override', () => {
    const action = between(read('src/app/(protected)/issue/actions.ts'), 'export async function issueBoxesAction', 'const meta');
    expect(action).toMatch(
      /parsed\.data\.priceOk && !actor\.permissions\.has\('finance\.debt_override'\)\)\s*\{\s*return \{ ok: false, error: 'price_override_forbidden' \}/,
    );
  });

  it('the schema carries the tick, the screen posts it, the list route says which boxes are gated', () => {
    expect(read('src/modules/wms/issue/service.ts')).toMatch(/priceOk: z\.boolean\(\)\.default\(false\)/);
    const screen = read('src/app/(protected)/issue/issue-screen.tsx');
    expect(between(screen, 'await issueBoxesAction({', '});')).toMatch(/\bpriceOk,/);
    expect(screen).toContain('data-testid="issue-price-ok"');
    const route = read('src/app/api/issue/list/route.ts');
    expect(route).toMatch(/gated: gatedIds\.has\(row\.boxId\)/);
    expect(route).toMatch(/\n\s+unpriced,\n/);
  });

  it('in issueBoxes: the ban read on the pool BEFORE the transaction, the price check AFTER the replay return', () => {
    const service = read('src/modules/wms/issue/service.ts');
    const fn = between(service, 'export async function issueBoxes', 'async function notifyUnpricedIssued');
    expect(fn.indexOf('unpricedGate()')).toBeGreaterThan(-1);
    expect(fn.indexOf('unpricedGate()')).toBeLessThan(fn.indexOf('db.transaction('));
    expect(fn.indexOf('if (existing) return')).toBeLessThan(fn.indexOf('uncoveredBoxesOn(tx,'));
    expect(fn.indexOf('uncoveredBoxesOn(tx,')).toBeLessThan(fn.indexOf('const needPrice'));
  });

  it('issueBoxes is the ONLY writer of a client handover — the ban cannot be walked round', () => {
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && /kind: 'issued_to_client'/.test(read(path))) writers.push(path);
      }
    };
    walk('src');
    expect(writers).toEqual(['src/modules/wms/issue/service.ts']);
  });

  it('deciding is the override: /approvals’ action authorizes finance.debt_override itself', () => {
    const action = between(
      read('src/app/(protected)/issue/actions.ts'),
      'export async function decideIssueApprovalAction',
      'const meta',
    );
    expect(action).toContain("authorize('finance.debt_override')");
    expect(action).not.toContain("authorize('finance.view')");
  });

  it('the settings door asks the value’s validator BEFORE anything is stored, and refuses in words', () => {
    const action = between(read('src/app/(protected)/admin/settings/actions.ts'), 'export async function updateSettingAction', '\n}');
    const asked = action.indexOf('if (validator && !validator(raw.trim())) redirect(');
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(action.indexOf('await setSetting('));
    expect(read('src/app/(protected)/admin/settings/page.tsx')).toContain('data-testid="setting-bad"');
  });
});
