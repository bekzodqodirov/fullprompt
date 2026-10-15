import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';

/**
 * Is 0132's copy table there? (#472: a deploy whose migration did not land.)
 *
 * The cost panel and the freight save read the bills' frozen copies at
 * RENDER; a server running this code on an older schema would answer those
 * pages with a 42P01. A reader asks this first and, on «no», disables the
 * freight option with «server yangilanmagan».
 *
 * It names `cost_entry_tariffs` ONLY. The warehouse mapping table 0132 also
 * made is unread since his 1a (one column for every truck) and will be
 * dropped later; a probe still naming it would switch freight off on every
 * truck, silently, the day it goes.
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
      SELECT to_regclass('public.cost_entry_tariffs') IS NOT NULL AS ok
    `)) as unknown as { ok: boolean }[];
    ready = rows[0]?.ok === true;
  } catch (error) {
    console.error('[freight] readiness probe failed', error);
    return false;
  }
  return ready;
}
