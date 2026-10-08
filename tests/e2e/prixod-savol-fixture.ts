import postgres from 'postgres';
import { hashPassword } from '@/modules/platform/auth/password';

/**
 * What «m9zzz-prixod-savol» mints and gives back, in one place so the mint
 * and the cleanup cannot disagree about which rows are the spec's (the
 * qarz-izoh fixture's shape).
 *
 * The owner's E6 c / E7 b case (2026-10-07): the logist asks about a prixod
 * standing at TAS1, and the question goes to the staff of TAS1.
 *
 *  - a TAS1 WAREHOUSE OPERATOR of the spec's own — `PS operator <marker>`,
 *    `warehouse_operator` scoped to TAS1, Uzbek — DEACTIVATED by the cleanup,
 *    never deleted (audit_log FK). Not a demo-seed account: the demo has no
 *    staff at any Uzbek warehouse, and a seeded one would join every TAS1
 *    recipient list for every later spec (#183). m9zzz-qarz-izoh, after this
 *    spec, mints a TAS1 manager of its own — so assertions about TAS1's
 *    audience say «contains my operator», never an exact count;
 *  - a client `PS<digits>` with NO seller;
 *  - a confirmed WALK-IN prixod at TAS1 with ONE lot of TWO cartons standing
 *    there (`in_stock`), so the cargo stands at TAS1 and nowhere else;
 *  - a second prixod RECEIVED at YW whose two cartons have since moved on to
 *    TAS1 — the YW operator still opens its card (the receiving warehouse, for
 *    ever) and the thread is TAS1's, so he is the «elsewhere» line's reader.
 */

export const PASSWORD = 'prixodsavol1234';

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export interface Run {
  marker: string;
  operatorPhone: string;
  operatorName: string;
}

export function newRun(): Run {
  const digits = String(Date.now()).slice(-7);
  const marker = `PS${digits.slice(-6)}`;
  return { marker, operatorPhone: `+99892${digits}`, operatorName: `PS operator ${marker}` };
}

export async function mint(
  sql: postgres.Sql,
  run: Run,
): Promise<{ receiptId: string; operatorId: string; movedReceiptId: string }> {
  const passwordHash = await hashPassword(PASSWORD);
  return sql.begin(async (tx) => {
    const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000001'`;
    const [tas] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'TAS1'`;
    const [yw] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'YW'`;
    const [role] = await tx<{ id: string }[]>`SELECT id FROM roles WHERE code = 'warehouse_operator'`;
    if (!owner || !tas || !yw || !role) throw new Error('the demo has no owner, no TAS1, no YW or no warehouse_operator role');
    const [operator] = await tx<{ id: string }[]>`
      INSERT INTO users (id, phone, full_name, password_hash, locale, active)
      VALUES (gen_random_uuid(), ${run.operatorPhone}, ${run.operatorName}, ${passwordHash}, 'uz', true)
      RETURNING id`;
    await tx`INSERT INTO user_roles (user_id, role_id) VALUES (${operator!.id}, ${role.id})`;
    await tx`INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (${operator!.id}, ${tas.id})`;
    const [client] = await tx<{ id: string }[]>`
      INSERT INTO clients (id, client_code, name, phones)
      VALUES (gen_random_uuid(), ${run.marker}, ${`Prixod savol ${run.marker}`}, ${tx.json([])})
      RETURNING id`;
    const [receipt] = await tx<{ id: string }[]>`
      INSERT INTO receipts (id, number, warehouse_id, client_id, status, confirmed_at, confirmed_by, source_note, created_by, created_at)
      VALUES (gen_random_uuid(), ${`${run.marker}-R`}, ${tas.id}, ${client!.id}, 'confirmed', now() - interval '1 day',
              ${owner.id}, ${run.marker}, ${owner.id}, now() - interval '1 day')
      RETURNING id`;
    const [lot] = await tx<{ id: string }[]>`
      INSERT INTO receipt_lots (id, receipt_id, seq, letter, cycle_no, product_name_zh, product_name_ru, box_count, dims_mode,
                                total_weight_kg, total_volume_m3)
      VALUES (gen_random_uuid(), ${receipt!.id}, 1, 'A', 1, ${'问答PS'}, 'Savol yuk', 2, 'mixed', 24.000, 0.2000)
      RETURNING id`;
    for (const seq of [1, 2]) {
      await tx`
        INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
        VALUES (gen_random_uuid(), ${lot!.id}, ${`${run.marker}-${seq}`}, ${seq}, 'in_stock', ${tas.id})`;
    }
    const [moved] = await tx<{ id: string }[]>`
      INSERT INTO receipts (id, number, warehouse_id, client_id, status, confirmed_at, confirmed_by, source_note, created_by, created_at)
      VALUES (gen_random_uuid(), ${`${run.marker}-Y`}, ${yw.id}, ${client!.id}, 'confirmed', now() - interval '9 days',
              ${owner.id}, ${run.marker}, ${owner.id}, now() - interval '9 days')
      RETURNING id`;
    const [movedLot] = await tx<{ id: string }[]>`
      INSERT INTO receipt_lots (id, receipt_id, seq, letter, cycle_no, product_name_zh, product_name_ru, box_count, dims_mode,
                                total_weight_kg, total_volume_m3)
      VALUES (gen_random_uuid(), ${moved!.id}, 1, 'A', 1, ${'问答PSY'}, 'Savol yuk Y', 2, 'mixed', 24.000, 0.2000)
      RETURNING id`;
    for (const seq of [1, 2]) {
      await tx`
        INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
        VALUES (gen_random_uuid(), ${movedLot!.id}, ${`${run.marker}-Y${seq}`}, ${seq}, 'in_stock', ${tas.id})`;
    }
    return { receiptId: receipt!.id, operatorId: operator!.id, movedReceiptId: moved!.id };
  });
}

