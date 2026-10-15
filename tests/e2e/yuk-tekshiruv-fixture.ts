import postgres from 'postgres';

/**
 * What «m9zzy-yuk-tekshiruv» mints and gives back, in one place so the mint
 * and the cleanup cannot disagree about which rows are the spec's
 * (lot-tarkibi-fixture's shape).
 *
 * The owner's case, the spec's own: a client `YT<digits>` with a phone, a
 * confirmed prixod at YW (a CHINESE warehouse — where the ❓ is asked, his
 * 4a), ONE lot of 10 cartons received as «键盘YT<digits> (Клавиатура)»
 * standing on the shelf. Never the demo GS777: a check on it would be
 * configuration every later spec reads (#183).
 */

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export interface Run {
  marker: string;
  lotName: string;
}

export interface Minted {
  receiptId: string;
  lotId: string;
}

export function newRun(): Run {
  const digits = String(Date.now()).slice(-6);
  return { marker: `YT${digits}`, lotName: `键盘YT${digits}` };
}

export async function mint(sql: postgres.Sql, run: Run): Promise<Minted> {
  return sql.begin(async (tx) => {
    const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000001'`;
    const [yw] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'YW'`;
    if (!owner || !yw) throw new Error('the demo has no owner or no YW');
    const [client] = await tx<{ id: string }[]>`
      INSERT INTO clients (id, client_code, name, phones)
      VALUES (gen_random_uuid(), ${run.marker}, ${`Tekshiruv ${run.marker}`}, ${tx.json(['+998901112233'])})
      RETURNING id`;
    const [receipt] = await tx<{ id: string }[]>`
      INSERT INTO receipts (id, number, warehouse_id, client_id, status, confirmed_at, confirmed_by, source_note, created_by, created_at)
      VALUES (gen_random_uuid(), ${`${run.marker}-R`}, ${yw.id}, ${client!.id}, 'confirmed', now() - interval '1 day',
              ${owner.id}, ${run.marker}, ${owner.id}, now() - interval '1 day')
      RETURNING id`;
    const [lot] = await tx<{ id: string }[]>`
      INSERT INTO receipt_lots (id, receipt_id, seq, letter, cycle_no, product_name_zh, product_name_ru, box_count, dims_mode,
                                total_weight_kg, total_volume_m3)
      VALUES (gen_random_uuid(), ${receipt!.id}, 1, 'A', 1, ${run.lotName}, 'Клавиатура', 10, 'mixed', 100.000, 0.5000)
      RETURNING id`;
    await tx`
      INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
      SELECT gen_random_uuid(), ${lot!.id}, ${run.marker} || '-' || n, n, 'in_stock', ${yw.id}
        FROM generate_series(1, 10) AS n`;
    return { receiptId: receipt!.id, lotId: lot!.id };
  });
}

/** A run that died before its cleanup test: the next run clears every earlier marker. */
export async function cleanupEarlier(sql: postgres.Sql): Promise<void> {
  const earlier = await sql<{ client_code: string }[]>`
    SELECT client_code FROM clients WHERE name ~ '^Tekshiruv YT[0-9]{6}$' AND client_code ~ '^YT[0-9]{6}$'`;
  for (const row of earlier) {
    await cleanup(sql, { marker: row.client_code, lotName: `键盘${row.client_code}` });
  }
}

/** Deletes every row the run names, in FK order, and returns what still carries it. */
export async function cleanup(sql: postgres.Sql, run: Run): Promise<number> {
  await sql.begin(async (tx) => {
    const lotIds = (
      await tx<{ id: string }[]>`
        SELECT l.id FROM receipt_lots l JOIN receipts r ON r.id = l.receipt_id WHERE r.source_note = ${run.marker}`
    ).map((r) => r.id);
    if (lotIds.length > 0) {
      await tx`DELETE FROM lot_checks WHERE lot_id IN ${tx(lotIds)}`;
      await tx`DELETE FROM box_movements WHERE box_id IN (SELECT id FROM boxes WHERE lot_id IN ${tx(lotIds)})`;
      await tx`DELETE FROM boxes WHERE lot_id IN ${tx(lotIds)}`;
      await tx`DELETE FROM receipt_lots WHERE id IN ${tx(lotIds)}`;
    }
    await tx`DELETE FROM receipts WHERE source_note = ${run.marker}`;
    await tx`DELETE FROM clients WHERE client_code = ${run.marker}`;
  });
  const [left] = await sql<{ n: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE source_note = ${run.marker})
         + (SELECT count(*)::int FROM clients WHERE client_code = ${run.marker})
         + (SELECT count(*)::int FROM boxes WHERE short_code LIKE ${`${run.marker}-%`})
         + (SELECT count(*)::int FROM lot_checks WHERE seen_name_zh = ${run.lotName}) AS n`;
  return left!.n;
}
