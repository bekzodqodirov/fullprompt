import { sql, type SQL } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { isServerBehind } from '../../platform/db/errors';
import { MIN_STORED_LINES } from './composition-math';

/**
 * The Russian name a lot is SHOWN under (the owner's items 3-4, 2026-11-10;
 * docs/TARKIB-TUZATISH.md §3): while a lot tarkibi stands, every screen, list
 * and message that prints the lot's Russian name prints the tarkib's instead
 * — one line → its name, several → «first +N» (`tarkibLabel`,
 * composition-math.ts, the pure twin this module is pinned against).
 *
 * DERIVED, never written. The stored `receipt_lots.product_name_ru` stays the
 * warehouse's own word, because a dozen readers use it as the lot's identity
 * and each would fail in silence on a label: the customs papers of a truck
 * whose papers went before the tarkib was stated, the TNVED memory's Russian
 * name and the hints matched against it, two model prompts, the price
 * history's needle, the sticker, the person's ✅ snapshot — and `editLot`
 * re-posts the name from a form with no compare-and-set. Derived, the label
 * exists exactly while the lines do: a clear, a torn header or a raw write
 * all read right by themselves, and a reader that forgets this module shows
 * yesterday's name, which is visible and harmless.
 *
 * This is the ONE home of the rule (#513) and the only reader of the lines
 * table besides `lot-composition.ts`, the price history and the TNVED hints.
 * Display readers import THIS module — never the composition tables
 * (`tests/unit/lot-composition-fence.test.ts`).
 *
 * `lot` is a TABLE reference, never a column (#128: drizzle renders a column
 * unqualified in a single-table select, and inside a correlated subquery it
 * would bind to the subquery's own table): pass `sql\`${receiptLots}\`` for a
 * joined table or `sql\`l\`` for an alias. The lines' alias is `tarkib_line`,
 * a name no caller's query uses.
 */

/** «first +N» over one lot's lines — NULL when the lot has none. */
function labelSql(lot: SQL): SQL {
  return sql`(SELECT CASE WHEN count(*) = 1 THEN min(tarkib_line.name)
                          ELSE (array_agg(tarkib_line.name ORDER BY tarkib_line.seq))[1] || ' +' || (count(*) - 1)
                     END
                FROM lot_composition_lines tarkib_line
               WHERE tarkib_line.lot_id = ${lot}.id
              HAVING count(*) >= ${MIN_STORED_LINES})`;
}

/**
 * The Russian name to SHOW: the tarkib's label, else the lot's own. Drop-in
 * for `<lot>.product_name_ru` in a select list — a scalar subquery through
 * `lot_composition_lines_lot_seq_unique`, legal in a grouped select that
 * groups by the lot's id (measured: 2.3 µs a lot row).
 */
export function lotRuShownSql(lot: SQL): SQL {
  return sql`coalesce(${labelSql(lot)}, ${lot}.product_name_ru)`;
}

/**
 * The ONE name a `ru || zh` reader prints: the shown Russian name, else the
 * Chinese one — `lot.productNameRu?.trim() || lot.productNameZh`, with the
 * tarkib's label first.
 */
export function lotGoodsShownSql(lot: SQL): SQL {
  return sql`coalesce(nullif(btrim(${lotRuShownSql(lot)}), ''), ${lot}.product_name_zh)`;
}

/**
 * A search predicate's extra arm: the lot has a tarkib LINE whose name
 * matches — so «мышь» finds the lot whose second line is mice, which no
 * stored name of the lot says. OR it into the screen's own zh/ru predicate.
 *
 * An uncorrelated ARRAY sub-select on purpose (#152): `EXISTS (… WHERE
 * lot_id = <lot>.id …)` inside an OR makes the planner filter every lot row
 * and lose the two trigram indexes the name arms use; this is evaluated once
 * (the lines table is a few thousand rows a year) and joins by the lot's key.
 */
export function tarkibLineMatchSql(lot: SQL, like: string): SQL {
  return sql`${lot}.id = ANY(ARRAY(
    SELECT tarkib_line.lot_id FROM lot_composition_lines tarkib_line WHERE tarkib_line.name ILIKE ${like}))`;
}

/**
 * The labels of the lots that HAVE a tarkib, by lot id — for a reader that
 * already holds whole lot rows: `shown.get(lot.id) ?? lot.productNameRu`.
 * One statement. `exec` defaults to `db` (`= db` in the signature, so the
 * tx-pool fence classifies it). A server without 0122 answers an empty map on
 * the pool; inside a transaction the error is rethrown — the failed statement
 * has aborted the caller's transaction.
 */
export async function lotRuShownFor(lotIds: readonly string[], exec: Db | Tx = db): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(lotIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) return out;
  let rows: { lot_id: string; label: string | null }[];
  try {
    rows = (await exec.execute(sql`
      SELECT tarkib_line.lot_id,
             CASE WHEN count(*) = 1 THEN min(tarkib_line.name)
                  ELSE (array_agg(tarkib_line.name ORDER BY tarkib_line.seq))[1] || ' +' || (count(*) - 1)
             END AS label
        FROM lot_composition_lines tarkib_line
       WHERE tarkib_line.lot_id IN (${sql.join(
         ids.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
       GROUP BY tarkib_line.lot_id
      HAVING count(*) >= ${MIN_STORED_LINES}
    `)) as unknown as typeof rows;
  } catch (err) {
    if (isServerBehind(err) && exec === db) return out;
    throw err;
  }
  for (const row of rows) if (row.label !== null) out.set(row.lot_id, row.label);
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
