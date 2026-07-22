import { sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';

/**
 * Next sequential client code for the configured prefix (owner's rule): if
 * the operator leaves the code empty, the system assigns max existing number
 * + 1 (starting at {prefix}100 when none exist). Runs under an advisory
 * transaction lock so two concurrent auto-creates never collide.
 */
export async function nextClientCode(tx: Db | Tx, prefix: string): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('client_code_seq'))`);
  const pattern = `^${prefix}[0-9]+$`;
  const rows = (await tx.execute(sql`
    SELECT COALESCE(MAX((substring(client_code from '[0-9]+$'))::bigint), 99) AS max_num
    FROM clients
    WHERE client_code ~ ${pattern}
  `)) as unknown as { max_num: string | number }[];
  const maxNum = Number(rows[0]?.max_num ?? 99);
  return `${prefix}${maxNum + 1}`;
}
