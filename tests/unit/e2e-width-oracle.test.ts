import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «The page is no wider than the phone» (#400) must be measured against
 * something the overflow cannot move. Under mobile emulation Chrome zooms an
 * over-wide page out and `window.innerWidth` grows WITH it — measured: a
 * /admin/users at 360 px with a 2,056 px document read innerWidth 1,440, so
 * `scrollWidth <= innerWidth` passed a four-fold overflow, and the person's
 * name was covering their own edit button when the spec finally went red on
 * a click. `document.documentElement.clientWidth` stays at the layout width
 * (360), and so does the configured `page.viewportSize()`.
 *
 * The one legitimate reader is a comparison to a LITERAL width (m9y: an
 * innerWidth that is not 360 IS the rescale). Comments are stripped first
 * (#725) — two files explain the rule in words.
 */
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const LITERAL_ONLY = new Set(['tests/e2e/m9y-partners.spec.ts']);

describe('e2e width oracle', () => {
  const files = globSync('tests/e2e/**/*.ts');

  it('finds the specs it is about', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('tests/e2e/m9zzu-hodim-kirmaydi.spec.ts');
  });

  it('no spec measures the document against window.innerWidth', () => {
    const offenders = files.filter(
      (file) => !LITERAL_ONLY.has(file) && strip(readFileSync(file, 'utf8')).includes('window.innerWidth'),
    );
    expect(offenders).toEqual([]);
  });

  it('the literal reader still compares to a literal', () => {
    for (const file of LITERAL_ONLY) {
      const code = strip(readFileSync(file, 'utf8'));
      expect(code).toMatch(/const inner = await page\.evaluate\(\(\) => window\.innerWidth\);/);
      expect(code).toMatch(/expect\(inner[^)]*\)\.toBe\(360\)/);
    }
  });
});
