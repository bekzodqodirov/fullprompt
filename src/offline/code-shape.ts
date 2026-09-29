/**
 * What a scanned string LOOKS like, decided in the browser with nothing
 * imported (this file ships in the scan screens' bundle).
 *
 * Our own labels carry two shapes: a crate `CR-…`, and a carton whose code
 * ends in a dash and a zero-padded sequence (`YW26-000123`, `GS777-00012`).
 * Anything else a camera sees on a Chinese carton is somebody else's: a
 * supplier URL, a courier waybill, the factory's retail barcode.
 */
export function isOwnCodeShape(code: string): boolean {
  const c = code.trim();
  return /^CR-/i.test(c) || /-\d{5,}$/.test(c);
}

/**
 * A factory's retail barcode: EAN-8/13, UPC-A/E, ITF-14 — digits only,
 * 8 to 14 of them. It names a PRODUCT, never a carton, so the scan screens
 * refuse it as a foreign code instead of queueing it (DECISIONS #1224 — it
 * used to open an «identify the pile» sheet, retired with the barcode field).
 */
export function looksLikeRetailBarcode(code: string): boolean {
  return /^\d{8,14}$/.test(code.trim());
}
