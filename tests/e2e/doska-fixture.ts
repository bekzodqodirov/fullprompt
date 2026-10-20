import postgres from 'postgres';

/**
 * The batch board specs' own truck (docs/PARTIYA-DOSKASI.md). Borrowing
 * «whatever is on the road» makes a spec conditional, and in CI's order a
 * later spec may have unloaded it (the chegara round's lesson). Minted on the
 * seeded YW → TAS1 road, departed a day ago — inside China by its schedule —
 * with a driver's number written the way people write it. A pin press writes
 * an audit row and nothing that refers to the truck, so the spec's last test
 * deletes it.
 */

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and drop the board spec’s truck');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export const DRIVER = '+998 90 765-43-21 (Akmal)';

export async function mintBoardTruck(sql: postgres.Sql, ownerPhone: string): Promise<{ id: string; code: string }> {
  const code = `DSK${String(Date.now()).slice(-7)}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, departed_at, driver_phone, created_by)
    SELECT gen_random_uuid(), ${code}, o.id, d.id, 'in_transit', now() - interval '24 hours', ${DRIVER}, u.id
    FROM warehouses o, warehouses d, users u
    WHERE o.code = 'YW' AND d.code = 'TAS1' AND u.phone = ${ownerPhone}
    RETURNING id`;
  if (!row) throw new Error('the demo has no YW, TAS1 or owner to mint the truck from');
  return { id: row.id, code };
}

export async function dropBoardTruck(sql: postgres.Sql, id: string) {
  await sql`DELETE FROM batches WHERE id = ${id}`;
}
