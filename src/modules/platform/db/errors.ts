/**
 * Postgres error codes this application actually decides on.
 *
 * `23505` is a unique violation, and it reaches a person more often than
 * anything else here: two people typing the same client code at once, an
 * owner adding «Narx» to a list that already holds «narx» (the indexes are on
 * `lower(label)`, which is exactly why the two look the same to him), an
 * admin renaming a custom field onto a name another field holds. Every one of
 * those is a sentence — «this name is taken» — and every one of them used to
 * be the error page, because the write path never caught it and the action
 * above rethrew (#472's rule, stated and then not applied to the
 * dictionaries).
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
}

/**
 * The app is a release ahead of the database — deploy morning, before
 * `docker compose run --rm migrate` has landed (#472-475).
 *
 * BOTH codes, and the second is the one that matters here: `42P01` is a
 * missing TABLE, which only a brand-new table produces, while a release that
 * adds COLUMNS to a table that already exists fails with `42703`, undefined
 * column. A guard that knows only the first passes that straight through to
 * the error page, which is precisely the morning nobody can afford it.
 */
export function isServerBehind(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  return err.code === '42P01' || err.code === '42703';
}

/**
 * The CHECK constraint a statement broke (23514), by NAME — or null.
 *
 * A release that WIDENS a CHECK has the same deploy-morning hole as one that
 * adds a column: the app accepts a value the old constraint still refuses,
 * and the refusal reaches the person as a white page or a «save failed».
 * The name is what tells «the server is behind» apart from a real fault on
 * the SAME table (a broken pair CHECK is a bug, not a late migration), so a
 * caller matches the constraints its own release widened and nothing else —
 * never a blanket 23514. drizzle may wrap the driver's error; its `cause` is
 * asked too (the users service's idiom).
 */
export function violatedCheck(err: unknown): string | null {
  type PgError = { code?: string; constraint_name?: string };
  const pg = err as (PgError & { cause?: PgError }) | null;
  const code = pg?.code ?? pg?.cause?.code;
  if (code !== '23514') return null;
  return pg?.constraint_name ?? pg?.cause?.constraint_name ?? null;
}

const BUSY = new Set(['40P01', '40001', '55P03']);
/**
 * A deadlock, a serialisation failure or a lock timeout: «boshqa o'zgarish
 * ketayotgan edi — qaytadan bosing». Moved here from `costing/fx-reprice.ts`
 * when the office count doors (0112) became its second family of callers —
 * a question about Postgres belongs beside the others.
 */
export function isBusyError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return typeof code === 'string' && BUSY.has(code);
}

/**
 * Postgres cancelled the statement — a `statement_timeout` ran out (57014).
 * drizzle may wrap the driver's error, so its `cause` is asked too (the shape
 * staff-pay.integration's budget test already accepts).
 */
export function isQueryCanceled(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '57014' || e?.cause?.code === '57014';
}
