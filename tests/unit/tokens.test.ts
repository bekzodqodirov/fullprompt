import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../../tailwind.config';

/**
 * Every colour class in the app must be one the theme can actually produce.
 *
 * A Tailwind class the config has no token for is not an error anywhere: not
 * at typecheck, not at lint, not at build, not in the browser console. It
 * simply produces no CSS, so the element renders with whatever was behind it
 * and the page looks *nearly* right — which is why it survives review.
 *
 * That is not hypothetical. `bg-surface-200` was written on both screens that
 * show a Telegram conversation, and the surface scale has never had numbers
 * (DEFAULT / raised / sunken), so every message a CLIENT sent had no bubble at
 * all while ours had one. The public layout carried a `surface-100` with the
 * same effect from the day `/driver` shipped. Both read perfectly as code.
 *
 * The palette is deliberately small (DECISIONS #180) precisely so a wrong
 * shade is a mistake rather than a choice — this is the check that makes the
 * smallness enforceable.
 */

const SRC = join(__dirname, '../../src');

/** The colour scales, flattened to `brand-50`, `surface-raised`, `good`, … */
const VALID = new Set<string>();
for (const [name, value] of Object.entries(config.theme.extend.colors)) {
  if (typeof value === 'string') {
    VALID.add(name);
    continue;
  }
  for (const key of Object.keys(value)) {
    VALID.add(key === 'DEFAULT' ? name : `${name}-${key}`);
  }
}

const FAMILIES = Object.keys(config.theme.extend.colors).join('|');
/**
 * `bg-brand-50`, `hover:text-ink-700`, `border-line-strong`, `bg-good/10`.
 *
 * Anchored on a family name rather than on the utility prefix, so a utility
 * nobody thought of (`divide-`, `caret-`, `shadow-`) is covered too, and so
 * `ring-offset-surface` needs no special case. The suffix stops at `/` to let
 * the opacity modifier through.
 */
const CLASS_RE = new RegExp(`\\b(?:[a-z-]+-)?(${FAMILIES})(-[a-z0-9]+)?\\b`, 'g');

/** Utilities whose value is a size or a position, not a colour from the theme. */
const NOT_COLOUR = /^(?:min|max)?-?(?:w|h|p[trblxy]?|m[trblxy]?|inset|top|left|right|bottom|gap|space|text|leading|tracking|z|order|basis|grid|col|row|flex|opacity|scale|rotate|translate|duration|delay|indent)-$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

describe('colour tokens', () => {
  it('has a scale for every colour class written in src/', () => {
    const bad: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(CLASS_RE)) {
        const [whole, family, suffix] = match;
        // `text-surface`-style utilities where the FAMILY is also a Tailwind
        // scale word would be ambiguous; none of ours are, so a bare match on
        // the family with no utility prefix is prose, not a class.
        const prefix = whole.slice(0, whole.length - (family + (suffix ?? '')).length);
        if (prefix === '' || NOT_COLOUR.test(prefix)) continue;
        const token = `${family}${suffix ?? ''}`;
        if (!VALID.has(token)) bad.push(`${file.slice(SRC.length + 1)}: ${whole}`);
      }
    }
    // Named, not counted: the point of failing is to say which one.
    expect(bad).toEqual([]);
  });

  it('rejects a shade the theme does not define', () => {
    // The check is only worth having if it can fail — `surface-200` is the
    // exact class that shipped, and it must not be in the palette.
    expect(VALID.has('surface-200')).toBe(false);
    expect(VALID.has('surface-sunken')).toBe(true);
    expect(VALID.has('brand-50')).toBe(true);
    expect(VALID.has('good')).toBe(true);
  });
});
