import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { PROMISE_TASK_TITLE } from '@/modules/wms/debt/promises';

/**
 * 0124's backfill, run as the migration wrote it — its own statements, inside
 * a transaction that is rolled back — over one task of every shape it has to
 * tell apart. A restatement of the SQL here would prove the restatement.
 *
 * The labels decide what a task can DO after the deploy: a 'calc' task loses
 * its ✅ to «🧮 Hisobni ochish», a hand task appears in «📤 Men bergan». So the
 * shape that must NOT match — a person's own task that happens to start
 * «Hisoblash: » — is the case the tightened rule exists for.
 */

const SUFFIX = String(Date.now()).slice(-7);
const MIGRATION = readFileSync(
  'src/modules/platform/db/migrations/0124_task_origin_calc_note.sql',
  'utf8',
);
const BACKFILL = MIGRATION.slice(
  MIGRATION.indexOf('-- The backfill.'),
  MIGRATION.indexOf('-- 2. The VED'),
)
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter((s) => /^(--[^\n]*\n)*\s*UPDATE/.test(s));

afterAll(async () => {
  await pgClient.end();
});

describe("0124's backfill labels every old task by the door that made it", () => {
  it('finds its five statements, pointers before titles', () => {
    expect(BACKFILL).toHaveLength(5);
    expect(BACKFILL[0]).toContain('FROM "calc_requests"');
    expect(BACKFILL[1]).toContain('FROM "payment_promises"');
  });

  it('the title literals are what the code itself writes', () => {
    // A rename of a builder would stop the backfill matching with nothing red.
    expect(MIGRATION).toContain(`'${PROMISE_TASK_TITLE.replace(/'/g, "''")}%'`);
    const calc = readFileSync('src/modules/wms/calc/service.ts', 'utf8');
    expect(calc).toContain('title: `Hisoblash: ${label} (${items.length})`');
    expect(calc).toContain("title: `↩️ Ma'lumot to'ldiring: ${await requestLabel(row.entityType, row.entityId)}`");
  });

  it('labels each shape, and leaves a person\'s own «Hisoblash: …» alone', async () => {
    let labels = new Map<string, { origin: string | null; bound: boolean }>();
    await db
      .transaction(async (tx) => {
        const [me] = (await tx.execute(sql`SELECT id FROM users ORDER BY created_at LIMIT 1`)) as unknown as {
          id: string;
        }[];
        const user = me!.id;
        const client = (
          (await tx.execute(sql`
            INSERT INTO clients (id, client_code, name) VALUES (gen_random_uuid(), ${`BF${SUFFIX}`}, ${`Backfill ${SUFFIX}`})
            RETURNING id`)) as unknown as { id: string }[]
        )[0]!.id;
        const task = async (key: string, title: string, over: { priority?: number; allDay?: boolean; entity?: string | null } = {}) => {
          const entity = over.entity === undefined ? 'lead' : over.entity;
          const [row] = (await tx.execute(sql`
            INSERT INTO tasks (id, title, assignee_id, created_by, priority, all_day, due_at, entity_type, entity_id)
            VALUES (gen_random_uuid(), ${title}, ${user}::uuid, ${user}::uuid, ${over.priority ?? 1},
                    ${over.allDay ?? false}, now(), ${entity}, ${entity ? sql`gen_random_uuid()` : null})
            RETURNING id`)) as unknown as { id: string }[];
          return [key, row!.id] as const;
        };
        const ids = new Map([
          await task('pointedCalc', `Hisoblash: GS1 ${SUFFIX} (2)`),
          await task('ghost', `Hisoblash: GS2 ${SUFFIX} (3)`),
          await task('handHisoblash', `Hisoblash: kim qancha ${SUFFIX}`, { priority: 2, allDay: true, entity: null }),
          await task('handBack', `↩️ Ma'lumot to'ldiring: GS3 ${SUFFIX}`, { allDay: true }),
          await task('pointedPromise', `${PROMISE_TASK_TITLE} · BF${SUFFIX}`, { allDay: true, entity: 'client' }),
          await task('unpointedPromise', `${PROMISE_TASK_TITLE} · BG${SUFFIX}`, { allDay: true, entity: 'client' }),
          await task('hand', `Oddiy ish ${SUFFIX}`, { priority: 2, allDay: true, entity: null }),
        ]);
        // Today's rows have their origin stamped by createTask; these are
        // made to look like the rows the deploy finds — NULL, never labelled.
        await tx.execute(sql`UPDATE tasks SET origin = NULL, bound_id = NULL WHERE id IN (${sql.join(
          [...ids.values()].map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`);
        await tx.execute(sql`
          INSERT INTO calc_requests (id, entity_type, entity_id, requested_by, item_count, task_id, due_at)
          VALUES (gen_random_uuid(), 'lead', gen_random_uuid(), ${user}::uuid, 2, ${ids.get('pointedCalc')!}::uuid, now())`);
        await tx.execute(sql`
          INSERT INTO payment_promises (id, client_id, amount_usd, due_on, balance_at_usd, task_id, created_by)
          VALUES (gen_random_uuid(), ${client}::uuid, 10, current_date, 10, ${ids.get('pointedPromise')!}::uuid, ${user}::uuid)`);

        for (const statement of BACKFILL) await tx.execute(sql.raw(statement));

        const rows = (await tx.execute(sql`
          SELECT id, origin, bound_id IS NOT NULL AS bound FROM tasks WHERE id IN (${sql.join(
            [...ids.values()].map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`)) as unknown as { id: string; origin: string | null; bound: boolean }[];
        const byId = new Map(rows.map((r) => [r.id, r]));
        labels = new Map([...ids].map(([key, id]) => [key, { origin: byId.get(id)!.origin, bound: byId.get(id)!.bound }]));
        tx.rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof TransactionRollbackError)) throw err;
      });

    expect(labels.get('pointedCalc')).toEqual({ origin: 'calc', bound: true });
    expect(labels.get('ghost')).toEqual({ origin: 'calc', bound: false });
    expect(labels.get('handHisoblash')).toEqual({ origin: null, bound: false });
    expect(labels.get('handBack')).toEqual({ origin: 'calc_return', bound: false });
    expect(labels.get('pointedPromise')).toEqual({ origin: 'promise', bound: true });
    expect(labels.get('unpointedPromise')).toEqual({ origin: 'promise', bound: false });
    expect(labels.get('hand')).toEqual({ origin: null, bound: false });
  });

  it('a bound record with no origin is refused by the table itself', async () => {
    // With a NULL origin the IN is NULL, and a CHECK passes on NULL — so the
    // constraint spells `origin IS NOT NULL` out.
    await expect(
      db.execute(sql`
        INSERT INTO tasks (id, title, assignee_id, created_by, bound_id)
        SELECT gen_random_uuid(), 'bound', id, id, gen_random_uuid() FROM users ORDER BY created_at LIMIT 1`),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
