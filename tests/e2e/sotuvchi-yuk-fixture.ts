import postgres from 'postgres';

/**
 * What «m9zzzj-sotuvchi-yuk» mints and gives back, in one place so the mint
 * and the cleanup cannot disagree about which rows are the spec's (the
 * prixod-xabari fixture's shape).
 *
 * The owner's request (2026-11-18): the sellers see every client's cargo, the
 * trucks and the warehouses — to READ. So two clients, each with a confirmed
 * prixod at YW standing on its manager's deal and carrying one receipt bill:
 *
 *  - `SY<4 digits>M`: the demo SELLER manages it and owns its deal;
 *  - `SY<4 digits>O`: the super admin manages it and owns its deal — a
 *    colleague's client, as the seller meets it on Ostatka.
 *
 * (A client code is at most ten characters, so the marker is short.)
 *
 * Each deal carries a quote nobody prints, and each prixod a bill of an amount
 * nobody types, so the page's text AND its payload can be searched for them.
 * Nothing here is configuration: two clients, their prixods, deals and bills,
 * all deleted by the cleanup TEST (#523).
 */

export const SELLER_PHONE = '+998900000009';
export const YW_OPERATOR_PHONE = '+998900000006';
/** The quote on each deal — in no rendering, only in a leaking payload. */
export const QUOTE = { MINE: '54321.98', OTHER: '12345.67' } as const;
/** The bill on each prixod — on the card only for a cost reader. */
export const BILL = { MINE: '771.13', OTHER: '772.19' } as const;

export function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to mint and clean this spec');
  return postgres(url, { max: 1, onnotice: () => {} });
}

export interface Run {
  marker: string;
}

export function newRun(): Run {
  return { marker: `SY${String(Date.now()).slice(-4)}` };
}

export interface Minted {
  mine: { receiptId: string; dealCode: string };
  other: { receiptId: string; dealCode: string };
}

