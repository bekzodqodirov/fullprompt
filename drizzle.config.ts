import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/modules/platform/db/schema/index.ts',
  out: './src/modules/platform/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5432/gsr_dev',
  },
  casing: 'snake_case',
});
