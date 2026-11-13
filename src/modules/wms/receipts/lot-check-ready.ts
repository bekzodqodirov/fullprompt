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
 * THREE answers since 0146 (docs/PRIXOD-XABARI.md §A.6): the client's answer
 * may also remember the lot's kilos and cubic metres (`shown_kg`,
 * `shown_m3`), and the sentence compares them — by NAME, under this third
 * flag. Not the house's `to_jsonb(row)->>'col'` idiom, which needs no flag:
 * measured over 200,000 evaluations the named columns cost 0.17 µs a row and
 * the json one 12.5 µs, on a sentence that runs once per carton on the stock
 * table. A column is not a table, so this half asks `pg_attribute` (measured
 * warm: 0.36 ms for the whole statement, against 2.8 ms through
 * `information_schema.columns` — and on a server one migration behind it
 * runs on every reader call).
 *
 * FIVE answers since 0147 (docs/PRIXOD-JAVOBLAR.md §4): a colleague's tick
 * remembers the lot's kilos and cubic metres too (`lot_checks.seen_kg` /
 * `seen_m3` — the owner's «2 b»), and a customer notice remembers the tag of
 * the last question with buttons it delivered (`client_notices.asked_tag` /
 * `asked_at` — his «1 b»). Two more column counts in the same statement, each
 * its own flag: the tick's term sits in BOTH sentence forms (0123's and
 * 0144's), so it never waits on the client's flags, and the remembered tag is
 * a fact about the notices table alone.
 *
 * The early return below is ALL FIVE answers: with fewer in it, a process
 * that was asked once while a migration had not landed would never ask again
 * — and after `docker compose run --rm migrate` (the repair that restarts
 * nothing) one bundle's copy of these flags would go on speaking the older
 * sentence beside another that had learned the new one (#1710).
 *
 * A probe and not a catch: one catalog lookup (~0.1 ms), and each answer is
 * remembered once it is «yes» — tables and columns do not disappear under a
 * running process. «No» is asked again every time, so the screens come back
 * the moment the migration lands, with no restart.
 */
let ready = false;
let clientReady = false;
let measuresReady = false;
let tickReady = false;
let askedReady = false;

export async function lotChecksReady(): Promise<boolean> {
  if (ready && clientReady && measuresReady && tickReady && askedReady) return true;
  const rows = (await db.execute(sql`
    SELECT (to_regclass('public.lot_checks') IS NOT NULL
        AND to_regclass('public.lot_compositions') IS NOT NULL
        AND to_regclass('public.lot_composition_lines') IS NOT NULL) AS ok,
           to_regclass('public.lot_client_confirms') IS NOT NULL AS client,
           (SELECT count(*) = 2 FROM pg_attribute
             WHERE attrelid = to_regclass('public.lot_client_confirms')
               AND attname IN ('shown_kg', 'shown_m3') AND NOT attisdropped) AS measures,
           (SELECT count(*) = 2 FROM pg_attribute
             WHERE attrelid = to_regclass('public.lot_checks')
               AND attname IN ('seen_kg', 'seen_m3') AND NOT attisdropped) AS tick,
           (SELECT count(*) = 2 FROM pg_attribute
             WHERE attrelid = to_regclass('public.client_notices')
               AND attname IN ('asked_tag', 'asked_at') AND NOT attisdropped) AS asked
  `)) as unknown as { ok: boolean; client: boolean; measures: boolean; tick: boolean; asked: boolean }[];
  ready = rows[0]?.ok === true;
  clientReady = ready && rows[0]?.client === true;
  measuresReady = clientReady && rows[0]?.measures === true;
  tickReady = ready && rows[0]?.tick === true;
  askedReady = rows[0]?.asked === true;
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

/**
 * Can the client's answer remember kilos and cubic metres (0146)? What the
 * last probe remembered — SYNC, for the sentence (`clientHoldsSql`), under
 * the same rule as `lotClientConfirmsReady()`: every reader awaits the probe
 * before it builds a statement.
 */
export function lotClientMeasuresReady(): boolean {
  return measuresReady;
}

/**
 * …and the question's own doors ask the probe THEMSELVES (0144's as-built
 * lesson: a writer that reads what another screen remembered is right only
 * while that screen has run in its module instance). «No» = the question is
 * asked, tagged and remembered exactly as 0144 did.
 */
export async function clientMeasuresReady(): Promise<boolean> {
  return (await lotChecksReady()) && measuresReady;
}

/**
 * Does a colleague's tick remember kilos and cubic metres (0147, the owner's
 * «2 b»)? What the last probe remembered — SYNC, for the sentence
 * (`checkTermsSql`) and the card's view, under the rule of the two above:
 * every reader awaits `lotChecksReady()` before it builds a statement.
 */
export function lotTickMeasuresReady(): boolean {
  return tickReady;
}

/** …and the tick's own writer asks the probe itself (L1-1), on the pool, before its transaction. */
export async function tickMeasuresReady(): Promise<boolean> {
  return (await lotChecksReady()) && tickReady;
}

/**
 * Does a customer notice remember the last question it delivered (0147, the
 * owner's «1 b»)? Asked by the sweep before it writes the tag and by the
 * automatic re-ask before it reads one — never a remembered flag: both run in
 * the job worker's own module instance.
 */
export async function askedTagReady(): Promise<boolean> {
  await lotChecksReady();
  return askedReady;
}
