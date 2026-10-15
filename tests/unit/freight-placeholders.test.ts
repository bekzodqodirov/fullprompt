import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

/**
 * Every literal sentence the yo'lkira split draws, held against the bundles BY
 * THE CALL SITE (judge J13): the argument names a call passes are read out of
 * the source with TypeScript's own parser, and the sentence is formatted with
 * exactly those names in all four locales. A sentence that still says
 * `{group}` while its call passes `lot` — or a plural the call feeds no
 * number — is a FORMATTING_ERROR here, where `locales.test.ts` (bundles
 * against each other) cannot see it: it compares four copies of the same
 * mistake and finds them equal. Derived, not a hand list, so a call added next
 * month is checked the day it is written.
 */
const SITES: { file: string; namespace: string; callees: string[] }[] = [
  { file: 'src/components/freight-views.tsx', namespace: 'costing', callees: ['t'] },
  { file: 'src/components/cost-panel.tsx', namespace: 'costing', callees: ['t'] },
  { file: 'src/app/(protected)/batches/[id]/pricing/page.tsx', namespace: 'costing', callees: ['tcost'] },
  { file: 'src/app/(protected)/admin/tarif/page.tsx', namespace: 'costing', callees: ['tcost'] },
  { file: 'src/app/(protected)/admin/tarif/page.tsx', namespace: 'calc', callees: ['t'] },
];
const LOCALES = ['uz', 'ru', 'en', 'zh-CN'] as const;
const bundles = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(readFileSync(`messages/${l}.json`, 'utf8'))]));

interface Call {
  key: string;
  args: string[];
  line: number;
}

/** The literal key(s) of a call — a plain string, or both arms of a `cond ? 'a' : 'b'`; null when built at runtime. */
function keysOf(node: ts.Expression): string[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return keysOf(node.expression);
  if (ts.isConditionalExpression(node)) {
    const a = keysOf(node.whenTrue);
    const b = keysOf(node.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  return null;
}

function callsIn(file: string, callees: string[]): { calls: Call[]; dynamic: number } {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls: Call[] = [];
  let dynamic = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && callees.includes(node.expression.text)) {
      const [first, second] = node.arguments;
      const keys = first ? keysOf(first) : null;
      if (!keys) dynamic += 1;
      else if (second && !ts.isObjectLiteralExpression(second)) dynamic += 1;
      else {
        const args = second
          ? second.properties.flatMap((p) =>
              (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
                ? [p.name.text]
                : [],
            )
          : [];
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        for (const key of keys) calls.push({ key, args, line });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { calls, dynamic };
}

describe('the yo’lkira sentences format with exactly the names their calls pass (judge J13)', () => {
  const all = SITES.map((site) => ({ site, ...callsIn(site.file, site.callees) }));

  it('the fence reads the calls it is about (non-vacuous)', () => {
    const keys = new Set(all.flatMap((a) => a.calls.map((c) => `${a.site.namespace}.${c.key}`)));
    for (const k of [
      'costing.freightHeldLight',
      'costing.freightHeldMeasure',
      'costing.freightClientLine',
      'costing.freightClientBands',
      'costing.freightRowLine1',
      'costing.freightSplitSummary',
      'costing.freightClientsMore',
      'costing.freightLabel',
      'costing.rebaseColumn',
      'costing.freightColumnLine',
      'costing.freightBandsMore',
      'costing.freightLotShare',
      'costing.errFreightGap',
      'calc.freightWatchTitle',
      'calc.freightWatchFrom',
    ]) {
      expect(keys, k).toContain(k);
    }
  });

  for (const { site, calls } of all) {
    it(`${site.file} (${site.namespace}): every literal call formats in all four bundles`, () => {
      const broken: string[] = [];
      for (const locale of LOCALES) {
        const t = createTranslator({
          locale,
          messages: bundles[locale],
          namespace: site.namespace as never,
          onError: (error) => broken.push(`${locale} ${error.code}: ${error.message}`),
        }) as unknown as (key: string, values?: Record<string, number>) => string;
        for (const call of calls) {
          // A number fits every argument these sentences have: a plain value
          // prints it, a plural branches on it.
          t(call.key, Object.fromEntries(call.args.map((a) => [a, 2])));
        }
      }
      expect(broken).toEqual([]);
    });
  }
});