/**
 * Every run this spec ever made, this one included — a run that died before
 * its cleanup test must not stack up (#523). Returns what still stands.
 */
export async function cleanupAll(sql: postgres.Sql): Promise<{ receipts: number; activeOperators: number }> {
  const runs = await sql<{ client_id: string; client_code: string }[]>`
    SELECT c.id AS client_id, c.client_code
      FROM clients c
     WHERE c.client_code ~ '^PS[0-9]{6}$' AND c.name = 'Prixod savol ' || c.client_code`;
  for (const run of runs) {
    await sql.begin(async (tx) => {
      const receiptIds = (
        await tx<{ id: string }[]>`SELECT id FROM receipts WHERE source_note = ${run.client_code}`
      ).map((row) => row.id);
      if (receiptIds.length > 0) {
        // The thread is data on the card: its pings, read marks and notes go
        // with it (the audit rows stay — audit_log refuses DELETE).
        await tx`DELETE FROM notifications WHERE payload -> 'thread' ->> 'id' IN ${tx(receiptIds)}`;
        await tx`DELETE FROM thread_reads WHERE thread_kind = 'receipt' AND thread_id IN ${tx(receiptIds)}`;
        await tx`DELETE FROM crm_activities WHERE entity_type = 'receipt' AND entity_id IN ${tx(receiptIds)}`;
        const lotIds = (
          await tx<{ id: string }[]>`SELECT id FROM receipt_lots WHERE receipt_id IN ${tx(receiptIds)}`
        ).map((row) => row.id);
        if (lotIds.length > 0) {
          await tx`DELETE FROM box_movements WHERE box_id IN (SELECT id FROM boxes WHERE lot_id IN ${tx(lotIds)})`;
          await tx`DELETE FROM boxes WHERE lot_id IN ${tx(lotIds)}`;
          await tx`DELETE FROM receipt_lots WHERE id IN ${tx(lotIds)}`;
        }
        await tx`DELETE FROM receipts WHERE id IN ${tx(receiptIds)}`;
      }
      await tx`DELETE FROM clients WHERE id = ${run.client_id}`;
    });
  }
  // DEACTIVATED, never deleted: his note's audit row names him. His own pings
  // and marks go, so a deactivated operator leaves nothing pending.
  const operators = (await sql<{ id: string }[]>`SELECT id FROM users WHERE full_name LIKE 'PS operator %'`).map((r) => r.id);
  if (operators.length > 0) {
    await sql`DELETE FROM notifications WHERE user_id IN ${sql(operators)}`;
    await sql`DELETE FROM thread_reads WHERE user_id IN ${sql(operators)}`;
    await sql`UPDATE users SET active = false WHERE id IN ${sql(operators)} AND active`;
  }
  const [left] = await sql<{ receipts: number; active_operators: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE source_note ~ '^PS[0-9]{6}$') AS receipts,
           (SELECT count(*)::int FROM users WHERE full_name LIKE 'PS operator %' AND active) AS active_operators`;
  return { receipts: left!.receipts, activeOperators: left!.active_operators };
}
