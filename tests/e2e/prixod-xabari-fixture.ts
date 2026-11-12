import postgres from 'postgres';

/**
 * What «m9zzzi-prixod-xabari» mints and gives back, in one place so the mint
 * and the cleanup cannot disagree about which rows are the spec's (the
 * prixod-savol fixture's shape).
 *
 * The owner's case (2026-11-11): the seller is told «Prixod keldi» with a
 * «🔗 Bitim biriktirish» button that opens the prixod AT its deal block.
 *
 *  - a client `PX<digits>` whose seller is the demo SELLER, with NO deal — so
 *    the card offers «+ Yangi bitim ochish»;
 *  - a confirmed prixod of theirs at YW, one lot, one carton on the shelf;
 *  - two files on it: one the SELLER uploaded (theirs to take back) and one
 *    the office did (not theirs).
 *
 * Nothing here is configuration: a client, a prixod and — once the spec has
 * pressed — one deal, all deleted by the cleanup TEST (#523).
 */

export const SELLER_PHONE = '+998900000009';

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export interface Run {
  marker: string;
}

export function newRun(): Run {
  return { marker: `PX${String(Date.now()).slice(-6)}` };
}

export async function mint(sql: postgres.Sql, run: Run): Promise<{ receiptId: string; clientId: string; number: string }> {
  return sql.begin(async (tx) => {
    const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000001'`;
    const [seller] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = ${SELLER_PHONE}`;
    const [yw] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'YW'`;
    if (!owner || !seller || !yw) throw new Error('the demo has no owner, no seller or no YW');
    const [client] = await tx<{ id: string }[]>`
      INSERT INTO clients (id, client_code, name, phones, sales_manager_id)
      VALUES (gen_random_uuid(), ${run.marker}, ${`Prixod xabari ${run.marker}`}, ${tx.json([])}, ${seller.id})
      RETURNING id`;
    const number = `${run.marker}-R`;
    const [receipt] = await tx<{ id: string }[]>`
      INSERT INTO receipts (id, number, warehouse_id, client_id, status, confirmed_at, confirmed_by, source_note, created_by, created_at)
      VALUES (gen_random_uuid(), ${number}, ${yw.id}, ${client!.id}, 'confirmed', now() - interval '1 hour',
              ${owner.id}, ${run.marker}, ${owner.id}, now() - interval '1 hour')
      RETURNING id`;
    const [lot] = await tx<{ id: string }[]>`
      INSERT INTO receipt_lots (id, receipt_id, seq, letter, cycle_no, product_name_zh, product_name_ru, box_count, dims_mode,
                                total_weight_kg, total_volume_m3)
      VALUES (gen_random_uuid(), ${receipt!.id}, 1, 'A', 1, ${'通知PX'}, 'Xabar yuk', 1, 'mixed', 12.000, 0.1000)
      RETURNING id`;
    await tx`
      INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
      VALUES (gen_random_uuid(), ${lot!.id}, ${`${run.marker}-1`}, 1, 'in_stock', ${yw.id})`;
    for (const [name, by] of [
      [`seller-${run.marker}.pdf`, seller.id],
      [`office-${run.marker}.pdf`, owner.id],
    ] as const) {
      await tx`
        INSERT INTO attachments (id, entity_type, entity_id, kind, storage_key, file_name, content_type, size_bytes, uploaded_by)
        VALUES (gen_random_uuid(), 'receipt', ${receipt!.id}, 'file', ${`pxtest/${receipt!.id}/${name}`}, ${name}, 'application/pdf', 1, ${by})`;
    }
    return { receiptId: receipt!.id, clientId: client!.id, number };
  });
}

/**
 * Only the seller's own files left on the prixod — `count` of them — the
 * state in which taking them back leaves nothing to list for a reader who
 * cannot attach. Returns their names, in the order they were written.
 */
export async function leaveSellerFiles(sql: postgres.Sql, run: Run, receiptId: string, count: number): Promise<string[]> {
  const [seller] = await sql<{ id: string }[]>`SELECT id FROM users WHERE phone = ${SELLER_PHONE}`;
  if (!seller) throw new Error('the demo has no seller');
  await sql`DELETE FROM attachments WHERE entity_type = 'receipt' AND entity_id = ${receiptId}`;
  const names: string[] = [];
  for (let i = 1; i <= count; i++) {
    const name = `last${i}-${run.marker}.pdf`;
    await sql`
      INSERT INTO attachments (id, entity_type, entity_id, kind, storage_key, file_name, content_type, size_bytes, uploaded_by)
      VALUES (gen_random_uuid(), 'receipt', ${receiptId}, 'file', ${`pxtest/${receiptId}/${name}`}, ${name}, 'application/pdf', 1, ${seller.id})`;
    names.push(name);
  }
  return names;
}

