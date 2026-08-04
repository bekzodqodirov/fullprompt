import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const globalForDb = globalThis as unknown as {
  pgClient?: ReturnType<typeof postgres>;
};

// Reuse the connection pool across Next.js hot reloads in dev.
export const pgClient =
  globalForDb.pgClient ??
  postgres(process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev', {
    max: 10,
    onnotice: () => {},
  });

if (process.env.NODE_ENV !== 'production') globalForDb.pgClient = pgClient;

export const db = drizzle(pgClient, { schema });

export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
