import { sql } from 'drizzle-orm';
import type { Db, Tx } from '../platform/db/client';

/**
 * Atomically advance a named counter by `by` and return the NEW value
 * (the end of the reserved range). Concurrency-safe: the upsert takes a row
 * lock, so parallel callers get disjoint ranges (spec 5.2 / DECISIONS #18).
 */
export async function bumpCounter(
  tx: Db | Tx,
  kind: string,
  scopeKey: string,
  by = 1,
): Promise<number> {
  const rows = (await tx.execute(sql`
    INSERT INTO counters (kind, scope_key, value) VALUES (${kind}, ${scopeKey}, ${by})
    ON CONFLICT (kind, scope_key) DO UPDATE SET value = counters.value + ${by}
    RETURNING value
  `)) as unknown as { value: string | number }[];
  return Number(rows[0]!.value);
}

/** Warehouse-local calendar date parts for a UTC instant. */
export function warehouseLocalDate(
  instant: Date,
  timezone: string,
): { yy: string; mm: string; dd: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { yy: get('year'), mm: get('month'), dd: get('day') };
}

/** Receipt number `{WH}-IN-{YYMMDD}-{seq}`, seq per warehouse per local day. */
export async function nextReceiptNumber(
  tx: Db | Tx,
  warehouse: { code: string; timezone: string },
  now = new Date(),
): Promise<string> {
  const { yy, mm, dd } = warehouseLocalDate(now, warehouse.timezone);
  const dateKey = `${yy}${mm}${dd}`;
  const seq = await bumpCounter(tx, 'receipt_day', `${warehouse.code}:${dateKey}`);
  return `${warehouse.code}-IN-${dateKey}-${String(seq).padStart(3, '0')}`;
}

/** Batch code `{PREFIX}-{001}`, lifetime per-origin-warehouse sequence. */
export async function nextBatchCode(
  tx: Db | Tx,
  warehouse: { code: string; batchPrefix: string | null },
): Promise<string> {
  const prefix = warehouse.batchPrefix || warehouse.code;
  const seq = await bumpCounter(tx, 'batch_seq', prefix);
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

/** Crate code `CR-{WH}{YY}-{00000}`, per-WH-per-year sequence (DECISIONS #19). */
export async function nextCrateCode(
  tx: Db | Tx,
  warehouse: { code: string; timezone: string },
  now = new Date(),
): Promise<string> {
  const { yy } = warehouseLocalDate(now, warehouse.timezone);
  const seq = await bumpCounter(tx, 'crate_year', `${warehouse.code}:${yy}`);
  return `CR-${warehouse.code}${yy}-${String(seq).padStart(5, '0')}`;
}

/**
 * Reserve `count` box short codes `{WH}{YY}-{000000}` (per-WH-per-year
 * sequence, spec 5.2). Returns codes in ascending order.
 */
export async function nextBoxCodes(
  tx: Db | Tx,
  warehouse: { code: string; timezone: string },
  count: number,
  now = new Date(),
): Promise<string[]> {
  const { yy } = warehouseLocalDate(now, warehouse.timezone);
  const end = await bumpCounter(tx, 'box_year', `${warehouse.code}:${yy}`, count);
  const start = end - count + 1;
  return Array.from(
    { length: count },
    (_, i) => `${warehouse.code}${yy}-${String(start + i).padStart(6, '0')}`,
  );
}
