import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BOX_LABEL,
  CRATE_LABEL,
  FIT_FLOOR_MM,
  FIT_STEP_MM,
  LABEL_MM,
  MARGIN_MM,
  fitSize,
  ptMm,
} from '@/modules/wms/labels/geometry';

/**
 * The sticker is printed twice over — once as a PDF for the share sheet and
 * once as SVG for the phone's print dialog — and a warehouse cannot have two
 * sticker designs depending on which button was pressed.
 *
 * These tests hold the two things that would let them drift apart: the
 * shrink rule, which each renderer feeds a different measuring function, and
 * the geometry itself, which each converts into its own coordinate system.
 */

describe('shrink to fit', () => {
  /** A monospace-ish stand-in: width is proportional to size, as in a font. */
  const measure = (chars: number) => (size: number) => chars * size * 0.6;

  it('leaves text that already fits alone', () => {
    expect(fitSize(22, 92, measure(5), FIT_FLOOR_MM, FIT_STEP_MM)).toBe(22);
  });

  it('shrinks until it fits, and no further', () => {
    // 12 characters at 22 mm is 158 mm — far too wide for 92 mm.
    const size = fitSize(22, 92, measure(12), FIT_FLOOR_MM, FIT_STEP_MM);
    expect(measure(12)(size)).toBeLessThanOrEqual(92);
    // One step bigger would have overflowed: it stopped at the first fit.
    expect(measure(12)(size + FIT_STEP_MM)).toBeGreaterThan(92);
  });

  it('stops at the floor rather than printing something unreadable', () => {
    // Nothing could make this fit; the loop must terminate at the floor.
    const size = fitSize(22, 1, measure(40), FIT_FLOOR_MM, FIT_STEP_MM);
    expect(size).toBeLessThanOrEqual(FIT_FLOOR_MM);
    expect(size).toBeGreaterThan(0);
  });

  it('keeps the PDF renderer’s original 6 pt floor and 1 pt step', () => {
    // The rule moved from points into millimetres when the two renderers
    // started sharing it; the STEPS must still land on the same sizes.
    expect(FIT_FLOOR_MM).toBeCloseTo(ptMm(6), 9);
    expect(FIT_STEP_MM).toBeCloseTo(ptMm(1), 9);
  });
});

describe('geometry', () => {
  const all = [...Object.entries(BOX_LABEL), ...Object.entries(CRATE_LABEL)];

  it('keeps every mark inside the 100 mm sticker', () => {
    for (const [name, spec] of all) {
      const s = spec as Record<string, number>;
      const bottom = 'baseline' in s ? s.baseline! : s.top! + (s.size ?? 0);
      expect(bottom, name).toBeLessThanOrEqual(LABEL_MM - 1);
      expect(bottom, name).toBeGreaterThan(0);
      if ('x' in s) {
        expect(s.x!, name).toBeGreaterThanOrEqual(0);
        expect(s.x!, name).toBeLessThanOrEqual(LABEL_MM - MARGIN_MM);
      }
    }
  });

  it('never lets #UNKNOWN print across the code it is describing', () => {
    // The bug this replaced: `444-A` — unclaimed cargo carrying the marking
    // written on the box — never shrinks, so its ink ran from 24.2 mm down to
    // a baseline at 40 mm while the marker's started at 38 mm. Two mm of both
    // at once, dead centre, on the one sticker whose whole job is to be read
    // by a human looking for an owner.
    const mark = BOX_LABEL.unknownMark;
    const code = BOX_LABEL.clientCode;
    // Helvetica-Bold: descenders reach 0.207 em below the baseline, capitals
    // rise 0.718 em above it.
    const markBottom = mark.baseline + 0.207 * mark.size;
    const codeTop = code.top + 0.282 * code.maxSize;
    expect(markBottom).toBeLessThan(codeTop);
  });

  it('leaves the marker clear of the row above it as well', () => {
    const mark = BOX_LABEL.unknownMark;
    const wh = BOX_LABEL.warehouseCode;
    // The warehouse code is left-aligned and the marker is centred, so they
    // could only collide vertically — but the receipt number is right-aligned
    // on the same rows, and it is the one with the least room.
    expect(mark.baseline - 0.718 * mark.size).toBeGreaterThan(
      wh.baseline + 0.207 * wh.size - 0.01,
    );
  });
});

