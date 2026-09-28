import journal from './migrations/meta/_journal.json';
import { sideSql } from './side';

/**
 * Does the database carry every migration this code was built for?
 *
 * CLAUDE.md's deploy oracle is «count `drizzle.__drizzle_migrations` and
 * compare it with the journal» — typed by hand into psql on the server, by an
 * owner who is not a developer, after every deploy. The app knows both
 * numbers itself: the journal is inlined into the build, so `expected` is the
 * CODE's own answer and never a number somebody carried over from a previous
 * session (the trap CLAUDE.md warns about twice), and `applied` is one count.
 *
 * `behind` is the half-applied deploy (#472's morning: screens that read a
 * table this release adds render the error page). With `migrate` a
 * `service_completed_successfully` dependency of the app, a FAILED migrate
 * never lets the app start at all — so on this machine «behind» means the
 * other trap: a stale `migrate` IMAGE, rebuilt `app` only (deploy trap 2),
 * re-running yesterday's migrations successfully. `ahead` is the reverse — a
 * rollback of the code over a newer database — and is said in its own words.
 */

export const EXPECTED_MIGRATIONS: number = journal.entries.length;

export type LedgerState = 'ok' | 'behind' | 'ahead';

export interface SchemaLedger {
  applied: number;
  expected: number;
  state: LedgerState;
}

export function ledgerState(applied: number, expected: number): LedgerState {
  if (applied < expected) return 'behind';
  if (applied > expected) return 'ahead';
  return 'ok';
}

/** Minutes, not seconds: the ledger changes once per deploy. */
const LEDGER_TTL_MS = 60_000;

const globalForLedger = globalThis as unknown as {
  gsrLedger?: { at: number; value: SchemaLedger };
};

/**
 * Read through the SIDE connection (the health route's judge, finding 2): on a
 * cold cache this runs inside /api/health, and a pool read there is one more
 * thing that hangs when the pool is the thing that is stuck. Cached for a
 * minute on globalThis, so the layout banner costs nothing per page.
 */
export async function schemaLedger(now = Date.now()): Promise<SchemaLedger> {
  const cached = globalForLedger.gsrLedger;
  if (cached && now - cached.at < LEDGER_TTL_MS) return cached.value;
  const side = sideSql();
  // Two statements: a table that does not exist cannot be named even inside
  // a CASE branch — the planner resolves it first. A database the migrator
  // has never touched has applied nothing.
  const [probe] = await side<{ present: boolean }[]>`
    SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`;
  let applied = 0;
  if (probe?.present) {
    const [row] = await side<{ n: number }[]>`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    applied = Number(row?.n ?? 0);
  }
  const value: SchemaLedger = {
    applied,
    expected: EXPECTED_MIGRATIONS,
    state: ledgerState(applied, EXPECTED_MIGRATIONS),
  };
  globalForLedger.gsrLedger = { at: now, value };
  return value;
}
