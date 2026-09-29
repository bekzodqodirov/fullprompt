import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The factory barcode is RETIRED (DECISIONS #1224 — the owner: «zavotdan bar
 * code kelmaydi»). What a scan screen does with a retail barcode now is
 * REFUSE it as a foreign code, before anything is queued. Source-shape,
 * comments stripped (#725), because the wrong versions all WORK: without the
 * guard an 8-14 digit code fits the sync route's 3-40 characters and is
 * queued — unload answers it with the unclaimed-intake toast as if an unknown
 * carton had landed, loading with the red not-on-plan confirm.
 */

const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const SCREENS = [
  'src/app/(protected)/batches/[id]/load/loading-screen.tsx',
  'src/app/(protected)/batches/[id]/unload/unload-screen.tsx',
];

/** The body of `function onCode(…)`, to its closing brace. */
function onCodeBody(source: string): string {
  const start = source.indexOf('function onCode(');
  expect(start, 'onCode exists').toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n  }\n', start));
}

describe('the scan screens after the barcode', () => {
  for (const file of SCREENS) {
    const name = file.split('/').at(-2);
    const source = strip(readFileSync(file, 'utf8'));
    const body = onCodeBody(source);

    it(`${name}: refuses a retail barcode BEFORE the sendable check, and queues nothing`, () => {
      // The WHOLE condition, verbatim: only for a code that is not one of
      // ours (ours always carry a dash), and nothing else ANDed on — a
      // looser fence stayed green with `false && ` in front of it.
      const guard = body.indexOf('if (!isOwnCodeShape(code) && looksLikeRetailBarcode(code)) {');
      expect(guard).toBeGreaterThan(-1);
      expect(guard).toBeLessThan(body.indexOf('isSendableCode('));
      const branch = body.slice(guard, body.indexOf('return;', guard) + 'return;'.length);
      expect(branch).toContain("feedback('bad')");
      expect(branch).toContain("t('foreignCode')");
      expect(branch).not.toMatch(/\baccept\(|enqueueScan\(/);
    });

    it(`${name}: no identify sheet, no mode toggle, no barcodes in the snapshot`, () => {
      expect(source).not.toMatch(/BarcodeIdentify|lotsForBarcode|setIdentify|lotBarcodes|scanMode/);
      expect(source).not.toContain('scan-mode-barcode');
      // The camera reads our QR — no `mode` any more — and manual entry stays.
      expect(source).toMatch(/<Scanner\s+active[\s\S]{0,60}onCode=\{\(code\) => onCode\(code\)\}/);
      expect(source).toContain('data-testid="manual-open"');
    });
  }

  it('the issue counter picks a carton by its QR and nothing else', () => {
    const source = strip(readFileSync('src/app/(protected)/issue/issue-screen.tsx', 'utf8'));
    expect(source).not.toMatch(/factoryBarcode|pileLots|scanMode|scan-mode-barcode/);
    expect(source).toContain('<Scanner active onCode={onScan} />');
  });

  it('the snapshot and the issue list no longer carry the barcode', () => {
    for (const file of [
      'src/app/api/batches/[id]/planned/route.ts',
      'src/app/api/issue/list/route.ts',
    ]) {
      expect(strip(readFileSync(file, 'utf8'))).not.toMatch(/lotBarcodes|factoryBarcode/);
    }
  });

  it('the modules the barcode lived in are gone', () => {
    for (const file of [
      'src/components/barcode-identify.tsx',
      'src/modules/wms/receipts/factory-barcode.ts',
      'src/app/(protected)/stock/stock-scan-button.tsx',
    ]) {
      expect(existsSync(file), file).toBe(false);
    }
  });
});
