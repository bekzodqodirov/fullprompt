import type postgres from 'postgres';

/**
 * His 3a on a screen (m9zzu): one client of Dilnoza's with two jobs, A and B,
 * each answered at $1000 («Готово») and offered at $1300, each with its
 * carton arrived. A was charged a month ago, B today, and the client paid
 * $1300 today with no deal named — so the oldest debt (A) is paid and B still
 * waits. The old rule (the client's balance) held both.
 *
 * Written in ONE transaction straight to the tables, every NOT NULL and every
 * load-bearing column spelt out (money-O7: a receipt with no client is no
 * cargo to the walk). Ids are explicit: drizzle's `id()` is a JS default, and
 * a raw INSERT gets none. The NAME carries the tag the cleanup sweeps by
 * (#523), so a restarted worker still cleans.
 */
export const FIFO_NAME_PREFIX = 'Upsale FIFO e2e';

export async function mintFifoJobs(sql: postgres.Sql): Promise<{ offerA: string; offerB: string; tag: string }> {
  const tag = String(Date.now()).slice(-6);
  return sql.begin(async (tx) => {
    const [seller] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000009'`;
    const [stage] = await tx<{ id: string }[]>`
      SELECT id FROM deal_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`;
    const [yw] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'YW'`;
    if (!seller || !stage || !yw) throw new Error('demo seed missing: the seller, an open deal stage or YW');

    const [client] = await tx<{ id: string }[]>`
      INSERT INTO clients (id, client_code, name, sales_manager_id)
      VALUES (gen_random_uuid(), ${`UE${tag}`}, ${`${FIFO_NAME_PREFIX} ${tag}`}, ${seller.id})
      RETURNING id`;

    const job = async (letter: 'A' | 'B') => {
      const [deal] = await tx<{ id: string }[]>`
        INSERT INTO deals (id, code, client_id, stage_id, title, created_by)
        VALUES (gen_random_uuid(), ${`UE-${tag}-${letter}`}, ${client!.id}, ${stage.id}, 'e2e', ${seller.id})
        RETURNING id`;
      const [receipt] = await tx<{ id: string }[]>`
        INSERT INTO receipts (id, warehouse_id, client_id, deal_id, status, confirmed_at, created_by, confirmed_by)
        VALUES (gen_random_uuid(), ${yw.id}, ${client!.id}, ${deal!.id}, 'confirmed', now(), ${seller.id}, ${seller.id})
        RETURNING id`;
      const [lot] = await tx<{ id: string }[]>`
        INSERT INTO receipt_lots (id, receipt_id, seq, product_name_zh, box_count, total_weight_kg, total_volume_m3)
        VALUES (gen_random_uuid(), ${receipt!.id}, 1, '测试', 1, 500, 10)
        RETURNING id`;
      await tx`
        INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
        VALUES (gen_random_uuid(), ${lot!.id}, ${`UE${tag}${letter}`}, 1, 'in_stock', ${yw.id})`;
      const [request] = await tx<{ id: string }[]>`
        INSERT INTO calc_requests (id, entity_type, entity_id, requested_by, item_count, due_at, section, volume_m3,
                                   weight_kg, completed_at, completed_by, completed_via, answer_amount, answer_currency)
        VALUES (gen_random_uuid(), 'deal', ${deal!.id}, ${seller.id}, 1, now(), 'rastamojka', 10,
                500, now() - interval '1 hour', ${seller.id}, 'task', 1000, 'USD')
        RETURNING id`;
      const [offer] = await tx<{ id: string }[]>`
        INSERT INTO calc_offers (id, request_id, entity_type, entity_id, client_price_usd, locale, text, offered_by)
        VALUES (gen_random_uuid(), ${request!.id}, 'deal', ${deal!.id}, 1300, 'uz', 'e2e', ${seller.id})
        RETURNING id`;
      return { dealId: deal!.id, offerId: offer!.id };
    };
    const a = await job('A');
    const b = await job('B');

    // A a month ago, B today (Tashkent's days), and the money today with no deal.
    const money = async (type: 'charge' | 'payment', dealId: string | null, daysAgo: number) => tx`
      INSERT INTO client_transactions (id, client_id, deal_id, type, amount, currency, rate_to_usd, amount_usd,
                                       tx_date, note, created_by)
      VALUES (gen_random_uuid(), ${client!.id}, ${dealId}, ${type}, 1300, 'USD', 1, 1300,
              (now() AT TIME ZONE 'Asia/Tashkent')::date - ${daysAgo}::int, 'e2e', ${seller.id})`;
    await money('charge', a.dealId, 28);
    await money('charge', b.dealId, 0);
    await money('payment', null, 0);

    return { offerA: a.offerId, offerB: b.offerId, tag };
  });
}

/**
 * Everything any run of this spec minted, found by the NAME — never by ids a
 * crashed worker forgot — in the foreign keys' order. Raw SQL wrote no audit
 * rows, so hard deletes are allowed. Returns what is left (must be 0).
 */
export async function sweepFifoJobs(sql: postgres.Sql): Promise<{ clients: number; offers: number }> {
  const like = `${FIFO_NAME_PREFIX} %`;
  await sql.begin(async (tx) => {
    await tx`
      DELETE FROM calc_offers WHERE entity_type = 'deal' AND entity_id IN (
        SELECT d.id FROM deals d JOIN clients c ON c.id = d.client_id WHERE c.name LIKE ${like})`;
    await tx`
      DELETE FROM calc_requests WHERE entity_type = 'deal' AND entity_id IN (
        SELECT d.id FROM deals d JOIN clients c ON c.id = d.client_id WHERE c.name LIKE ${like})`;
    await tx`DELETE FROM client_transactions WHERE client_id IN (SELECT id FROM clients WHERE name LIKE ${like})`;
    await tx`
      DELETE FROM boxes WHERE lot_id IN (
        SELECT l.id FROM receipt_lots l JOIN receipts r ON r.id = l.receipt_id
          JOIN clients c ON c.id = r.client_id WHERE c.name LIKE ${like})`;
    await tx`
      DELETE FROM receipt_lots WHERE receipt_id IN (
        SELECT r.id FROM receipts r JOIN clients c ON c.id = r.client_id WHERE c.name LIKE ${like})`;
    await tx`DELETE FROM receipts WHERE client_id IN (SELECT id FROM clients WHERE name LIKE ${like})`;
    await tx`DELETE FROM deals WHERE client_id IN (SELECT id FROM clients WHERE name LIKE ${like})`;
    await tx`DELETE FROM clients WHERE name LIKE ${like}`;
  });
  const [left] = await sql<{ clients: number; offers: number }[]>`
    SELECT (SELECT count(*)::int FROM clients WHERE name LIKE ${like}) AS clients,
           (SELECT count(*)::int FROM calc_offers o JOIN deals d ON d.id = o.entity_id
              JOIN clients c ON c.id = d.client_id WHERE c.name LIKE ${like}) AS offers`;
  return left!;
}
