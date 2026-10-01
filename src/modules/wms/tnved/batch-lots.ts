import { cache } from 'react';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { boxes, clients, receiptLots, receipts } from '../../platform/db/schema';
import { aboardFilter } from '../scanning/unload';
import { cartonsBefore, isStale, paperLines } from '../receipts/composition-math';
import { lotTrucksFor, paperCompositionsFor } from '../receipts/lot-composition';
import { productKey, tnvedFor, tnvedHintsFor } from './service';

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
 *
 * Lot tarkibi (docs/LOT-TARKIBI.md §5): a COMPOSED lot leaves the per-name
 * grouping and contributes one row per line that is on this truck's papers
 * (`paperLines` — a line with no carton here has no row), with the line's
 * own code. So «TNVED kodsiz · N» counts the lines the invoice prints, and
 * the editor and the header agree by construction.
 */
export interface TnvedProductRow {
  /** The first lot of this product — the editor's AI button asks about it. */
  lotId: string;
  /** Every lot of this product on the truck (for the page's photo lookup). */
  lotIds: string[];
  /** The name the row shows — the lot's Chinese name, or a composition line's own name. */
  nameZh: string;
  nameRu: string | null;
  /** The LOT's box_count on every row kind — line figures are on `line`. */
  boxCount: number;
  /** From the shared memory — pre-filled; '' means nobody has classified it. */
  code: string;
  source: 'manual' | 'ai' | null;
  /** The lots behind this row, for the per-lot «🧩 Tarkibi» links. */
  lots: { lotId: string; receiptId: string; label: string }[];
  /** Present on a composition LINE row; absent on a product row. */
  line?: {
    /** 'line:<lineId>' live | 'snap:<lotId>:<seq>' frozen. */
    rowKey: string;
    lotId: string;
    lineId: string | null;
    seq: number;
    rev: number;
    receiptId: string;
    label: string;
    ofLines: number;
    /** On THIS truck; null = aralash. */
    cartons: number | null;
    /** On THIS truck. */
    pieces: number | null;
    /** On THIS truck. */
    kg: number;
    estimate: boolean;
    stale: boolean;
    /** The truck is ticked «hujjat yuborildi»: its papers are frozen, read-only here. */
    frozen: boolean;
    hint: { code: string; from: 'memory' | 'composition' } | null;
  };
}

export const batchTnvedProducts = cache(async function batchTnvedProducts(
  batchId: string,
  departed: boolean,
): Promise<TnvedProductRow[]> {
  // Grouped per lot: `n` = this lot's cartons in the population, which feeds
  // `paperLines` only — a product row keeps the lot's own box_count.
  const rows = await db
    .select({
      lot: receiptLots,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
      n: sql<number>`count(*)::int`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(departed ? aboardFilter(batchId) : eq(boxes.currentBatchId, batchId))
    .groupBy(receiptLots.id, clients.clientCode, receipts.unclaimedMarking);
  const lots = rows.sort((a, b) => (a.lot.letter ?? '').localeCompare(b.lot.letter ?? ''));
  const memory = await tnvedFor(lots.map(({ lot }) => lot.productNameZh));
  const lotIds = lots.map(({ lot }) => lot.id);
  const compositions = await paperCompositionsFor(batchId, lotIds);
  const trucks = compositions.size > 0 ? await lotTrucksFor(db, [...compositions.keys()]) : new Map();
  const lineNames = [...compositions.values()].flatMap((c) => c.lines.map((l) => l.name));
  const hints = lineNames.length > 0 ? await tnvedHintsFor(lineNames) : new Map();

  // One row per distinct product name — the code belongs to the PRODUCT —
  // and one per composition line, in the order the lots are lettered.
  const out: TnvedProductRow[] = [];
  const byProduct = new Map<string, TnvedProductRow>();
  for (const { lot, clientCode, marking, n } of lots) {
    const label = `${clientCode ?? marking ?? '?'}-${lot.letter ?? ''}`;
    const chip = { lotId: lot.id, receiptId: lot.receiptId, label };
    const comp = compositions.get(lot.id);
    if (comp) {
      const totals = { boxCount: lot.boxCount, kg: lot.totalWeightKg, m3: lot.totalVolumeM3 };
      const cartons = Number(n);
      const view = paperLines(comp, totals, {
        before: cartonsBefore(trucks.get(lot.id) ?? [], batchId),
        cartons,
        kg: Math.round(((Number(lot.totalWeightKg) / lot.boxCount) * cartons) * 10) / 10,
      });
      const stale = isStale(comp, totals);
      for (const line of view.lines) {
        const stored = comp.lines.find((l) => l.seq === line.seq);
        const lineId = comp.frozen ? null : (stored?.id ?? null);
        out.push({
          lotId: lot.id,
          lotIds: [lot.id],
          // The name the row shows: the line's own (a Russian name, usually).
          nameZh: line.name,
          nameRu: null,
          boxCount: lot.boxCount,
          code: line.tnvedCode ?? '',
          source: null,
          lots: [chip],
          line: {
            rowKey: lineId ? `line:${lineId}` : `snap:${lot.id}:${line.seq}`,
            lotId: lot.id,
            lineId,
            seq: line.seq,
            rev: comp.rev,
            receiptId: lot.receiptId,
            label,
            ofLines: comp.lines.length,
            cartons: line.cartons,
            pieces: line.pieces,
            kg: line.kg,
            estimate: view.estimate,
            stale,
            frozen: comp.frozen,
            hint: line.tnvedCode ? null : (hints.get(productKey(line.name)) ?? null),
          },
        });
      }
      continue;
    }
    const key = productKey(lot.productNameZh);
    const existing = byProduct.get(key);
    if (existing) {
      existing.boxCount += lot.boxCount;
      existing.lotIds.push(lot.id);
      existing.lots.push(chip);
      continue;
    }
    const stored = memory.get(key);
    const row: TnvedProductRow = {
      lotId: lot.id,
      lotIds: [lot.id],
      nameZh: lot.productNameZh,
      nameRu: lot.productNameRu ?? stored?.productNameRu ?? null,
      boxCount: lot.boxCount,
      code: stored?.tnvedCode ?? '',
      source: stored ? (stored.source as 'manual' | 'ai') : null,
      lots: [chip],
    };
    byProduct.set(key, row);
    out.push(row);
  }
  return out;
});

/** The editor's empty codes — the header item «TNVED kodsiz · N». */
export function missingTnvedCount(rows: TnvedProductRow[]): number {
  return rows.filter((row) => row.code === '').length;
}
