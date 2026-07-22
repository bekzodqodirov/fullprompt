import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import path from 'node:path';

async function main() {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev';
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(client);
  await migrate(db, {
    migrationsFolder: path.join(process.cwd(), 'src/modules/platform/db/migrations'),
  });
  await client.end();
  console.log('migrations applied');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
