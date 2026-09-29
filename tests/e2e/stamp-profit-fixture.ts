import postgres from 'postgres';

/**
 * What «m9zzu-foyda-stamp» mints and gives back, in one place so the mint and
 * the cleanup cannot disagree about which rows are the spec's (chegara's
 * shape). Everything sits in OCTOBER 2018, a period no other spec or test
 * writes a ledger row in, and every row carries the run's MARKER — the client
 * code, the truck code, the carton codes and the charges' note — so the
 * cleanup deletes by the marker and then proves nothing carries it.
 *
 * The 4a case, made impossible on the old code: a client whose card names
 * Dilnoza, with cargo stamped Admin Demo (2 m³) and Dilnoza (1 m³) received
 * in SEPTEMBER (outside the period, so no cargo column can draw an Admin row),
 * one truck price of $90 over both (split 60 / 30 by m³) and one card price
 * of $40 (the newest prixod by its day is Dilnoza's). The client-book code
 * would put all $130 on Dilnoza and nothing on Admin Demo.
 */

export const OWNER = '+998900000001';
export const STAMP_A = '+998900000002'; // Admin Demo
export const BOOK = '+998900000009'; // Dilnoza (Sales)

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export function newMarker(): string {
  return `FS${String(Date.now()).slice(-6)}`;
}

export async function mint(sql: postgres.Sql, marker: string): Promise<void> {
  await sql.begin(async (tx) => {
    const people = await tx<{ phone: string; id: string }[]>`
      SELECT phone, id FROM users WHERE phone IN (${OWNER}, ${STAMP_A}, ${BOOK})`;
    const id = (phone: string) => {
      const row = people.find((p) => p.phone === phone);
      if (!row) throw new Error(`the demo has no user ${phone}`);
      return row.id;
    };
    const owner = id(OWNER);
    const [places] = await tx<{ cn: string | null; uz: string | null }[]>`
      SELECT (SELECT id FROM warehouses WHERE country = 'CN' AND active ORDER BY code LIMIT 1) AS cn,
             (SELECT id FROM warehouses WHERE country = 'UZ' AND active ORDER BY code LIMIT 1) AS uz`;
    if (!places?.cn || !places.uz) throw new Error('the demo has no active CN and UZ warehouse');

    const [client] = await tx<{ id: string }[]>`
      INSERT INTO clients (id, client_code, name, sales_manager_id)
      VALUES (gen_random_uuid(), ${marker}, ${`Foyda ${marker}`}, ${id(BOOK)}) RETURNING id`;
    const [truck] = await tx<{ id: string }[]>`
      INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, departed_at, created_by)
      VALUES (gen_random_uuid(), ${`${marker}-T`}, ${places.cn}, ${places.uz}, 'in_transit', '2018-09-25T10:00:00+05:00', ${owner})
      RETURNING id`;

    const cargo = async (tag: string, stamp: string, day: string, m3: string, kg: string) => {
      const [receipt] = await tx<{ id: string }[]>`
        INSERT INTO receipts (id, warehouse_id, client_id, sales_manager_id, status, received_at, confirmed_at,
                              source_note, created_by)
        VALUES (gen_random_uuid(), ${places.cn}, ${client!.id}, ${stamp}, 'confirmed', ${`${day}T10:00:00+05:00`},
                ${`${day}T10:00:00+05:00`}, ${marker}, ${owner})
        RETURNING id`;
      const [lot] = await tx<{ id: string }[]>`
        INSERT INTO receipt_lots (id, receipt_id, seq, product_name_zh, box_count, total_weight_kg, total_volume_m3)
        VALUES (gen_random_uuid(), ${receipt!.id}, 1, ${`货${marker}${tag}`}, 1, ${kg}, ${m3}) RETURNING id`;
      const [box] = await tx<{ id: string }[]>`
        INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
        VALUES (gen_random_uuid(), ${lot!.id}, ${`${marker}${tag}`}, 1, 'in_transit', NULL) RETURNING id`;
      await tx`
        INSERT INTO box_movements (box_id, from_warehouse_id, to_warehouse_id, from_status, to_status, cause,
                                   ref_type, ref_id, actor_id)
        VALUES (${box!.id}, ${places.cn}, ${places.uz}, 'loading', 'in_transit', 'batch_departed',
                'batch', ${truck!.id}, ${owner})`;
    };
    await cargo('A', id(STAMP_A), '2018-09-19', '2', '200');
    await cargo('D', id(BOOK), '2018-09-20', '1', '100');

    // The truck price over both stamps, and a card price that names no cargo.
    await tx`
      INSERT INTO client_transactions (id, client_id, type, amount, currency, rate_to_usd, amount_usd, tx_date,
                                       batch_id, note, created_by)
      VALUES (gen_random_uuid(), ${client!.id}, 'charge', 90, 'USD', 1, 90, '2018-10-10', ${truck!.id}, ${marker}, ${owner}),
             (gen_random_uuid(), ${client!.id}, 'charge', 40, 'USD', 1, 40, '2018-10-12', NULL, ${marker}, ${owner})`;
  });
}

/**
 * A run that died before its cleanup test left its marker behind (serial mode
 * skips the rest of the file after a failure): the next run's first test
 * clears every earlier marker by the client's name shape before minting its own.
 */
export async function cleanupEarlier(sql: postgres.Sql): Promise<void> {
  const earlier = await sql<{ client_code: string }[]>`
    SELECT client_code FROM clients WHERE name ~ '^Foyda FS[0-9]{6}$' AND client_code ~ '^FS[0-9]{6}$'`;
  for (const row of earlier) await cleanup(sql, row.client_code);
}

/** Deletes every row the marker names, in FK order, and returns what still carries it. */
export async function cleanup(sql: postgres.Sql, marker: string) {
  await sql.begin(async (tx) => {
    const clientIds = (await tx<{ id: string }[]>`SELECT id FROM clients WHERE client_code = ${marker}`).map(
      (r) => r.id,
    );
    const boxIds = (
      await tx<{ id: string }[]>`SELECT id FROM boxes WHERE short_code LIKE ${`${marker}%`}`
    ).map((r) => r.id);
    if (clientIds.length > 0) await tx`DELETE FROM client_transactions WHERE client_id IN ${tx(clientIds)}`;
    if (boxIds.length > 0) {
      await tx`DELETE FROM box_movements WHERE box_id IN ${tx(boxIds)}`;
      await tx`DELETE FROM boxes WHERE id IN ${tx(boxIds)}`;
    }
    await tx`DELETE FROM receipt_lots WHERE receipt_id IN (SELECT id FROM receipts WHERE source_note = ${marker})`;
    await tx`DELETE FROM receipts WHERE source_note = ${marker}`;
    await tx`DELETE FROM batches WHERE code = ${`${marker}-T`}`;
    await tx`DELETE FROM clients WHERE client_code = ${marker}`;
  });
  const [left] = await sql<{ charges: number; receipts: number; batches: number; clients: number }[]>`
    SELECT (SELECT count(*)::int FROM client_transactions WHERE note = ${marker}) AS charges,
           (SELECT count(*)::int FROM receipts WHERE source_note = ${marker}) AS receipts,
           (SELECT count(*)::int FROM batches WHERE code LIKE ${`${marker}%`}) AS batches,
           (SELECT count(*)::int FROM clients WHERE client_code = ${marker}) AS clients`;
  return left!;
}
