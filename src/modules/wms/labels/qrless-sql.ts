import { sql, type SQL } from 'drizzle-orm';
import { boxes, receiptLots } from '../../platform/db/schema';

/**
 * «QR-siz» (0112, the owner's Q8): the ONE sentence for «this carton has no
 * sticker of ours on it».
 *
 * A carton is QR-siz when it is uncrated (a crate carries its own CR- label
 * and is scanned as the crate), its lot was declared «QR yopishtirilmadi»,
 * and no label has been printed for it SINCE that declaration. A timestamp
 * on the lot and not a flag on the box: a lot of sacks gets marked, a sheet
 * is stuck on some of them later, the lot gets re-marked — and only the order
 * of the two stamps can say which cartons the sheet covered. There is no
 * second per-box writer to keep in step.
 *
 * Every reader — the stocktake, the print list, the scan screens' count-only
 * rows, the phone's refusal — asks through here, so the stocktake and the
 * scanner can never disagree about which carton is stickerless (#513).
 *
 * `box` and `lot` are table references, never columns (#128): pass
 * `sql\`b\`` / `sql\`l\`` for aliases, or the drizzle table objects.
 */
export function qrlessRowSql(box: SQL, lot: SQL): SQL {
  return sql`(${box}.crate_id IS NULL AND ${lot}.qr_skipped_at IS NOT NULL
    AND (${box}.label_printed_at IS NULL OR ${box}.label_printed_at < ${lot}.qr_skipped_at))`;
}

/** The same sentence where `boxes` and `receipt_lots` are already joined unaliased. */
export function qrlessJoinedSql(): SQL {
  return qrlessRowSql(sql`${boxes}`, sql`${receiptLots}`);
}

/** The same sentence over `boxes` alone — the lot is looked up. */
export function qrlessBoxSql(): SQL {
  return sql`(${boxes}.crate_id IS NULL AND EXISTS (
    SELECT 1 FROM receipt_lots ql
    WHERE ql.id = ${boxes}.lot_id AND ${qrlessRowSql(sql`${boxes}`, sql`ql`)}
  ))`;
}

/**
 * The most stickers one print sheet carries. A lot of 2,000 sacks is printed
 * in sheets, never in one document a phone cannot open (#758: a cap is said,
 * never silent).
 */
export const QRLESS_SHEET_CAP = 500;
