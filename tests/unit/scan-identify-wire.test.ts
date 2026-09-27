import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A factory barcode on a scan screen IDENTIFIES and never counts (0112, the
 * owner's Q10 c; decision 41). Source-shape, comments stripped (#725), because
 * both wrong orders WORK — they just queue a barcode, which unload then
 * answers «unknown code» with the unclaimed-intake toast, and loading answers
 * with the red not-on-plan confirm.
 */

const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const SCREENS = [
  'src/app/(protected)/batches/[id]/load/loading-screen.tsx',
  'src/app/(protected)/batches/[id]/unload/unload-screen.tsx',
];

/** The body of `function onCode(…)` up to its first top-level `return` branch set. */
function onCodeBody(source: string): string {
  const start = source.indexOf('function onCode(');
  expect(start, 'onCode exists').toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n  }\n', start));
}

describe('the identify branch on the scan screens', () => {
  for (const file of SCREENS) {
    const source = strip(readFileSync(file, 'utf8'));
    const body = onCodeBody(source);

    it(`${file.split('/').at(-2)}: asks the barcode question BEFORE the sendable one`, () => {
      const barcode = body.indexOf('lotsForBarcode(');
      expect(barcode).toBeGreaterThan(-1);
      expect(barcode).toBeLessThan(body.indexOf('isSendableCode('));
      // …and only for a code that is not one of ours.
      expect(body.indexOf('isOwnCodeShape(')).toBeLessThan(barcode);
    });

    it(`${file.split('/').at(-2)}: the branch opens the sheet and queues nothing`, () => {
      const branch = body.slice(body.indexOf('isOwnCodeShape('), body.indexOf('isSendableCode('));
      expect(branch).toContain('setIdentify(');
      expect(branch).toContain('return');
      expect(branch).not.toMatch(/\baccept\(|enqueueScan\(/);
    });

    it(`${file.split('/').at(-2)}: the scanner pauses while the sheet is open`, () => {
      expect(source).toMatch(/<Scanner\s[^>]*active=\{[^}]*identify === null/);
      expect(source).toContain('<BarcodeIdentify');
      expect(source).toMatch(/lotBarcodes \?\? \[\]/);
      expect(source).toContain('data-testid="scan-mode-barcode"');
      expect(source).toContain('data-testid="manual-open"');
    });
  }

  it('ships the lot barcodes in the scan snapshot', () => {
    const route = strip(readFileSync('src/app/api/batches/[id]/planned/route.ts', 'utf8'));
    expect(route).toMatch(/lotBarcodes,/);
  });

  it('keeps the identify sheet free of anything that moves a carton', () => {
    const sheet = strip(readFileSync('src/components/barcode-identify.tsx', 'utf8'));
    expect(sheet).not.toMatch(/enqueueScan|flushScans|Action\(/);
    expect(sheet).toContain('countHref');
  });
});
