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

  it('the one home is itemFacts, and the card form derives no weight', () => {
    // `landingItems` must READ through `itemFacts` — the derivation and its
    // brutto note live there — and the card form, whose total box is brutto
    // and whose rows carry their own netto cell, must say its line weights
    // were STATED, or the total lands in the netto column (MR-7).
    const intake = readFileSync(join(SRC, 'modules', 'wms', 'calc', 'intake.ts'), 'utf8');
    const body = intake.slice(intake.indexOf('export function landingItems('));
    expect(body.slice(0, body.indexOf('\n}\n'))).toContain('itemFacts(facts)');
    const action = readFileSync(join(SRC, 'app', '(protected)', 'hisoblash', 'actions.ts'), 'utf8');
    expect(action).toMatch(/landingItems\(\{[^}]*lineWeightsStated: true/);
  });

  it('no caller builds its items straight off the goods array', () => {
    for (const { path, source } of callers) {
      let at = source.indexOf('openCalcRequest(');
      while (at !== -1) {
        const args = callArgs(source, at + 'openCalcRequest('.length);
        if (args.includes('items:')) {
          // ONE home since 2026-10-09 (P1, TT-16): every door hands its facts
          // to `landingItems`, which reads them through `itemFacts` and
          // carries every column — the pair, the volume, the seller's word.
          // The fence used to accept `loneWeightKg` for the card form; the
          // form now types its own netto and passes `lineWeightsStated`
          // instead (judge MR-7), so a door applying the derivation by hand
          // is exactly the second rule this exists to refuse.
          expect(args, `${path} must land through the one home`).toMatch(/landingItems\(/);
          // …and must not reach past it into the raw goods, which is the
          // shape that dropped the weight.
          expect(args, `${path} must not read goods directly`).not.toMatch(/\.goods\s*\?\?/);
        }
        at = source.indexOf('openCalcRequest(', at + 1);
      }
    }
  });
});
