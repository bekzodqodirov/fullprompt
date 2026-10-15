import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { freshAnswer, shownRefusal, type ServerAnswer } from '@/app/(protected)/batches/[id]/rename-state';

/**
 * The truck-rename form's refusal line (a reviewer's reproduction at 360 px):
 * the server's «bu nom band» outlived the moment it described — it stood
 * after «Bekor qilish» and ✏️ again under the truck's OWN name, and under a
 * free name typed afterwards, beside a Save greyed for an unrelated reason,
 * reading as if THAT name were taken. The rule is pure (rename-state.ts) and
 * proven here; the form's wiring to it is pinned source-shape below, because
 * the component itself runs only in a browser.
 */
describe('which refusal the form shows', () => {
  const taken: ServerAnswer = { error: 'code_taken' };

  it('a fresh server answer is shown — and the same refusal twice is two answers', () => {
    expect(shownRefusal(null, taken, null, null)).toEqual({ error: 'code_taken', detail: undefined });
    const again: ServerAnswer = { error: 'code_taken' };
    expect(shownRefusal(null, again, taken, null)).toEqual({ error: 'code_taken', detail: undefined });
  });

  it('an answer the person moved past (reopened, or typed since) is not shown', () => {
    expect(shownRefusal(null, taken, taken, null)).toBeNull();
    expect(freshAnswer(taken, taken)).toBeNull();
  });

  it('once dismissed, the live Cyrillic warning speaks again; the browser’s own pre-check always wins', () => {
    const live = { error: 'code_cyrillic' };
    expect(shownRefusal(null, taken, taken, live)).toEqual(live);
    const local = { error: 'code_shape', detail: 'lot' };
    expect(shownRefusal(local, taken, null, live)).toEqual(local);
  });

  it('a success is dismissed the same way (the ✅ does not survive reopening)', () => {
    const saved: ServerAnswer = { ok: true, changed: true };
    expect(freshAnswer(saved, null)).toBe(saved);
    expect(freshAnswer(saved, saved)).toBeNull();
  });
});

const strip = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('the form is wired to the rule', () => {
  const FORM = strip(readFileSync('src/app/(protected)/batches/[id]/batch-code-form.tsx', 'utf8'));

  it('shows the refusal through shownRefusal, never state.error directly', () => {
    expect(FORM).toContain('shownRefusal(local, state, dismissed, live)');
    expect(FORM).not.toMatch(/state\.error\s*\?/);
  });

  it('opening the form dismisses the answer that stood', () => {
    const open = FORM.slice(FORM.indexOf('const openForm'), FORM.indexOf('};', FORM.indexOf('const openForm')));
    expect(open).toContain('setDismissed(state)');
  });

  it('every input of both modes moves past the answer when typed in', () => {
    const moveOn = FORM.slice(FORM.indexOf('const moveOn'), FORM.indexOf('};', FORM.indexOf('const moveOn')));
    expect(moveOn).toContain('setDismissed(state)');
    // The loading code box, the road code box and the reason box.
    const handlers = [...FORM.matchAll(/onChange=\{\(e\) => \{([\s\S]*?)\}\}/g)].map((m) => m[1]!);
    expect(handlers).toHaveLength(3);
    for (const handler of handlers) expect(handler).toContain('moveOn()');
  });
});
