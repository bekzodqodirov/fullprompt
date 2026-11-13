import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';

/**
 * 0147's backfill of the colleagues' ticks (docs/PRIXOD-JAVOBLAR.md §2.2, §8),
 * run as the migration wrote it — its own statement, inside a transaction
 * that is rolled back — over one tick of every shape it has to tell apart. A
 * restatement of the SQL here would prove the restatement (0124's idiom).
 *
 * The shape that must NOT take the lot's figures is a tick whose COUNT no
 * longer holds (the kernel lens, K2): a count door grew the lot since, so its
 * kilos are the grown lot's, and the take-back that heals the count would
 * never heal kilos remembered from the grown lot — a ✅ «o'zgardi» for ever
 * about exactly the figures the person vouched for. And a lot whose totals
 * are NaN must not abort the migration.
 */

const SUFFIX = String(Date.now()).slice(-7);
const MIGRATION = readFileSync('src/modules/platform/db/migrations/0147_prixod_javoblar.sql', 'utf8');
const BACKFILL = MIGRATION.split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter((s) => /^(--[^\n]*\n)*\s*UPDATE "lot_checks"/.test(s));

afterAll(async () => {
  await pgClient.end();
});

describe('0147 backfills the ticks that stand, with the figures of the lot they vouched for', () => {
  it('finds its one statement', () => {
    expect(BACKFILL).toHaveLength(1);
    expect(BACKFILL[0]).toContain('k."seen_box_count" = l."box_count"');
  });

  it('a tick whose count holds takes today’s figures; one the count left, and a NaN lot, keep NULL', async () => {
    let got = new Map<string, { kg: string | null; m3: string | null }>();
    await db
      .transaction(async (tx) => {
        const [me] = (await tx.execute(sql`SELECT id FROM users ORDER BY created_at LIMIT 1`)) as unknown as { id: string }[];
        const [wh] = (await tx.execute(sql`
          INSERT INTO warehouses (id, code, name, country, type, timezone, batch_prefix)
          VALUES (gen_random_uuid(), ${`BK${SUFFIX}`}, ${`Backfill ${SUFFIX}`}, 'CN', 'origin', 'Asia/Shanghai', ${`BK${SUFFIX}`})
          RETURNING id`)) as unknown as { id: string }[];
        const [client] = (await tx.execute(sql`
          INSERT INTO clients (id, client_code, name) VALUES (gen_random_uuid(), ${`BK${SUFFIX}`}, ${`Backfill ${SUFFIX}`})
          RETURNING id`)) as unknown as { id: string }[];
        const [receipt] = (await tx.execute(sql`
          INSERT INTO receipts (id, warehouse_id, number, client_id, status, created_by, confirmed_at, confirmed_by)
          VALUES (gen_random_uuid(), ${wh!.id}::uuid, ${`BK-${SUFFIX}`}, ${client!.id}::uuid, 'confirmed', ${me!.id}::uuid, now(), ${me!.id}::uuid)
          RETURNING id`)) as unknown as { id: string }[];
        const lot = async (key: string, seq: number, count: number, kg: string, m3: string, seenCount: number) => {
          const [row] = (await tx.execute(sql`
            INSERT INTO receipt_lots (id, receipt_id, seq, letter, dims_mode, product_name_zh, box_count, total_weight_kg, total_volume_m3)
            VALUES (gen_random_uuid(), ${receipt!.id}::uuid, ${seq}, ${String.fromCharCode(64 + seq)}, 'mixed', ${`秤${SUFFIX}${key}`},
                    ${count}, ${kg}::numeric, ${m3}::numeric)
            RETURNING id`)) as unknown as { id: string }[];
          await tx.execute(sql`
            INSERT INTO lot_checks (lot_id, seen_name_zh, seen_name_ru, seen_box_count, seen_client_id, checked_by)
            VALUES (${row!.id}::uuid, ${`秤${SUFFIX}${key}`}, NULL, ${seenCount}, ${client!.id}::uuid, ${me!.id}::uuid)`);
          return [key, row!.id] as const;
        };
        const ids = new Map([
          // Ticked at 2 cartons, still 2 — awkward figures, rounded by the database.
          await lot('holds', 1, 2, '40.715', '0.3145', 2),
          // Ticked at 2 cartons; a count door grew it to 5 since.
          await lot('grown', 2, 5, '101.785', '0.7850', 2),
          // A lot whose totals are NaN — the column takes it; the CHECK must not abort 0147.
          await lot('nan', 3, 2, 'NaN', 'NaN', 2),
        ]);
        await tx.execute(sql.raw(BACKFILL[0]!));
        const rows = (await tx.execute(sql`
          SELECT lot_id::text AS lot_id, seen_kg::text AS kg, seen_m3::text AS m3 FROM lot_checks
           WHERE lot_id IN (${sql.join(
             [...ids.values()].map((id) => sql`${id}::uuid`),
             sql`, `,
           )})`)) as unknown as { lot_id: string; kg: string | null; m3: string | null }[];
        const byId = new Map(rows.map((r) => [r.lot_id, { kg: r.kg, m3: r.m3 }]));
        got = new Map([...ids].map(([key, id]) => [key, byId.get(id) ?? { kg: 'missing', m3: 'missing' }]));
        tx.rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof TransactionRollbackError)) throw err;
      });
    expect(Object.fromEntries(got)).toEqual({
      holds: { kg: '40.72', m3: '0.315' },
      grown: { kg: null, m3: null },
      nan: { kg: null, m3: null },
    });
  });
});
