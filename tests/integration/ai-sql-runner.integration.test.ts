import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, clientTransactions, users } from '@/modules/platform/db/schema';
import { EXCLUDED_TABLES } from '@/modules/platform/ai/schema-card';
import { runAnalystSql } from '@/modules/platform/ai/sql-runner';
import { clientBalanceUsd } from '@/modules/wms/finance/service';

/**
 * The fence under model-written SQL, asked against the LIVE role and grants
 * migration 0079 installed — not against a mock, because the confidentiality
 * boundary IS the database's ACL and only the database can answer for it.
 *
 * Red proofs run for this file (#166, string-edit never git checkout):
 *  - `SET LOCAL ROLE` line stripped from sql-runner.ts → the sessions and
 *    password_hash refusals go red (rows come back).
 *  - the runner's query moved onto the module `db` instead of the pinned
 *    `tx` → same two go red: SET LOCAL lives on one socket, and a pooled
 *    query runs unfenced as the app's own user.
 */

const STAMP = String(Date.now()).slice(-7);
let clientId: string;

beforeAll(async () => {
  const [staff] = await db.select({ id: users.id }).from(users).limit(1);
  const createdBy = staff!.id;
  const [row] = await db
    .insert(clients)
    .values({ clientCode: `QA${STAMP.slice(-4)}`, name: `ai-runner ${STAMP}` })
    .returning({ id: clients.id });
  clientId = row!.id;
  // A charge, a payment against it, and a VOIDED charge the balance must
  // ignore — the shape the view-equivalence test below is about.
  await db.insert(clientTransactions).values([
    { clientId, createdBy, type: 'charge', amount: '100.00', currency: 'USD', rateToUsd: '1', amountUsd: '100.00', txDate: '2026-01-10' },
    { clientId, createdBy, type: 'payment', amount: '40.00', currency: 'USD', rateToUsd: '1', amountUsd: '40.00', txDate: '2026-01-11' },
    { clientId, createdBy, type: 'charge', amount: '500.00', currency: 'USD', rateToUsd: '1', amountUsd: '500.00', txDate: '2026-01-12', voidedAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(clientTransactions).where(eq(clientTransactions.clientId, clientId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

describe('runAnalystSql — the four fences', () => {
  it('answers a plain SELECT through the wrap', async () => {
    const result = await runAnalystSql(
      `SELECT client_code FROM clients WHERE id = '${clientId}'`,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]!.client_code).toBe(`QA${STAMP.slice(-4)}`);
      expect(result.truncated).toBe(false);
    }
  });

  it('refuses sessions — the role holds no grant on any credential table', async () => {
    const result = await runAnalystSql('SELECT * FROM sessions');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('permission denied');
  });

  it('refuses users.password_hash while answering users.id', async () => {
    const denied = await runAnalystSql('SELECT password_hash FROM users');
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain('permission denied');
    // SELECT * expands to the denied column and dies the same way.
    const star = await runAnalystSql('SELECT * FROM users');
    expect(star.ok).toBe(false);

    const named = await runAnalystSql('SELECT id, full_name FROM users');
    expect(named.ok).toBe(true);
  });

  it('refuses DML hidden in a CTE — the wrap parses it out before read-only is even asked', async () => {
    // This SHAPE passes the vet (starts with WITH, one statement). What
    // refuses it is the WRAP: inside `SELECT * FROM (…) __ai` a
    // data-modifying CTE is not even grammatical («must be at the top
    // level»), so the write dies at parse — and BEGIN READ ONLY still stands
    // behind it for anything with a side effect that does parse.
    const result = await runAnalystSql(
      `WITH x AS (DELETE FROM clients WHERE id = '${clientId}' RETURNING id) SELECT count(*) FROM x`,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/top level|read-only/);
    // And the row is still there.
    const alive = await db.select().from(clients).where(eq(clients.id, clientId));
    expect(alive).toHaveLength(1);
    // NOTE, probed while writing this: no statement that survives the vet
    // AND the wrap can reach the READ ONLY flag at all — every write shape
    // dies at the vet (not SELECT) or at parse (this test). The flag is
    // depth for the day the vet or the wrap regresses, not a fence with a
    // reachable surface, and pretending to probe it here would be a test
    // that passes for the wrong reason (#494).
  });

  it('cancels at the statement timeout', async () => {
    const result = await runAnalystSql('SELECT pg_sleep(2)', { timeoutMs: 300 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('statement timeout');
  });

  it('caps rows and says so', async () => {
    const result = await runAnalystSql('SELECT generate_series(1, 300) AS n');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rowCount).toBe(200);
      expect(result.truncated).toBe(true);
    }
  });

  it('v_client_balance_usd equals clientBalanceUsd — the drift guard', async () => {
    // The view is the ONE money figure raw SQL may aggregate; if it ever
    // stops matching the TS function, this line is what says so.
    const viaFunction = await clientBalanceUsd(clientId);
    expect(viaFunction).toBe(60);
    const viaView = await runAnalystSql(
      `SELECT balance_usd FROM v_client_balance_usd WHERE client_id = '${clientId}'`,
    );
    expect(viaView.ok).toBe(true);
    if (viaView.ok) expect(Number(viaView.rows[0]!.balance_usd)).toBe(viaFunction);
  });

  it('the live ACL holds zero privilege on every excluded table', async () => {
    for (const table of EXCLUDED_TABLES) {
      const [grants] = await db.execute(sql`
        SELECT
          (SELECT count(*) FROM information_schema.role_table_grants
            WHERE grantee = 'gsr_ai_reader' AND table_name = ${table}) AS tables,
          (SELECT count(*) FROM information_schema.column_privileges
            WHERE grantee = 'gsr_ai_reader' AND table_name = ${table}) AS columns
      `);
      expect(Number((grants as { tables: string }).tables), table).toBe(0);
      expect(Number((grants as { columns: string }).columns), table).toBe(0);
    }
    // The column grants on users: the secrets are absent, the rest present.
    const cols = await db.execute(sql`
      SELECT column_name FROM information_schema.column_privileges
      WHERE grantee = 'gsr_ai_reader' AND table_name = 'users'
    `);
    const names = (cols as unknown as { column_name: string }[]).map((c) => c.column_name);
    expect(names).toContain('id');
    expect(names).not.toContain('password_hash');
    expect(names).not.toContain('quick_pin_hash');
  });
});
