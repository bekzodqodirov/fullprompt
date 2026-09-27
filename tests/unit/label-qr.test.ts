import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { QR_ECC, QR_MARGIN_MODULES, QR_MM } from '@/modules/wms/labels/geometry';

/**
 * The label's QR moved from error correction M to Q (QR-siz round). The
 * promise that made the move free: every code we ship stays QR VERSION 1 —
 * 21 modules — so the module printed on the sticker is exactly as large as
 * before, and all the extra is error correction for a label rubbed, wet or
 * glared on the road. This measures that promise with the library that draws
 * the sticker, over the code shapes `wms/codes.ts` mints:
 *   box   `{WH}{YY}-{000000}`   crate `CR-{WH}{YY}-{00000}`
 * at their widest sequence, for the warehouse codes that exist and the
 * longest one the warehouse form accepts (10 characters).
 */

const SHIPPED_WAREHOUSES = ['YW', 'GZ', 'KA', 'TAS1', 'TAS2', 'AND', 'UCH'];
const box = (wh: string) => `${wh}26-999999`;
const crate = (wh: string) => `CR-${wh}26-99999`;
const version = (code: string) => QRCode.create(code, { errorCorrectionLevel: QR_ECC }).version;
/** Modules across the printed square, quiet zone included. */
const modulesAcross = (v: number) => 17 + 4 * v + 2 * QR_MARGIN_MODULES;
const mmPerModule = (code: string) => QR_MM / modulesAcross(version(code));

describe('the label QR at its error-correction level', () => {
  it('is Q', () => {
    expect(QR_ECC).toBe('Q');
  });

  it('keeps every shipped box and crate code at version 1, so the printed module is unchanged', () => {
    for (const wh of [...SHIPPED_WAREHOUSES, 'ABCDE']) {
      expect(version(box(wh)), box(wh)).toBe(1);
      expect(version(crate(wh)), crate(wh)).toBe(1);
      expect(mmPerModule(box(wh))).toBeGreaterThanOrEqual(1.3);
    }
  });

  it('keeps even a ten-character warehouse code at version 2 or less (still over 1.15 mm a module)', () => {
    const longest = 'ABCDEFGHIJ';
    for (const code of [box(longest), crate(longest)]) {
      expect(version(code), code).toBeLessThanOrEqual(2);
      expect(mmPerModule(code)).toBeGreaterThanOrEqual(1.15);
    }
  });
});

/**
 * Every renderer that draws a QR takes the level from the ONE constant — the
 * PDF sticker, the crate sticker and the phone's print sheet must never
 * disagree about what a label is (#232's two renderers, one geometry).
 * Derived over `src/`, so a fourth renderer written with a literal is found
 * the day it is added.
 */
describe('who decides the level', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) files.push(full);
    }
  };
  walk(path.join(process.cwd(), 'src'));

  it('is the constant, everywhere a level is named', () => {
    const sites = files.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/errorCorrectionLevel:\s*([^,\n}]+)/g)].map((m) => ({
        file: path.relative(process.cwd(), f),
        value: m[1]!.trim(),
      })),
    );
    // renderer.ts twice (box + crate), sheet.ts once — the three we know draw one.
    expect(sites.length).toBeGreaterThanOrEqual(3);
    expect(sites.filter((s) => s.value !== 'QR_ECC')).toEqual([]);
  });

  it('leaves no literal M in the label renderers', () => {
    for (const f of ['src/modules/wms/labels/renderer.ts', 'src/modules/wms/labels/sheet.ts']) {
      const src = readFileSync(path.join(process.cwd(), f), 'utf8');
      expect(src, f).not.toMatch(/errorCorrectionLevel:\s*['"]M['"]/);
      expect(src, f).toMatch(/margin:\s*QR_MARGIN_MODULES/);
    }
  });
});
