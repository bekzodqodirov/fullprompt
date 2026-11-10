import { sql, type SQL } from 'drizzle-orm';
import { clients, receiptLots, receipts } from '../../platform/db/schema';
import { withoutLabelCount } from '../../platform/text/label-count';
import { tarkibLineMatchSql } from '../receipts/lot-name';
import { likeNeedle } from '../search/query';

/**
 * What the /stock search box matches — ONE predicate, read by the screen AND
 * by its XLSX (#513): client code, the two product names and the unclaimed
 * marking, with the wildcards escaped like every other search box
 * (`likeNeedle`). The marking is where a factory's own text code lives
 * (numbers, a name, letters — DECISIONS #1224), so a fragment of it finds
 * the lot. The parentheses stay: the caller ANDs this onto its scope.
 *
 * Since 2026-11-10 the row's Russian name is the tarkib's while one stands
 * («Клавиатура +2», `receipts/lot-name.ts`), so the box also finds a lot by
 * ANY line of its tarkib — «мышь» is the second line and no stored name —
 * and a label copied off a row is searched without its count: no stored
 * name and no line says «+2». The lot's own stored names still match (the
 * word on the sticker must go on finding the carton).
 *
 * The caller joins `receipts`, `receipt_lots` and (LEFT) `clients`.
 */
export function stockTextWhere(q: string): SQL {
  const like = likeNeedle(withoutLabelCount(q));
  const text = sql`${clients.clientCode} ILIKE ${like} OR ${receiptLots.productNameZh} ILIKE ${like} OR ${receiptLots.productNameRu} ILIKE ${like} OR ${tarkibLineMatchSql(sql`${receiptLots}`, like)} OR ${receipts.unclaimedMarking} ILIKE ${like}`;
  return sql`(${text})`;
}
