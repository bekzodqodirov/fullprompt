import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';

/**
 * 0150 — the first migration that writes a GRANT (the sellers' `batches.view`,
 * 2026-11-18) — run as the migration wrote it: its own statements read from
 * its FILE, inside a transaction that is rolled back (0124's idiom; a
 * restatement here would prove the restatement).
 *
 * Its grant statement is the one place the rows are written on HIS database
 * and nowhere else: on every fresh database the roles do not exist yet when
 * migrations run, and the seed writes the same rows from the matrix right
 * after. So in CI's order (migrate → seed → vitest) the rows are already here,
 * and re-running the file would insert nothing and prove nothing (the design
 * judge's DEP-2) — each case first takes away what the seed wrote and marks
 * the roles edited by an admin, which is the database the statement exists for.
 */

const STATEMENTS = readFileSync('src/modules/platform/db/migrations/0150_batches_view.sql', 'utf8')
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter(Boolean);
const READERS = ['scan.load', 'scan.unload', 'ved.docs', 'plans.manage', 'batches.depart_close'];

afterAll(async () => {
  await pgClient.end();
});

/** Runs `prepare`, then 0150's statements, and answers which roles hold `batches.view` — all rolled back. */
async function holdersAfter(prepare: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>) {
  let holders: string[] = [];
  let permissionRows = -1;
  await db
    .transaction(async (tx) => {
      // What the seed wrote goes (the grants cascade with the permission row).
      await tx.execute(sql`DELETE FROM permissions WHERE code = 'batches.view'`);
      await prepare(tx);
      for (const statement of STATEMENTS) await tx.execute(sql.raw(statement));
      const rows = (await tx.execute(sql`
        SELECT r.code, rp.source FROM role_permissions rp
          JOIN roles r ON r.id = rp.role_id
          JOIN permissions p ON p.id = rp.permission_id
         WHERE p.code = 'batches.view'
         ORDER BY r.code`)) as unknown as { code: string; source: string }[];
      holders = rows.map((row) => `${row.code}:${row.source}`);
      const [count] = (await tx.execute(
        sql`SELECT count(*)::int AS n FROM permissions WHERE code = 'batches.view'`,
      )) as unknown as { n: number }[];
      permissionRows = count!.n;
      // Run twice: a re-run inserts nothing and refuses nothing.
      for (const statement of STATEMENTS) await tx.execute(sql.raw(statement));
      const [again] = (await tx.execute(sql`
        SELECT count(*)::int AS n FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
         WHERE p.code = 'batches.view'`)) as unknown as { n: number }[];
      expect(again!.n).toBe(rows.length);
      tx.rollback();
    })
    .catch((err: unknown) => {
      if (!(err instanceof TransactionRollbackError)) throw err;
    });
  return { holders, permissionRows };
}

describe('0150 grants the sellers the trucks — on his database, edited roles included', () => {
  it('is two statements: the code, then the grant', () => {
    expect(STATEMENTS).toHaveLength(2);
    expect(STATEMENTS[0]).toContain('INSERT INTO "permissions"');
    expect(STATEMENTS[1]).toContain('INSERT INTO "role_permissions"');
  });

  it('reaches the seller, the super admin and the admin even when an admin edited all three', async () => {
    const { holders, permissionRows } = await holdersAfter(async (tx) => {
      await tx.execute(sql`UPDATE roles SET grants_customised = true WHERE code IN ('super_admin', 'admin', 'sales_manager')`);
    });
    expect(permissionRows).toBe(1);
    // An edited admin that still reads trucks gains nothing new — given it.
    expect(holders).toEqual(['admin:seed', 'sales_manager:seed', 'super_admin:seed']);
  });

  it('leaves an edited admin he cut off from the trucks cut off — the seller and the super admin still get it', async () => {
    const { holders } = await holdersAfter(async (tx) => {
      await tx.execute(sql`UPDATE roles SET grants_customised = true WHERE code IN ('super_admin', 'admin', 'sales_manager')`);
      await tx.execute(sql`
        DELETE FROM role_permissions rp
         USING roles r, permissions p
         WHERE rp.role_id = r.id AND rp.permission_id = p.id
           AND r.code = 'admin' AND p.code IN (${sql.join(READERS.map((code) => sql`${code}`), sql`, `)})`);
    });
    expect(holders).toEqual(['sales_manager:seed', 'super_admin:seed']);
  });

  it('gives no other role anything', async () => {
    const { holders } = await holdersAfter(async () => {});
    for (const holder of holders) {
      expect(['admin:seed', 'sales_manager:seed', 'super_admin:seed'], holder).toContain(holder);
    }
  });

  it('on a fresh database (no roles yet — migrations run before the seed) writes the code and no grant', async () => {
    const { holders, permissionRows } = await holdersAfter(async (tx) => {
      await tx.execute(sql`DELETE FROM user_roles`);
      await tx.execute(sql`DELETE FROM role_permissions`);
      await tx.execute(sql`DELETE FROM roles`);
    });
    expect(permissionRows).toBe(1);
    expect(holders).toEqual([]);
  });
});
