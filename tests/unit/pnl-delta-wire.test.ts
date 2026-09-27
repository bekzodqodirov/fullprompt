import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ONE delta rule, one tap apart (the judge's O4): the dashboard's revenue tile
 * links to /accounting/pnl, and the page had its own `change()` — integer
 * percent, over |base| — so the tile read «▲ 7.6%» and the page «▲ 8%» for
 * the same revenue, and a loss month got a percentage whose sign lies. The page
 * renders behind `getActor`, which no integration test can press, so the
 * wiring is pinned by shape (#531); `pctDelta` itself is tested where it
 * lives. Comments are stripped first, or the fence matches the sentence
 * explaining itself (#725).
 */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PNL_PAGE = 'src/app/(protected)/accounting/pnl/page.tsx';

describe('the P&L page asks the dashboard\'s delta rule', () => {
  const page = read(PNL_PAGE);

  it('imports pctDelta from the dashboard arithmetic and asks it for every headline figure', () => {
    expect(page).toMatch(/import\s*\{[^}]*\bpctDelta\b[^}]*\}\s*from\s*'@\/modules\/wms\/reports\/dashboard-math'/);
    expect(page).toContain('const delta = pctDelta(kpi.now, kpi.was);');
  });

  it('keeps no delta arithmetic of its own', () => {
    expect(page).not.toMatch(/\bchange\s*=\s*\(/);
    expect(page).not.toMatch(/function\s+change\s*\(/);
    expect(page).not.toMatch(/\bchange\(/);
    // No percentage computed by hand anywhere on the page.
    expect(page).not.toMatch(/\/\s*Math\.abs\(\s*was\s*\)/);
  });
});
