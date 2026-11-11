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
 * TWO answers from the one catalog statement (0144). The readers also join
 * the client's own answers (`lot_client_confirms`) — but that table is a
 * SECOND question, never part of the first: folded into one flag, a deploy
 * whose 0144 did not land would have switched off what has been live since
 * 0123 — every ✅/❓ chip, the worklist, the colleague's tick itself and the
 * tarkib's shown names — for a table none of them needs (the design judge).
 * So `lotChecksReady()` still means 0122/0123, and the sentence asks
 * `lotClientConfirmsReady()` — a sync read of what the same probe remembered
 * — and speaks its two-source form while that is «no».
 *
 * A probe and not a catch: one catalog lookup (~0.1 ms), and each answer is
 * remembered once it is «yes» — tables do not disappear under a running
 * process. «No» is asked again every time, so the screens come back the
 * moment the migration lands, with no restart.
 */
let ready = false;
let clientReady = false;

export async function lotChecksReady(): Promise<boolean> {
  if (ready && clientReady) return true;
  const rows = (await db.execute(sql`
    SELECT (to_regclass('public.lot_checks') IS NOT NULL
        AND to_regclass('public.lot_compositions') IS NOT NULL
        AND to_regclass('public.lot_composition_lines') IS NOT NULL) AS ok,
           to_regclass('public.lot_client_confirms') IS NOT NULL AS client
  `)) as unknown as { ok: boolean; client: boolean }[];
  ready = rows[0]?.ok === true;
  clientReady = ready && rows[0]?.client === true;
  return ready;
}

/**
 * Is the client's answer table there (0144)? What the last `lotChecksReady()`
 * remembered — SYNC, because the sentence is built by functions that return
 * SQL and cannot await. Every reader awaits `lotChecksReady()` before it
 * builds a statement, which is what keeps this fresh; before any probe has
 * run it is «no», and the sentence is then the one that needs no new table.
 */
export function lotClientConfirmsReady(): boolean {
  return clientReady;
}

/** The client's side of the feature, asked by its own doors: probe, then read. */
export async function clientConfirmsReady(): Promise<boolean> {
  return (await lotChecksReady()) && lotClientConfirmsReady();
}
