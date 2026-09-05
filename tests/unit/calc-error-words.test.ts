import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY refusal this module can throw has a SENTENCE (law 6, audit A56).
 *
 * `CalcError.code` is a plain string, so nothing in the type system connects
 * a thrown code to the words a screen prints — and four of them reached the
 * VED and the accountant as raw Latin codes: `superseded` on releasing an
 * offer whose seal had been corrected, and `fx_missing`,
 * `category_not_found`, `account_currency_mismatch` on the upsale payout.
 * Every surface guards with `t.has(...)`, so the failure is silent: the
 * screen prints the code and nobody sees an error at all.
 *
 * The fence is DERIVED — it reads the throws out of the source rather than
 * naming today's list — so a new code turns it red the day it is written
 * (#789's idiom). Comments are stripped first (#725).
 */
const ROOTS = ['src/modules/wms/calc', 'src/modules/wms/customs', 'src/app/(protected)/hisoblash'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const thrown = new Set<string>();
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const source = strip(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(/new CalcError\(\s*'([a-z_0-9]+)'/g)) {
      thrown.add(match[1]!);
    }
  }
}

const bundles = ['uz', 'ru', 'en', 'zh-CN'].map((locale) => ({
  locale,
  json: JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as {
    calc: { errors?: Record<string, string>; threadErrors?: Record<string, string> };
  },
}));

describe('a refusal is a sentence, never a code', () => {
  it('found the throws to check (the fence itself is not vacuous)', () => {
    // #494's lesson: an assertion over an empty set passes and proves nothing.
    expect(thrown.size).toBeGreaterThan(20);
    expect(thrown).toContain('not_ready');
  });

  for (const { locale, json } of bundles) {
    it(`${locale} has a sentence for every CalcError code`, () => {
      const errors = json.calc.errors ?? {};
      const threadErrors = json.calc.threadErrors ?? {};
      const missing = [...thrown].filter((code) => !(code in errors) && !(code in threadErrors));
      expect(missing.sort(), `codes with no sentence in ${locale}`).toEqual([]);
    });
  }
});
