/**
 * The factory's own barcode on a carton (0112, the owner's Q10 c): identical
 * on every carton of one lot, so it IDENTIFIES a pile — «which prixod is
 * this?» — and never moves one. It is never queued as a scan.
 *
 * ZERO imports: the scan screens, the receive wizard and the services all
 * normalise through this one function, so a code typed in Yiwu and a code
 * read by a camera in Tashkent are the same string.
 *
 * The key:
 *  - NFKC first — the Chinese IME types FULL-WIDTH digits («６９０…»), which
 *    look right and match nothing;
 *  - every whitespace out, upper-cased;
 *  - leading zeros off an ALL-DIGIT code, so the UPC-A, EAN-13 and GTIN-14
 *    readings of one product (`012345678905` / `0012345678905`) are one key.
 *
 * It names a PRODUCT, and one product arrives in many prixods from many
 * clients — hence no uniqueness anywhere, and identification lists candidates.
 */

/**
 * Kept literally equal to the CHECK in migration 0112; a unit test reads the
 * SQL and compares the two strings, because a key this function accepts and
 * the column refuses would fail a warehouse's confirm with a 23514.
 */
export const FACTORY_BARCODE_PATTERN = '^[A-Z0-9./+-]{4,48}$';
export const FACTORY_BARCODE_RE = new RegExp(FACTORY_BARCODE_PATTERN);

/** The canonical key of what was typed or read, or null when it cannot be one. */
export function factoryBarcodeKey(raw: string): string | null {
  const s = raw.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
  if (!s) return null;
  const key = /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
  return FACTORY_BARCODE_RE.test(key) ? key : null;
}

/** The lots on this screen whose barcode is what was just read. */
export function lotsForBarcode(
  code: string,
  lotBarcodes: readonly { lotId: string; key: string }[],
): string[] {
  const key = factoryBarcodeKey(code);
  return key ? lotBarcodes.filter((lot) => lot.key === key).map((lot) => lot.lotId) : [];
}
