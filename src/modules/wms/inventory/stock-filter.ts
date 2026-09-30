import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { boxes, clients, crates, receiptLots, receipts } from '../../platform/db/schema';
import { isUuidShaped } from '../../platform/audit/fields';
import { warehouseScope } from '../../platform/rbac/scope';
import { likeNeedle } from '../search/query';
import { SHELF_STATUSES } from './service';

/**
 * What the /stock search box matches — ONE predicate, read by the screen AND
 * by its XLSX (#513): client code, the two product names and the unclaimed
 * marking, with the wildcards escaped like every other search box
 * (`likeNeedle`). The marking is where a factory's own text code lives
 * (numbers, a name, letters — DECISIONS #1224), so a fragment of it finds
 * the lot. The parentheses stay: the caller ANDs this onto its scope.
 *
 * …and the CR- code of the crate a carton stands in (2026-09-30): the rows
 * now say which crates they hold, and the code printed on a crate is what the
 * warehouse reads at the shelf. Matched per CARTON like everything else here,
 * so searching one crate narrows its row to exactly that crate's cartons and
 * the Σ still counts what the table shows. The membership is `crateHereOn`,
 * inside an EXISTS so no caller has to join `crates` for it — and when a
 * caller does (the crate read), the inner `crates` shadows the outer one.
 *
 * The caller joins `receipts`, `receipt_lots` and (LEFT) `clients`.
 */
export function stockTextWhere(q: string): SQL {
  const like = likeNeedle(q.trim());
  const text = sql`${clients.clientCode} ILIKE ${like} OR ${receiptLots.productNameZh} ILIKE ${like} OR ${receiptLots.productNameRu} ILIKE ${like} OR ${receipts.unclaimedMarking} ILIKE ${like}`;
  const crate = sql`EXISTS (SELECT 1 FROM ${crates} WHERE ${crateHereOn()} AND ${crates.code} ILIKE ${like})`;
  return sql`(${text} OR ${crate})`;
}

/**
 * A carton is IN a crate on the shelf when its crate is active and stands at
 * the carton's own warehouse — the rule round 107 wrote for the yashik strip,
 * now the one home every stock read joins through (`stock-crates.ts`, the
 * search above).
 *
 * Never the bare `boxes.crate_id`: a carton short-loaded at the origin (round
 * 31) keeps its crate pointer while the crate itself follows the landed half
 * to another country, and the bare pointer would count a carton standing in
 * Yiwu into a crate in Tashkent. Such a carton is LOOSE where it stands, and
 * that is how every row counts it.
 *
 * The caller adds the shelf statuses; this is only the membership.
 */
export function crateHereOn(): SQL {
  return and(
    eq(crates.id, boxes.crateId),
    eq(crates.status, 'active'),
    eq(crates.warehouseId, boxes.currentWarehouseId),
  )!;
}

/**
 * The stock screen's base filter — what is ON THE SHELF, where this person may
 * look, at the warehouse asked for — built once for the table, its Σ, its
 * crates and its export, so they cannot come to count different cartons.
 *
 * The export used to spell the status list out as a literal and bind its
 * `wh` unchecked, so `?wh=YW` answered a 22P02 error page there while the
 * screen ignored it; a `wh` that is not an id is dropped here, for everyone.
 * The search is NOT part of it: the drill-downs share this filter and never
 * see `q`, so the caller adds `stockTextWhere(q)` where the search applies.
 */
export function stockBoxFilter(
  actor: Parameters<typeof warehouseScope>[0],
  opts: { wh?: string | null },
): SQL[] {
  const filters: SQL[] = [inArray(boxes.status, [...SHELF_STATUSES])];
  const scope = warehouseScope(actor, boxes.currentWarehouseId);
  if (scope) filters.push(scope);
  if (opts.wh && isUuidShaped(opts.wh)) filters.push(eq(boxes.currentWarehouseId, opts.wh));
  return filters;
}