/**
 * A SECOND client of the same seller — where a client correction moves the
 * prixod TO. Its code is the run's own digits shifted by half the range, so
 * it wears the spec's shape (and the cleanup's) and can never be the run's.
 */
export async function mintSibling(sql: postgres.Sql, run: Run): Promise<{ clientId: string; code: string }> {
  const digits = (Number(run.marker.slice(2)) + 500_000) % 1_000_000;
  const code = `PX${String(digits).padStart(6, '0')}`;
  const [seller] = await sql<{ id: string }[]>`SELECT id FROM users WHERE phone = ${SELLER_PHONE}`;
  if (!seller) throw new Error('the demo has no seller');
  const [client] = await sql<{ id: string }[]>`
    INSERT INTO clients (id, client_code, name, phones, sales_manager_id)
    VALUES (gen_random_uuid(), ${code}, ${`Prixod xabari ${code}`}, ${sql.json([])}, ${seller.id})
    RETURNING id`;
  return { clientId: client!.id, code };
}

/**
 * Every run this spec ever made, this one included — a run that died before
 * its cleanup test must not stack up (#523). Returns what still stands.
 */
export async function cleanupAll(sql: postgres.Sql): Promise<{ clients: number; receipts: number; deals: number }> {
  const runs = await sql<{ id: string; client_code: string }[]>`
    SELECT id, client_code FROM clients
     WHERE client_code ~ '^PX[0-9]{6}$' AND name = 'Prixod xabari ' || client_code`;
  // A prixod of ONE of the spec's clients may stand on a deal of ANOTHER (the
  // «left on another client's deal» test, or a run that died inside it), and
  // `receipts.deal_id` has no ON DELETE: let go of every deal first, or the
  // order the clients happen to come back in decides whether this throws.
  if (runs.length > 0) {
    await sql`UPDATE receipts SET deal_id = NULL WHERE client_id IN ${sql(runs.map((run) => run.id))}`;
  }
  for (const run of runs) {
    await sql.begin(async (tx) => {
      const receiptIds = (await tx<{ id: string }[]>`SELECT id FROM receipts WHERE client_id = ${run.id}`).map((row) => row.id);
      if (receiptIds.length > 0) {
        await tx`DELETE FROM attachments WHERE entity_type = 'receipt' AND entity_id IN ${tx(receiptIds)}`;
        const lotIds = (await tx<{ id: string }[]>`SELECT id FROM receipt_lots WHERE receipt_id IN ${tx(receiptIds)}`).map((row) => row.id);
        if (lotIds.length > 0) {
          await tx`DELETE FROM box_movements WHERE box_id IN (SELECT id FROM boxes WHERE lot_id IN ${tx(lotIds)})`;
          await tx`DELETE FROM boxes WHERE lot_id IN ${tx(lotIds)}`;
          await tx`DELETE FROM receipt_lots WHERE id IN ${tx(lotIds)}`;
        }
        await tx`DELETE FROM notifications WHERE event_id IN (SELECT id FROM events WHERE entity_id IN ${tx(receiptIds)})`;
        await tx`DELETE FROM events WHERE entity_id IN ${tx(receiptIds)}`;
        await tx`DELETE FROM receipts WHERE id IN ${tx(receiptIds)}`;
      }
      // The deal the spec opened: a job with no cargo left on it (the prixod
      // above went first), no line and no money.
      const dealIds = (await tx<{ id: string }[]>`SELECT id FROM deals WHERE client_id = ${run.id}`).map((row) => row.id);
      if (dealIds.length > 0) {
        await tx`DELETE FROM notifications WHERE event_id IN (SELECT id FROM events WHERE entity_id IN ${tx(dealIds)})`;
        await tx`DELETE FROM events WHERE entity_id IN ${tx(dealIds)}`;
        await tx`DELETE FROM deals WHERE id IN ${tx(dealIds)}`;
      }
      await tx`DELETE FROM clients WHERE id = ${run.id}`;
    });
  }
  const [left] = await sql<{ clients: number; receipts: number; deals: number }[]>`
    SELECT (SELECT count(*)::int FROM clients WHERE client_code ~ '^PX[0-9]{6}$' AND name = 'Prixod xabari ' || client_code) AS clients,
           (SELECT count(*)::int FROM receipts WHERE source_note ~ '^PX[0-9]{6}$') AS receipts,
           (SELECT count(*)::int FROM deals d JOIN clients c ON c.id = d.client_id
             WHERE c.client_code ~ '^PX[0-9]{6}$' AND c.name = 'Prixod xabari ' || c.client_code) AS deals`;
  return left!;
}
