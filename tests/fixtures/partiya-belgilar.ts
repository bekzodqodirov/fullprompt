import 'dotenv/config';
import postgres from 'postgres';

/**
 * The seed behind `m9zzs-partiya-belgilar` (0119): a run-scoped client, a deal
 * with a client price on the card, one prixod whose carton rides the truck the
 * spec made through the UI, and a Готово answer on the deal — the m9zt path's
 * end state, with no seal and no stamp (a seal is configuration for any later
 * spec, #935). Written straight to the database, like `m9zzs-kuzatuv`: the
 * receive wizard and the queue are other specs' subjects, and the icons only
 * READ this state.
 */
export interface Seeded {
  clientId: string;
  dealId: string;
  receiptId: string;
  lotId: string;
  boxId: string;
  requestId: string;
  /** The deal's client price — the figure the VED must never read (law 4). */
  clientPrice: string;
  /** The Готово answer — the figure both sheets print. */
  answer: string;
  /** A Russian name long enough to push a fold past 360 px if it could. */
  ruName: string;
}

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to seed and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export async function seedPriceIcons(batchId: string, run: string): Promise<Seeded> {
  const q = database();
  try {
    const [owner] = await q`SELECT id FROM users WHERE phone = '+998900000001'`;
    const [ved] = await q`SELECT id FROM users WHERE phone = '+998900000004'`;
    const [stage] = await q`SELECT id FROM deal_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`;
    const [batch] = await q`SELECT origin_warehouse_id FROM batches WHERE id = ${batchId}`;
    const [client] = await q`
      INSERT INTO clients (id, client_code, name)
      VALUES (gen_random_uuid(), ${`PB${run}`}, ${`Belgilar mijoz ${run}`}) RETURNING id`;
    const clientPrice = '4321.00';
    const [deal] = await q`
      INSERT INTO deals (id, code, client_id, stage_id, title, created_by,
                         quoted_amount, quoted_currency, quoted_volume_m3)
      VALUES (gen_random_uuid(), ${`PB-${run}`}, ${client!.id}, ${stage!.id}, 'Belgilar e2e', ${owner!.id},
              ${clientPrice}, 'USD', 2) RETURNING id`;
    const [receipt] = await q`
      INSERT INTO receipts (id, number, warehouse_id, client_id, status, created_by, confirmed_at, confirmed_by, deal_id)
      VALUES (gen_random_uuid(), ${`PB${run}`}, ${batch!.origin_warehouse_id}, ${client!.id}, 'confirmed',
              ${owner!.id}, now(), ${owner!.id}, ${deal!.id}) RETURNING id`;
    const ruName = `Juda uzun rus nomli tovar ${run} — simsiz sichqoncha, qora, qadoqda, o'n ikki donadan`;
    const [lot] = await q`
      INSERT INTO receipt_lots (id, receipt_id, seq, product_name_zh, product_name_ru, box_count,
                                total_weight_kg, total_volume_m3)
      VALUES (gen_random_uuid(), ${receipt!.id}, 1, ${`无线鼠标${run}`}, ${ruName}, 1, 20, 0.06) RETURNING id`;
    const [box] = await q`
      INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id, current_batch_id)
      VALUES (gen_random_uuid(), ${lot!.id}, ${`PB${run}01`}, 1, 'loading', ${batch!.origin_warehouse_id}, ${batchId})
      RETURNING id`;
    const answer = '700.00';
    const [request] = await q`
      INSERT INTO calc_requests (id, entity_type, entity_id, section, requested_by, item_count, due_at,
                                 completed_at, completed_via, completed_by, answer_amount, answer_currency, answer_note)
      VALUES (gen_random_uuid(), 'deal', ${deal!.id}, 'rastamojka', ${owner!.id}, 1, now(),
              now(), 'task', ${ved!.id}, ${answer}, 'USD', 'belgilar e2e') RETURNING id`;
    return {
      clientId: client!.id,
      dealId: deal!.id,
      receiptId: receipt!.id,
      lotId: lot!.id,
      boxId: box!.id,
      requestId: request!.id,
      clientPrice,
      answer,
      ruName,
    };
  } finally {
    await q.end();
  }
}

/**
 * Everything the seed wrote goes: the carton off the truck and void, the
 * prixod voided and off the deal, the answer and the deal deleted, the client
 * retired. The truck itself is cancelled by the spec through the UI.
 */
export async function cleanPriceIcons(s: Seeded): Promise<void> {
  const q = database();
  try {
    await q`UPDATE boxes SET current_batch_id = NULL, status = 'void' WHERE id = ${s.boxId}`;
    await q`UPDATE receipts SET status = 'voided', voided_at = now(), void_reason = 'e2e', deal_id = NULL
             WHERE id = ${s.receiptId}`;
    await q`DELETE FROM lot_similar_picks WHERE lot_id = ${s.lotId}`;
    await q`DELETE FROM calc_requests WHERE id = ${s.requestId}`;
    await q`DELETE FROM crm_activities WHERE entity_id = ${s.dealId}`;
    await q`DELETE FROM deals WHERE id = ${s.dealId}`;
    await q`UPDATE clients SET active = false WHERE id = ${s.clientId}`;
  } finally {
    await q.end();
  }
}

/** What remains of the seed — the final test's own assertion. */
export async function leftovers(s: Seeded): Promise<number> {
  const q = database();
  try {
    const [row] = await q`
      SELECT (SELECT count(*) FROM deals WHERE id = ${s.dealId})
           + (SELECT count(*) FROM calc_requests WHERE id = ${s.requestId})
           + (SELECT count(*) FROM boxes WHERE id = ${s.boxId} AND current_batch_id IS NOT NULL)
           + (SELECT count(*) FROM receipts WHERE id = ${s.receiptId} AND voided_at IS NULL) AS n`;
    return Number(row!.n);
  } finally {
    await q.end();
  }
}
