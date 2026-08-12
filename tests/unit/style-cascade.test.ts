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

/**
 * The same cascade, wearing its fourth costume: `.input` also carries
 * `min-h-12`, so a bare `min-h-24` on a textarea that wants to be six lines
 * tall does nothing and the box comes back at three — which is what round 67's
 * template body did, found in a screenshot and in nothing else.
 *
 * The house idioms are `h-28` (ask for a HEIGHT; `min-height` is only a floor
 * and 3rem is below it) or `!min-h-…`. Both pass. `min-h-9`/`min-h-0` are
 * exempt: they sit beside `max-h-…` on the autogrowing composers, where losing
 * to `min-h-12` makes the box taller, never unusable.
 */
const BARE_MIN_HEIGHT = /(?:^|\s)(?:[a-z]+:)?min-h-(?:1[3-9]|[2-9]\d|\[)/;

/**
 * The FIFTH costume, MEASURED and deliberately NOT enforced yet.
 *
 * `.btn` declares its own `text-[0.9375rem]` after `@tailwind utilities`, so a
 * bare `text-xs` on a button loses the cascade: measured in the browser, a
 * `btn-secondary btn-icon … text-xs` renders at **15px**, and the same button
 * with `!text-xs` renders at **12px**. Found while stopping the kanban move
 * button from competing with the card's own name.
 *
 * A sweep of `src/**` finds **51** class lists in this shape — every one a
 * button whose author asked for a smaller label and silently did not get it.
 * They are not fixed here, and the rule is not armed, for one measured reason:
 * `text-xs` also sets `line-height: 1rem`, and THAT half of it wins (16px on
 * the same button). So neither deleting the class nor adding the `!` is the
 * zero-pixel change it looks like — both move real geometry on 51 screens, and
 * that is its own round with its own screenshots, not a side effect of a card
 * redesign. The list above is the inventory; regenerate it by armed-and-run.
 */
const FONT_OWNING = ['btn', 'btn-primary', 'btn-secondary', 'btn-ghost', 'btn-danger', 'btn-icon'];
const BARE_FONT_SIZE = /(?:^|\s)(?:[a-z]+:)?text-(?:xs|sm|base|lg|xl|\dxl|\[)/;

describe('the .btn font-size cascade is known and measured', () => {
  it('the board move button asks for its size the only way that works', () => {
    const source = readFileSync('src/components/kanban.tsx', 'utf8');
    const lists = classLists(source).filter((list) =>
      list.split(/\s+/).some((cls) => FONT_OWNING.includes(cls)),
    );
    const moveNext = lists.find((list) => list.includes('flex-1') && list.includes('justify-start'));
    expect(moveNext, 'the one-tap move button').toBeDefined();
    expect(moveNext).toContain('!text-xs');
    expect(BARE_FONT_SIZE.test(moveNext!.replace('!text-xs', ''))).toBe(false);
  });
});

describe('a width utility on .input needs the important', () => {
  const files = globSync('src/**/*.tsx');

  it('finds the components to check', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('never lets a bare min-height sit on a class list that already owns one', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const list of classLists(source)) {
        const classes = list.split(/\s+/);
        if (!classes.some((cls) => WIDTH_OWNING.includes(cls))) continue;
        if (!BARE_MIN_HEIGHT.test(list)) continue;
        offenders.push(`${file}: "${list}"`);
      }
    }
    expect(
      offenders,
      'these need `h-…` or `!min-h-…` — `.input` carries min-h-12 and wins on source order',
    ).toEqual([]);
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

/**
 * A component class that is USED must be DEFINED (round 98).
 *
 * `input-sm` sat on the chat composers and the tray for months without
 * existing anywhere — so those fields kept the browser's own white `field`
 * background under the app's inherited ink, which in dark mode is near-white
 * text on a white box: the owner's «dark modeda yozishganda hech nima
 * ko'rinmayapti». Tailwind cannot warn (it ignores unknown classes), and no
 * behaviour test can see it, because the markup is exactly what was intended.
 *
 * The check is scoped to the house component vocabulary — Tailwind's own
 * utilities are unknowable here, but `input-*`/`btn-*`/`chip-*`/`card*` and
 * friends are OURS, and one of them missing from both stylesheets is always
 * this bug.
 */
describe('every house component class that is used exists', () => {
  it('finds no phantom class in the component vocabulary', () => {
    const css =
      readFileSync('src/app/globals.css', 'utf8') +
      readFileSync('src/app/(print)/print.css', 'utf8');
    const defined = new Set(
      [...css.matchAll(/^\.([a-z][a-z0-9-]*)\s*[{,]/gm)].map((m) => m[1]!),
    );
    const VOCAB = /^(?:input|btn|chip|card|label|section-title|num)(?:-[a-z0-9-]+)?$/;
    const offenders: string[] = [];
    for (const file of globSync('src/**/*.tsx')) {
      const source = readFileSync(file, 'utf8');
      for (const list of classLists(source)) {
        for (const cls of list.split(/\s+/)) {
          if (VOCAB.test(cls) && !defined.has(cls)) offenders.push(`${file}: ${cls}`);
        }
      }
    }
    expect(offenders, 'a used component class no stylesheet defines').toEqual([]);
  });
});
