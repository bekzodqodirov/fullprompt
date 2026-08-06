import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Where the funnel's ticks may live — a rule no behaviour test can see.
 *
 * The owner, 2026-08-06: «umumiy belgilash … juda qotib ishlayabti, bosganda
 * qotib qolyabti». Measured on his own data before anything was changed: 298
 * open leads, both board shapes mounted at once (`md:hidden` / `hidden
 * md:block` is CSS, not a condition) = 596 live card subtrees. The selection
 * was `useState<Set<string>>` in each board's parent, so every tick minted a
 * new Set, re-rendered the parent, and re-rendered all 596 cards to flip ONE
 * checkbox: 135-400 ms of frozen main thread per tick at a 4x CPU throttle,
 * against a 33 ms measurement floor. After moving the ticks into a store with
 * per-id subscriptions the same measurement reads 35-66 ms — at the floor.
 *
 * Source-shape, like the chat-controls and style-cascade tripwires and for the
 * same reason: both versions WORK. The bulk e2e passes either way. What went
 * wrong is invisible to every assertion about behaviour and shows up only as a
 * warehouse phone that stops answering, so the only durable way to state it is
 * "the ticks are not React state on these screens".
 */

const read = (path: string) => readFileSync(path, 'utf8');

const BOARDS = [
  'src/app/(protected)/crm/leads/kanban.tsx',
  'src/app/(protected)/bitimlar/board.tsx',
];

describe('the funnel boards keep their ticks out of React state', () => {
  it('neither board holds the selection in useState', () => {
    for (const file of BOARDS) {
      const source = read(file);
      expect(source, file).toContain('useSelection()');
      // The exact shape that caused the freeze: a Set in component state.
      expect(source, file).not.toMatch(/useState<Set<string>>/);
      expect(source, file).not.toMatch(/new Set\(was\)/);
    }
  });

  it('the board is handed the store, never a Set it has to be re-rendered with', () => {
    const board = read('src/components/kanban.tsx');
    // A `Set` prop is a new object on every tick, which is the re-render.
    expect(board).not.toMatch(/ids:\s*Set<string>/);
    expect(board).toContain('selection.store.useIsSelected(id)');
  });

  it('the bulk bar reads the count from the store and the ids at press time', () => {
    const bar = read('src/components/list/bulk-bar.tsx');
    expect(bar).toContain('selection.useCount()');
    expect(bar).toContain('selection.ids()');
    // Not a number passed down: that would put the count back in the parent's
    // render, and the parent's render is the board's render.
    expect(bar).not.toMatch(/^\s*count: number;/m);
  });
});
