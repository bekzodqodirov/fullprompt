import postgres from 'postgres';

/**
 * What the two «chegara navbat» specs borrow and give back, in one place so
 * the snapshot and the restore cannot disagree about the table's columns
 * (a column the restore forgets comes back as its DEFAULT, and 0118's two
 * clocks default to now() — the table would read «changed» after the spec).
 */

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to snapshot and restore this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export type QueueRow = {
  id: string;
  post: string;
  min_hours: number | null;
  max_hours: number | null;
  note: string | null;
  updated_by: string | null;
  updated_at: string;
  hours_since: string;
  prev_min_hours: number | null;
  prev_max_hours: number | null;
  prev_since: string | null;
};

export async function readQueue(sql: postgres.Sql): Promise<QueueRow[]> {
  return sql<QueueRow[]>`
    SELECT id, post, min_hours, max_hours, note, updated_by, updated_at::text AS updated_at,
           hours_since::text AS hours_since, prev_min_hours, prev_max_hours, prev_since::text AS prev_since
    FROM border_queue ORDER BY post`;
}

/** The table back EXACTLY: same ids, same people, same two clocks. */
export async function putQueueBack(tx: postgres.TransactionSql, rows: QueueRow[]) {
  await tx`DELETE FROM border_queue`;
  for (const r of rows) {
    await tx`
      INSERT INTO border_queue (id, post, min_hours, max_hours, note, updated_by, updated_at,
                                hours_since, prev_min_hours, prev_max_hours, prev_since)
      VALUES (${r.id}, ${r.post}, ${r.min_hours}, ${r.max_hours}, ${r.note}, ${r.updated_by},
              ${r.updated_at}::timestamptz, ${r.hours_since}::timestamptz, ${r.prev_min_hours},
              ${r.prev_max_hours}, ${r.prev_since}::timestamptz)`;
  }
}

/**
 * A truck of this spec's OWN on the road Yiwu → Tashkent, departed a day ago.
 * Borrowing «whatever is in transit» made the Mashina test conditional — and
 * in CI's order a later spec may have unloaded m3's truck, so it skipped
 * itself green (a conditional test proves nothing). Nothing is pressed on it,
 * so nothing refers to it and it is deleted by the spec's last test.
 */
export async function mintTruck(sql: postgres.Sql, logistPhone: string): Promise<string> {
  const code = `CHN${String(Date.now()).slice(-7)}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, departed_at, created_by)
    SELECT gen_random_uuid(), ${code}, o.id, d.id, 'in_transit', now() - interval '24 hours', u.id
    FROM warehouses o, warehouses d, users u
    WHERE o.code = 'YW' AND d.code = 'TAS1' AND u.phone = ${logistPhone}
    RETURNING id`;
  if (!row) throw new Error('the demo has no YW, TAS1 or logist to mint the truck from');
  return row.id;
}

export async function dropTruck(sql: postgres.Sql, id: string) {
  await sql`DELETE FROM batches WHERE id = ${id}`;
}
