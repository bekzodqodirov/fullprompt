import postgres from 'postgres';

/**
 * What «m9zzzh-yoldagi-yuk» mints and gives back, in one place so the mint and
 * the cleanup cannot disagree about which rows are the spec's
 * (yuk-tekshiruv-fixture's shape).
 *
 * The owner's case (docs/YOLDAGI-YUK.md): a client `YY<digits>`, a prixod at
 * YW of ONE lot of six cartons, all six on a truck `YY<digits>-I` that left
 * Yiwu for Kashgar yesterday — on the road, not yet at the shelf the plan
 * loads from. Never the demo GS777: a plan on it is configuration every later
 * spec reads (#183).
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
  inboundId: string;
  inboundCode: string;
}

export function newRun(): Run {
  const digits = String(Date.now()).slice(-6);
  return { marker: `YY${digits}`, lotName: `路上YY${digits}` };
}

export async function mint(sql: postgres.Sql, run: Run): Promise<Minted> {
  return sql.begin(async (tx) => {
    const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000001'`;
    const [yw] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'YW'`;
    const [ka] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'KA'`;
    if (!owner || !yw || !ka) throw new Error('the demo has no owner, YW or KA');
    const [client] = await tx<{ id: string }[]>`
      INSERT INTO clients (id, client_code, name, phones)
      VALUES (gen_random_uuid(), ${run.marker}, ${`Yo'l ${run.marker}`}, ${tx.json(['+998901112244'])})
      RETURNING id`;
    const [receipt] = await tx<{ id: string }[]>`
      INSERT INTO receipts (id, number, warehouse_id, client_id, status, confirmed_at, confirmed_by, source_note, created_by, created_at)
      VALUES (gen_random_uuid(), ${`${run.marker}-R`}, ${yw.id}, ${client!.id}, 'confirmed', now() - interval '2 days',
              ${owner.id}, ${run.marker}, ${owner.id}, now() - interval '2 days')
      RETURNING id`;
    const [lot] = await tx<{ id: string }[]>`
      INSERT INTO receipt_lots (id, receipt_id, seq, letter, cycle_no, product_name_zh, product_name_ru, box_count, dims_mode,
                                total_weight_kg, total_volume_m3)
      VALUES (gen_random_uuid(), ${receipt!.id}, 1, 'A', 1, ${run.lotName}, 'Дорожный груз', 6, 'mixed', 60.000, 0.3000)
      RETURNING id`;
    const inboundCode = `${run.marker}-I`;
    const [inbound] = await tx<{ id: string }[]>`
      INSERT INTO batches (id, code, origin_warehouse_id, dest_warehouse_id, status, created_by, departed_at, created_at)
      VALUES (gen_random_uuid(), ${inboundCode}, ${yw.id}, ${ka.id}, 'in_transit', ${owner.id},
              now() - interval '1 day', now() - interval '2 days')
      RETURNING id`;
    await tx`
      INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_batch_id)
      SELECT gen_random_uuid(), ${lot!.id}, ${run.marker} || '-' || n, n, 'in_transit', ${inbound!.id}
        FROM generate_series(1, 6) AS n`;
    return { receiptId: receipt!.id, lotId: lot!.id, inboundId: inbound!.id, inboundCode };
  });
}

/**
 * Everything the spec made, gone: the plans that name its lot (their lines,
 * road parts and versions with them), the cartons, the truck, the prixod and
 * the client. Returns what still carries the marker, so a cleanup that missed
 * something fails the spec instead of leaving it for the next one.
 */
export async function cleanup(sql: postgres.Sql, run: Run): Promise<number> {
  await sql.begin(async (tx) => {
    const lots = await tx<{ id: string }[]>`
      SELECT l.id FROM receipt_lots l JOIN receipts r ON r.id = l.receipt_id WHERE r.number = ${`${run.marker}-R`}`;
    const lotIds = lots.map((l) => l.id);
    if (lotIds.length) {
      const plans = await tx<{ id: string }[]>`
        SELECT DISTINCT pv.plan_id AS id FROM load_plan_lines pl
          JOIN load_plan_versions pv ON pv.id = pl.version_id WHERE pl.lot_id IN ${tx(lotIds)}`;
      const planIds = plans.map((p) => p.id);
      if (planIds.length) {
        // A pending plan made no truck and reserved nothing; its road parts go
        // with its lines (ON DELETE CASCADE). The audit rows stay (#183's rule:
        // the audit log refuses deletes, and names no row by foreign key).
        await tx`DELETE FROM load_plan_lines WHERE version_id IN (SELECT id FROM load_plan_versions WHERE plan_id IN ${tx(planIds)})`;
        await tx`DELETE FROM load_plan_versions WHERE plan_id IN ${tx(planIds)}`;
        await tx`DELETE FROM load_plans WHERE id IN ${tx(planIds)}`;
      }
      await tx`DELETE FROM boxes WHERE lot_id IN ${tx(lotIds)}`;
      await tx`DELETE FROM receipt_lots WHERE id IN ${tx(lotIds)}`;
    }
    await tx`DELETE FROM batches WHERE code = ${`${run.marker}-I`}`;
    await tx`DELETE FROM receipts WHERE number = ${`${run.marker}-R`}`;
    await tx`DELETE FROM clients WHERE client_code = ${run.marker}`;
  });
  const [left] = await sql<{ n: number }[]>`
    SELECT ((SELECT count(*) FROM clients WHERE client_code = ${run.marker})
          + (SELECT count(*) FROM batches WHERE code = ${`${run.marker}-I`})
          + (SELECT count(*) FROM receipts WHERE number = ${`${run.marker}-R`}))::int AS n`;
  return left!.n;
}
