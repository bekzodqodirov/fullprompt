import postgres from 'postgres';

/**
 * A second, one-connection door to the database that the POOL cannot starve.
 *
 * The pool (`db/client.ts`) is ten connections shared by every page. #714
 * measured what happens when all ten are held: every screen stops together,
 * and so does anything that would have told somebody. The two readers that
 * must still work in that minute are the error recorder (the error IS the
 * freeze) and the health check that has to tell «the pool is stuck» from
 * «postgres is down» — and both can only answer if they are not queued behind
 * the ten connections they are asking about.
 *
 * One connection, short fuses: `connect_timeout` 5 s, a server-side
 * `statement_timeout` of 3 s so a query here can never become the next thing
 * holding a lock, and `application_name` so it is recognisable in
 * `pg_stat_activity` as not part of the pool. Nothing here opens a
 * transaction. Held on globalThis like the pool, so a dev hot reload does not
 * leak a connection per edit.
 */

const globalForSide = globalThis as unknown as { gsrSideSql?: postgres.Sql };

export function sideSql(): postgres.Sql {
  globalForSide.gsrSideSql ??= postgres(
    process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev',
    {
      max: 1,
      connect_timeout: 5,
      idle_timeout: 60,
      onnotice: () => {},
      connection: { statement_timeout: 3000, application_name: 'gsr-side' },
    },
  );
  return globalForSide.gsrSideSql;
}
