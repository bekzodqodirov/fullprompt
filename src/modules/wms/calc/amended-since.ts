import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';
import { CalcError } from './service';

/**
 * «Did a seller's addition land after the VED's screen was drawn?» — the one
 * question the VED's four official doors ask (docs/SAKKIZ-R3.md §10A, P6
 * «Ko‘rdim»; law-money-3).
 *
 * The add door (his 1.9 a) writes into a request for as long as no PERSON has
 * saved on it (⭐ Q2 a): opening the page, taking the job or composing the
 * «Готово» fold is not «started». So a seller's «2: 40 juft» and the re-pass
 * behind it can land between the VED's page load and the press — and every
 * door compared only what it computed AT the press, which by then already
 * includes the seller's figures. The official answer would then price goods
 * the VED never saw (that answer is the upsale floor, the card's lock, the
 * price channel's post and the CalcDone push), and a ✅ would record
 * seller-written figures as «what stood on the screen».
 *
 * Keyed on `calc_amendments`, never on `rev` moving: the VED's own saves and
 * the machine's pass move the clock too, and neither may trip it. Only an
 * APPLIED addition changed a row — a `to_ved`, `noted` or `waiting` one wrote
 * nothing the screen is missing. `rev` on an applied row is the revision that
 * write LEFT, so «after the screen» is `rev > sawRev`.
 *
 * Qualified by its own alias: the fragment is ANDed into an UPDATE of
 * `calc_requests`, which has a `rev` of its own (#128's shape). The
 * `outcome` clause is not what keeps a `to_ved` row out — 0139's CHECK
 * already leaves every other row's `rev` NULL, and the red proof that dropped
 * the clause stayed green for that reason — it is what lets the planner read
 * 0139's partial index (an index-only scan; without it, the request index and
 * a filter, measured).
 */
export function amendedSinceSql(requestId: string, sawRev: number): SQL {
  // A forged or broken post must not fail OPEN: a fractional, negative or
  // enormous figure would either never be exceeded or refuse as a 22P02
  // white page from `::int`.
  if (!Number.isSafeInteger(sawRev) || sawRev < 0 || sawRev > 2_147_483_647) {
    throw new CalcError('validation');
  }
  return sql`EXISTS (
    SELECT 1 FROM calc_amendments ca
     WHERE ca.request_id = ${requestId}::uuid
       AND ca.outcome = 'applied'
       AND ca.rev > ${sawRev}::int)`;
}

/**
 * The refusal, on the door's own TRANSACTION (#714 — never the pool), after
 * the door locked the request row and before it writes anything. The lock is
 * what makes it sound: the add door's applied write commits its amendment
 * row under that same `FOR UPDATE`, and in READ COMMITTED the statement after
 * the lock is granted takes a fresh snapshot — so an addition that committed
 * while this door waited is seen here.
 */
export async function refuseIfAmendedSinceInTx(tx: Tx, requestId: string, sawRev: number): Promise<void> {
  const rows = await tx.execute<{ amended: boolean }>(
    sql`SELECT ${amendedSinceSql(requestId, sawRev)} AS amended`,
  );
  if (rows[0]?.amended) throw new CalcError('amended_since');
}
