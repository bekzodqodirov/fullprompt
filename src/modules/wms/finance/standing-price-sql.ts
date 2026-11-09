import { sql, type SQL } from 'drizzle-orm';

/**
 * What counts as a STANDING price, as SQL — the clauses the unpriced rule
 * (`u_charge`), the truck-price question's deal heads (`truckDealHeads`) and
 * the «Narx» tab's table all ask, written once so the three cannot disagree
 * about which money covers which cargo (#513; review A1 found the table
 * reading live charges only while the other two counted a zeroed one).
 *
 * Builders, not queries: each is embedded in the caller's own statement, on
 * whichever executor it holds (#714). `txId` / `dealId` is the column as the
 * caller's query names it — `${table}.id`, never `${table.id}`, inside a
 * single-table select (#128).
 */

/**
 * A charge the lost-cargo door lowered to ZERO (0105, Q15). The ledger cannot
 * hold a $0 charge, so the door voids it and writes nothing back; the void's
 * own audit row says so (`from: 'compensation'`, `repricedTo` null). It is
 * still a price someone set and covers like the price it was — never
 * «unpriced», or the next press bills again exactly what the compensation
 * took back (review A1).
 */
export function zeroedByCompensationSql(txId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM audit_log za
     WHERE za.entity_type = 'client_transaction' AND za.entity_id = ${txId} AND za.action = 'void'
       AND za.after->>'from' = 'compensation' AND za.after->'repricedTo' = 'null'::jsonb)`;
}

/**
 * A deal-less truck price the person CHOSE as «bitimsiz» (Q8 «c»): its create
 * audit says `dealVia: 'none'`. Every other deal-less price was written before
 * the deals were known or before Q8, and is the whole cargo's
 * (`pricedHereReading`). The correction doors (the lost-cargo re-post, the
 * part of a «Ko'chirish» that stays) carry the word onto their copy, so a
 * chosen part keeps being one (review A2).
 */
export function chosenNoneSql(txId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM audit_log ca
     WHERE ca.entity_type = 'client_transaction' AND ca.entity_id = ${txId}
       AND ca.action = 'create' AND ca.after->>'dealVia' = 'none')`;
}

/**
 * The deal carries a price of its own with NO truck — a deal price from the
 * ledger, live or lowered to zero by the lost-cargo door. The unpriced rule's
 * deal clause covers its cartons on every truck, so «narx yo'q» there would
 * invite a second bill for the same job.
 */
export function dealCardPricedSql(dealId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM client_transactions ct
     WHERE ct.deal_id = ${dealId} AND ct.batch_id IS NULL AND ct.type = 'charge'
       AND (ct.voided_at IS NULL OR ${zeroedByCompensationSql(sql`ct.id`)}))`;
}
