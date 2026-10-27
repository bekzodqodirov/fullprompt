import { cache } from 'react';
import { asc, eq, ne, sql, and } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { boxes, clients, deals, receiptLots, receipts } from '../../platform/db/schema';
import { leftBehindSql, riderFilter, riderRowsSql, rodeLaterSql } from './riders';
import { dealCandidatesOf, type DealCandidates } from '../finance/truck-deal';

/**
 * What rode this truck, one row per LOT — the goods, not the client (owner,
 * 2026-09-24: «partiya ichidagi tovarlar bo'yicha ko'rsatsin va tovar nomi
 * rasmi ko'rinib tursin, linki bilan prixodni ichiga o'tishga, bitim ulangan
 * bo'lsa bitim ham ko'rinsin»).
 *
 * The money screens read the truck through this: the prixod cost grid groups
 * it by receipt, «Partiya moliyasi» by client. The batch card keeps its own
 * query on purpose — it counts planned/loaded boxes, which nothing here needs,
 * and its photo order is the LOADER's (tests/unit/loading-photo-order).
 *
 * Membership is the truck's RIDERS (`riders.ts`) — the money rule, which
 * the cost engine splits the truck's bills over (U17/U25): an unloaded box no
 * longer points at its truck (#152/#440), a carton found back at the origin
 * never rode it, one scanned off without a load scan did. An annulled box is
 * not cargo — `voidBoxRows` clears the live pointer, but the `batch_departed`
 * movement stays for ever, so without the status clause an annulled prixod
 * would go on being offered a customs cell with nobody left to carry it.
 *
 * A carton's FATE rides beside it and moves nothing (U35): lost, still
 * missing from the unload, or found back where the truck started. The cost
 * stays where the engine put it (#833 — whether the client's bill shrinks is
 * the deal's damage discount), and the three money screens go on agreeing to
 * the cent; what changes is that the person typing a price per kilo is told
 * how many of those kilos did not arrive.
 *
 * kg / m³ are a SHARE of the lot (boxes aboard ÷ boxes in the lot), the same
 * arithmetic as the batch card and the stock table: a lot split over two
 * trucks is weighed once in total, not once per truck.
 *
 * The deal is its code and title only. Its quote is the client price, and
 * this list is read by people the quote is not for.
 */
export interface BatchLot {
  lotId: string;
  letter: string | null;
  productNameZh: string;
  productNameRu: string | null;
  receiptId: string;
  receiptNumber: string | null;
  clientId: string | null;
  clientCode: string | null;
  clientName: string | null;
  /** What is written on an unclaimed carton; kept after a claim (round 98). */
  marking: string | null;
  dealId: string | null;
  dealCode: string | null;
  dealTitle: string | null;
  /**
   * Whose job the receipt's deal is. A prixod re-assigned to another client
   * keeps its old deal link (`assignReceiptClient`), and the pricing readers
   * treat such a lot as deal-less for its new client (`ownDealOf`); the lot
   * row itself still prints the stored link, which is how somebody sees it.
   */
  dealClientId: string | null;
  /**
   * The calculation this lot's prixod is linked to (0119, «🧮 Bitim hisobi»)
   * and whether a PERSON confirmed it — a guess and an answer read differently
   * on the sheet. Ids and a flag only; never the calculation's money.
   */
  calcRequestId: string | null;
  calcLinkConfirmed: boolean;
  /** Boxes of this lot on this truck. */
  onBatch: number;
  /** Boxes the lot was received with — `onBatch < lotBoxCount` is a split lot. */
  lotBoxCount: number;
  kg: number;
  m3: number;
  /**
   * Of `onBatch`: written off as lost, on this leg or at its destination
   * before the carton rode anywhere else — a loss on a LATER truck is that
   * truck's (U35).
   */
  lostCount: number;
  /** Of `onBatch`: not scanned off this truck — flagged missing, unresolved. */
  missingCount: number;
  /**
   * NOT in `onBatch`: scanned as loaded onto this truck and found back at its
   * origin — it never rode, and neither its cost nor its kilos are here.
   */
  leftBehindCount: number;
  /** `kg` / `m3` over the boxes that arrived: `onBatch − lost − missing`. */
  arrivedKg: number;
  arrivedM3: number;
  /** The goods themselves (the receipt_lot photo) — «what is it». */
  goodsPhotoId: string | null;
  /** The carton's outside (the receipt's general photo) — the fallback. */
  boxPhotoId: string | null;
}

