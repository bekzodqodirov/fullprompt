import postgres from 'postgres';

/**
 * What «m9zzv-partiya-nomi» mints and gives back, in one place so the mint and
 * the cleanup cannot disagree about which rows are the spec's (chegara's and
 * stamp-profit's shape).
 *
 * The spec needs its OWN truck ON THE ROAD — a YW → TAS1 truck, departed, with
 * one carton still aboard — because a truck with nothing aboard is closed to
 * renaming by design, and m3's trucks are never borrowed (#154). Every row
 * carries the run's MARKER (the client code, the receipt's note, the carton's
 * code and the truck's first name) so the cleanup deletes by the marker and
 * then proves nothing carries it. The truck's first name is `PNT-<digits>`
 * and NOT `<marker>-T`: that one is lot-shaped, and ⌘K sends a lot-shaped
 * query to lots only, so the old name could never be searched.
 *
 * The rename itself leaves one `audit_log` row, which the database refuses to
 * delete; every former-name reader JOINs to `batches`, so it is invisible
 * once the truck is gone.
 */

export const OWNER = '+998900000001';

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export interface Minted {
  marker: string;
  truckId: string;
  oldCode: string;
  newCode: string;
}

export function newRun(): Omit<Minted, 'truckId'> {
  const digits = String(Date.now()).slice(-6);
  return { marker: `PN${digits}`, oldCode: `PNT-${digits}`, newCode: `KA-7${digits}` };
}

export async function mint(sql: postgres.Sql, run: Omit<Minted, 'truckId'>): Promise<string> {
  return sql.begin(async (tx) => {
    const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = ${OWNER}`;
    if (!owner) throw new Error('the demo has no owner');
    const [places] = await tx<{ yw: string | null; tas: string | null }[]>`
      SELECT (SELECT id FROM warehouses WHERE code = 'YW') AS yw,
             (SELECT id FROM warehouses WHERE code = 'TAS1') AS tas`;
    if (!places?.yw || !places.tas) throw new Error('the demo has no YW and TAS1');

    const [client] = await tx<{ id: string }[]>`
      INSERT INTO clients (id, client_code, name)
      VALUES (gen_random_uuid(), ${run.marker}, ${`Nomi ${run.marker}`}) RETURNING id`;
    const [truck] = await tx<{ id: string }[]>`
      INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, departed_at, created_by)
      VALUES (gen_random_uuid(), ${run.oldCode}, ${places.yw}, ${places.tas}, 'in_transit', now(), ${owner.id})
      RETURNING id`;
    const [receipt] = await tx<{ id: string }[]>`
      INSERT INTO receipts (id, warehouse_id, client_id, status, confirmed_at, source_note, created_by)
      VALUES (gen_random_uuid(), ${places.yw}, ${client!.id}, 'confirmed', now(), ${run.marker}, ${owner.id})
      RETURNING id`;
    const [lot] = await tx<{ id: string }[]>`
      INSERT INTO receipt_lots (id, receipt_id, seq, product_name_zh, box_count, total_weight_kg, total_volume_m3)
      VALUES (gen_random_uuid(), ${receipt!.id}, 1, ${`改名${run.marker}`}, 1, 10, 0.2) RETURNING id`;
    const [box] = await tx<{ id: string }[]>`
      INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_batch_id, current_warehouse_id)
      VALUES (gen_random_uuid(), ${lot!.id}, ${`${run.marker}A`}, 1, 'in_transit', ${truck!.id}, NULL) RETURNING id`;
    await tx`
      INSERT INTO box_movements (box_id, from_warehouse_id, to_warehouse_id, from_status, to_status, cause,
                                 ref_type, ref_id, actor_id)
      VALUES (${box!.id}, ${places.yw}, ${places.tas}, 'loading', 'in_transit', 'batch_departed',
              'batch', ${truck!.id}, ${owner.id})`;
    return truck!.id;
  });
}

/**
 * A run that died before its cleanup test left its marker behind (serial mode
 * skips the rest of the file after a failure): the next run clears every
 * earlier marker by the client's name shape before minting its own.
 */
export async function cleanupEarlier(sql: postgres.Sql): Promise<void> {
  const earlier = await sql<{ client_code: string }[]>`
    SELECT client_code FROM clients WHERE name ~ '^Nomi PN[0-9]{6}$' AND client_code ~ '^PN[0-9]{6}$'`;
  for (const row of earlier) {
    const digits = row.client_code.slice(2);
    await cleanup(sql, { marker: row.client_code, oldCode: `PNT-${digits}`, newCode: `KA-7${digits}` });
  }
}

/** Deletes every row the run names, in FK order, and returns what still carries it. */
export async function cleanup(sql: postgres.Sql, run: Omit<Minted, 'truckId'>) {
  await sql.begin(async (tx) => {
    const truckIds = (
      await tx<{ id: string }[]>`SELECT id FROM batches WHERE code IN (${run.oldCode}, ${run.newCode})`
    ).map((r) => r.id);
    const boxIds = (await tx<{ id: string }[]>`SELECT id FROM boxes WHERE short_code = ${`${run.marker}A`}`).map(
      (r) => r.id,
    );
    if (truckIds.length > 0) await tx`DELETE FROM scan_events WHERE batch_id IN ${tx(truckIds)}`;
    if (boxIds.length > 0) {
      await tx`DELETE FROM box_movements WHERE box_id IN ${tx(boxIds)}`;
      await tx`DELETE FROM boxes WHERE id IN ${tx(boxIds)}`;
    }
    await tx`DELETE FROM receipt_lots WHERE receipt_id IN (SELECT id FROM receipts WHERE source_note = ${run.marker})`;
    await tx`DELETE FROM receipts WHERE source_note = ${run.marker}`;
    if (truckIds.length > 0) await tx`DELETE FROM batches WHERE id IN ${tx(truckIds)}`;
    await tx`DELETE FROM clients WHERE client_code = ${run.marker}`;
  });
  const [left] = await sql<{ receipts: number; batches: number; clients: number; boxes: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE source_note = ${run.marker}) AS receipts,
           (SELECT count(*)::int FROM batches WHERE code IN (${run.oldCode}, ${run.newCode})) AS batches,
           (SELECT count(*)::int FROM clients WHERE client_code = ${run.marker}) AS clients,
           (SELECT count(*)::int FROM boxes WHERE short_code = ${`${run.marker}A`}) AS boxes`;
  return left!;
}
