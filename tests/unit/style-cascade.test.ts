import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `.input` is declared OUTSIDE a Tailwind layer (globals.css), after
 * `@tailwind utilities`, and it carries `w-full`. At equal specificity the
 * later rule wins, so a plain `w-24` on an element that also has `.input`
 * does nothing at all — the box claims the whole row.
 *
 * That cascade has now shipped three times, each time as a form a person could
 * not use on a phone: the counterparty amount box (a screenshot from the
 * owner found it), the settlement amounts, and the TN VED import row. It is
 * invisible to typecheck, to lint, to dev, and to any assertion about markup,
 * because the markup is exactly what was intended.
 *
 * The house idiom is `!w-24`. This test is the grep-shaped rule that says so.
 */

const WIDTH_OWNING = ['input', 'input-cell'];

/**
 * A bare width utility that names a SIZE — `w-24`, `w-1/2`, `w-[7rem]`.
 *
 * `w-full` and `w-auto` are exempt: they are what `.input` already sets, so
 * losing the cascade changes nothing. `w-0` is exempt too — it only ever
 * appears beside `flex-1`, where `flex-basis: 0%` decides the size whatever
 * `width` says. What breaks is a width meant to CONSTRAIN a box that then
 * silently does not.
 */
const BARE_WIDTH = /(?:^|\s)(?:[a-z]+:)?w-(?:[1-9]\d*(?:\/\d+)?|\[|px|screen|min|max|fit)(?:\s|$)/;

function classLists(source: string): string[] {
  // Only the static strings; a runtime-built class list cannot be read here
  // (and Tailwind cannot see it either, which is its own rule).
  return [...source.matchAll(/className\s*=\s*"([^"]*)"/g)].map((m) => m[1]!);
}

describe('a width utility on .input needs the important', () => {
  const files = globSync('src/**/*.tsx');

  it('finds the components to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('never lets a bare width sit on a class list that already owns its width', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const list of classLists(source)) {
        const classes = list.split(/\s+/);
        if (!classes.some((cls) => WIDTH_OWNING.includes(cls))) continue;
        if (!BARE_WIDTH.test(list)) continue;
        offenders.push(`${file}: "${list}"`);
      }
    }
    expect(
      offenders,
      'these need `!w-…` — `.input` carries w-full and wins on source order',
    ).toEqual([]);
  });
});
