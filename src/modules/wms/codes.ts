import { sql } from 'drizzle-orm';
import type { Db, Tx } from '../platform/db/client';
import { codeEverWorn, lockBatchCode, numberEverAtAgent } from './batches/former-codes';

/**
 * Atomically advance a named counter by `by` and return the NEW value
 * (the end of the reserved range). Concurrency-safe: the upsert takes a row
 * lock, so parallel callers get disjoint ranges (spec 5.2 / DECISIONS #18).
 */
export async function bumpCounter(
  tx: Db | Tx,
  kind: string,
  scopeKey: string,
  by = 1,
): Promise<number> {
  const rows = (await tx.execute(sql`
    INSERT INTO counters (kind, scope_key, value) VALUES (${kind}, ${scopeKey}, ${by})
    ON CONFLICT (kind, scope_key) DO UPDATE SET value = counters.value + ${by}
    RETURNING value
  `)) as unknown as { value: string | number }[];
  return Number(rows[0]!.value);
}

/** Warehouse-local calendar date parts for a UTC instant. */
export function warehouseLocalDate(
  instant: Date,
  timezone: string,
): { yy: string; mm: string; dd: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { yy: get('year'), mm: get('month'), dd: get('day') };
}

/** Receipt number `{WH}-IN-{YYMMDD}-{seq}`, seq per warehouse per local day. */
export async function nextReceiptNumber(
  tx: Db | Tx,
  warehouse: { code: string; timezone: string },
  now = new Date(),
): Promise<string> {
  const { yy, mm, dd } = warehouseLocalDate(now, warehouse.timezone);
  const dateKey = `${yy}${mm}${dd}`;
  const seq = await bumpCounter(tx, 'receipt_day', `${warehouse.code}:${dateKey}`);
  return `${warehouse.code}-IN-${dateKey}-${String(seq).padStart(3, '0')}`;
}

/**
 * Whose sequence a truck out of this warehouse counts on: the prefix, and the
 * warehouse's code when it has none. ONE home (#513) for the mint, the
 * cancel's give-back and the dry-run list — the counter row is keyed on this
 * string, so two warehouses with one prefix share one sequence.
 */
export function batchSeqPrefix(warehouse: { code: string; batchPrefix: string | null }): string {
  return warehouse.batchPrefix || warehouse.code;
}

/**
 * The exact string the mint builds for number `n` — the give-back compares
 * against THIS and never parses a code, so a truck minted under an older
 * prefix, or a hand-typed «YW-0010», is never taken for number 10. The pad
 * has no cap: 999 → «-999», 1000 → «-1000» (#653).
 */