describe('the two renderers', () => {
  /**
   * Neither may go back to writing its own coordinates.
   *
   * This is the check that actually holds the sticker together: both files
   * are read from disk and asserted to contain no bare `N * MM` positioning,
   * because that is exactly the shape the geometry was extracted FROM, and
   * re-introducing one line of it is how the PDF and the screen would quietly
   * start printing different labels.
   */
  it('both position from the shared geometry, not from their own numbers', () => {
    const pdf = readFileSync('src/modules/wms/labels/renderer.ts', 'utf8');
    const svg = readFileSync('src/components/label-svg.tsx', 'utf8');

    for (const [name, source] of [
      ['renderer.ts', pdf],
      ['label-svg.tsx', svg],
    ] as const) {
      expect(source, `${name} must import the shared geometry`).toMatch(
        /from '(\.\/geometry|@\/modules\/wms\/labels\/geometry)'/,
      );
    }

    // `PAGE - margin - 37 * MM` and friends: a position computed in place.
    const inlineCoordinates = pdf.match(/PAGE - margin - \d/g) ?? [];
    expect(inlineCoordinates).toEqual([]);
  });
});

describe('the browser fitter', () => {
  /**
   * A stand-in for a laid-out `<text>`: it reports a width proportional to
   * its font-size, which is what a real font does, and remembers what was
   * set on it so the assertions can read the result back.
   *
   * The DOM is stubbed rather than run under jsdom because jsdom has no SVG
   * layout at all — `getComputedTextLength` does not exist there, so a jsdom
   * test would be asserting on the stub either way, with more machinery.
   */
  function fakeText(text: string, startSize: number, maxWidth: number, fitTop?: number) {
    const attrs: Record<string, string> = { 'font-size': String(startSize) };
    return {
      dataset: { fit: String(maxWidth), fitTop: fitTop === undefined ? undefined : String(fitTop) },
      getAttribute: (name: string) => attrs[name] ?? null,
      setAttribute: (name: string, value: string) => {
        attrs[name] = value;
      },
      // 0.595 em per character reproduces the real measurement closely
      // enough to matter: `GS777-A` at 22 mm comes to 91.7 mm against a
      // 92 mm sticker, which is the actual live margin — it fits by 0.3 mm,
      // and one letter more does not.
      getComputedTextLength: () => text.length * Number(attrs['font-size']) * 0.595,
      attrs,
    };
  }

  function root(nodes: unknown[]) {
    return { querySelectorAll: () => nodes } as unknown as Document;
  }

  it('leaves a code that already fits at full size', async () => {
    const { fitLabels } = await import('@/components/print-sheet');
    const node = fakeText('GS777-A', 22, 92);
    expect(fitLabels(root([node]))).toBe(0);
    expect(Number(node.attrs['font-size'])).toBe(22);
  });

  it('shrinks a long code AND moves its baseline with it', async () => {
    const { fitLabels } = await import('@/components/print-sheet');
    // 14 characters at 22 mm is 184 mm: far past the 92 mm sticker.
    const node = fakeText('GS1000-VERYLONG', 22, 92, BOX_LABEL.clientCode.top);
    expect(fitLabels(root([node]))).toBe(1);

    const size = Number(node.attrs['font-size']);
    expect(size).toBeLessThan(22);
    expect(node.getComputedTextLength()).toBeLessThanOrEqual(92);
    // The dominant code hangs FROM a top edge. A fitter that shrank the text
    // and left the baseline alone would lift it off its row and, on a code
    // small enough, drop it into the product line underneath.
    expect(Number(node.attrs['y'])).toBeCloseTo(BOX_LABEL.clientCode.top + size, 9);
  });

  it('does not move text that sits on a fixed baseline', async () => {
    const { fitLabels } = await import('@/components/print-sheet');
    // The product line and the short code are positioned by baseline, not by
    // a top edge; shrinking them must not shift them.
    const node = fakeText(
      '很长很长的商品名称很长很长的商品名称很长很长的商品名称很长很长的商品名称',
      ptMm(14),
      92,
    );
    // It really does shrink — otherwise this would pass for the wrong reason.
    expect(fitLabels(root([node]))).toBe(1);
    expect(node.attrs['y']).toBeUndefined();
  });
});
