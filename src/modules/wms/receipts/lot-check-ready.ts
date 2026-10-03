import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';

/**
 * Are the check's tables there? (#472: a deploy whose migration did not land.)
 *
 * The check's readers JOIN `lot_checks` (0123) and the lot tarkibi's tables
 * (0122) inside the statements of the two screens the warehouse lives on —
 * the stock table and the plan editor's list — so a server running this code
 * on an older schema would take both down with a 42P01, while the check
 * itself is the least important thing on them (docs/YUK-TEKSHIRUV.md §8:
 * a check never blocks a plan). A reader asks this first and, on «no», runs
 * its pre-0123 shape: no joins, no chip, the `tek` filter ignored.
 *
 * A probe and not a catch: one catalog lookup (~0.1 ms), and the answer is
 * remembered once it is «yes» — tables do not disappear under a running
 * process. «No» is asked again every time, so the screens come back the
 * moment the migration lands, with no restart.
 */
let ready = false;

export async function lotChecksReady(): Promise<boolean> {
  if (ready) return true;
  const rows = (await db.execute(sql`
    SELECT to_regclass('public.lot_checks') IS NOT NULL
       AND to_regclass('public.lot_compositions') IS NOT NULL
       AND to_regclass('public.lot_composition_lines') IS NOT NULL AS ok
  `)) as unknown as { ok: boolean }[];
  ready = rows[0]?.ok === true;
  return ready;
}
