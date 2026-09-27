import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FACTORY_BARCODE_PATTERN,
  factoryBarcodeKey,
  lotsForBarcode,
} from '@/modules/wms/receipts/factory-barcode';
import { isOwnCodeShape, looksLikeRetailBarcode } from '@/offline/code-shape';

/**
 * The factory barcode's canonical key (0112, the owner's Q10 c): what the
 * wizard stores, what the scan screens compare, what the column's CHECK
 * accepts. Pure — the browser runs the same function.
 */

describe('factoryBarcodeKey', () => {
  it('reads the full-width digits a Chinese IME types', () => {
    expect(factoryBarcodeKey('６９０１２３４５６７８９２')).toBe('6901234567892');
  });

  it('makes the UPC-A and EAN-13 readings of one product the same key', () => {
    expect(factoryBarcodeKey('0012345678905')).toBe('12345678905');
    expect(factoryBarcodeKey('012345678905')).toBe('12345678905');
    expect(factoryBarcodeKey('12345678905')).toBe('12345678905');
  });

  it('strips every space and upper-cases, and keeps the zeros of a code that is not all digits', () => {
    expect(factoryBarcodeKey(' ab-12 34 ')).toBe('AB-1234');
    expect(factoryBarcodeKey('0A12')).toBe('0A12');
  });

  it('refuses what the column would refuse', () => {
    expect(factoryBarcodeKey('汉字')).toBeNull();
    expect(factoryBarcodeKey('')).toBeNull();
    expect(factoryBarcodeKey('   ')).toBeNull();
    expect(factoryBarcodeKey('AB1')).toBeNull(); // shorter than 4
    expect(factoryBarcodeKey('0000')).toBeNull(); // one digit once the zeros go
    expect(factoryBarcodeKey('X'.repeat(49))).toBeNull();
    expect(factoryBarcodeKey('https://detail.tmall.com/x')).toBeNull();
  });

  it('keeps the SAME pattern as migration 0112 writes into the CHECK', () => {
    // A key this function accepts and the column refuses would fail a
    // warehouse's confirm with a 23514; comments stripped before reading (#725).
    const sqlText = readFileSync('src/modules/platform/db/migrations/0112_qr_less.sql', 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    const match = /"factory_barcode"\s*~\s*'([^']+)'/.exec(sqlText);
    expect(match?.[1]).toBe(FACTORY_BARCODE_PATTERN);
  });
});

describe('the shapes a scan screen sorts a code by', () => {
  it('knows our own codes from a factory barcode', () => {
    expect(isOwnCodeShape('YW26-000123')).toBe(true);
    expect(isOwnCodeShape('CR-YW26-00001')).toBe(true);
    expect(isOwnCodeShape('6901234567892')).toBe(false);
    expect(looksLikeRetailBarcode('6901234567892')).toBe(true);
    expect(looksLikeRetailBarcode('1234567')).toBe(false);
    expect(looksLikeRetailBarcode('YW26-000123')).toBe(false);
  });

  it('finds the lots on the screen by the key, whatever reading of it was scanned', () => {
    const lots = [
      { lotId: 'a', key: '12345678905' },
      { lotId: 'b', key: '6901234567892' },
      { lotId: 'c', key: '12345678905' },
    ];
    expect(lotsForBarcode('0012345678905', lots)).toEqual(['a', 'c']);
    expect(lotsForBarcode('６９０１２３４５６７８９２', lots)).toEqual(['b']);
    expect(lotsForBarcode('9999999999999', lots)).toEqual([]);
    expect(lotsForBarcode('汉字', lots)).toEqual([]);
  });
});
