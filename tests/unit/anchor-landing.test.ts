import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A page opened AT an anchor stays there.
 *
 * The workspace tab strip sits in the protected LAYOUT, so whatever its
 * effects do, they do on every page — after the browser has already landed
 * on the address's `#fragment`. It used to call `scrollIntoView` on its lit
 * tab «to bring it into view on a phone». That call scrolls every scrollable
 * ancestor, the window included: on a desktop, where the row cannot scroll
 * sideways (\`md:overflow-hidden\`, and the fold's re-render puts it back at its
 * start), its only visible effect was to pull an anchored page back up to
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

  it('nothing the protected layout mounts on every page — followed through every import — scrolls the window', () => {
    // The layout's chrome, CLOSED transitively: a component the layout mounts
    // mounts its own imports on every page too (the dock's bubbles, the
    // composer). The first version of this fence read the layout's direct
    // imports only — 12 of the 25 modules (the merged card's review, T2).
    const closure: string[] = [];
    const queue = ['src/app/(protected)/layout.tsx'];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (closure.includes(file)) continue;
      closure.push(file);
      for (const match of readFileSync(join(process.cwd(), file), 'utf8').matchAll(/from '(@\/components\/[^']+|\.{1,2}\/[^']+)'/g)) {
        const spec = match[1]!;
        const base = normalize(spec.startsWith('@/') ? join('src', spec.slice(2)) : join(dirname(file), spec));
        const hit = ['.tsx', '.ts', '/index.tsx', '/index.ts'].map((ext) => base + ext).find((path) => existsSync(join(process.cwd(), path)));
        if (hit) queue.push(hit);
      }
    }
    // The walk is real: the strip, the dock and a module only the dock imports.
    expect(closure.length).toBeGreaterThanOrEqual(20);
    expect(closure).toEqual(expect.arrayContaining(['src/components/ui/ws-tabs.tsx', 'src/components/dock.tsx', 'src/components/composer.ts']));

    const scrolls = closure.filter((file) => /scrollIntoView|\.scrollTo\(|\.scrollBy\(|window\.scroll/.test(read(file)));
    expect(scrolls).toEqual([]);
    // A focus without `preventScroll` scrolls its element into view, so a
    // mount-time focus would pull an anchored page just the same. The two that
    // exist run inside a panel a person has OPENED (⌘K, «+ Yangi») — a closed
    // list, so a new one is looked at before it ships.
    const focuses = closure.filter((file) => /autoFocus|\.focus\(/.test(read(file))).sort();
    expect(focuses).toEqual(['src/components/quick-create.tsx', 'src/components/search-palette.tsx']);
  });
});
