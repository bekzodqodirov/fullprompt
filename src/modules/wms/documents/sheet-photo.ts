/**
 * A photograph as a spreadsheet carries it — one rule for the three sheets
 * that embed them (the packing list with photos, the agent's file, the stock
 * «Ostatka»), so a fix to one is a fix to all (#513).
 *
 * His report of 2026-10-21: «packing list sklad excellarida rasimlar
 * kachestvasini ozgartirmasin hozir hira korinyabti». Measured, three causes,
 * all here now:
 *
 *  1. The sheets embedded the 200-px THUMBNAIL — the list-screen copy — so a
 *     picture enlarged in Excel, or read on a high-density screen, was a
 *     smear of the carton's label. The documents now take the 800-px copy
 *     (`thumb800Key`, the app's own «open the photo» size), the original
 *     when that copy has not been made.
 *  2. It was compressed TWICE: WebP at 75 by the thumbnail job, then JPEG at
 *     70 for exceljs. The JPEG is now at 88.
 *  3. Every picture was drawn into a fixed 78×72 box whatever its shape, so a
 *     4:3 carton photo was squeezed. The box is kept (it is the row's size)
 *     and the picture is FITTED into it, its proportions intact.
 *
 * The stock sheet stays smaller (`SHEET_PHOTO_PX.stock`): it carries up to
 * three thousand pictures of a whole warehouse in one file built in memory by
 * the one Node process, and at 800 px that file would be hundreds of
 * megabytes. Double the old resolution, stated as the trade.
 */
export const SHEET_PHOTO_PX = { document: 800, stock: 400 } as const;

/** The cell box every sheet draws a photo into, in pixels (row height 60pt). */
export const SHEET_PHOTO_BOX = { width: 78, height: 72 } as const;

export interface SheetPhoto {
  buffer: Buffer;
  width: number;
  height: number;
}

/** The storage key to read for a sheet: the 800-px copy, else the original. */
export function sheetPhotoKey(att: { thumb800Key: string | null; storageKey: string }): string {
  return att.thumb800Key ?? att.storageKey;
}

/**
 * Bytes → a JPEG at most `longSide` px on its long side (exceljs embeds png and
 * jpeg only; the stored copies are WebP). Rotated by EXIF, for an original.
 */
export async function sheetPhoto(bytes: Buffer, longSide: number): Promise<SheetPhoto> {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(bytes)
    .rotate()
    .resize(longSide, longSide, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/** The picture's drawn size inside the cell box, its proportions kept. */
export function fitInBox(
  photo: { width: number; height: number },
  box: { width: number; height: number } = SHEET_PHOTO_BOX,
): { width: number; height: number } {
  if (photo.width <= 0 || photo.height <= 0) return { ...box };
  const scale = Math.min(box.width / photo.width, box.height / photo.height);
  return { width: Math.round(photo.width * scale), height: Math.round(photo.height * scale) };
}