export const batchLots = cache(async function batchLots(batchId: string): Promise<BatchLot[]> {
  const rows = await db
    .select({
      lotId: receiptLots.id,
      letter: receiptLots.letter,
      productNameZh: receiptLots.productNameZh,
      productNameRu: receiptLots.productNameRu,
      lotBoxCount: receiptLots.boxCount,
      lotWeightKg: receiptLots.totalWeightKg,
      lotVolumeM3: receiptLots.totalVolumeM3,
      receiptId: receipts.id,
      receiptNumber: receipts.number,
      marking: receipts.unclaimedMarking,
      clientId: clients.id,
      clientCode: clients.clientCode,
      clientName: clients.name,
      dealId: deals.id,
      dealCode: deals.code,
      dealTitle: deals.title,
      dealClientId: deals.clientId,
      calcRequestId: receipts.calcRequestId,
      calcLinkConfirmedAt: receipts.calcLinkConfirmedAt,
      onBatch: sql<number>`count(*)`,
      // Lost on THIS leg — or after it landed, before it rode on: a carton
      // this truck delivered and the NEXT truck lost is not «not arrived»
      // here, and counting it flipped this truck's price to «/kg of what
      // arrived» for a loss that belongs to another leg (`rodeLaterSql`).
      lostCount: sql<number>`count(*) FILTER (
        WHERE ${boxes.status} = 'lost' AND NOT ${rodeLaterSql(sql`${batchId}::uuid`, 'boxes')}
      )`,
      // Flagged by `finishUnload` and still pointing at THIS truck: a box
      // merely in transit before the unload is on the road, not missing.
      missingCount: sql<number>`count(*) FILTER (
        WHERE ${boxes.flags} @> '["missing_in_transit"]'::jsonb AND ${boxes.currentBatchId} = ${batchId}
          AND ${boxes.status} <> 'lost'
      )`,
      leftBehindCount: sql<number>`(
        SELECT count(*) FROM boxes lb
         WHERE lb.lot_id = ${receiptLots.id} AND ${leftBehindSql(sql`${batchId}::uuid`, 'lb')}
      )`,
      goodsPhotoId: sql<string | null>`(
        SELECT a.id FROM attachments a
        WHERE a.entity_type = 'receipt_lot' AND a.entity_id = ${receiptLots.id} AND a.kind = 'photo'
        ORDER BY a.created_at LIMIT 1
      )`,
      boxPhotoId: sql<string | null>`(
        SELECT a.id FROM attachments a
        WHERE a.entity_type = 'receipt' AND a.entity_id = ${receipts.id} AND a.kind = 'photo'
        ORDER BY a.created_at LIMIT 1
      )`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .leftJoin(deals, eq(receipts.dealId, deals.id))
    .where(and(riderFilter(batchId), ne(boxes.status, 'void')))
    .groupBy(receiptLots.id, receipts.id, clients.id, deals.id)
    // Client code first with the unclaimed last, then the prixod, then its
    // letter — the order the accountant's Excel is kept in.
    .orderBy(
      sql`${clients.clientCode} ASC NULLS LAST`,
      asc(receipts.number),
      asc(receiptLots.letter),
    );

  return rows.map((row) => {
    const onBatch = Number(row.onBatch);
    const lostCount = Number(row.lostCount);
    const missingCount = Number(row.missingCount);
    const share = row.lotBoxCount > 0 ? onBatch / row.lotBoxCount : 0;
    const arrived = onBatch - lostCount - missingCount;
    const arrivedShare = row.lotBoxCount > 0 ? arrived / row.lotBoxCount : 0;
    return {
      lotId: row.lotId,
      letter: row.letter,
      productNameZh: row.productNameZh,
      productNameRu: row.productNameRu,
      receiptId: row.receiptId,
      receiptNumber: row.receiptNumber,
      clientId: row.clientId,
      clientCode: row.clientCode,
      clientName: row.clientName,
      marking: row.marking,
      dealId: row.dealId,
      dealCode: row.dealCode,
      dealTitle: row.dealTitle,
      dealClientId: row.dealClientId,
      calcRequestId: row.calcRequestId,
      calcLinkConfirmed: row.calcLinkConfirmedAt !== null,
      onBatch,
      lotBoxCount: row.lotBoxCount,
      kg: Math.round(Number(row.lotWeightKg) * share * 10) / 10,
      m3: Math.round(Number(row.lotVolumeM3) * share * 1000) / 1000,
      lostCount,
      missingCount,
      leftBehindCount: Number(row.leftBehindCount),
      arrivedKg: Math.round(Number(row.lotWeightKg) * arrivedShare * 10) / 10,
      arrivedM3: Math.round(Number(row.lotVolumeM3) * arrivedShare * 1000) / 1000,
      goodsPhotoId: row.goodsPhotoId,
      boxPhotoId: row.boxPhotoId,
    };
  });
});

/**
 * The deals a client's cargo rides a truck under — one row per (truck,
 * client, receipt deal, that deal's client) over the money riders
 * (`riderRowsSql`: the live pointer before departure, the rides after it, a
 * void box never). The ONE read behind every question about a truck price's
 * deal: the price door before its transaction and again inside it (`tx`),
 * the «Narx» tab once per truck for all its clients, and the client ledger's
 * truck select once over the trucks it offers — so no screen can draw a
 * question the door would answer differently (#513). `dealCandidatesOf`
 * folds the rows into the answer.
 *
 * `clientId` null reads every client on the trucks (the «Narx» tab).
 */
export interface DealCandidateRow {
  batchId: string;
  clientId: string;
  dealId: string | null;
  dealClientId: string | null;
}

export async function dealCandidateRows(
  batchIds: string[],
  clientId: string | null,
  handle: Db | Tx = db,
): Promise<DealCandidateRow[]> {
  if (batchIds.length === 0) return [];
  const list = sql.join(
    batchIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await handle.execute(sql`
    SELECT DISTINCT rr.batch_id, r.client_id, r.deal_id, d.client_id AS deal_client_id
      FROM (${riderRowsSql({ batches: list })}) rr
      JOIN boxes cb ON cb.id = rr.box_id
      JOIN receipt_lots cl ON cl.id = cb.lot_id
      JOIN receipts r ON r.id = cl.receipt_id
      LEFT JOIN deals d ON d.id = r.deal_id
     WHERE r.client_id IS NOT NULL ${clientId ? sql`AND r.client_id = ${clientId}::uuid` : sql``}
  `)) as unknown as { batch_id: string; client_id: string; deal_id: string | null; deal_client_id: string | null }[];
  return [...rows].map((row) => ({
    batchId: row.batch_id,
    clientId: row.client_id,
    dealId: row.deal_id,
    dealClientId: row.deal_client_id,
  }));
}

/**
 * Is this client's cargo aboard this truck, and which deals a price set here
 * may be written to (`dealCandidatesOf` — R3a's one derived deal, or his Q8
 * «c» choice between several). A deal whose client is not this one is never
 * a candidate: the receipt's link is somebody else's data and no price may
 * reach another client's job through it.
 *
 * `aboard` is the price door's refusal (0104, U31 claim 1): a truck price for a
 * client with nothing on the truck names no cargo. The pricing screen draws a
 * form only for riders, so it refuses a stale or hand-built post — and the
 * card form's truck select and «🚚 Ko'chirish», which cannot mint a no-cargo
 * price at birth.
 *
 * Takes the handle so the price door asks it AGAIN inside its transaction,
 * after the truck lock, with the very same statement (#714: never the pool
 * from inside a transaction).
 */
export async function cargoAboard(
  batchId: string,
  clientId: string,
  handle: Db | Tx = db,
): Promise<{ aboard: boolean; dealId: string | null; candidates: DealCandidates }> {
  const rows = await dealCandidateRows([batchId], clientId, handle);
  const candidates = dealCandidatesOf(rows, clientId);
  return { aboard: rows.length > 0, dealId: candidates.sole, candidates };
}
