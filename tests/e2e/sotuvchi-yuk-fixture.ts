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
 *    colleague's client, as the seller meets it on Ostatka;
 *  - `SY<4 digits>H`: the super admin's client, stamped with him, on a deal the
 *    SELLER owns (a won lead about a colleague's client, Uch band Q3 b) — only
 *    the deal's owner makes this prixod his (the as-built review, FENCE-2);
 *  - `SY<4 digits>L`: the super admin's client, with one deal of each of them,
 *    its prixod on no deal of ITS client — left on `O`'s deal, as a client
 *    correction leaves it — so the seller's cell offers his deal and only his,
 *    names the foreign job, and waits for a deal before «Saqlash» (the as-built
 *    review EE-1, the fixes' review RR-3/RR-4).
 *
 * (A client code is at most ten characters, so the marker is short.)
 *
 * Each deal carries a quote nobody prints, and each prixod a bill of an amount
 * nobody types, so the page's text AND its payload can be searched for them.
 * Nothing here is configuration: four clients, their prixods, deals and bills,
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
  /** On a deal the seller owns, of a colleague's client. */
  hisDeal: { receiptId: string; dealCode: string };
  /** On no deal of its client (left on `other`'s); `dealCode` is the seller's deal, `theirDealCode` the colleague's. */
  loose: { receiptId: string; dealCode: string; theirDealCode: string };
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
    const deal = async (code: string, clientId: string, dealOwner: string, title: string, quote: string | null) => {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO deals (id, code, client_id, stage_id, owner_id, title, quoted_amount, quoted_currency, created_by)
        VALUES (gen_random_uuid(), ${code}, ${clientId}, ${stage.id}, ${dealOwner}, ${title},
                ${quote}, ${quote ? 'USD' : null}, ${owner.id})
        RETURNING id`;
      return row!.id;
    };
    const one = async (
      letter: 'M' | 'O' | 'H' | 'L',
      manager: string,
      standsOn: { owner: string } | null,
      money: { quote: string; bill: string } | null,
      leftOn: string | null = null,
    ) => {
      const code = `${run.marker}${letter}`;
      const [client] = await tx<{ id: string }[]>`
        INSERT INTO clients (id, client_code, name, phones, sales_manager_id)
        VALUES (gen_random_uuid(), ${code}, ${`Sotuvchi yuk ${code}`}, ${tx.json([])}, ${manager})
        RETURNING id`;
      const dealCode = `${code}-D`;
      const dealId = standsOn ? await deal(dealCode, client!.id, standsOn.owner, `Sotuvchi yuk ${letter}`, money?.quote ?? null) : leftOn;
      const [receipt] = await tx<{ id: string }[]>`
        INSERT INTO receipts (id, number, warehouse_id, client_id, deal_id, sales_manager_id, status, confirmed_at, confirmed_by,
                              source_note, created_by, created_at)
        VALUES (gen_random_uuid(), ${`${code}-R`}, ${yw.id}, ${client!.id}, ${dealId}, ${manager}, 'confirmed',
                now() - interval '1 hour', ${owner.id}, ${run.marker}, ${owner.id}, now() - interval '1 hour')
        RETURNING id`;
      const [lot] = await tx<{ id: string }[]>`
        INSERT INTO receipt_lots (id, receipt_id, seq, letter, cycle_no, product_name_zh, product_name_ru, box_count, dims_mode,
                                  total_weight_kg, total_volume_m3)
        VALUES (gen_random_uuid(), ${receipt!.id}, 1, 'A', 1, ${'卖家'}, ${`Sotuvchi yuk ${letter === 'M' ? 'MINE' : letter === 'O' ? 'OTHER' : letter}`}, 1, 'mixed', 15.000, 0.2000)
        RETURNING id`;
      await tx`
        INSERT INTO boxes (id, lot_id, short_code, seq_in_lot, status, current_warehouse_id)
        VALUES (gen_random_uuid(), ${lot!.id}, ${`${code}-1`}, 1, 'in_stock', ${yw.id})`;
      if (money) {
        await tx`
          INSERT INTO cost_entries (id, scope, receipt_id, cost_type_id, amount, currency, cost_date, entered_by, note)
          VALUES (gen_random_uuid(), 'receipt', ${receipt!.id}, ${type.id}, ${money.bill}, 'CNY', current_date, ${owner.id}, ${run.marker})`;
      }
      return { receiptId: receipt!.id, dealCode, clientId: client!.id, dealId };
    };
    const mine = await one('M', seller.id, { owner: seller.id }, { quote: QUOTE.MINE, bill: BILL.MINE });
    const other = await one('O', owner.id, { owner: owner.id }, { quote: QUOTE.OTHER, bill: BILL.OTHER });
    const hisDeal = await one('H', owner.id, { owner: seller.id }, null);
    const loose = await one('L', owner.id, null, null, other.dealId);
    const looseCode = `${run.marker}L`;
    await deal(`${looseCode}-MY`, loose.clientId, seller.id, 'Sotuvchi yuk L — his', null);
    await deal(`${looseCode}-TH`, loose.clientId, owner.id, 'Sotuvchi yuk L — theirs', null);
    return {
      mine: { receiptId: mine.receiptId, dealCode: mine.dealCode },
      other: { receiptId: other.receiptId, dealCode: other.dealCode },
      hisDeal: { receiptId: hisDeal.receiptId, dealCode: hisDeal.dealCode },
      loose: { receiptId: loose.receiptId, dealCode: `${looseCode}-MY`, theirDealCode: `${looseCode}-TH` },
    };
  });
}

/** Everything any run of this spec minted — found by the marker's shape, never by ids a dead run lost. */
export async function cleanupAll(sql: postgres.Sql): Promise<number> {
  const clients = await sql<{ id: string }[]>`
    SELECT id FROM clients WHERE client_code ~ '^SY[0-9]{4}[MOHL]$' AND name = 'Sotuvchi yuk ' || client_code`;
  // `L`'s prixod stands on `O`'s deal: unhooked first, or a client deleted
  // before the other trips the receipt → deal key.
  if (clients.length > 0) await sql`UPDATE receipts SET deal_id = NULL WHERE client_id IN ${sql(clients.map((c) => c.id))}`;
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
