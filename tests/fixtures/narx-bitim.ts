import 'dotenv/config';
import postgres from 'postgres';

/**
 * The seed behind `m9zzzg-narx-bitim` (his Q8 «c», 2026-10-27: «logist o'zi
 * tanlaydi»): a run-scoped client with THREE deals, one prixod of each whose
 * carton rides the truck the spec made through the UI. Each deal carries a
 * dollar quote with distinctive digits, so a VED's page can be searched for
 * them (law 4). Written straight to the database: the receive wizard is other
 * specs' subject, and the question only READS this state.
 */
export interface NarxBitimSeed {
  clientId: string;
  clientCode: string;
  deals: { id: string; code: string; receiptId: string; lotId: string; boxId: string; quote: string }[];
}

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to seed and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export async function seedNarxBitim(batchId: string, run: string): Promise<NarxBitimSeed> {
  const q = database();
  try {
    const [owner] = await q`SELECT id FROM users WHERE phone = '+998900000001'`;
    const [stage] = await q`SELECT id FROM deal_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`;
    const [batch] = await q`SELECT origin_warehouse_id FROM batches WHERE id = ${batchId}`;
    const clientCode = `NB${run}`;
    const [client] = await q`
      INSERT INTO clients (id, client_code, name)
      VALUES (gen_random_uuid(), ${clientCode}, ${`Narx bitim mijoz ${run}`}) RETURNING id`;
    const goods = ['Sichqoncha', 'Klaviatura', 'Monitor'];
    // Distinctive quotes: 1234.56 for 2 m³, 6543.21 for 3 m³ and 7777.33 for
    // 4 m³ — each deal's cargo aboard is one m³ less than it was quoted for.
    const quotes = ['1234.56', '6543.21', '7777.33'];
    const deals: NarxBitimSeed['deals'] = [];
    for (const [i, name] of goods.entries()) {
      const code = `NB-${run}-${i + 1}`;
      const [deal] = await q`
        INSERT INTO deals (id, code, client_id, stage_id, title, created_by,
                           quoted_amount, quoted_currency, quoted_volume_m3)
        VALUES (gen_random_uuid(), ${code}, ${client!.id}, ${stage!.id}, ${`${name} bitimi`}, ${owner!.id},
                ${quotes[i]!}, 'USD', ${i + 2}) RETURNING id`;
      const [receipt] = await q`
        INSERT INTO receipts (id, number, warehouse_id, client_id, status, created_by, confirmed_at, confirmed_by, deal_id)
        VALUES (gen_random_uuid(), ${`NB${run}${i + 1}`}, ${batch!.origin_warehouse_id}, ${client!.id}, 'confirmed',
                ${owner!.id}, now(), ${owner!.id}, ${deal!.id}) RETURNING id`;
      const [lot] = await q`
        INSERT INTO receipt_lots (id, receipt_id, seq, product_name_zh, product_name_ru, box_count,
                                  total_weight_kg, total_volume_m3)
        VALUES (gen_random_uuid(), ${receipt!.id}, 1, ${`货${run}${i}`}, ${name}, 1, ${100 * (i + 1)}, ${i + 1})
        RETURNING id`;
      const [box] = await q`
        INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id, current_batch_id)
        VALUES (gen_random_uuid(), ${lot!.id}, ${`NB${run}${i + 1}1`}, 1, 'loading', ${batch!.origin_warehouse_id}, ${batchId})
        RETURNING id`;
      deals.push({ id: deal!.id, code, receiptId: receipt!.id, lotId: lot!.id, boxId: box!.id, quote: quotes[i]! });
    }
    return { clientId: client!.id, clientCode, deals };
  } finally {
    await q.end();
  }
}

/** The client's live prices on that truck, each with its deal. */
export async function pricesOn(batchId: string, clientId: string): Promise<{ dealId: string | null; usd: string }[]> {
  const q = database();
  try {
    return (await q`
      SELECT deal_id, amount_usd FROM client_transactions
       WHERE batch_id = ${batchId} AND client_id = ${clientId} AND type = 'charge' AND voided_at IS NULL
       ORDER BY created_at`).map((row) => ({ dealId: row.deal_id as string | null, usd: String(row.amount_usd) }));
  } finally {
    await q.end();
  }
}

/** Re-files one deal's prixod onto the other — what `linkReceipt` writes. */
export async function refile(receiptId: string, dealId: string): Promise<void> {
  const q = database();
  try {
    await q`UPDATE receipts SET deal_id = ${dealId} WHERE id = ${receiptId}`;
  } finally {
    await q.end();
  }
}

/**
 * Everything the seed and the spec wrote goes: the prices (a live price on
 * the truck refuses its cancel, and a price naming a deal refuses the deal's
 * delete), the cartons off the truck and void, the prixods voided and off
 * their deals, the deals deleted, the client retired. The truck itself is
 * cancelled by the spec through the UI.
 */
export async function cleanNarxBitim(s: NarxBitimSeed): Promise<void> {
  const q = database();
  try {
    await q`DELETE FROM client_transactions WHERE client_id = ${s.clientId}`;
    // Every prixod off every deal FIRST: the spec re-files prixods between
    // the seed's deals, so one deal's receipt may name another (an FK).
    for (const deal of s.deals) {
      await q`UPDATE boxes SET current_batch_id = NULL, status = 'void' WHERE id = ${deal.boxId}`;
      await q`UPDATE receipts SET status = 'voided', voided_at = now(), void_reason = 'e2e', deal_id = NULL
               WHERE id = ${deal.receiptId}`;
    }
    for (const deal of s.deals) {
      await q`DELETE FROM crm_activities WHERE entity_id = ${deal.id}`;
      await q`DELETE FROM deals WHERE id = ${deal.id}`;
    }
    await q`UPDATE clients SET active = false WHERE id = ${s.clientId}`;
  } finally {
    await q.end();
  }
}

/**
 * The truck, off the books by SQL — `afterAll`'s fallback when a failed test
 * skipped the UI cancel (serial mode skips the rest), so a loaded YW truck
 * and its prices are never the next spec's input (#154).
 */
export async function retireTruck(batchId: string): Promise<void> {
  const q = database();
  try {
    await q`UPDATE load_plans SET status = 'cancelled' WHERE batch_id = ${batchId}`;
    await q`UPDATE batches SET status = 'cancelled' WHERE id = ${batchId} AND status <> 'cancelled'`;
  } finally {
    await q.end();
  }
}

/** What remains of the seed — the final test's own assertion. */
export async function leftovers(s: NarxBitimSeed): Promise<number> {
  const q = database();
  try {
    const ids = s.deals.map((deal) => deal.id);
    const boxes = s.deals.map((deal) => deal.boxId);
    const [row] = await q`
      SELECT (SELECT count(*) FROM deals WHERE id = ANY(${ids}::uuid[]))
           + (SELECT count(*) FROM client_transactions WHERE client_id = ${s.clientId})
           + (SELECT count(*) FROM boxes WHERE id = ANY(${boxes}::uuid[]) AND current_batch_id IS NOT NULL) AS n`;
    return Number(row!.n);
  } finally {
    await q.end();
  }
}
