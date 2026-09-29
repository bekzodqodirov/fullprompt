import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every date a person reads carries the logist's typed border queues (0118).
 *
 * `waits` is a REQUIRED argument of `scheduleEstimate` / `truckFor` /
 * `truckRow`, but a literal `{}` satisfies the type: a reader that passes it
 * silently ignores the queue every other screen shows (#790's shape one level
 * down), and every behavioural test stays green — measured: the cabinet's
 * `loadBorderHours()` replaced by `{}` left 53 of 53 tests passing, because no
 * test reads a typed wait through the cabinet, the map, the bot or the
 * dashboard. So the rule is fenced on the SOURCE, DERIVED: every file under
 * src/ that calls one of the three (the three modules that only pass `waits`
 * through excepted) must itself load the queues, and the argument it passes
 * must be a name bound to that load — never a literal. Comments are stripped
 * first (#725: a fence that reads the sentence explaining it tests nothing).
 */

const PASS_THROUGH = new Set([
  'src/modules/wms/tracking/eta.ts',
  'src/modules/wms/tracking/on-road-state.ts',
  'src/modules/wms/tracking/truck.ts',
]);

/** The callee and the 0-based position of its `waits` argument. */
const READERS: Record<string, number> = { scheduleEstimate: 4, truckFor: 3, truckRow: 3 };

/** Comments out, strings kept — the quote-walking stripper (#725). */
function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/** The top-level arguments of the call whose `(` is at `open`. */
function argsAt(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = open + 1; i < src.length; i += 1) {
    const ch = src[i]!;
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) {
      if (depth === 0) {
        args.push(cur.trim());
        return args;
      }
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  throw new Error('unbalanced call');
}

const files = globSync('src/**/*.{ts,tsx}')
  .filter((f) => !PASS_THROUGH.has(f))
  .map((f) => ({ file: f, src: stripComments(readFileSync(f, 'utf8')) }))
  .filter(({ src }) => Object.keys(READERS).some((name) => new RegExp(`\\b${name}\\(`).test(src)));

describe('the typed border queues reach every ETA reader', () => {
  it('finds the readers it is about (a fence that matches nothing proves nothing)', () => {
    const names = files.map((f) => f.file).sort();
    for (const known of [
      'src/app/(protected)/map/page.tsx',
      'src/modules/wms/bot/lookup.ts',
      'src/modules/wms/client-cabinet/map.ts',
      'src/modules/wms/client-cabinet/service.ts',
      'src/modules/wms/tracking/on-road.ts',
    ]) {
      expect(names).toContain(known);
    }
  });

  for (const { file, src } of files) {
    it(`${file} loads the queues and passes that load, never a literal`, () => {
      expect(src, `${file} never calls loadBorderHours()`).toMatch(/\bloadBorderHours\(/);
      for (const [name, pos] of Object.entries(READERS)) {
        for (const m of src.matchAll(new RegExp(`\\b${name}\\(`, 'g'))) {
          const arg = argsAt(src, m.index! + name.length)[pos];
          expect(arg, `${file}: ${name}(…) passes no waits`).toBeDefined();
          expect(arg, `${file}: ${name}(…) passes «${arg}» as waits`).toMatch(/^[A-Za-z_$][\w$]*$/);
          // A plain `const <arg> = …` must be the load itself; the empty
          // answer is allowed only as the short-circuit of a guarded load
          // (`rows.length ? await loadBorderHours() : {}` — nothing to date).
          for (const d of src.matchAll(new RegExp(`\\bconst ${arg!.replace('$', '\\$')}\\s*=([^;]*);`, 'g'))) {
            const init = d[1]!;
            expect(init, `${file}: ${arg} is not bound to loadBorderHours()`).toMatch(/\bloadBorderHours\(\)/);
            if (init.includes('{}')) {
              expect(init, `${file}: ${arg} falls back to {} outside the guarded load`).toMatch(
                /\?\s*await\s+loadBorderHours\(\)\s*:\s*\{\}\s*$/,
              );
            }
          }
        }
      }
    });
  }
});
