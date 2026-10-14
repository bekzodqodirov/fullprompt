import { readdirSync, readFileSync } from 'node:fs';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { FREIGHT_ERROR_PARAMS, HELD_KEY } from '@/modules/wms/costing/freight-errors';

/**
 * docs/YOLKIRA-TAQSIMOT.md §5 (T9) — a freight refusal NAMES what to fix, and
 * three things must agree for it to: the bundle sentence's `{placeholders}`,
 * the literal throw site's params, and FREIGHT_ERROR_PARAMS. And the action
 * must forward the params structurally, or the sentence prints a hole.
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => strip(readFileSync(p, 'utf8'));
const LOCALES = ['uz', 'ru', 'en', 'zh-CN'] as const;
const bundles = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(`messages/${l}.json`, 'utf8')) as Record<string, unknown>]),
) as Record<(typeof LOCALES)[number], Record<string, Record<string, string>>>;

const PANEL = read('src/components/cost-panel.tsx');
const map = /const PAYER_ERRORS = \{([\s\S]*?)\} as const;/.exec(PANEL)?.[1] ?? '';
const keyOf = new Map([...map.matchAll(/^\s*([a-z_]+): '([A-Za-z]+)',/gm)].map((m) => [m[1]!, m[2]!]));

const placeholders = (msg: string) => [...new Set([...msg.matchAll(/\{(\w+)/g)].map((m) => m[1]!))].sort();

const COSTING = readdirSync('src/modules/wms/costing')
  .filter((f) => f.endsWith('.ts'))
  .map((f) => read(`src/modules/wms/costing/${f}`))
  .join('\n');

describe('freight refusals name what to fix', () => {
  for (const [code, params] of Object.entries(FREIGHT_ERROR_PARAMS)) {
    it(`${code}: the sentence's placeholders are exactly ${JSON.stringify(params)} in all four bundles`, () => {
      const key = keyOf.get(code);
      expect(key, `${code} has no word in the panel map`).toBeTruthy();
      for (const l of LOCALES) {
        const msg = bundles[l].costing![key!];
        expect(typeof msg, `${l}: costing.${key}`).toBe('string');
        expect(placeholders(msg!), `${l}: costing.${key}`).toEqual([...params].sort());
      }
    });

    it(`${code}: a literal throw site carries exactly those params (non-vacuous)`, () => {
      if (code === 'freight_changed') {
        // The action's own refusal (the digest compare), not a CostError.
        expect(read('src/app/(protected)/costs/actions.ts')).toMatch(
          /error: 'freight_changed', params: \{ column: draft\.zone, from: draft\.tariffFrom \}/,
        );
        return;
      }
      if (params.length === 0) {
        expect(COSTING).toMatch(new RegExp(`new CostError\\('${code}'\\)`));
        return;
      }
      const sites = [...COSTING.matchAll(new RegExp(`new CostError\\('${code}', \\{([^}]*)\\}`, 'g'))];
      expect(sites.length, `no literal throw of ${code}`).toBeGreaterThan(0);
      for (const site of sites) {
        const keys = site[1]!
          .split(',')
          .map((part) => part.split(':')[0]!.trim())
          .filter(Boolean)
          .sort();
        expect(keys).toEqual([...params].sort());
      }
    });
  }

  it('every sentence formats with its params in all four bundles — no FORMATTING_ERROR, no hole', () => {
    const sample: Record<string, string | number> = {
      warehouse: 'YW — Yiwu',
      column: 'Yiwu / Guangzhou → Toshkent',
      date: '2026-10-14',
      from: 900,
      to: 999,
      at: 700,
    };
    for (const l of LOCALES) {
      const t = createTranslator({
        locale: l,
        messages: bundles[l] as never,
        namespace: 'costing',
        onError: (error) => {
          throw error;
        },
      });
      for (const [code, params] of Object.entries(FREIGHT_ERROR_PARAMS)) {
        const values = Object.fromEntries(params.map((p) => [p, sample[p]!]));
        const out = (t as unknown as (k: string, v: Record<string, unknown>) => string)(keyOf.get(code)!, values);
        expect(out, `${l}/${code}`).not.toContain(keyOf.get(code)!);
        for (const p of params) expect(out, `${l}/${code}/${p}`).toContain(String(sample[p]));
      }
    }
  });

  it('the band words and the disabled option’s facts exist in all four bundles (built keys, #163)', () => {
    const opt = /const FREIGHT_OPT = \{([\s\S]*?)\} as const;/.exec(PANEL)?.[1] ?? '';
    const optKeys = [...opt.matchAll(/: '([A-Za-z]+)'/g)].map((m) => m[1]!);
    expect(optKeys.length).toBe(4);
    const bandKeys = ['freightBand', 'freightBandPerKg', 'freightBandMoney', 'freightBandMoneyPerKg'];
    for (const key of [...optKeys, ...bandKeys]) {
      for (const l of LOCALES) expect(typeof bundles[l].costing![key], `${l}: costing.${key}`).toBe('string');
    }
  });

  it('every held reason has its words in all four bundles', () => {
    for (const key of new Set(Object.values(HELD_KEY))) {
      for (const l of LOCALES) expect(typeof bundles[l].costing![key], `${l}: costing.${key}`).toBe('string');
    }
  });
});

describe('the action forwards the params structurally', () => {
  const actions = read('src/app/(protected)/costs/actions.ts');
  it('only costRefusal turns a CostError into a result', () => {
    expect(actions.match(/error: err\.code/g)?.length).toBe(1);
    expect(actions).toMatch(/function costRefusal\(err: CostError\): CostActionResult \{\s*return \{ ok: false, error: err\.code, \.\.\.\(err\.params/);
    const caught = actions.match(/instanceof CostError/g)?.length ?? 0;
    const refused = actions.match(/return costRefusal\(err\)/g)?.length ?? 0;
    expect(caught).toBeGreaterThan(0);
    expect(refused).toBe(caught);
  });
  it('the panel asks payerErrorText with the whole result', () => {
    // Every CALL (not the definition) passes an action result as it came
    // back — a bare identifier — never a rebuilt `{ error }` that drops the
    // params.
    const calls = [...PANEL.matchAll(/(?<!function )payerErrorText\(([^,)]+)/g)].map((m) => m[1]!.trim());
    expect(calls.length).toBeGreaterThan(1);
    for (const arg of calls) expect(arg, 'payerErrorText must get the result object').toMatch(/^[a-z][A-Za-z]*$/);
  });
});
