import 'dotenv/config';
import postgres from 'postgres';

/**
 * The seed behind `m9zzzg-narx-bitim` (his Q8 «c», 2026-10-27, and the price
 * table of 2026-11-08 — his own case: «1 mashinada 1 clientda 10 15 ta
 * prixoda va har birida bitim»): a run-scoped client with TWELVE deals, one
 * prixod of each whose carton rides the truck the spec made through the UI,
 * plus one prixod with no deal at all (the «Bitimsiz» row). One goods name is
 * 44 characters with no break in it — the phone must wrap it, not zoom out
 * (#400). Each deal carries a dollar quote with distinctive digits, so a VED's
 * page can be searched for them (law 4). Written straight to the database:
 * the receive wizard is other specs' subject, and the table only READS this
 * state.
 *
 * Deal i (0-based) is quoted for i + 2 m³ and has i + 1 m³ aboard, so its
 * stated part here is quote × (i + 1) / (i + 2): deal 0 → 617.28, deal 1 →
 * 4362.14, deal 2 → 5833.00 (5832.9975 rounded up).
 */
export interface NarxBitimSeed {
  clientId: string;
  clientCode: string;
  deals: { id: string; code: string; receiptId: string; lotId: string; boxId: string; quote: string; goods: string }[];
  loose: { receiptId: string; lotId: string; boxId: string };
}

export const LONG_GOODS = 'Supermegaultrauzunnomlitovarnomi4000modeliXL';

const GOODS = [
  'Sichqoncha',
  'Klaviatura',
  'Monitor',
  LONG_GOODS,
  'Printer',
  'Skaner',
  'Kabel',
  'Quloqchin',
  'Kolonka',
  'Planshet',
  'Router',
  'Kamera',
];

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to seed and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

/** Distinctive quotes: the first three are the Q8 spec's own figures. */
function quoteOf(i: number): string {
  return ['1234.56', '6543.21', '7777.33'][i] ?? `${2000 + i * 37}.${String(11 + i).padStart(2, '0')}`;
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
    const deals: NarxBitimSeed['deals'] = [];
    for (const [i, name] of GOODS.entries()) {
      // Two digits, so the codes sort as the deals were made (-01 … -12).
      const code = `NB-${run}-${String(i + 1).padStart(2, '0')}`;
      const quote = quoteOf(i);
      const [deal] = await q`
        INSERT INTO deals (id, code, client_id, stage_id, title, created_by,
                           quoted_amount, quoted_currency, quoted_volume_m3)
        VALUES (gen_random_uuid(), ${code}, ${client!.id}, ${stage!.id}, ${`${name.slice(0, 20)} bitimi`}, ${owner!.id},
                ${quote}, 'USD', ${i + 2}) RETURNING id`;
      const cargo = await prixod(q, {
        number: `NB${run}${String(i + 1).padStart(2, '0')}`,
        warehouseId: batch!.origin_warehouse_id,
        clientId: client!.id,
        ownerId: owner!.id,
        dealId: deal!.id,
        zh: `货${run}${i}`,
        ru: name,
        kg: 100 * (i + 1),
        m3: i + 1,
        shortCode: `NB${run}${String(i + 1).padStart(2, '0')}1`,
        batchId,
      });
      deals.push({ id: deal!.id, code, quote, goods: name, ...cargo });
    }
    const loose = await prixod(q, {
      number: `NB${run}00`,
      warehouseId: batch!.origin_warehouse_id,
      clientId: client!.id,
      ownerId: owner!.id,
      dealId: null,
      zh: `货${run}x`,
      ru: 'Bitimsiz yuk',
      kg: 50,
      m3: 1,
      shortCode: `NB${run}001`,
      batchId,
    });
    return { clientId: client!.id, clientCode, deals, loose };
  } finally {
    await q.end();
  }
}

async function prixod(
  q: postgres.Sql,
  p: {
    number: string;
    warehouseId: string;
    clientId: string;
    ownerId: string;
    dealId: string | null;
    zh: string;
    ru: string;
    kg: number;
    m3: number;
    shortCode: string;
    batchId: string;
  },
) {
  const [receipt] = await q`
    INSERT INTO receipts (id, number, warehouse_id, client_id, status, created_by, confirmed_at, confirmed_by, deal_id)
    VALUES (gen_random_uuid(), ${p.number}, ${p.warehouseId}, ${p.clientId}, 'confirmed',
            ${p.ownerId}, now(), ${p.ownerId}, ${p.dealId}) RETURNING id`;
  const [lot] = await q`
    INSERT INTO receipt_lots (id, receipt_id, seq, product_name_zh, product_name_ru, box_count,
                              total_weight_kg, total_volume_m3)
    VALUES (gen_random_uuid(), ${receipt!.id}, 1, ${p.zh}, ${p.ru}, 1, ${p.kg}, ${p.m3})
    RETURNING id`;
  const [box] = await q`
    INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id, current_batch_id)
    VALUES (gen_random_uuid(), ${lot!.id}, ${p.shortCode}, 1, 'loading', ${p.warehouseId}, ${p.batchId})
    RETURNING id`;
  return { receiptId: receipt!.id as string, lotId: lot!.id as string, boxId: box!.id as string };
}

/** The client's live prices on that truck, each with its deal. */
export async function pricesOn(batchId: string, clientId: string): Promise<{ dealId: string | null; usd: string }[]> {
  const q = database();
  try {
    return (await q`
      SELECT deal_id, amount_usd FROM client_transactions
       WHERE batch_id = ${batchId} AND client_id = ${clientId} AND type = 'charge' AND voided_at IS NULL
       ORDER BY created_at, id`).map((row) => ({ dealId: row.deal_id as string | null, usd: String(row.amount_usd) }));
  } finally {
    await q.end();
  }
}

/**
 * A price written by somebody else while a page stays open — another tab, a
 * colleague — straight to the ledger, the way the door writes one.
 */
export async function priceBehindTheScreen(batchId: string, clientId: string, dealId: string, usd: string): Promise<void> {
  const q = database();
  try {
    const [owner] = await q`SELECT id FROM users WHERE phone = '+998900000001'`;
    await q`
      INSERT INTO client_transactions (id, client_id, type, amount, currency, rate_to_usd, amount_usd, tx_date,
                                       batch_id, deal_id, created_by)
      VALUES (gen_random_uuid(), ${clientId}, 'charge', ${usd}, 'USD', 1, ${usd}, current_date,
              ${batchId}, ${dealId}, ${owner!.id})`;
  } finally {
    await q.end();
  }
}

/** Re-files one deal's prixod onto another — what `linkReceipt` writes. */
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
    for (const cargo of [...s.deals, s.loose]) {
      await q`UPDATE boxes SET current_batch_id = NULL, status = 'void' WHERE id = ${cargo.boxId}`;
      await q`UPDATE receipts SET status = 'voided', voided_at = now(), void_reason = 'e2e', deal_id = NULL
               WHERE id = ${cargo.receiptId}`;
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
    const boxes = [...s.deals.map((deal) => deal.boxId), s.loose.boxId];
    const [row] = await q`
      SELECT (SELECT count(*) FROM deals WHERE id = ANY(${ids}::uuid[]))
           + (SELECT count(*) FROM client_transactions WHERE client_id = ${s.clientId})
           + (SELECT count(*) FROM boxes WHERE id = ANY(${boxes}::uuid[]) AND current_batch_id IS NOT NULL) AS n`;
    return Number(row!.n);
  } finally {
    await q.end();
  }
}
