import postgres from 'postgres';
import { hashPassword } from '@/modules/platform/auth/password';

/**
 * What «m9zzz-ved-bitim» mints and gives back, in one place so the mint and
 * the cleanup cannot disagree about which rows are the spec's
 * (yuk-tekshiruv-fixture's shape).
 *
 * The owner's 17a with G1-G4 a (2026-10-07): a client `VB<digits>` and three
 * deals on the first open stage, owned by the demo SELLER — so the VED owns
 * none of them and his board can only show them through his work set:
 *   - A carries a finished calc request (the calc arm) and a coded line;
 *   - B has a position with no TNVED code (the missing arm);
 *   - C is fully coded and carries no request (neither arm — off his board);
 * plus a confirmed prixod `VB…-R` at YW for the client, on no deal, so the
 * card offers it to link (G1). Never the demo GS777: a deal or a link on it
 * would be configuration every later spec reads (#183).
 *
 * And, for the review's DEAL17-1/2 (2026-10-07):
 *   - a lenta note on B carrying `hiddenWord` — B has no calc request, so its
 *     lenta is not the VED's to read and his board's lenta filter must not
 *     answer for it;
 *   - a person of the spec's own, `VB viewall <marker>`: the demo VED's role
 *     PLUS a run-scoped role holding `crm.leads.view_all` alone — the VED hat
 *     with view_all and no seller grant, which no seeded role is. The role is
 *     CONFIGURATION while it exists (#183), so the cleanup deletes it (m9d's
 *     precedent) and DEACTIVATES the person (his login is audited); a later
 *     run with the same digits re-uses the row by phone.
 */

/** The run-scoped person's own password — not the demo one. */
export const VIEW_ALL_PASSWORD = 'vedviewall1234';
export const viewAllPhone = (marker: string) => `+998938${marker.slice(2)}`;
export const viewAllRole = (marker: string) => `vb_viewall_${marker.slice(2)}`;
export const hiddenWord = (marker: string) => `yashirin${marker.slice(2)}`;

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export interface Run {
  marker: string;
}

export interface Minted {
  clientId: string;
  dealA: string;
  dealB: string;
  dealC: string;
  receiptId: string;
  lineB: string;
  /** The demo seller — the colleague a forged `hodim` names. */
  sellerId: string;
}

export function newRun(): Run {
  return { marker: `VB${String(Date.now()).slice(-6)}` };
}

