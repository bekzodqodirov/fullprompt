import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ru from '../../messages/ru.json';

/**
 * Fourth instance of the trap #163 named: the bundle-parity test compares the
 * four bundles to EACH OTHER, so a key missing from all four matches perfectly
 * and ships. `settings.descriptions.*`, the bridge labels and the feed labels
 * each got their own source-of-truth test after being caught in production.
 *
 * This is the general case. Every `t('literal')` call in the app is a key the
 * page WILL ask for, so the source itself is the source of truth: whatever the
 * components read, the reference bundle must contain.
 *
 * `void-tx.tsx` shipped `tc('confirm')` with no `common.confirm` anywhere —
 * the void button on the counterparty ledger read the raw key path in every
 * language, and nothing in the suite could see it.
 *
 * Only literal single-quoted keys are checked. A key built at runtime
 * (`t(\`kinds.${type}\`)`) is exactly the shape the three earlier tests exist
 * to cover, and each of those anchors on a map the component exports.
 */

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, path: string): string | Tree | undefined {
  return path.split('.').reduce<string | Tree | undefined>((node, part) => {
    if (node === undefined || typeof node === 'string') return undefined;
    return node[part];
  }, tree);
}

/** `const t = useTranslations('batches')` / `await getTranslations('crm')`. */
const BINDING = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*(?:'([^']*)')?\s*\)/g;

describe('every translation key a component asks for exists', () => {
  const files = globSync('src/**/*.{ts,tsx}');

  it('finds the components to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('resolves in the reference bundle', () => {
    const missing: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // A name may be bound to different namespaces in different functions of
      // one file — `tc` is `crm` in one component and `calc` in another. The
      // bindings are collected per FILE rather than per scope, so a key counts
      // as found if it resolves under ANY namespace that name carries here.
      // That can only hide a mistake when the same name is bound twice AND the
      // key exists under the other one; it still catches the whole class this
      // test is for, which is a key that exists in no namespace at all.
      const namespaces = new Map<string, Set<string>>();
      for (const match of source.matchAll(BINDING)) {
        const bound = namespaces.get(match[1]!) ?? new Set<string>();
        bound.add(match[2] ?? '');
        namespaces.set(match[1]!, bound);
      }
      if (namespaces.size === 0) continue;

      for (const [binding, spaces] of namespaces) {
        // `t('a.b')`, and the `.rich`/`.raw` forms of the same call.
        const calls = new RegExp(`\\b${binding}(?:\\.(?:rich|raw|markup))?\\(\\s*'([^']+)'`, 'g');
        for (const call of source.matchAll(calls)) {
          const keys = [...spaces].map((ns) => (ns ? `${ns}.${call[1]}` : call[1]!));
          if (!keys.some((key) => typeof lookup(ru as Tree, key) === 'string')) {
            missing.push(`${file}: ${keys.join(' / ')}`);
          }
        }
      }
    }
    expect([...new Set(missing)], 'used in the app, absent from messages/ru.json').toEqual([]);
  });
});
