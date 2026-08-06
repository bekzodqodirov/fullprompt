'use client';

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';

/**
 * Which cards are ticked — held OUTSIDE the board's render.
 *
 * The owner, 2026-08-06: «umumiy belgilash … juda qotib ishlayabti, bosganda
 * qotib qolyabti». Measured on his own data before touching anything: his
 * funnel puts 298 open leads on the board, both board shapes are mounted at
 * once (`md:hidden` / `hidden md:block` is CSS, not a condition), so 596 card
 * subtrees are live. The selection was a `useState<Set>` in the board's
 * parent, so every tick minted a new Set, re-rendered the parent, and through
 * it re-rendered all 596 cards to change ONE checkbox: 135-400 ms of frozen
 * main thread per tick on a mid-range phone. Ten cards is three seconds of
 * dead screen.
 *
 * So the ticks stop being React state. This is a tiny store with per-id
 * subscriptions: a checkbox subscribes to its OWN id, the bulk bar subscribes
 * to the count, and NOTHING else is told anything. The board does not
 * re-render at all — the object handed to it never changes identity — and a
 * tick costs one checkbox plus one number.
 *
 * `useSyncExternalStore` for the same reason `components/composer.ts` uses it:
 * it is the supported way to read a value that lives outside React without
 * tearing under concurrent rendering.
 */
export interface Selection {
  /** Subscribe this checkbox to its own id, and nothing else. */
  useIsSelected: (id: string) => boolean;
  /** Subscribe to how many are ticked — the bulk bar's whole interest. */
  useCount: () => number;
  toggle: (id: string) => void;
  clear: () => void;
  /** Read at press time; never a render input, so it wakes nobody. */
  ids: () => string[];
}

export function useSelection(): Selection {
  const picked = useRef<Set<string>>(new Set());
  // Per-id listeners plus the count's own, so a tick on card A never wakes
  // card B. A Map of Sets rather than one listener list for exactly that.
  const perId = useRef<Map<string, Set<() => void>>>(new Map());
  const counters = useRef<Set<() => void>>(new Set());

  const subscribeId = useCallback((id: string, notify: () => void) => {
    let listeners = perId.current.get(id);
    if (!listeners) {
      listeners = new Set();
      perId.current.set(id, listeners);
    }
    listeners.add(notify);
    return () => {
      listeners!.delete(notify);
      if (listeners!.size === 0) perId.current.delete(id);
    };
  }, []);

  const fire = useCallback((ids: string[]) => {
    for (const id of ids) for (const notify of perId.current.get(id) ?? []) notify();
    for (const notify of counters.current) notify();
  }, []);

  return useMemo<Selection>(() => {
    const store: Selection = {
      useIsSelected(id) {
        return useSyncExternalStore(
          useCallback((notify: () => void) => subscribeId(id, notify), [id]),
          () => picked.current.has(id),
          () => false,
        );
      },
      useCount() {
        return useSyncExternalStore(
          useCallback((notify: () => void) => {
            counters.current.add(notify);
            return () => counters.current.delete(notify);
          }, []),
          () => picked.current.size,
          () => 0,
        );
      },
      toggle(id) {
        if (picked.current.has(id)) picked.current.delete(id);
        else picked.current.add(id);
        fire([id]);
      },
      clear() {
        const was = [...picked.current];
        picked.current.clear();
        fire(was);
      },
      ids: () => [...picked.current],
    };
    return store;
  }, [subscribeId, fire]);
}