export async function mint(sql: postgres.Sql, run: Run): Promise<Minted> {
  const passwordHash = await hashPassword(VIEW_ALL_PASSWORD);
  return sql.begin(async (tx) => {
    const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000001'`;
    const [seller] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000009'`;
    const [yw] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'YW'`;
    const [stage] = await tx<{ id: string }[]>`
      SELECT id FROM deal_stages WHERE active AND kind = 'open' ORDER BY sort_order LIMIT 1`;
    if (!owner || !seller || !yw || !stage) throw new Error('the demo has no owner, seller, YW or open stage');
    const [client] = await tx<{ id: string }[]>`
      INSERT INTO clients (id, client_code, name, phones, sales_manager_id)
      VALUES (gen_random_uuid(), ${run.marker}, ${`VED bitim ${run.marker}`}, ${tx.json([])}, ${seller.id})
      RETURNING id`;
    const deal = async (suffix: string) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO deals (id, code, client_id, stage_id, owner_id, title, created_by)
        VALUES (gen_random_uuid(), ${`${run.marker}-${suffix}`}, ${client!.id}, ${stage.id}, ${seller.id},
                ${`VED bitim ${suffix}`}, ${owner.id})
        RETURNING id`;
      return row!.id;
    };
    const line = async (dealId: string, description: string, tnved: string | null) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO deal_lines (id, deal_id, seq, description, tnved_code)
        VALUES (gen_random_uuid(), ${dealId}, 1, ${description}, ${tnved})
        RETURNING id`;
      return row!.id;
    };
    const dealA = await deal('A');
    const dealB = await deal('B');
    const dealC = await deal('C');
    await line(dealA, `Sichqoncha ${run.marker}`, '8471607000');
    const lineB = await line(dealB, `Klaviatura ${run.marker}`, null);
    await line(dealC, `Kabel ${run.marker}`, '8544429007');
    await tx`
      INSERT INTO crm_activities (id, entity_type, entity_id, kind, note, created_by)
      VALUES (gen_random_uuid(), 'deal', ${dealB}, 'note', ${`lenta izohi ${hiddenWord(run.marker)}`}, ${seller.id})`;
    const [ved] = await tx<{ id: string }[]>`SELECT id FROM roles WHERE code = 'ved_manager'`;
    const [viewAll] = await tx<{ id: string }[]>`SELECT id FROM permissions WHERE code = 'crm.leads.view_all'`;
    if (!ved || !viewAll) throw new Error('the demo has no ved_manager role or no crm.leads.view_all');
    const [role] = await tx<{ id: string }[]>`
      INSERT INTO roles (id, code, name, is_system, grants_customised)
      VALUES (gen_random_uuid(), ${viewAllRole(run.marker)}, ${`VB viewall ${run.marker}`}, false, true)
      RETURNING id`;
    await tx`INSERT INTO role_permissions (role_id, permission_id, source) VALUES (${role!.id}, ${viewAll.id}, 'admin')`;
    const [person] = await tx<{ id: string }[]>`
      INSERT INTO users (id, phone, full_name, password_hash, locale, active)
      VALUES (gen_random_uuid(), ${viewAllPhone(run.marker)}, ${`VB viewall ${run.marker}`}, ${passwordHash}, 'uz', true)
      ON CONFLICT (phone) DO UPDATE
        SET active = true, password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name
      RETURNING id`;
    await tx`DELETE FROM user_roles WHERE user_id = ${person!.id}`;
    await tx`INSERT INTO user_roles (user_id, role_id) VALUES (${person!.id}, ${ved.id}), (${person!.id}, ${role!.id})`;
    // Finished, so it never sits in the company queue or on a VED's day.
    await tx`
      INSERT INTO calc_requests (id, entity_type, entity_id, requested_by, item_count, due_at, completed_at, completed_via)
      VALUES (gen_random_uuid(), 'deal', ${dealA}, ${owner.id}, 0, now(), now(), 'lines')`;
    const [receipt] = await tx<{ id: string }[]>`
      INSERT INTO receipts (id, number, warehouse_id, client_id, status, confirmed_at, confirmed_by, source_note, created_by, created_at)
      VALUES (gen_random_uuid(), ${`${run.marker}-R`}, ${yw.id}, ${client!.id}, 'confirmed', now() - interval '1 day',
              ${owner.id}, ${run.marker}, ${owner.id}, now() - interval '1 day')
      RETURNING id`;
    const [lot] = await tx<{ id: string }[]>`
      INSERT INTO receipt_lots (id, receipt_id, seq, letter, cycle_no, product_name_zh, product_name_ru, box_count, dims_mode,
                                total_weight_kg, total_volume_m3)
      VALUES (gen_random_uuid(), ${receipt!.id}, 1, 'A', 1, ${`键盘${run.marker}`}, 'Клавиатура', 2, 'mixed', 20.000, 0.1000)
      RETURNING id`;
    await tx`
      INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
      SELECT gen_random_uuid(), ${lot!.id}, ${run.marker} || '-' || n, n, 'in_stock', ${yw.id}
        FROM generate_series(1, 2) AS n`;
    return { clientId: client!.id, dealA, dealB, dealC, receiptId: receipt!.id, lineB, sellerId: seller.id };
  });
}

/** A run that died before its cleanup test: the next run clears every earlier marker. */
export async function cleanupEarlier(sql: postgres.Sql): Promise<void> {
  const earlier = await sql<{ client_code: string }[]>`
    SELECT client_code FROM clients WHERE name ~ '^VED bitim VB[0-9]{6}$' AND client_code ~ '^VB[0-9]{6}$'`;
  for (const row of earlier) await cleanup(sql, { marker: row.client_code });
  // A run-scoped role that outlived its client (a run that died between the
  // two) is configuration on /admin/roles for every later spec.
  await sql`DELETE FROM roles WHERE code ~ '^vb_viewall_[0-9]{6}$' AND NOT is_system`;
  await sql`UPDATE users SET active = false WHERE full_name ~ '^VB viewall VB[0-9]{6}$' AND active`;
}

/**
 * Deletes every row the run names, in FK order, and returns what still
 * carries it. Audit rows stay — audit_log refuses DELETE.
 */
export async function cleanup(sql: postgres.Sql, run: Run): Promise<number> {
  await sql.begin(async (tx) => {
    const dealIds = (
      await tx<{ id: string }[]>`SELECT id FROM deals WHERE code LIKE ${`${run.marker}-%`}`
    ).map((r) => r.id);
    const lotIds = (
      await tx<{ id: string }[]>`
        SELECT l.id FROM receipt_lots l JOIN receipts r ON r.id = l.receipt_id WHERE r.source_note = ${run.marker}`
    ).map((r) => r.id);
    if (lotIds.length > 0) {
      await tx`DELETE FROM box_movements WHERE box_id IN (SELECT id FROM boxes WHERE lot_id IN ${tx(lotIds)})`;
      await tx`DELETE FROM boxes WHERE lot_id IN ${tx(lotIds)}`;
      await tx`DELETE FROM receipt_lots WHERE id IN ${tx(lotIds)}`;
    }
    await tx`DELETE FROM receipts WHERE source_note = ${run.marker}`;
    if (dealIds.length > 0) {
      const requestIds = (
        await tx<{ id: string }[]>`
          SELECT id FROM calc_requests WHERE entity_type = 'deal' AND entity_id IN ${tx(dealIds)}`
      ).map((r) => r.id);
      if (requestIds.length > 0) {
        await tx`DELETE FROM calc_request_items WHERE request_id IN ${tx(requestIds)}`;
        await tx`DELETE FROM calc_requests WHERE id IN ${tx(requestIds)}`;
      }
      const notes = (
        await tx<{ id: string }[]>`
          SELECT id FROM crm_activities WHERE entity_type = 'deal' AND entity_id IN ${tx(dealIds)}`
      ).map((r) => r.id);
      if (notes.length > 0) {
        await tx`DELETE FROM events WHERE entity_id IN ${tx(notes)}`;
        await tx`DELETE FROM crm_activities WHERE id IN ${tx(notes)}`;
      }
      await tx`DELETE FROM events WHERE entity_id IN ${tx(dealIds)}`;
      await tx`DELETE FROM deal_lines WHERE deal_id IN ${tx(dealIds)}`;
      await tx`DELETE FROM deals WHERE id IN ${tx(dealIds)}`;
    }
    await tx`DELETE FROM clients WHERE client_code = ${run.marker}`;
    // The role's grants and memberships go with it (ON DELETE CASCADE).
    await tx`DELETE FROM roles WHERE code = ${viewAllRole(run.marker)} AND NOT is_system`;
    await tx`UPDATE users SET active = false WHERE phone = ${viewAllPhone(run.marker)}`;
  });
  const [left] = await sql<{ n: number }[]>`
    SELECT (SELECT count(*)::int FROM receipts WHERE source_note = ${run.marker})
         + (SELECT count(*)::int FROM clients WHERE client_code = ${run.marker})
         + (SELECT count(*)::int FROM deals WHERE code LIKE ${`${run.marker}-%`})
         + (SELECT count(*)::int FROM boxes WHERE short_code LIKE ${`${run.marker}-%`})
         + (SELECT count(*)::int FROM roles WHERE code = ${viewAllRole(run.marker)})
         + (SELECT count(*)::int FROM users WHERE phone = ${viewAllPhone(run.marker)} AND active) AS n`;
  return left!.n;
}
