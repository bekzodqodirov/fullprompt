import { cache } from 'react';
import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { boxes, receiptLots } from '../../platform/db/schema';
import { aboardFilter } from '../scanning/unload';
import { productKey, tnvedFor } from './service';

/**
 * The products a truck DECLARES, one row per product — the TNVED editor's
 * rows, and the ONE list the truck card counts «TNVED kodsiz» from (#513):
 * the header's number is the count of empty codes the editor shows.
 *
 * Which cartons: before the truck leaves, whatever is on its live pointer —
 * planned included, because the VED classifies the goods BEFORE the truck
 * is loaded. After it leaves, the cartons that really went (`aboardFilter`).
 * Never the scan history: an office count dialled to 0 keeps its scan events,
 * and a lot that did not go must not be declared (0112, decision 25).
 *
 * The departure is the switch, not «does any carton still point here». That
 * older rule read the live pointer whenever ANY carton was still on it, so
 * mid-unload — at a customs warehouse, exactly when the VED declares — every
 * lot already scanned off vanished from the editor (measured: 58 lots on 25
 * arrived trucks of one database), and a count of missing codes would have
 * fallen as cartons came off, not as codes were typed.
 */
export interface TnvedProductRow {
  /** The first lot of this product — the editor's AI button asks about it. */
  lotId: string;
  /** Every lot of this product on the truck (for the page's photo lookup). */
  lotIds: string[];
  nameZh: string;
  nameRu: string | null;
  boxCount: number;
  /** From the shared memory — pre-filled; '' means nobody has classified it. */
  code: string;
  source: 'manual' | 'ai' | null;
}

export const batchTnvedProducts = cache(async function batchTnvedProducts(
  batchId: string,
  departed: boolean,
): Promise<TnvedProductRow[]> {
  const rows = await db
    .selectDistinct({ lot: receiptLots })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(departed ? aboardFilter(batchId) : eq(boxes.currentBatchId, batchId));
  const lots = rows
    .map((r) => r.lot)
    .sort((a, b) => (a.letter ?? '').localeCompare(b.letter ?? ''));
  const memory = await tnvedFor(lots.map((lot) => lot.productNameZh));

  // One row per distinct product name — the code belongs to the PRODUCT.
  const byProduct = new Map<string, TnvedProductRow>();
  for (const lot of lots) {
    const key = productKey(lot.productNameZh);
    const existing = byProduct.get(key);
    if (existing) {
      existing.boxCount += lot.boxCount;
      existing.lotIds.push(lot.id);
      continue;
    }
    const stored = memory.get(key);
    byProduct.set(key, {
      lotId: lot.id,
      lotIds: [lot.id],
      nameZh: lot.productNameZh,
      nameRu: lot.productNameRu ?? stored?.productNameRu ?? null,
      boxCount: lot.boxCount,
      code: stored?.tnvedCode ?? '',
      source: stored ? (stored.source as 'manual' | 'ai') : null,
    });
  }
  return [...byProduct.values()];
});

/** The editor's empty codes — the header item «TNVED kodsiz · N». */
export function missingTnvedCount(rows: TnvedProductRow[]): number {
  return rows.filter((row) => row.code === '').length;
}
