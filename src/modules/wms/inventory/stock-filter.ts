import { sql, type SQL } from 'drizzle-orm';
import { clients, receiptLots, receipts } from '../../platform/db/schema';
import { likeNeedle } from '../search/query';

/**
 * What the /stock search box matches — ONE predicate, read by the screen AND
 * by its XLSX (#513): client code, the two product names and the unclaimed
 * marking, with the wildcards escaped like every other search box
 * (`likeNeedle`). The marking is where a factory's own text code lives
 * (numbers, a name, letters — DECISIONS #1224), so a fragment of it finds
 * the lot. The parentheses stay: the caller ANDs this onto its scope.
 *
 * The caller joins `receipts`, `receipt_lots` and (LEFT) `clients`.
 */
export function stockTextWhere(q: string): SQL {
  const like = likeNeedle(q.trim());
  const text = sql`${clients.clientCode} ILIKE ${like} OR ${receiptLots.productNameZh} ILIKE ${like} OR ${receiptLots.productNameRu} ILIKE ${like} OR ${receipts.unclaimedMarking} ILIKE ${like}`;
  return sql`(${text})`;
}
