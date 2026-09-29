import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * /hodimlar prints a refusal as `t(\`refusal.${code}\`)` — a key built at
 * runtime, which `i18n-keys.test.ts` cannot see (#163). So the codes are READ
 * OUT OF THE SOURCES — the three unions and every literal the actions return
 * — and each must be a sentence in all four bundles (#906/#915's shape): a
 * member added tomorrow is red the day it is written, not the day a payer
 * meets a missing key at render time.
 */
const read = (path: string) => readFileSync(path, 'utf8');

function unionMembers(path: string, name: string): string[] {
  const source = read(path);
  const start = source.indexOf(`export type ${name} =`);
  expect(start, `${name} in ${path}`).toBeGreaterThan(-1);
  const end = source.indexOf(';', start);
  return [...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

const ACTION_CODES = [...read('src/app/(protected)/hodimlar/actions.ts').matchAll(/error: '([a-z_]+)'/g)].map(
  (m) => m[1]!,
);

const CODES = [
  ...new Set([
    ...unionMembers('src/modules/wms/staff/kpi-engine.ts', 'KpiRefusal'),
    ...unionMembers('src/modules/wms/staff/kpi-service.ts', 'PayKpiError'),
    ...unionMembers('src/modules/wms/staff/kpi-table.ts', 'KpiTableError'),
    ...ACTION_CODES,
  ]),
];

describe('every staff refusal is a sentence', () => {
  it('reads the codes it guards', () => {
    expect(CODES).toEqual(
      expect.arrayContaining(['rate_missing', 'amount_moved', 'kpi_version_paid', 'forbidden', 'server_behind']),
    );
    expect(CODES.length).toBeGreaterThanOrEqual(27);
  });

  for (const locale of ['ru', 'uz', 'en', 'zh-CN']) {
    it(locale, () => {
      const bundle = JSON.parse(read(`messages/${locale}.json`)) as { hodimlar?: { refusal?: Record<string, unknown> } };
      const map = bundle.hodimlar?.refusal ?? {};
      const missing = CODES.filter((code) => typeof map[code] !== 'string' || !(map[code] as string).trim());
      expect(missing).toEqual([]);
    });
  }
});
