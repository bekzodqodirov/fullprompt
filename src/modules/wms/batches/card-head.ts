import { cache } from 'react';
import { aliasedTable, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, boxes, receiptLots, warehouses } from '../../platform/db/schema';
import { qrlessJoinedSql } from '../labels/qrless-sql';
import { isInternalLeg } from './internal';
import { riderFilter } from './riders';

/**
 * The truck card's head — the batch row and its two ends — read ONCE per
 * request by whichever of the card's six tab pages is rendering, its
 * `generateMetadata`, and the card's own header (React `cache`, keyed by the
 * id). Null when there is no such truck.
 *
 * `internal` is the money rule (a leg inside China is never priced, C1a);
 * `crossesBorder` the VED's paperwork rule (`sameCountryLegSql`'s sentence,
 * restated for two already-read country strings): Andijan → Tashkent is
 * priced but crosses no border, so it has no customs fact to show. An empty
 * origin country is treated as crossed: the header then SHOWS the customs
 * fact («Rastamojka: —») rather than hiding a border that may be real.
 */
export const loadBatchHead = cache(async function loadBatchHead(id: string) {
  const dest = aliasedTable(warehouses, 'dest');
  const [hit] = await db
    .select({
      batch: batches,
      originCode: warehouses.code,
      originName: warehouses.name,
      originCountry: warehouses.country,
      destCode: dest.code,
      destName: dest.name,
      destCountry: dest.country,
    })
    .from(batches)
    .innerJoin(warehouses, eq(batches.originWarehouseId, warehouses.id))
    .innerJoin(dest, eq(batches.destWarehouseId, dest.id))
    .where(eq(batches.id, id))
    .limit(1);
  if (!hit) return null;
  const origin = (hit.originCountry ?? '').trim().toUpperCase();
  const destination = (hit.destCountry ?? '').trim().toUpperCase();
  return {
    ...hit,
    internal: isInternalLeg(hit.originCountry, hit.destCountry),
    crossesBorder: origin === '' || origin !== destination,
  };
});

export type BatchHead = NonNullable<Awaited<ReturnType<typeof loadBatchHead>>>;

/**
 * The loading progress of each lot on the truck: what is still only
 * RESERVED (`planned`) and what is on it (`loading` / `in_transit`) — both
 * read off the LIVE pointer and nothing else. The old card counted the
 * statuses over the truck's whole membership, so every closed truck read
 * «0/0 yuklandi» and an unloaded one counted cartons already planned on the
 * NEXT truck as planned here (review, data lens D5); this line is only drawn
 * while the truck is being loaded anyway. `qrless` is the lot's stickerless
 * cartons among the truck's riders — the chip on the contents row.
 *
 * Membership is the riders' (the contents table's, `batchLots`), so a lot
 * here is a lot there.
 */
export interface LotProgress {
  planned: number;
  loaded: number;
  qrless: number;
}

export const batchLoadProgress = cache(async function batchLoadProgress(
  batchId: string,
): Promise<Map<string, LotProgress>> {
  const rows = await db
    .select({
      lotId: receiptLots.id,
      planned: sql<number>`count(*) FILTER (WHERE ${boxes.currentBatchId} = ${batchId} AND ${boxes.status} = 'planned')`,
      loaded: sql<number>`count(*) FILTER (WHERE ${boxes.currentBatchId} = ${batchId} AND ${boxes.status} IN ('loading', 'in_transit'))`,
      qrless: sql<number>`count(*) FILTER (WHERE ${qrlessJoinedSql()})`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(riderFilter(batchId))
    .groupBy(receiptLots.id);
  return new Map(
    rows.map((row) => [
      row.lotId,
      { planned: Number(row.planned), loaded: Number(row.loaded), qrless: Number(row.qrless) },
    ]),
  );
});
