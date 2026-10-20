import { cache } from 'react';
import { aliasedTable, and, eq, inArray, sql, type SQL } from 'drizzle-orm';
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

/**
 * «Still only reserved» and «on it», over the live pointer of the truck
 * `batch` names — ONE pair of sentences for the per-lot progress below and
 * the per-truck totals the batch board draws (#513), so the header's
 * «12 / 40 📦» and the board's «Yuklandi 12 / 40» cannot disagree.
 */
function loadState(batch: SQL): { planned: SQL; loaded: SQL } {
  return {
    planned: sql`${boxes.currentBatchId} = ${batch} AND ${boxes.status} = 'planned'`,
    loaded: sql`${boxes.currentBatchId} = ${batch} AND ${boxes.status} IN ('loading', 'in_transit')`,
  };
}

export const batchLoadProgress = cache(async function batchLoadProgress(
  batchId: string,
): Promise<Map<string, LotProgress>> {
  const state = loadState(sql`${batchId}`);
  const rows = await db
    .select({
      lotId: receiptLots.id,
      planned: sql<number>`count(*) FILTER (WHERE ${state.planned})`,
      loaded: sql<number>`count(*) FILTER (WHERE ${state.loaded})`,
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

/** Boxes and their share of their lots' kilos and cubes. */
export interface LoadMeasure {
  boxes: number;
  kg: number;
  m3: number;
}

/**
 * Per TRUCK, for many trucks in one grouped statement (the batch board's
 * «Yuklandi a / b karobka · x / y m³ · x / y kg», his 7a): what is on it and
 * what the plan holds — `planned` is the whole plan, aboard or not. The same
 * sentences as the per-lot progress (`loadState`), so it is the server's
 * number: a scan still queued on a loader's offline phone is not in it, and
 * after «yuklash tugadi» the short-loaded cartons have gone back to the shelf
 * and the plan reads what was loaded. A box's kilos and cubes are its lot's
 * share (`total ÷ box_count`, the house rule `riderLoad` uses). A truck with
 * nothing on its pointer is absent; the caller reads that as an empty plan.
 */
export async function batchLoadTotals(
  batchIds: string[],
): Promise<Map<string, { loaded: LoadMeasure; planned: LoadMeasure }>> {
  const out = new Map<string, { loaded: LoadMeasure; planned: LoadMeasure }>();
  const ids = [...new Set(batchIds)];
  if (ids.length === 0) return out;
  const state = loadState(sql`${boxes.currentBatchId}`);
  const kg = sql`${receiptLots.totalWeightKg} / nullif(${receiptLots.boxCount}, 0)`;
  const m3 = sql`${receiptLots.totalVolumeM3} / nullif(${receiptLots.boxCount}, 0)`;
  const rows = await db
    .select({
      batchId: boxes.currentBatchId,
      loadedBoxes: sql<number>`count(*) FILTER (WHERE ${state.loaded})`,
      loadedKg: sql<string>`coalesce(sum(${kg}) FILTER (WHERE ${state.loaded}), 0)`,
      loadedM3: sql<string>`coalesce(sum(${m3}) FILTER (WHERE ${state.loaded}), 0)`,
      planBoxes: sql<number>`count(*)`,
      planKg: sql<string>`coalesce(sum(${kg}), 0)`,
      planM3: sql<string>`coalesce(sum(${m3}), 0)`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(
      and(
        inArray(boxes.currentBatchId, ids),
        sql`(${state.planned} OR ${state.loaded})`,
      ),
    )
    .groupBy(boxes.currentBatchId);
  for (const r of rows) {
    if (!r.batchId) continue;
    out.set(r.batchId, {
      loaded: { boxes: Number(r.loadedBoxes), kg: Number(r.loadedKg), m3: Number(r.loadedM3) },
      planned: { boxes: Number(r.planBoxes), kg: Number(r.planKg), m3: Number(r.planM3) },
    });
  }
  return out;
}
