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

/**
 * The thumbnail must not be squeezable (round 54).
 *
 * The browser's own stylesheet gives every img `max-width: 100%`, which turns
 * a fixed 80×80 thumbnail into one whose MINIMAL width is zero — permission
 * for any table column or flex row to crush it to a sliver. That is exactly
 * what the owner's phone did: large system fonts pushed the stock table's
 * nowrap columns past its width, the photo column paid, and every photo
 * rendered as an 18px vertical strip («cho'zinchoq»). Reproduced headlessly
 * by forcing the cell to 60px — 60×80 before the fix, 80×80 after.
 *
 * `max-w-none` takes the permission away and `shrink-0` on the wrapper does
 * the same for flex rows; the table then grows and scrolls sideways, which is
 * what its overflow container exists for. A cascade rule, like `.input`'s
 * width above: invisible to typecheck, lint and every behaviour test, because
 * the class list is exactly what was intended.
 */
describe('the lightbox thumbnail owns its minimal width', () => {
  it('carries max-w-none on the img and shrink-0 on its wrapper', () => {
    const source = readFileSync('src/components/lightbox-img.tsx', 'utf8');
    const thumb = source.slice(0, source.indexOf('onDelete &&'));
    expect(thumb).toContain('max-w-none');
    expect(thumb).toContain('shrink-0');
  });
});
