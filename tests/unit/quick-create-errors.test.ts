import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every refusal the «+» panel can be handed has words in all four locales.
 *
 * The panel renders its error through a TEMPLATE key — `t(\`error.${error}\`)`
 * — which `i18n-keys.test.ts` cannot see: that one matches literal single-quoted
 * calls, by design. So the codes and the bundles are compared here instead,
 * from the source of truth on each side: the codes the two actions can
 * actually return, and the four bundles.
 *
 * This is the fifth outing of #163 (a missing key THROWS AT RENDER, in every
 * locale) and the reason it needs its own fence: the app bar renders on every
 * protected page, so a missed key here is not one broken screen.
 */

const ACTIONS = [
  'src/app/(protected)/admin/clients/actions.ts',
  'src/app/(protected)/crm/actions.ts',
];

const BUNDLES = ['ru', 'uz', 'zh-CN', 'en'] as const;

/**
 * The codes the QUICK actions return — scoped to those two function bodies,
 * not to the files. `crm/actions.ts` also holds winLead, whose refusals
 * (`client_not_found`, `client_inactive`) are rendered by the win dialog in
 * its own namespace; the first version of this fence scanned whole files and
 * demanded words for those in `quick.error` too. A fence that fails on
 * something correct gets deleted by the next person.
 */
function refusalCodes(src: string): string[] {
  const codes: string[] = [];
  for (const start of [...src.matchAll(/export async function quickCreate\w+/g)]) {
    const rest = src.slice(start.index!);
    const next = rest.indexOf('\nexport ', 1);
    const body = next === -1 ? rest : rest.slice(0, next);
    codes.push(...[...body.matchAll(/\berror:\s*'([a-zA-Z_]+)'/g)].map((m) => m[1]!));
  }
  return codes;
}

describe('quick-create refusals', () => {
  const codes = new Set(ACTIONS.flatMap((path) => refusalCodes(readFileSync(path, 'utf8'))));

  it('the actions really do return refusal codes', () => {
    // If this ever reads 0 the scoping above stopped matching and every other
    // assertion in the file passes vacuously (#494's shape).
    expect(codes.size).toBeGreaterThan(3);
    expect(codes).toContain('duplicateCode');
  });

  it.each(BUNDLES)('%s has words for every one of them', (locale) => {
    const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as {
      quick: { error: Record<string, string> };
    };
    const missing = [...codes].filter((code) => typeof bundle.quick.error[code] !== 'string');
    expect(missing, `quick.error.* missing from messages/${locale}.json`).toEqual([]);
  });
});
