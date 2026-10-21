import postgres from 'postgres';

/**
 * The batch board specs' own truck (docs/PARTIYA-DOSKASI.md). Borrowing
 * «whatever is on the road» makes a spec conditional, and in CI's order a
 * later spec may have unloaded it (the chegara round's lesson). Minted on the
 * seeded YW → TAS1 road, departed a day ago — inside China by its schedule —
 * with a driver's number written the way people write it. A pin press writes
 * an audit row and nothing that refers to the truck, so the spec deletes it
 * (`dropSpecTrucks`).
 */

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and drop the board spec’s truck');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export const DRIVER = '+998 90 765-43-21 (Akmal)';

/**
 * A spec's trucks carry its own code prefix, so its `afterAll` can delete
 * every one it ever minted — a failed serial test skips the final cleanup,
 * and a CI retry re-runs `beforeAll` in a new worker that has forgotten the
 * first attempt's ids (the review: an in_transit truck left on every later
 * board, dashboard and map, #154/#183).
 */
export async function dropSpecTrucks(sql: postgres.Sql, prefix: string) {
  await sql`DELETE FROM batches WHERE code LIKE ${`${prefix}%`}`;
}

export async function mintBoardTruck(
  sql: postgres.Sql,
  ownerPhone: string,
  prefix = 'DSK',
): Promise<{ id: string; code: string }> {
  const code = `${prefix}${String(Date.now()).slice(-7)}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, departed_at, driver_phone, created_by)
    SELECT gen_random_uuid(), ${code}, o.id, d.id, 'in_transit', now() - interval '24 hours', ${DRIVER}, u.id
    FROM warehouses o, warehouses d, users u
    WHERE o.code = 'YW' AND d.code = 'TAS1' AND u.phone = ${ownerPhone}
    RETURNING id`;
  if (!row) throw new Error('the demo has no YW, TAS1 or owner to mint the truck from');
  return { id: row.id, code };
}

/**
 * A truck on the Chinese road from Yiwu to the Kashgar hub, departed a day
 * ago — the inland road column's card (his «xitoy ichidagi va tashqisi»,
 * 2026-10-21).
 */
export async function mintInlandTruck(sql: postgres.Sql, ownerPhone: string, prefix = 'DSI'): Promise<{ id: string; code: string }> {
  return mintRoadTruck(sql, ownerPhone, prefix, 'YW', 'KA');
}

/** A truck a day out on the road between two seeded warehouses. */
export async function mintRoadTruck(
  sql: postgres.Sql,
  ownerPhone: string,
  prefix: string,
  origin: string,
  dest: string,
): Promise<{ id: string; code: string }> {
  const code = `${prefix}${String(Date.now()).slice(-7)}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, departed_at, created_by)
    SELECT gen_random_uuid(), ${code}, o.id, d.id, 'in_transit', now() - interval '24 hours', u.id
    FROM warehouses o, warehouses d, users u
    WHERE o.code = ${origin} AND d.code = ${dest} AND u.phone = ${ownerPhone}
    RETURNING id`;
  if (!row) throw new Error(`the demo has no ${origin}, ${dest} or owner to mint the truck from`);
  return { id: row.id, code };
}

/** A quick truck being formed at Yiwu: no plan, nothing scanned. */
export async function mintFormingTruck(sql: postgres.Sql, ownerPhone: string): Promise<{ id: string; code: string }> {
  const code = `DSF${String(Date.now()).slice(-7)}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, created_by)
    SELECT gen_random_uuid(), ${code}, o.id, d.id, 'forming', u.id
    FROM warehouses o, warehouses d, users u
    WHERE o.code = 'YW' AND d.code = 'TAS1' AND u.phone = ${ownerPhone}
    RETURNING id`;
  if (!row) throw new Error('the demo has no YW, TAS1 or owner to mint the truck from');
  return { id: row.id, code };
}
