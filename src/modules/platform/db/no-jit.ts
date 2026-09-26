import { sql } from 'drizzle-orm';
import { db } from './client';

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
 * `timeoutMs` is a BUDGET (design §5.1): the read is abandoned by postgres
 * itself at that point — nothing keeps holding the connection — and the
 * caller's catch renders the row without its number.
 */
export function withoutJit<T>(
  readWith: (exec: Pick<typeof db, 'execute'>) => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL jit = off`);
    if (opts.timeoutMs) await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${Math.trunc(opts.timeoutMs)}`));
    return readWith(tx);
  });
}