export async function mint(sql: postgres.Sql, run: Run): Promise<Minted> {
  return sql.begin(async (tx) => {
    const [owner] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = '+998900000001'`;
    const [seller] = await tx<{ id: string }[]>`SELECT id FROM users WHERE phone = ${SELLER_PHONE}`;
    const [yw] = await tx<{ id: string }[]>`SELECT id FROM warehouses WHERE code = 'YW'`;
    const [stage] = await tx<{ id: string }[]>`
      SELECT id FROM deal_stages WHERE active AND kind = 'open' ORDER BY sort_order LIMIT 1`;
    const [type] = await tx<{ id: string }[]>`SELECT id FROM cost_types WHERE code = 'customs'`;
    if (!owner || !seller || !yw || !stage || !type) throw new Error('the demo lacks the owner, seller, YW, an open stage or «customs»');
    const one = async (which: 'MINE' | 'OTHER', manager: string) => {
      const code = `${run.marker}${which === 'MINE' ? 'M' : 'O'}`;
      const [client] = await tx<{ id: string }[]>`
        INSERT INTO clients (id, client_code, name, phones, sales_manager_id)
        VALUES (gen_random_uuid(), ${code}, ${`Sotuvchi yuk ${code}`}, ${tx.json([])}, ${manager})
        RETURNING id`;
      const dealCode = `${code}-D`;
      const [deal] = await tx<{ id: string }[]>`
        INSERT INTO deals (id, code, client_id, stage_id, owner_id, title, quoted_amount, quoted_currency, created_by)
        VALUES (gen_random_uuid(), ${dealCode}, ${client!.id}, ${stage.id}, ${manager}, ${`Sotuvchi yuk ${which}`},
                ${QUOTE[which]}, 'USD', ${owner.id})
        RETURNING id`;
      const [receipt] = await tx<{ id: string }[]>`
        INSERT INTO receipts (id, number, warehouse_id, client_id, deal_id, sales_manager_id, status, confirmed_at, confirmed_by,
                              source_note, created_by, created_at)
        VALUES (gen_random_uuid(), ${`${code}-R`}, ${yw.id}, ${client!.id}, ${deal!.id}, ${manager}, 'confirmed',
                now() - interval '1 hour', ${owner.id}, ${run.marker}, ${owner.id}, now() - interval '1 hour')
        RETURNING id`;
      const [lot] = await tx<{ id: string }[]>`
        INSERT INTO receipt_lots (id, receipt_id, seq, letter, cycle_no, product_name_zh, product_name_ru, box_count, dims_mode,
                                  total_weight_kg, total_volume_m3)
        VALUES (gen_random_uuid(), ${receipt!.id}, 1, 'A', 1, ${'卖家'}, ${`Sotuvchi yuk ${which}`}, 1, 'mixed', 15.000, 0.2000)
        RETURNING id`;
      await tx`
        INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
        VALUES (gen_random_uuid(), ${lot!.id}, ${`${code}-1`}, 1, 'in_stock', ${yw.id})`;
      await tx`
        INSERT INTO cost_entries (id, scope, receipt_id, cost_type_id, amount, currency, cost_date, entered_by, note)
        VALUES (gen_random_uuid(), 'receipt', ${receipt!.id}, ${type.id}, ${BILL[which]}, 'CNY', current_date, ${owner.id}, ${run.marker})`;
      return { receiptId: receipt!.id, dealCode };
    };
    return { mine: await one('MINE', seller.id), other: await one('OTHER', owner.id) };
  });
}

/** Everything any run of this spec minted — found by the marker's shape, never by ids a dead run lost. */
export async function cleanupAll(sql: postgres.Sql): Promise<number> {
  const clients = await sql<{ id: string }[]>`
    SELECT id FROM clients WHERE client_code ~ '^SY[0-9]{4}[MO]$' AND name = 'Sotuvchi yuk ' || client_code`;
  for (const client of clients) {
    await sql.begin(async (tx) => {
      const receiptIds = (await tx<{ id: string }[]>`SELECT id FROM receipts WHERE client_id = ${client.id}`).map((r) => r.id);
      if (receiptIds.length > 0) {
        await tx`DELETE FROM cost_allocations WHERE cost_entry_id IN (SELECT id FROM cost_entries WHERE receipt_id IN ${tx(receiptIds)})`;
        await tx`DELETE FROM cost_entries WHERE receipt_id IN ${tx(receiptIds)}`;
        const lotIds = (await tx<{ id: string }[]>`SELECT id FROM receipt_lots WHERE receipt_id IN ${tx(receiptIds)}`).map((r) => r.id);
        if (lotIds.length > 0) {
          await tx`DELETE FROM box_movements WHERE box_id IN (SELECT id FROM boxes WHERE lot_id IN ${tx(lotIds)})`;
          await tx`DELETE FROM boxes WHERE lot_id IN ${tx(lotIds)}`;
          await tx`DELETE FROM receipt_lots WHERE id IN ${tx(lotIds)}`;
        }
        await tx`DELETE FROM notifications WHERE event_id IN (SELECT id FROM events WHERE entity_id IN ${tx(receiptIds)})`;
        await tx`DELETE FROM events WHERE entity_id IN ${tx(receiptIds)}`;
        await tx`DELETE FROM receipts WHERE id IN ${tx(receiptIds)}`;
      }
      const dealIds = (await tx<{ id: string }[]>`SELECT id FROM deals WHERE client_id = ${client.id}`).map((r) => r.id);
      if (dealIds.length > 0) {
        await tx`DELETE FROM notifications WHERE event_id IN (SELECT id FROM events WHERE entity_id IN ${tx(dealIds)})`;
        await tx`DELETE FROM events WHERE entity_id IN ${tx(dealIds)}`;
        await tx`DELETE FROM deals WHERE id IN ${tx(dealIds)}`;
      }
      await tx`DELETE FROM clients WHERE id = ${client.id}`;
    });
  }
  return clients.length;
}
