import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every refusal the cost form can be answered with has WORDS (SARFLAR §8.5).
 * The form prints `payerErrorText(code)`, which falls back to the bare code —
 * so a code the doors learn and the map does not is a code on a person's
 * screen. DERIVED: the codes are read out of the doors' own source, not
 * listed here.
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

const PANEL = read('src/components/cost-panel.tsx');
const map = /const PAYER_ERRORS = \{([\s\S]*?)\} as const;/.exec(PANEL)?.[1] ?? '';
const entries = [...map.matchAll(/^\s*([a-z_]+): '([A-Za-z]+)',/gm)].map((m) => [m[1]!, m[2]!] as const);
const keys = new Set(entries.map(([code]) => code));

/** Answered by the form in its own words before the map is asked. */
const INLINE = ['client_required', 'fx_missing'];
/**
 * Codes the two doors' services can raise that the cost FORM never meets,
 * each with its reason. Counted, so a new one is a decision.
 */
const NOT_FROM_THE_FORM: Record<string, string> = {
  unauthenticated: 'the action authorizes first; a lost session never reaches the service',
  already_placed: "the accountant's place-later queue (placeCostAccount), not this form",
  before_kassa_since: 'the place-later queue',
  not_staff: "«o'z pulimdan» on the queue (setCostStaffPayer)",
  receipt_not_on_batch: 'the per-prixod grid, which carries its own words',
};

/** Every literal `new CostError('code'` — with or without params (0132). */
const thrown = (source: string) => [...source.matchAll(/new CostError\('([a-z_]+)'[,)]/g)].map((m) => m[1]!);

/**
 * The ACTION files' own refusals. Kept to the action files (T9): a pure
 * helper's own string return (freight-copy's `'missing'`/`'invalid'`) is not
 * a form code and must not be harvested as one.
 */
function codesIn(source: string): string[] {
  return [
    ...thrown(source),
    ...[...source.matchAll(/error: '([a-z_]+)'/g)].map((m) => m[1]!),
    ...[...source.matchAll(/return '([a-z_]+)';/g)].map((m) => m[1]!),
  ];
}

/** Every module under costing/** — the doors' services throw from more than service.ts since 0132. */
const COSTING = readdirSync('src/modules/wms/costing')
  .filter((f) => f.endsWith('.ts'))
  .map((f) => `src/modules/wms/costing/${f}`);

describe('the cost form names every refusal', () => {
  it('the map was read', () => {
    expect(entries.length).toBeGreaterThan(15);
  });

  it('every code the add/void doors can return is worded, answered inline, or allowlisted with a reason', () => {
    const codes = new Set([
      ...codesIn(read('src/app/(protected)/costs/actions.ts')),
      ...COSTING.flatMap((f) => thrown(read(f))),
    ]);
    const bare = [...codes].filter((code) => !keys.has(code) && !INLINE.includes(code) && !(code in NOT_FROM_THE_FORM));
    expect(bare).toEqual([]);
    expect(Object.keys(NOT_FROM_THE_FORM)).toHaveLength(5);
  });

  it('every word exists in all four bundles', () => {
    for (const locale of ['ru', 'uz', 'zh-CN', 'en']) {
      const costing = (JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { costing: Record<string, unknown> })
        .costing;
      const missing = entries.filter(([, key]) => typeof costing[key] !== 'string').map(([, key]) => key);
      expect(missing, locale).toEqual([]);
    }
  });
});
