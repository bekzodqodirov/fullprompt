import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';

/**
 * What «m9zzx-lot-tarkibi» mints and gives back, in one place so the mint and
 * the cleanup cannot disagree about which rows are the spec's (partiya-nomi's
 * shape).
 *
 * The owner's case, the spec's own: a client `LT<digits>`, a confirmed prixod
 * at YW, ONE lot of 100 cartons received as «键盘LT<digits>» (run-suffixed —
 * the demo GS777's «键盘» is in the TNVED memory, and a defect writing under
 * the lot's own name would be green there and would change shared
 * configuration, #183), 1000.000 kg / 2.5000 m³, every carton on a YW → TAS1
 * truck `LTT-<digits>` that has departed. The memory ROWS for the lot's key,
 * «клавиатура» and «мышь» are captured at mint and must be equal at the end.
 */

export const OWNER = '+998900000001';

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export interface Run {
  marker: string;
  truckCode: string;
  lotName: string;
}

export interface Minted {
  truckId: string;
  receiptId: string;
  lotId: string;
}

export function newRun(): Run {
  const digits = String(Date.now()).slice(-6);
  return { marker: `LT${digits}`, truckCode: `LTT-${digits}`, lotName: `键盘LT${digits}` };
}

const memoryKeys = (run: Run) => [run.lotName.toLowerCase(), 'клавиатура', 'мышь'];

/** The memory rows as (key, code, updated_at) — `saveTnved` UPSERTS, so a count cannot see an update. */
export async function memoryRows(sql: postgres.Sql, run: Run): Promise<string[]> {
  const rows = await sql<{ key: string; code: string; at: string }[]>`
    SELECT product_key AS key, tnved_code AS code, updated_at::text AS at
      FROM tnved_assignments WHERE product_key IN ${sql(memoryKeys(run))}
     ORDER BY product_key`;
  return rows.map((r) => `${r.key}|${r.code}|${r.at}`);
}

