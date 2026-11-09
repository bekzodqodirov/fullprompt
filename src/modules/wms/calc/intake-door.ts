import { sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db, type Tx } from '../../platform/db/client';
import { logger } from '../../platform/logger';
import type { IntakeDoor } from './intake';

/**
 * The door a calculation request came in through (0141, docs/IKKI-ESHIK.md
 * §0) — `calc_requests.intake_door`, the ONE home of every statement that
 * names it.
 *
 * The column is not declared on the drizzle table (schema/wms.ts says why:
 * declared, every calc INSERT and whole-row select would be a 42703 one
 * migration behind). So it is written here, by raw SQL, only when the probe
 * has seen it; and read through `to_jsonb(row)`, which answers NULL — today's
 * behaviour, §0.2 — on a database where 0141 has not landed yet (#472): a
 * landing is never refused `server_behind` because the migration is late
 * (§0.4).
 */

let ready = false;
let probe: (() => Promise<boolean>) | null = null;

/**
 * Has 0141 landed? One catalog lookup on the POOL — never inside a
 * transaction (#714) — the `intakeTableReady` idiom (calc-store.ts). Caches
 * TRUE only: a column does not disappear under a running process, and «no» is
 * asked again, so the door is written the moment the migration lands, with no
 * restart. A lookup that fails answers no — the request still opens, its door
 * unwritten, which is NULL: today's behaviour.
 */
export async function intakeDoorReady(): Promise<boolean> {
  if (probe) return probe();
  if (ready) return true;
  try {
    const rows = (await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'calc_requests' AND column_name = 'intake_door'
      ) AS ok`)) as unknown as { ok: boolean }[];
    ready = rows[0]?.ok === true;
  } catch (err) {
    logger.warn({ err }, '[calc] intake_door not checked — the door is not written');
    return false;
  }
  return ready;
}

/**
 * The door a write may carry, decided on the pool BEFORE the request's
 * transaction: the door itself, or null when there is none to write (legacy)
 * or the column is not there yet — so the INSERT leaves it out (§0.4).
 */
export async function writableIntakeDoor(door: IntakeDoor | null): Promise<IntakeDoor | null> {
  if (door === null) return null;
  return (await intakeDoorReady()) ? door : null;
}

/**
 * The ONE writer: inside the transaction that inserted the request, right
 * after its INSERT, with a door `writableIntakeDoor` returned. A second
 * statement and not a column of the drizzle INSERT, because that INSERT
 * cannot name a column the table does not declare.
 */
export async function stampIntakeDoorInTx(tx: Tx, requestId: string, door: IntakeDoor): Promise<void> {
  await tx.execute(sql`UPDATE calc_requests SET intake_door = ${door} WHERE id = ${requestId}::uuid`);
}

/**
 * The ONE reader fragment: the door of the `calc_requests` row `row` names —
 * the drizzle table in a select over it, or a raw alias (`sql.raw('cr')`).
 * Through `to_jsonb`, never by name: NULL, not 42703, one migration behind.
 * Parse what it answers with `parseIntakeDoor`.
 */
export function intakeDoorSql(row: PgTable | SQL): SQL<string | null> {
  return sql<string | null>`(to_jsonb(${row}) ->> 'intake_door')`;
}

/** A stored value as a door — anything else (NULL, an unknown word) is legacy. */
export function parseIntakeDoor(value: unknown): IntakeDoor | null {
  return value === 'plain' || value === 'ai' ? value : null;
}

/**
 * One request's door, on the pool — for a reader that has no read of the row
 * of its own (the seeded collection's landing, §0.3). Null: legacy, no such
 * request, or 0141 not landed.
 */
export async function requestIntakeDoor(requestId: string): Promise<IntakeDoor | null> {
  const rows = (await db.execute(sql`
    SELECT ${intakeDoorSql(sql.raw('cr'))} AS door FROM calc_requests cr WHERE cr.id = ${requestId}::uuid`)) as unknown as {
    door: string | null;
  }[];
  return parseIntakeDoor(rows[0]?.door);
}

/** Tests: stand the probe in (null = the real one). */
export function __setIntakeDoorProbe(fn: (() => Promise<boolean>) | null): void {
  probe = fn;
}

/** Tests: forget the cached «yes» — a test that really drops the column. */
export function __forgetIntakeDoorReady(): void {
  ready = false;
}
