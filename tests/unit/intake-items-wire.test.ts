import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every door that lands a calculation builds its ITEMS the same way.
 *
 * `itemFacts` is the one home for «what does this line weigh» — including
 * the derivation that a single-line job's weight IS that line's weight — and
 * the checklist, the summary, the lenta note and both landing doors read it.
 * The bot door was taught it and the THREAD door was not, which made the
 * thread preview warn about a per-line weight its own sanitiser dropped: the
 * checklist asking for a hole the door itself was digging.
 *
 * DERIVED (#789's idiom, #513's rule): this walks the tree for callers of
 * `openCalcRequest` rather than naming the two that exist, so a third door
 * turns it red the day it is written instead of the day somebody notices two
 * identical jobs landing different rows.
 */
const SRC = 'src';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

/** The balanced `(...)` following a marker — one call's arguments, verbatim. */
function callArgs(source: string, at: number): string {
  let depth = 1;
  for (let i = at; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    if (source[i] === ')') depth -= 1;
    if (depth === 0) return source.slice(at, i);
  }
  throw new Error('unbalanced openCalcRequest(');
}

describe('every door lands its items through the one home', () => {
  const callers = walk(SRC)
    .map((path) => ({ path, source: readFileSync(path, 'utf8') }))
    .filter(({ source }) => source.includes('openCalcRequest('))
    // The service DECLARES it; the fence is about the callers.
    .filter(({ path }) => !path.endsWith(join('calc', 'service.ts')));

  it('there are callers to check — a fence over nothing proves nothing', () => {
    // #494's lesson: a test that passes because its subject never appeared is
    // not evidence. Both known doors must be here by name.
    expect(callers.length).toBeGreaterThanOrEqual(2);
    const paths = callers.map((c) => c.path.replaceAll('\\', '/'));
    expect(paths).toContain('src/modules/wms/calc/intake-land.ts');
    expect(paths).toContain('src/modules/wms/calc/from-thread.ts');
    expect(paths).toContain('src/app/(protected)/hisoblash/actions.ts');
  });

  it('no caller builds its items straight off the goods array', () => {
    for (const { path, source } of callers) {
      let at = source.indexOf('openCalcRequest(');
      while (at !== -1) {
        const args = callArgs(source, at + 'openCalcRequest('.length);
        if (args.includes('items:')) {
          // Either home will do — `itemFacts` for a door carrying read facts,
          // `loneWeightKg` for one carrying typed items. What may not happen
          // is a door applying neither, which is how the same job lands two
          // different rows.
          expect(args, `${path} must apply the shared per-line derivation`).toMatch(
            /itemFacts\(|loneWeightKg\(/,
          );
          // …and must not reach past it into the raw goods, which is the
          // shape that dropped the weight.
          expect(args, `${path} must not read goods directly`).not.toMatch(/\.goods\s*\?\?/);
        }
        at = source.indexOf('openCalcRequest(', at + 1);
      }
    }
  });
});
