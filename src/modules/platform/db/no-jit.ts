import { sql } from 'drizzle-orm';
import { db } from './client';
import { isQueryCanceled } from './errors';

/**
 * A company-wide READ with Postgres's JIT switched off for it alone (0104).
 *
 * Postgres 16 compiles a query to machine code once its ESTIMATED cost passes
 * `jit_above_cost` (100 000 by default, and production runs the default). A
 * read over every carton the company holds is past that line by its shape,
 * and the compilation is paid on EVERY call — measured on the 60k-carton
 * clone, the unpriced-cargo list spent ~3.1 s of 3.3 s compiling and ~0.2 s
 * reading. JIT pays off on analytic scans that run for minutes; this app's
 * reads run in milliseconds.
 *
 * `SET LOCAL` lives only inside a transaction, so the read runs in one — a
 * single read-committed transaction on one pool connection, nothing written.
 * Never call it from inside another transaction (#714: it takes a pool
 * connection of its own).
 *
 * docker-compose's postgres block now also runs `-c jit=off`, which lifts
 * the same tax off every heavy report once the container is recreated; this
 * stays because a server whose postgres was not recreated still has JIT on.
 *
 * `timeoutMs` is a budget PER STATEMENT (design §5.1): each is abandoned by
 * postgres itself at that point — nothing keeps holding the connection — and
 * the caller's catch renders the row without its number.
 *
 * `deadlineMs` is a budget for the WHOLE read: a read of four statements
 * under an 8 s `timeoutMs` may still hold a page for 32 s. Every statement is
 * sent with `statement_timeout` = what is LEFT of the deadline, and a
 * statement asked for after it has passed is refused before it is sent — so
 * the page waits at most the deadline (and one round trip), whatever the
 * read's shape. Statements the read fires in parallel share the one
 * connection and queue on it, so each one's timeout is at most what was left
 * when its own was set: bounded, never longer.
 */
export class ReadDeadlineError extends Error {
  constructor() {
    super('read deadline passed');
  }
}

/**
 * A budgeted read that ran out — refused before sending (`ReadDeadlineError`)
 * or cancelled by postgres at what was left (57014). The ONE predicate for
 * «soft: say it was not computed»; anything else is a bug and stays loud.
 */
export function isBudgetMiss(err: unknown): boolean {
  return err instanceof ReadDeadlineError || isQueryCanceled(err);
}

export function withoutJit<T>(
  readWith: (exec: Pick<typeof db, 'execute'>) => Promise<T>,
  opts: { timeoutMs?: number; deadlineMs?: number } = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL jit = off`);
    if (opts.timeoutMs) await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${Math.trunc(opts.timeoutMs)}`));
    if (!opts.deadlineMs) return readWith(tx);
    const deadline = Date.now() + opts.deadlineMs;
    const execute = (async (query: Parameters<typeof tx.execute>[0]) => {
      const left = Math.trunc(deadline - Date.now());
      if (left <= 0) throw new ReadDeadlineError();
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${left}`));
      return tx.execute(query);
      // A promise where drizzle types a lazy `PgRaw`: every reader AWAITS
      // `execute`, and a read that chains the builder's other methods has no
      // business inside a budgeted company read.
    }) as unknown as typeof tx.execute;
    return readWith({ execute });
  });
}
