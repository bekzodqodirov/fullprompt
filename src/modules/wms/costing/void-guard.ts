import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { batches, costEntries, crates } from '../../platform/db/schema';
import { allocateEntry, type AllocationBasis } from './engine';
import { boxDims, scopeBoxIds } from './service';

/**
 * Every live cost that shares money over these lots' boxes: an entry with a
 * share on one of them, the lots' receipts' own costs, and the batch, crate
 * and pickup entries of every truck, crate and factory trip those boxes were
 * part of — including an UNCONVERTED entry, which has no share yet and would
 * split over them the day its rate arrives.
 *
 * The ONE membership (#513): `recomputeForLot` calls it too (#440 — from the
 * ledger that defines it, never the live pointer alone), for a LIST of lots
 * and on a caller's handle, because the two doors that void boxes ask it from
 * inside their own transaction and a receipt correction asks it for every lot
 * at once.
 */
export async function costEntriesTouchingLots(
  lotIds: string[],
  handle: Db | Tx = db,
): Promise<string[]> {
  if (lotIds.length === 0) return [];
  const lots = sql.join(
    lotIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await handle.execute<{ id: string }>(sql`
    WITH lot_boxes AS (SELECT b.id FROM boxes b WHERE b.lot_id IN (${lots}))
    SELECT DISTINCT ce.id
      FROM cost_entries ce
     WHERE ce.voided_at IS NULL
       AND (
         ce.receipt_id IN (SELECT rl.receipt_id FROM receipt_lots rl WHERE rl.id IN (${lots}))
         OR EXISTS (
           SELECT 1 FROM cost_allocations ca JOIN lot_boxes lb ON lb.id = ca.box_id
            WHERE ca.cost_entry_id = ce.id
         )
         OR (ce.scope = 'batch' AND ce.batch_id IN (
           -- Every truck the boxes departed on, or were scanned off without
           -- a load scan (U25 — a rider too, batches/riders.ts).
           SELECT bm.ref_id FROM box_movements bm JOIN lot_boxes lb ON lb.id = bm.box_id
            WHERE bm.cause IN ('batch_departed', 'undocumented_transfer') AND bm.ref_type = 'batch'
         ))
         OR (ce.scope = 'batch' AND ce.batch_id IN (
           SELECT b.current_batch_id FROM boxes b
            WHERE b.lot_id IN (${lots}) AND b.current_batch_id IS NOT NULL
         ))
         OR (ce.scope = 'crate' AND ce.crate_id IN (
           SELECT bm.ref_id FROM box_movements bm JOIN lot_boxes lb ON lb.id = bm.box_id
            WHERE bm.cause = 'crate_packed' AND bm.ref_type = 'crate'
         ))
         OR (ce.scope = 'crate' AND ce.crate_id IN (
           SELECT b.crate_id FROM boxes b WHERE b.lot_id IN (${lots}) AND b.crate_id IS NOT NULL
         ))
         OR (ce.scope = 'pickup' AND ce.pickup_id IN (
           SELECT ps.pickup_id
             FROM receipt_lots rl
             JOIN receipts r ON r.id = rl.receipt_id
             JOIN pickup_stops ps ON ps.id = r.pickup_stop_id
            WHERE rl.id IN (${lots})
         ))
       )
     -- In id order: a re-split walks the list one entry lock at a time, and
     -- the void doors lock the whole list — the same order everywhere.
     ORDER BY ce.id
  `);
  return rows.map((r) => r.id);
}

/**
 * The costs a void may orphan, LOCKED — what `costOrphanedByVoid` judges.
 * Branded so the guard cannot be asked without the lock (a check that reads
 * the base unlocked is the defect this exists for).
 */
export interface LockedCosts {
  readonly ids: string[];
  readonly __locked: true;
}

/**
 * Lock every live cost that shares money over these lots (U20's race). The
 * guard below checks-then-acts: «would this void leave a cost on no box» is
 * read from the rest of the cost's base, and under READ COMMITTED two voids
 * that TOGETHER take a cost's last cargo — the two cartons of one prixod on
 * the box card at once, two duplicate prixods of one crate or one truck —
 * each saw the other's carton still live, both passed, and the money was left
 * on nothing (measured: both 'ok', $400 on zero shares). With the entries
 * locked, the second void waits for the first to commit, reads the base again
 * in its next statement, finds the first carton void and refuses.
 *
 * Taken FIRST in the door's transaction, before its box locks — the order a
 * recompute takes them in (`recomputeEntry` locks the entry, then its INSERT
 * reaches the boxes through their foreign key). Locked the other way round,
 * a door holding a carton and waiting for the entry, against a re-split
 * holding the entry and writing a share onto that carton, is a deadlock; in
 * id order, two voids sharing several costs cannot deadlock each other.
 * A lot's costs are read by its id, which no door changes, so reading them
 * before the box is locked reads the same list. The handle is the door's
 * transaction, passed last — the idiom tests/unit/tx-pool.test.ts reads; a
 * lock taken on the pool would end with its own statement.
 */
export async function lockCostsTouchingLots(
  lotIds: string[],
  tx: Db | Tx = db,
): Promise<LockedCosts> {
  const touching = await costEntriesTouchingLots(lotIds, tx);
  if (touching.length === 0) return { ids: [], __locked: true };
  const locked = await tx
    .select({ id: costEntries.id })
    .from(costEntries)
    .where(inArray(costEntries.id, touching))
    .orderBy(asc(costEntries.id))
    .for('update');
  return { ids: locked.map((row) => row.id), __locked: true };
}

export interface OrphanedCost {
  entryId: string;
  scope: 'receipt' | 'crate' | 'batch';
  /** The crate's or the truck's code, for the sentence that names it. */
  code: string | null;
}

/**
 * Would voiding these boxes leave a live cost splitting onto NOTHING (U20)?
 *
 * A void box is a counting mistake and carries no share anywhere (#530,
 * #849), so every door that voids re-splits afterwards — and where the
 * re-split would find no cargo at all, the money would stay in the P&L on no
 * box, named by no report: the crate fee of a crate whose only prixod was a
 * duplicate, the truck freight of a truck whose only cargo it was, a
 * prixod's own customs after its last live carton. There the door refuses
 * instead, which is `receipt_has_costs`'s rule one scope wider: a warehouse
 * button never voids money (#288/#530), finance does, on the cost panel.
 *
 * Asked INSIDE the door's transaction — its handle passed last, the idiom
 * tests/unit/tx-pool.test.ts reads — over the costs `lockCostsTouchingLots`
 * locked and the boxes the door has locked: the
 * base comes from the ONE definition of a cost's cargo (`scopeBoxIds`) and
 * the split from the ONE splitter, so «would split onto nothing» means what
 * the recompute would actually do — a direct_to_client fee whose client's
 * last box this was is money on nobody too. Judged before and after, so a
 * cost that already split onto nothing (a zero-weight base, a client with no
 * cargo aboard) does not block a void that changes nothing about it.
 *
 * The factory-trip scope is left out on purpose (#1004): a half-received
 * truck is not «money with no cargo», and the annul's empty-scope sweep is
 * kept out of it for the same reason. `factor` is read by the caller on the
 * pool before the transaction opens (#714).
 */
export async function costOrphanedByVoid(
  costs: LockedCosts,
  voidIds: string[],
  factor: number,
  tx: Db | Tx = db,
): Promise<OrphanedCost | null> {
  if (voidIds.length === 0 || costs.ids.length === 0) return null;
  // Read under the lock, so a cost voided while we waited is seen as void.
  const entries = await tx.select().from(costEntries).where(inArray(costEntries.id, costs.ids));
  const gone = new Set(voidIds);
  for (const entry of entries) {
    if (entry.voidedAt) continue;
    if (entry.scope !== 'receipt' && entry.scope !== 'crate' && entry.scope !== 'batch') continue;
    const base = await scopeBoxIds(entry, tx);
    if (!base.some((id) => gone.has(id))) continue;
    const splits = async (boxIds: string[]) => {
      const dims = await boxDims(boxIds, tx);
      const pool = dims.map((d) => ({
        ...d,
        chargeableKg: Math.max(d.weightKg, d.volumeM3 * factor),
      }));
      // Any positive amount answers «is there anything to split onto».
      const shares = allocateEntry(
        { amountUsd: 1, basis: entry.allocationBasis as AllocationBasis, clientId: entry.clientId },
        pool,
      );
      return shares.length > 0;
    };
    if (!(await splits(base))) continue;
    if (await splits(base.filter((id) => !gone.has(id)))) continue;
    let code: string | null = null;
    if (entry.scope === 'crate' && entry.crateId) {
      const [crate] = await tx
        .select({ code: crates.code })
        .from(crates)
        .where(eq(crates.id, entry.crateId));
      code = crate?.code ?? null;
    } else if (entry.scope === 'batch' && entry.batchId) {
      const [batch] = await tx
        .select({ code: batches.code })
        .from(batches)
        .where(eq(batches.id, entry.batchId));
      code = batch?.code ?? null;
    }
    return { entryId: entry.id, scope: entry.scope, code };
  }
  return null;
}
