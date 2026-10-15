import postgres from 'postgres';
import { hashPassword } from '@/modules/platform/auth/password';

/**
 * What «m9zzz-qarz-izoh» mints and gives back, in one place so the mint and
 * the cleanup cannot disagree about which rows are the spec's (the
 * yuk-tekshiruv fixture's shape).
 *
 * The owner's D2 case (2026-10-07, «sklad mudiri so'ramasdan beraversin»):
 *
 *  - a TAS1 WAREHOUSE MANAGER of the spec's own — `QI manager <marker>`,
 *    `warehouse_manager` scoped to TAS1 — DEACTIVATED by the cleanup, never
 *    deleted (audit_log FK). Not a demo-seed account: a seeded manager at TAS1
 *    would join every TAS1 recipient list, the debt grant's holders and the
 *    TAS1 home flows for every later spec — configuration, not data (#183);
 *  - a client `QI<digits>` with NO seller, so the seller in step 3 is not
 *    the client's and reads no money on the card;
 *  - a confirmed WALK-IN prixod at TAS1 (received there — not gated by the
 *    price ban) with ONE lot of ONE carton, so the whole lot goes out and
 *    nothing of the debtor stays on the shelf;
 *  - a $77.77 USD charge, noted, so the counter's debt gate is this spec's
 *    own and not whatever an earlier spec left (#154).
 */

export const PASSWORD = 'qarzizoh1234';

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export interface Run {
  marker: string;
  managerPhone: string;
  managerName: string;
  chargeNote: string;
}

export function newRun(): Run {
  const digits = String(Date.now()).slice(-7);
  const marker = `QI${digits.slice(-6)}`;
  return {
    marker,
    managerPhone: `+99891${digits}`,
    managerName: `QI manager ${marker}`,
    chargeNote: `qarz izoh e2e ${marker}`,
  };
}

