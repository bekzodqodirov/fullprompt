import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';

/**
 * Are 0132's tables there? (#472: a deploy whose migration did not land.)
 *
 * The warehouse form and the cost panel read the warehouse's tariff column
 * and the bills' frozen copies at RENDER; a server running this code on an
 * older schema would answer those pages with a 42P01. A reader asks this
 * first and, on «no», draws the pre-0132 shape: no column select on the
 * warehouse form (and so the field is ABSENT from its post — «leave it
 * alone»), the freight option disabled with «server yangilanmagan».
 *
 * The `lotChecksReady` idiom: one catalog lookup, remembered once it is «yes»
 * — tables do not disappear under a running process — and asked again on
 * «no», so the screens come back the moment the migration lands. Pool only,
 * pre-transaction only (#714, tests/unit/tx-pool.test.ts).
 */
let ready = false;

export async function freightTablesReady(): Promise<boolean> {
  if (ready) return true;
  try {
    const rows = (await db.execute(sql`
      SELECT to_regclass('public.warehouse_tariff_columns') IS NOT NULL
         AND to_regclass('public.cost_entry_tariffs') IS NOT NULL AS ok
    `)) as unknown as { ok: boolean }[];
    ready = rows[0]?.ok === true;
  } catch (error) {
    console.error('[freight] readiness probe failed', error);
    return false;
  }
  return ready;
}
