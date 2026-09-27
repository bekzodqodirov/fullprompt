import { sql, type SQL } from 'drizzle-orm';
import { clients, receiptLots, receipts } from '../../platform/db/schema';
import { likeNeedle } from '../search/query';
import { factoryBarcodeKey } from '../receipts/factory-barcode';

/**
 * What the /stock search box matches — ONE predicate, read by the screen AND
 * by its XLSX (#513).
 *
 * It was restated verbatim in both files, so adding the factory barcode
 * (0112, Q10 c) to one would have made the table find a lot its own download
 * did not have. The text half is the one both always had — client code, the
 * two product names, the unclaimed marking — now with its wildcards escaped
 * like every other search box (`likeNeedle`); the barcode half is an EXACT
 * match on the canonical key through the partial index, because a scanned
 * EAN is a whole code, never a fragment.
 *
 * The caller joins `receipts`, `receipt_lots` and (LEFT) `clients`.
 */
export function stockTextWhere(q: string): SQL {
  const like = likeNeedle(q.trim());
  const text = sql`${clients.clientCode} ILIKE ${like} OR ${receiptLots.productNameZh} ILIKE ${like} OR ${receiptLots.productNameRu} ILIKE ${like} OR ${receipts.unclaimedMarking} ILIKE ${like}`;
  const key = factoryBarcodeKey(q);
  return key ? sql`(${text} OR ${receiptLots.factoryBarcode} = ${key})` : sql`(${text})`;
}