export async function mint(sql: postgres.Sql, run: Run): Promise<Minted> {
  return sql.begin(async (tx) => {
    const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = ${OWNER}`;
    if (!owner) throw new Error('the demo has no owner');
    const [places] = await tx<{ yw: string | null; tas: string | null }[]>`
      SELECT (SELECT id FROM warehouses WHERE code = 'YW') AS yw,
             (SELECT id FROM warehouses WHERE code = 'TAS1') AS tas`;
    if (!places?.yw || !places.tas) throw new Error('the demo has no YW and TAS1');

    const [client] = await tx<{ id: string }[]>`
      INSERT INTO clients (id, client_code, name)
      VALUES (gen_random_uuid(), ${run.marker}, ${`Tarkib ${run.marker}`}) RETURNING id`;
    const [truck] = await tx<{ id: string }[]>`
      INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, departed_at, created_by)
      VALUES (gen_random_uuid(), ${run.truckCode}, ${places.yw}, ${places.tas}, 'in_transit', now(), ${owner.id})
      RETURNING id`;
    const [receipt] = await tx<{ id: string }[]>`
      INSERT INTO receipts (id, number, warehouse_id, client_id, status, confirmed_at, confirmed_by, source_note, created_by, created_at)
      VALUES (gen_random_uuid(), ${`${run.marker}-R`}, ${places.yw}, ${client!.id}, 'confirmed', now() - interval '1 day',
              ${owner.id}, ${run.marker}, ${owner.id}, now() - interval '1 day')
      RETURNING id`;
    const [lot] = await tx<{ id: string }[]>`
      INSERT INTO receipt_lots (id, receipt_id, seq, letter, cycle_no, product_name_zh, box_count, dims_mode,
                                total_weight_kg, total_volume_m3)
      VALUES (gen_random_uuid(), ${receipt!.id}, 1, 'A', 1, ${run.lotName}, 100, 'mixed', 1000.000, 2.5000)
      RETURNING id`;
    await tx`
      INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_batch_id, current_warehouse_id)
      SELECT gen_random_uuid(), ${lot!.id}, ${run.marker} || '-' || n, n, 'in_transit', ${truck!.id}, NULL
        FROM generate_series(1, 100) AS n`;
    await tx`
      INSERT INTO box_movements (box_id, from_warehouse_id, to_warehouse_id, from_status, to_status, cause,
                                 ref_type, ref_id, actor_id)
      SELECT b.id, ${places.yw}, ${places.tas}, 'loading', 'in_transit', 'batch_departed', 'batch', ${truck!.id}, ${owner.id}
        FROM boxes b WHERE b.lot_id = ${lot!.id}`;
    return { truckId: truck!.id, receiptId: receipt!.id, lotId: lot!.id };
  });
}

/**
 * A run that died before its cleanup test left its marker behind (serial mode
 * skips the rest of the file after a failure): the next run clears every
 * earlier marker by the client's name shape before minting its own.
 */
export async function cleanupEarlier(sql: postgres.Sql): Promise<void> {
  const earlier = await sql<{ client_code: string }[]>`
    SELECT client_code FROM clients WHERE name ~ '^Tarkib LT[0-9]{6}$' AND client_code ~ '^LT[0-9]{6}$'`;
  for (const row of earlier) {
    const digits = row.client_code.slice(2);
    await cleanup(sql, { marker: row.client_code, truckCode: `LTT-${digits}`, lotName: `键盘LT${digits}` });
  }
}

/**
 * Deletes every row the run names, in FK order, and returns what still
 * carries it. The LOT goes first (its composition cascades — the document FK
 * is NO ACTION, so the composition must be gone before the document), then
 * the run's files WITH their bytes (the local driver's own paths), then the
 * rest.
 */
export async function cleanup(sql: postgres.Sql, run: Run) {
  const files = await sql<{ key: string; t2: string | null; t8: string | null }[]>`
    SELECT storage_key AS key, thumb_200_key AS t2, thumb_800_key AS t8 FROM attachments
     WHERE entity_type = 'receipt' AND entity_id IN (SELECT id FROM receipts WHERE source_note = ${run.marker})`;
  await sql.begin(async (tx) => {
    const truckIds = (await tx<{ id: string }[]>`SELECT id FROM batches WHERE code = ${run.truckCode}`).map((r) => r.id);
    const lotIds = (
      await tx<{ id: string }[]>`
        SELECT l.id FROM receipt_lots l JOIN receipts r ON r.id = l.receipt_id WHERE r.source_note = ${run.marker}`
    ).map((r) => r.id);
    if (lotIds.length > 0) {
      await tx`DELETE FROM batch_sent_compositions WHERE lot_id IN ${tx(lotIds)}`;
      await tx`DELETE FROM lot_compositions WHERE lot_id IN ${tx(lotIds)}`;
    }
    await tx`DELETE FROM attachments
              WHERE entity_type = 'receipt' AND entity_id IN (SELECT id FROM receipts WHERE source_note = ${run.marker})`;
    if (lotIds.length > 0) {
      await tx`DELETE FROM box_movements WHERE box_id IN (SELECT id FROM boxes WHERE lot_id IN ${tx(lotIds)})`;
      await tx`DELETE FROM boxes WHERE lot_id IN ${tx(lotIds)}`;
      await tx`DELETE FROM receipt_lots WHERE id IN ${tx(lotIds)}`;
    }
    await tx`DELETE FROM receipts WHERE source_note = ${run.marker}`;
    if (truckIds.length > 0) {
      await tx`DELETE FROM scan_events WHERE batch_id IN ${tx(truckIds)}`;
      await tx`DELETE FROM batches WHERE id IN ${tx(truckIds)}`;
    }
    await tx`DELETE FROM clients WHERE client_code = ${run.marker}`;
  });
  // The local driver's own path for a key (platform/files/storage.ts
  // `filePath`); the S3 driver is not used by a local or CI run.
  const dir = process.env.STORAGE_LOCAL_DIR ?? '.data/files';
  for (const f of files) {
    for (const key of [f.key, f.t2, f.t8]) {
      if (!key) continue;
      const safe = createHash('sha256').update(key).digest('hex');
      await rm(join(dir, safe.slice(0, 2), safe), { force: true });
    }
  }
  const [left] = await sql<{ n: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE source_note = ${run.marker})
         + (SELECT count(*)::int FROM batches WHERE code = ${run.truckCode})
         + (SELECT count(*)::int FROM clients WHERE client_code = ${run.marker})
         + (SELECT count(*)::int FROM boxes WHERE short_code LIKE ${`${run.marker}-%`}) AS n`;
  return left!.n;
}
