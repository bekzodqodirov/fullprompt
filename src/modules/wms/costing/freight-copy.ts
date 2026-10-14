import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { batches, costEntryTariffs, warehouses } from '../../platform/db/schema';
import { tariffHistory } from '../calc/tariff-read';
import { CostError } from './errors';
import { customsCostTypeIds } from './customs-ids';
import { freightTablesReady } from './freight-ready';
import { FREIGHT_LIGHT_BELOW, copyDraft, validCopyBands } from './freight-split';
import { tariffColumnOf } from './tariff-column';
import type { FreightCopy, FreightCopyDraft } from './freight-types';

/**
 * The ONLY home of `cost_entry_tariffs` (docs/YOLKIRA-TAQSIMOT.md §3, §9.8):
 * one reader and one writer, and no other file names the table (fenced). A
 * freight bill has exactly one row — its frozen column, as of its cost_date —
 * and any other bill none, after every writer; the recompute, the void guard
 * and every explanation read ONLY this copy, never the live tariff and never
 * the warehouse's current column (his 3a).
 *
 * Imports the pure split and the database, never `./service`: a static cycle
 * inside costing crashes a later top-level `extends` at module load.
 */

/**
 * Every listed bill's copy in ONE read (#432 — a list renders every copy on
 * the page in one statement, never one per bill). A copy read back from jsonb
 * is checked again — the table's CHECK admits NaN — and a bad one is
 * `'invalid'`, which HOLDS the bill rather than splitting it on garbage.
 * Read only for a bill whose basis is 'freight' (the callers' rule).
 */
export async function freightCopiesFor(
  entryIds: string[],
  handle: Db | Tx = db,
): Promise<Map<string, FreightCopy | 'missing' | 'invalid'>> {
  const out = new Map<string, FreightCopy | 'missing' | 'invalid'>();
  if (entryIds.length === 0) return out;
  for (const id of entryIds) out.set(id, 'missing');
  const rows = await handle.select().from(costEntryTariffs).where(inArray(costEntryTariffs.costEntryId, entryIds));
  for (const r of rows) {
    const bands = validCopyBands(r.bands);
    out.set(
      r.costEntryId,
      bands === null || !Number.isInteger(r.lightBelow) || r.lightBelow < 1
        ? 'invalid'
        : { warehouseId: r.warehouseId, zone: r.tariffZone, tariffFrom: r.tariffFrom, lightBelow: r.lightBelow, bands },
    );
  }
  return out;
}

export async function freightCopyFor(entryId: string, handle: Db | Tx = db): Promise<FreightCopy | 'missing' | 'invalid'> {
  return (await freightCopiesFor([entryId], handle)).get(entryId)!;
}

/**
 * The ONE writer. DELETE the bill's row, then INSERT the new copy when there
 * is one — the create path and the re-basis door both call it, so «a freight
 * bill has one copy, any other bill none» rests on this function alone. A
 * non-finite band is refused before it can be frozen (#777's NaN lesson).
 */
export async function replaceFreightCopyInTx(
  tx: Tx,
  entryId: string,
  draft: FreightCopyDraft | null,
): Promise<void> {
  await tx.delete(costEntryTariffs).where(eq(costEntryTariffs.costEntryId, entryId));
  if (draft === null) return;
  if (validCopyBands(draft.bands) === null || !Number.isInteger(draft.lightBelow)) {
    throw new Error('freight copy with a non-finite band');
  }
  await tx.insert(costEntryTariffs).values({
    costEntryId: entryId,
    warehouseId: draft.warehouseId,
    tariffZone: draft.zone,
    tariffFrom: draft.tariffFrom,
    lightBelow: draft.lightBelow,
    bands: draft.bands.map((b) => ({ min: b.min, max: b.max, price: b.price, perKg: b.perKg })),
  });
}

/**
 * What a person SAW, as one string (M6): the panel posts the digest of the
 * version its preview drew, the save digests what it is about to freeze, and
 * a difference (a remap, a same-date overwrite, a back-dated row between the
 * render and the press) is refused in words instead of frozen silently.
 */
export function copyDigest(copy: FreightCopyDraft): string {
  const canonical = JSON.stringify([
    copy.warehouseId,
    copy.zone,
    copy.tariffFrom,
    copy.lightBelow,
    [...copy.bands]
      .sort((a, b) => a.min - b.min)
      .map((b) => [b.min, b.max, b.price, b.perKg]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * What a freight bill will freeze — or the refusal, in words (§5). On the
 * POOL, before any transaction (#714): the probe, the scope, the customs
 * list, the truck's ORIGIN warehouse and its column (his 2c — never inferred),
 * and the column as of the bill's own date with no earliest-row fallback.
 * Only tariff CONFIGURATION is refused here; lot DATA never refuses the money
 * (a light group saves the bill and holds it, §6). Null for any other basis.
 *
 * Each problem kind throws its OWN literal code (T9): a computed code is
 * invisible to the refusal fence.
 */
export async function prepareFreightCopy(input: {
  scope: string;
  batchId?: string | null;
  costTypeId: string;
  costDate: string;
  allocationBasis: string;
}): Promise<FreightCopyDraft | null> {
  if (input.allocationBasis !== 'freight') return null;
  if (!(await freightTablesReady())) throw new CostError('server_behind');
  if (input.scope !== 'batch' || !input.batchId) throw new CostError('freight_batch_only');
  if ((await customsCostTypeIds()).includes(input.costTypeId)) throw new CostError('freight_on_customs');
  const [truck] = await db
    .select({ originId: batches.originWarehouseId, code: warehouses.code, name: warehouses.name })
    .from(batches)
    .innerJoin(warehouses, eq(warehouses.id, batches.originWarehouseId))
    .where(eq(batches.id, input.batchId));
  if (!truck) throw new CostError('not_found');
  const warehouse = `${truck.code} — ${truck.name}`;
  const zone = await tariffColumnOf(truck.originId);
  if (!zone) throw new CostError('freight_no_column', { warehouse });
  const made = copyDraft(zone, await tariffHistory(), input.costDate, FREIGHT_LIGHT_BELOW, truck.originId);
  if (made.ok) return made.draft;
  const p = made.problem;
  if (p.kind === 'unpriced') {
    throw new CostError('freight_zone_unpriced', { warehouse, column: zone, date: input.costDate });
  }
  if (p.kind === 'gap' && p.to === null) throw new CostError('freight_tariff_top', { column: zone, from: p.from });
  if (p.kind === 'gap') throw new CostError('freight_tariff_gap', { column: zone, from: p.from, to: p.to ?? '' });
  if (p.kind === 'overlap') throw new CostError('freight_tariff_overlap', { column: zone, at: p.at });
  throw new CostError('freight_tariff_invalid', { column: zone });
}

