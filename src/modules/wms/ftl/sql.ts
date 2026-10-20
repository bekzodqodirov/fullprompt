import { sql, type SQL } from 'drizzle-orm';

/**
 * LTL / FTL (0135, the owner's 2026-10-20 answers): «biz odatda LTL boyicha
 * ishlaymiz va KPI sovrinlar shu LTL boyicha hsoblanadi agarda FTL bolsa bunga
 * kpi yozilmaydi va olib kelgan yuki KPI ga kirmaydi».
 *
 * ONE sentence for «is this prixod FTL», read by every cargo reader that must
 * tell the two apart: the KPI's cartons (staff/cargo.ts), the KPI's PAID part
 * (finance/unpriced.ts, the 'stamped' scope), the rating, the departure hint.
 * No project imports on purpose: `staff/cargo.ts` already imports
 * `finance/unpriced.ts`, so the shared fragment cannot live in either of them.
 *
 * No row in `receipt_load_mode` is LTL — the business's default — and only a
 * row whose mode is 'ftl' makes a prixod FTL (an 'ltl' row is the office's
 * hand-pin, which is still LTL).
 */

export type LoadMode = 'ltl' | 'ftl';
export const LOAD_MODES: readonly LoadMode[] = ['ltl', 'ftl'];

/** Which cargo a reader asks for. REQUIRED wherever cargo is summed (#790: an optional filter fails OPEN). */
export type LoadFilter = 'all' | LoadMode;

/**
 * The KPI counts LTL cargo only (the owner: «agarda FTL bolsa bunga kpi
 * yozilmaydi va olib kelgan yuki KPI ga kirmaydi»). ONE constant for the KPI's
 * readers (staff/kpi-service.ts), its paid part (kpi-paid.ts) and the rating's
 * points (staff/rating.ts — the KPI's competition), so none of them can drift.
 * A PAID month cannot move by it: a prixod's mode freezes once its month is
 * paid (staff/kpi-lock.ts, his 6a).
 */
export const KPI_LOAD = 'ltl' satisfies LoadFilter;

export const isLoadMode = (value: unknown): value is LoadMode => value === 'ltl' || value === 'ftl';

/** The prixod `receiptId` (an SQL expression naming its id) is FTL. */
export const receiptIsFtlSql = (receiptId: SQL): SQL =>
  sql`EXISTS (SELECT 1 FROM receipt_load_mode rlm WHERE rlm.receipt_id = ${receiptId} AND rlm.mode = 'ftl')`;

/** The clause a cargo reader puts in its WHERE for `filter`. */
export function loadFilterSql(receiptId: SQL, filter: LoadFilter): SQL {
  if (filter === 'all') return sql`true`;
  return filter === 'ftl' ? receiptIsFtlSql(receiptId) : sql`NOT ${receiptIsFtlSql(receiptId)}`;
}