export function batchSeqCode(prefix: string, n: number): string {
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

/**
 * The counter's value under its row lock, or null when the row is not there.
 * The give-back's first statement: a mint bumps the same row (`bumpCounter`'s
 * upsert), so the two serialise here and a release never reads a number a
 * mint is still handing out.
 */
export async function lockCounterRow(tx: Tx, kind: string, scopeKey: string): Promise<number | null> {
  const rows = (await tx.execute(sql`
    SELECT value FROM counters WHERE kind = ${kind} AND scope_key = ${scopeKey} FOR UPDATE
  `)) as unknown as { value: string | number }[];
  const row = [...rows][0];
  return row ? Number(row.value) : null;
}

/** The same value read with no lock — the read-only explainer's. */
export async function readCounter(handle: Db | Tx, kind: string, scopeKey: string): Promise<number | null> {
  const rows = (await handle.execute(sql`
    SELECT value FROM counters WHERE kind = ${kind} AND scope_key = ${scopeKey}
  `)) as unknown as { value: string | number }[];
  const row = [...rows][0];
  return row ? Number(row.value) : null;
}

/**
 * Take the counter back by one, compare-and-set: only from `from`. Under
 * `lockCounterRow` it cannot miss; it is the belt for a caller that read the
 * value in an earlier statement, so a number a mint has handed out since is
 * never handed out twice.
 */
export async function rewindCounter(tx: Tx, kind: string, scopeKey: string, from: number): Promise<boolean> {
  const rows = (await tx.execute(sql`
    UPDATE counters SET value = value - 1
     WHERE kind = ${kind} AND scope_key = ${scopeKey} AND value = ${from}
    RETURNING value
  `)) as unknown as unknown[];
  return [...rows].length === 1;
}

/** Batch code `{PREFIX}-{001}`, lifetime per-origin-warehouse sequence. */
export async function nextBatchCode(
  tx: Db | Tx,
  warehouse: { code: string; batchPrefix: string | null },
): Promise<string> {
  const prefix = batchSeqPrefix(warehouse);
  // The counter says which number is NEXT; the table says which are TAKEN —
  // and the two can disagree (round 100, the owner's item 7): production's
  // YW counter stood BEHIND the existing codes, the insert hit the unique
  // index, the whole transaction — counter bump included — rolled back, and
  // every retry minted the same taken code for ever. Walking past taken
  // codes heals the counter permanently: each loop step consumes a number,
  // so after one successful mint the counter stands clear of the collision
  // block. Concurrent minters serialize on the counter row's lock, and the
  // unique index stays the final arbiter.
  //
  // «Taken» means every name a truck wore ON THE ROAD, not only the codes
  // standing today (the owner's 1a, 2026-09-30): a road rename away does not
  // free a name — the old papers, the bot and ⌘K still answer to it — so the
  // walk skips such a former name exactly as it skips a current one
  // (`codeEverWorn`; a name changed before departure frees, as it always
  // did). The per-candidate lock makes a mint WAIT for an in-flight rename to
  // that same number and then see it, instead of meeting it as a 23505 inside
  // approvePlan or a quick batch. A rename takes this lock FIRST, before any
  // truck lock, and the walk never takes a truck row, so there is no cycle.
  //
  // A cancelled truck that never left gives its number BACK (the owner's 4a,
  // docs/NARX-VA-RAQAM.md §3.2): `releaseTrailingCodes` (batches/rename.ts)
  // renames it «YW-010 (bekor)» and rewinds this same counter, so the walk
  // meets the number free and hands it out again.
  //
  // Unless the agent holds papers under it (his 7a on the NUMBER, review M5):
  // a forming truck may take a given-back number by hand, be ticked
  // «agentga yuborildi» under it and move away before it leaves — «ever worn»
  // frees that name, the papers do not. Such a number is passed over like a
  // worn one and stays a gap; it is the release's own predicate
  // (`numberEverAtAgent`), so the walk and the mint never disagree about
  // papers at the agent. Asked under the same candidate lock, and only of a
  // candidate «ever worn» lets through.
  for (;;) {
    const seq = await bumpCounter(tx, 'batch_seq', prefix);
    const code = batchSeqCode(prefix, seq);
    await lockBatchCode(tx, code);
    if (!(await codeEverWorn(tx, code, null)) && !(await numberEverAtAgent(tx, code))) return code;
  }
}

/** Crate code `CR-{WH}{YY}-{00000}`, per-WH-per-year sequence (DECISIONS #19). */
export async function nextCrateCode(
  tx: Db | Tx,
  warehouse: { code: string; timezone: string },
  now = new Date(),
): Promise<string> {
  const { yy } = warehouseLocalDate(now, warehouse.timezone);
  const seq = await bumpCounter(tx, 'crate_year', `${warehouse.code}:${yy}`);
  return `CR-${warehouse.code}${yy}-${String(seq).padStart(5, '0')}`;
}

/**
 * Reserve `count` box short codes `{WH}{YY}-{000000}` (per-WH-per-year
 * sequence, spec 5.2). Returns codes in ascending order.
 */
export async function nextBoxCodes(
  tx: Db | Tx,
  warehouse: { code: string; timezone: string },
  count: number,
  now = new Date(),
): Promise<string[]> {
  const { yy } = warehouseLocalDate(now, warehouse.timezone);
  const end = await bumpCounter(tx, 'box_year', `${warehouse.code}:${yy}`, count);
  const start = end - count + 1;
  return Array.from(
    { length: count },
    (_, i) => `${warehouse.code}${yy}-${String(start + i).padStart(6, '0')}`,
  );
}
