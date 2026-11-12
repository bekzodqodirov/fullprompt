import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A page opened AT an anchor stays there.
 *
 * The workspace tab strip sits in the protected LAYOUT, so whatever its
 * effects do, they do on every page — after the browser has already landed
 * on the address's `#fragment`. It used to call `scrollIntoView` on its lit
 * tab «to bring it into view on a phone». That call scrolls every scrollable
 * ancestor, the window included: on a desktop, where the row cannot scroll
 * sideways at all, its only effect was to pull an anchored page back up to
 * the strip one frame after it had landed (measured on a prixod card at
 * 1280: scrollY 322, then 63). «🔗 Bitim biriktirish» (`#bitim`), a lot's
 * address (`#lot-…`) and a thread's (`#ichki`) all opened at the top for
 * everybody whose strip lights a tab on that page.
 *
 * The behaviour is the browser spec's (`m9zzzi-prixod-xabari.desktop`). This
 * file is the fence for the CAUSE, which no behavioural unit test can see:
 * layout chrome never scrolls an element «into view» — it scrolls its own
 * row.
 */

const read = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')
    // Comments explain the rule in the rule's own words; only code counts.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('layout chrome does not scroll the window', () => {
  it('the workspace strip moves its own row sideways and never calls scrollIntoView', () => {
    const strip = read('src/components/ui/ws-tabs.tsx');
    expect(strip).not.toMatch(/scrollIntoView/);
    // …and it still brings the lit tab into view: the row's scrollLeft, from the two boxes.
    expect(strip).toMatch(/querySelector\('\[aria-current\]'\)/);
    expect(strip).toMatch(/\.scrollLeft\s*[-+]=/);
  });

  it('nothing else the protected layout mounts on every page calls it either', () => {
    const layout = read('src/app/(protected)/layout.tsx');
    // The layout's own imports from components/ — each is on every page.
    const mounted = [...layout.matchAll(/from '@\/components\/([\w/-]+)'/g)].map((match) => `src/components/${match[1]}.tsx`);
    expect(mounted.length).toBeGreaterThan(5);
    const callers = mounted.filter((file) => {
      try {
        return /scrollIntoView/.test(read(file));
      } catch {
        return false; // a .ts module, not a component
      }
    });
    expect(callers).toEqual([]);
  });
});