export async function mint(sql: postgres.Sql, run: Run): Promise<{ clientId: string }> {
  const passwordHash = await hashPassword(PASSWORD);
  return sql.begin(async (tx) => {
    const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000001'`;
    const [tas] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'TAS1'`;
    const [role] = await tx<{ id: string }[]>`SELECT id FROM roles WHERE code = 'warehouse_manager'`;
    if (!owner || !tas || !role) throw new Error('the demo has no owner, no TAS1 or no warehouse_manager role');
    const [manager] = await tx<{ id: string }[]>`
      INSERT INTO users (id, phone, full_name, password_hash, locale, active)
      VALUES (gen_random_uuid(), ${run.managerPhone}, ${run.managerName}, ${passwordHash}, 'uz', true)
      RETURNING id`;
    await tx`INSERT INTO user_roles (user_id, role_id) VALUES (${manager!.id}, ${role.id})`;
    await tx`INSERT INTO user_warehouses (user_id, warehouse_id) VALUES (${manager!.id}, ${tas.id})`;
    const [client] = await tx<{ id: string }[]>`
      INSERT INTO clients (id, client_code, name, phones)
      VALUES (gen_random_uuid(), ${run.marker}, ${`Qarz izoh ${run.marker}`}, ${tx.json(['+998901112244'])})
      RETURNING id`;
    const [receipt] = await tx<{ id: string }[]>`
      INSERT INTO receipts (id, number, warehouse_id, client_id, status, confirmed_at, confirmed_by, source_note, created_by, created_at)
      VALUES (gen_random_uuid(), ${`${run.marker}-R`}, ${tas.id}, ${client!.id}, 'confirmed', now() - interval '1 day',
              ${owner.id}, ${run.marker}, ${owner.id}, now() - interval '1 day')
      RETURNING id`;
    const [lot] = await tx<{ id: string }[]>`
      INSERT INTO receipt_lots (id, receipt_id, seq, letter, cycle_no, product_name_zh, product_name_ru, box_count, dims_mode,
                                total_weight_kg, total_volume_m3)
      VALUES (gen_random_uuid(), ${receipt!.id}, 1, 'A', 1, ${`欠款QI`}, 'Qarz yuk', 1, 'mixed', 12.000, 0.1000)
      RETURNING id`;
    await tx`
      INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
      VALUES (gen_random_uuid(), ${lot!.id}, ${`${run.marker}-1`}, 1, 'in_stock', ${tas.id})`;
    await tx`
      INSERT INTO client_transactions (id, client_id, type, amount, currency, rate_to_usd, amount_usd, tx_date, note, created_by)
      VALUES (gen_random_uuid(), ${client!.id}, 'charge', 77.77, 'USD', 1, 77.77, current_date, ${run.chargeNote}, ${owner.id})`;
    return { clientId: client!.id };
  });
}

/**
 * Every run this spec ever made, this one included — a run that died before
 * its cleanup test must not stack up (#523). Returns what still stands.
 */
export async function cleanupAll(sql: postgres.Sql): Promise<{ issuable: number; activeManagers: number }> {
  const runs = await sql<{ client_id: string; client_code: string; handovers: number }[]>`
    SELECT c.id AS client_id, c.client_code,
           (SELECT count(*)::int FROM handovers h WHERE h.client_id = c.id) AS handovers
      FROM clients c
     WHERE c.client_code ~ '^QI[0-9]{6}$' AND c.name = 'Qarz izoh ' || c.client_code`;
  for (const run of runs) {
    await sql.begin(async (tx) => {
      // The owner's and the accountant's «qarzga yuk berildi» about this client.
      await tx`DELETE FROM notifications WHERE type = 'DebtReleased' AND payload->>'text' LIKE ${`%${run.client_code}%`}`;
      if (run.handovers > 0) {
        // History is kept: the carton went out with the handover, so nothing
        // stands on a shelf; the debt this spec raised is voided.
        await tx`
          UPDATE client_transactions SET voided_at = now(), voided_by = created_by, void_reason = 'e2e cleanup'
           WHERE client_id = ${run.client_id} AND voided_at IS NULL AND note LIKE 'qarz izoh e2e %'`;
        return;
      }
      const lotIds = (
        await tx<{ id: string }[]>`
          SELECT l.id FROM receipt_lots l JOIN receipts r ON r.id = l.receipt_id WHERE r.source_note = ${run.client_code}`
      ).map((row) => row.id);
      if (lotIds.length > 0) {
        await tx`DELETE FROM box_movements WHERE box_id IN (SELECT id FROM boxes WHERE lot_id IN ${tx(lotIds)})`;
        await tx`DELETE FROM boxes WHERE lot_id IN ${tx(lotIds)}`;
        await tx`DELETE FROM receipt_lots WHERE id IN ${tx(lotIds)}`;
      }
      await tx`DELETE FROM receipts WHERE source_note = ${run.client_code}`;
      await tx`DELETE FROM client_transactions WHERE client_id = ${run.client_id}`;
      await tx`DELETE FROM clients WHERE id = ${run.client_id}`;
    });
  }
  // DEACTIVATED, never deleted: the handover and its audit rows name him.
  await sql`UPDATE users SET active = false WHERE full_name LIKE 'QI manager %' AND active`;
  const [left] = await sql<{ issuable: number; active_managers: number }[]>`
    SELECT (SELECT count(*)::int FROM boxes b
              JOIN receipt_lots l ON l.id = b.lot_id JOIN receipts r ON r.id = l.receipt_id
              JOIN clients c ON c.id = r.client_id
              JOIN warehouses w ON w.id = b.current_warehouse_id
             WHERE c.client_code ~ '^QI[0-9]{6}$' AND w.code = 'TAS1'
               AND b.status IN ('in_stock', 'ready_for_pickup')) AS issuable,
           (SELECT count(*)::int FROM users WHERE full_name LIKE 'QI manager %' AND active) AS active_managers`;
  return { issuable: left!.issuable, activeManagers: left!.active_managers };
}
