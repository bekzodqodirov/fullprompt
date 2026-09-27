import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-shape fences for the workspace shell (2026-09-26). Both versions of
 * each of these WORK — nothing a render test sees can tell them apart until a
 * phone at 360 px or a spec in another file finds out.
 */

const root = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

function walk(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? walk(path) : [path];
  });
}

describe('the strip costs what the screens below it pay', () => {
  it('is 44 px tall with 12 under it, pulled 16 into main’s padding — the 41 px of --ws-strip', () => {
    const strip = read('src/components/ui/ws-tabs.tsx');
    expect(strip).toContain('-mx-4 -mt-4 mb-3 border-b');
    expect(strip).toContain('flex h-11 items-center');
    expect(read('src/app/globals.css')).toMatch(/--ws-strip:\s*41px;/);
  });

  it('is paid by every viewport-height screen it sits above, through the one variable', () => {
    // The desktop board and the chat thread. A bare «41px» anywhere would be
    // the copied constant this variable exists to replace.
    expect(read('src/components/kanban.tsx')).toContain('100dvh-6rem-var(--ws-strip)-var(--board-extra,0px)');
    expect(read('src/app/(protected)/suhbatlar/[clientId]/page.tsx')).toContain(
      'md:h-[calc(100dvh-6.5rem-var(--ws-strip))]',
    );
    for (const file of walk('src').filter((path) => /\.(tsx?|css)$/.test(path))) {
      expect(read(file), file).not.toMatch(/100dvh-[^\]]*41px/);
    }
  });
});

describe('the strip never hijacks a page’s own form', () => {
  it('has no <form> and only type="button" controls', () => {
    // Dozens of specs submit with `main form button[type="submit"]`.first();
    // a star inside a <form action> would be that first button on every page.
    const strip = read('src/components/ui/ws-tabs.tsx');
    expect(strip).not.toMatch(/<form\b/);
    expect(strip).not.toMatch(/type="submit"/);
  });
});

describe('«+ Yangi → Hisoblatish» only ever OPENS the calc panel', () => {
  it('is the one producer of ?yangi=hisob, and the two cards read nothing else', () => {
    // A default-open regression would turn every spec's click on the
    // calc-panel summary into a CLOSE.
    // Comments stripped first: a sentence explaining the link is not a link
    // (#725 — a fence that matches its own explanation).
    const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const producers = walk('src')
      .filter((path) => /\.tsx?$/.test(path))
      .filter((path) => code(path).includes('yangi=hisob'));
    expect(producers).toEqual([join('src', 'components', 'quick-create.tsx')]);
    for (const card of ['src/app/(protected)/crm/leads/[id]/page.tsx', 'src/app/(protected)/bitimlar/[id]/page.tsx']) {
      expect(read(card)).toContain("forceOpen={yangi === 'hisob'}");
    }
  });
});
