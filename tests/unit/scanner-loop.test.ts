import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The camera loop's SHAPE, read from the source (QR-siz round, owner:
 * «bazida sekin o'qiyabti, QR ni ko'rishi bilan o'qimayabti»).
 *
 * A camera loop cannot run in vitest — there is no camera, no video frame and
 * no BarcodeDetector — so what is pinned here is the four ways the old loop
 * made the scanner slow, each of which is a line somebody could put back:
 *   - a timer that stacks detect() calls on a slow phone (`setInterval`);
 *   - the camera closed and reopened whenever the screen paused it (an effect
 *     keyed on `active` that stops the tracks) — every red confirm cost a
 *     camera start and a 4.5 s decoder trial;
 *   - a code emitted after the native await without asking whether the
 *     screen paused meanwhile (#244: a read under the red confirm);
 *   - a frozen or ended camera nobody notices.
 * The decisions themselves are called directly in
 * `scan-decoder-and-outbox.test.ts` (#166); this file only guards the wiring.
 *
 * Comments are stripped first (#725): the file explains every one of these
 * mistakes in prose, and a fence that reads the explanation as the code
 * passes on the bug.
 */

function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      if (ch === '\\') {
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const SRC = stripComments(
  readFileSync(path.join(process.cwd(), 'src/components/scan/scanner.tsx'), 'utf8'),
);

/** The text of the call whose opening parenthesis is at `open`, strings skipped. */
function callAt(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error('unbalanced call');
}

/** Every `useEffect(…)` in the component: its whole text and its dependency list. */
const EFFECTS = [...SRC.matchAll(/useEffect\(/g)].map((m) => {
  const text = callAt(SRC, m.index! + 'useEffect'.length);
  const deps = /,\s*\[([^\]]*)\]\s*\)$/.exec(text)?.[1];
  return { text, deps: deps === undefined ? null : deps.split(',').map((d) => d.trim()).filter(Boolean) };
});

describe('the scanner camera loop', () => {
  it('found the effects it is about to judge', () => {
    expect(EFFECTS.length).toBeGreaterThanOrEqual(4);
    expect(EFFECTS.every((e) => e.deps !== null)).toBe(true);
  });

  it('runs on no timer that can stack decoder calls', () => {
    expect(SRC).not.toContain('setInterval(');
  });

  it('is paced by the camera\'s frames, with the display\'s clock as the fallback', () => {
    expect(SRC).toContain('requestVideoFrameCallback(');
    expect(SRC).toContain('requestAnimationFrame(');
  });

  it('opens the camera in exactly one place, inside the effect that lives as long as the screen', () => {
    expect(SRC.match(/getUserMedia\(/g)).toHaveLength(1);
    const opener = EFFECTS.filter((e) => e.text.includes('getUserMedia('));
    expect(opener).toHaveLength(1);
    expect(opener[0]!.deps).toEqual([]);
  });

  it('never stops the camera from an effect that re-runs when the screen pauses or switches mode', () => {
    for (const e of EFFECTS) {
      if (e.deps!.some((d) => d === 'active' || d === 'mode')) {
        expect(e.text).not.toContain('.stop()');
      }
    }
  });

  it('asks whether the screen paused after the native detector answers, before handing on a code', () => {
    const awaited = SRC.indexOf('await nativeCall');
    expect(awaited).toBeGreaterThan(-1);
    const nextEmit = SRC.indexOf('emitAll(', awaited);
    expect(nextEmit).toBeGreaterThan(awaited);
    expect(SRC.slice(awaited, nextEmit)).toMatch(/!activeRef\.current\)\s*return/);
  });

  it('builds the native detector from the mode\'s formats and names no format itself', () => {
    expect(SRC).toMatch(/new Ctor\(\{\s*formats:\s*nativeFormatsFor\(/);
    expect(SRC).not.toMatch(/['"](code_128|ean_13|qr_code)['"]/);
  });

  it('reads `active` and `mode` through refs in the loop', () => {
    expect(SRC).toMatch(/activeRef\.current = active/);
    expect(SRC).toMatch(/modeRef\.current = mode/);
    expect(SRC).toMatch(/engineFor\(modeRef\.current\)/);
  });

  it('notices a camera that ended or froze while the phone was locked', () => {
    expect(SRC).toMatch(/addEventListener\('ended'/);
    expect(SRC).toMatch(/addEventListener\('visibilitychange'/);
  });
});
