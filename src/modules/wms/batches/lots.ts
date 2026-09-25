import { asc, eq, ne, sql, and } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { boxes, clients, deals, receiptLots, receipts } from '../../platform/db/schema';
import { leftBehindSql, riderFilter } from './riders';
import { soleDealOf } from '../finance/pricing-view';

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
  /** Boxes of this lot on this truck. */
  onBatch: number;
  /** Boxes the lot was received with — `onBatch < lotBoxCount` is a split lot. */
  lotBoxCount: number;
  kg: number;
  m3: number;
  /** Of `onBatch`: written off as lost. */
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

export async function batchLots(batchId: string): Promise<BatchLot[]> {
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
      onBatch: sql<number>`count(*)`,
      lostCount: sql<number>`count(*) FILTER (WHERE ${boxes.status} = 'lost')`,
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
}

/**
 * The deal a price set on this truck for this client is ALSO written to
 * (owner's R3a) — `soleDealOf` over the deals of the client's cargo aboard,
 * read by the same rider rule as `batchLots` (the screen that announces
 * it), so the page and the ledger cannot answer differently. A deal whose
 * client is not this one is never written: the receipt's link is somebody
 * else's data and no price may reach another client's job through it.
 */
export async function soleDealAboard(batchId: string, clientId: string): Promise<string | null> {
  const rows = await db
    .selectDistinct({ dealId: receipts.dealId, dealClientId: deals.clientId })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(deals, eq(receipts.dealId, deals.id))
    .where(and(riderFilter(batchId), ne(boxes.status, 'void'), eq(receipts.clientId, clientId)));
  const dealId = soleDealOf(rows);
  if (!dealId) return null;
  return rows.find((row) => row.dealId === dealId)?.dealClientId === clientId ? dealId : null;
}
