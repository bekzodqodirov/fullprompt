import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import { batches, boxes, boxMovements, crates, loadPlans, receiptLots, scanEvents } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import {
  COUNT_LOAD_REASON,
  countOnlyLotsOnTruck,
  countedOnTruckSql,
  lockTruckLoading,
  setCountLockTimeout,
} from './count-rules';
import { doorOpens, type CountDoor } from './count-door';
import { loadScanInTx } from './service';
import { aboardFilter } from './unload';
import { planCountMove, shelfStatus, type CountRow } from './count-plan';
import { qrlessRowSql } from '../labels/qrless-sql';
import { codeIdentity } from '../labels/code-identity';
import {
  GROW_LOT_MAX,
  GrowLotError,
  afterLotGrown,
  grownCodesOnTruck,
  growLotInTx,
  shrinkGrownInTx,
} from '../receipts/grow-lot';
import { likeNeedle } from '../search/query';

/*
 * «Sanab yuklash» — the office's count-load door (0112, the owner's Q1-Q7).
 *
 * Cartons that never got our sticker cannot be scanned onto a truck, so the
 * logist or the admin (Q3: `plans.manage` at the origin, the kernel's
 * `CountDoor`) types how many of a lot went on — and the system moves exactly
 * that many cartons, each one through the SAME body a phone's scan goes
 * through (`loadScanInTx`). Movements, scan events, the plan's flip to
 * «loading», the ⚠ mark on a carton beyond the plan and every cost that reads
 * them cannot tell a counted carton from a scanned one; the reason
 * `count_load` on its scan event is the one difference, and it is what makes
 * the lot the office's on this truck (Q4).
 *
 * One press is ONE transaction: the truck lock, then the lot's cartons in id
 * order, then a fresh read of them — so the number is computed under the very
 * locks the writes run under, and «48» is either all true or none of it.
 */

/** Everything a press posts. `seenAboard` is what the office was looking at. */
export const countLoadSchema = z.object({
  batchId: z.string().uuid(),
  lotId: z.string().uuid(),
  target: z.coerce.number().int().min(0).max(10000),
  seenAboard: z.coerce.number().int().min(0).max(100000),
  pressId: z.string().uuid(),
  overReason: z.string().trim().max(500).optional().or(z.literal('')),
});
export type CountLoadInput = z.infer<typeof countLoadSchema>;

export const countCrateSchema = z.object({
  batchId: z.string().uuid(),
  crateId: z.string().uuid(),
  pressId: z.string().uuid(),
});
export type CountCrateInput = z.infer<typeof countCrateSchema>;

export const COUNT_LOAD_ERRORS = [
  'forbidden',
  'batch_not_found',
  'batch_not_loading',
  'lot_not_found',
  'lot_not_here',
  'count_stale',
  'over_reason_required',
  'grow_too_many',
  'grow_refused',
  'count_conflict',
  'crate_not_found',
  'crate_not_on_plan',
  'crate_not_here',
] as const;
export type CountLoadErrorCode = (typeof COUNT_LOAD_ERRORS)[number];

export interface CountErrorDetail {
  /** `count_stale`: what is aboard NOW, so the screen can say it. */
  current?: number;
  /** `over_reason_required`: the plan's number (null on a quick truck) and what stock holds. */
  plan?: number | null;
  stock?: number;
  /** `grow_too_many`: the most one press may add to a prixod. */
  max?: number;
  /** `grow_refused`: the prixod's own refusal. */
  reason?: string;
}

export class CountError extends Error {
  constructor(
    public readonly code: CountLoadErrorCode,
    public readonly detail: CountErrorDetail = {},
  ) {
    super(code);
  }
}

export interface CountLoadResult {
  lotId: string;
  lot: string;
  before: number;
  aboard: number;
  plan: number | null;
  /** Loaded within the plan (or plainly, on a quick truck). */
  added: number;
  /** Loaded beyond the plan, the ⚠ mark on each. */
  over: number;
  /** Cartons added to the PRIXOD (Q3 = b) and loaded. */
  grown: number;
  /** An earlier growth on this truck taken back out of the prixod (voided). */
  shrunk: number;
  removed: number;
  phoneScanned: number;
  unchanged: boolean;
}

/** How many codes one audit row names per list; the count is always whole. */
const AUDIT_CODES = 500;

/**
 * «This lot's cartons this press may touch» (alias `b`): the loose ones on
 * this truck, reserved or aboard, and the loose ones on the shelf at the
 * truck's origin. Never a crate — a crate is one place and moves by its own
 * code (decision 24).
 */
function candidatesSql(alias: string, batchId: string, lotId: string, originId: string): SQL {
  const b = sql.raw(alias);
  return sql`${b}.lot_id = ${lotId}::uuid AND ${b}.crate_id IS NULL AND ${b}.status <> 'void'
    AND ((${b}.current_batch_id = ${batchId}::uuid AND ${b}.status IN ('planned', 'loading'))
      OR (${b}.current_batch_id IS NULL AND ${b}.current_warehouse_id = ${originId}::uuid
          AND ${b}.status IN ('in_stock', 'ready_for_pickup')))`;
}

/**
 * The carton's latest load event on this truck is the office's count (alias
 * `b`) — what separates «ofis sanadi» from «telefonda skanerlangan» on one
 * lot, since his Q1 = b lets both stand side by side.
 */
function byCountSql(alias: string, batchId: string): SQL {
  const b = sql.raw(alias);
  return sql`COALESCE((
    SELECT bse.manual_reason = ${COUNT_LOAD_REASON} AND bse.crate_id IS NULL
      FROM scan_events bse
     WHERE bse.box_id = ${b}.id AND bse.batch_id = ${batchId}::uuid AND bse.type = 'load'
     ORDER BY bse.created_at DESC, bse.scanned_at DESC
     LIMIT 1
  ), false)`;
}

/** The approved plan's loose number for this lot on this truck (0 when the lot is not on it). */
async function planNumber(exec: Db | Tx, batchId: string, lotId: string): Promise<number> {
  const rows = (await exec.execute(sql`
    SELECT coalesce(sum(pl.planned_box_count), 0)::int AS n
      FROM load_plan_lines pl
      JOIN load_plan_versions pv ON pv.id = pl.version_id
      JOIN load_plans p ON p.id = pv.plan_id
     WHERE p.batch_id = ${batchId}::uuid AND pl.lot_id = ${lotId}::uuid AND pl.crate_id IS NULL
       AND pv.agent_verdict = 'approved'
       AND pv.version_no = (
         SELECT max(v2.version_no) FROM load_plan_versions v2
          WHERE v2.plan_id = p.id AND v2.agent_verdict = 'approved'
       )
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

/** The lot's label as every screen prints it («GS777-A»), with its goods. */
async function lotLabel(exec: Db | Tx, lotId: string) {
  const rows = (await exec.execute(sql`
    SELECT l.id, l.receipt_id, l.letter, l.product_name_zh, l.product_name_ru,
           r.unclaimed_marking AS marking, c.client_code
      FROM receipt_lots l
      JOIN receipts r ON r.id = l.receipt_id
      LEFT JOIN clients c ON c.id = r.client_id
     WHERE l.id = ${lotId}::uuid
  `)) as unknown as {
    id: string;
    receipt_id: string;
    letter: string | null;
    product_name_zh: string;
    product_name_ru: string | null;
    marking: string | null;
    client_code: string | null;
  }[];
  const row = rows[0];
  if (!row) return null;
  const identity = codeIdentity(row.marking, row.client_code);
  return {
    receiptId: row.receipt_id,
    label: `${identity.main}-${row.letter ?? '?'}`,
    sub: identity.sub,
    product: row.product_name_ru || row.product_name_zh,
    productZh: row.product_name_zh,
  };
}

/** The lot's cartons as the planner reads them, fresh, AFTER the locks are held. */
async function countRows(
  tx: Tx,
  batchId: string,
  lotId: string,
  originId: string,
  grownHere: ReadonlySet<string>,
): Promise<CountRow[]> {
  const rows = (await tx.execute(sql`
    SELECT b.id, b.short_code, b.seq_in_lot, b.status, (b.label_printed_at IS NULL) AS unlabelled,
           (b.current_batch_id IS NOT DISTINCT FROM ${batchId}::uuid) AS on_truck,
           (b.flags @> '["added_on_spot"]'::jsonb) AS over,
           ${byCountSql('b', batchId)} AS by_count,
           ${qrlessRowSql(sql`b`, sql`l`)} AS qrless,
           (SELECT m.from_status FROM box_movements m
             WHERE m.box_id = b.id AND m.ref_type = 'batch' AND m.ref_id = ${batchId}::uuid
               AND m.cause IN ('load_scan', 'loaded_on_spot')
             ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS loaded_from
      FROM boxes b
      JOIN receipt_lots l ON l.id = b.lot_id
     WHERE ${candidatesSql('b', batchId, lotId, originId)}
     ORDER BY b.id
  `)) as unknown as {
    id: string;
    short_code: string;
    seq_in_lot: number;
    status: CountRow['status'];
    on_truck: boolean;
    over: boolean;
    by_count: boolean;
    qrless: boolean;
    loaded_from: string | null;
    unlabelled: boolean;
  }[];
  return rows.map((r) => ({
    id: r.id,
    shortCode: r.short_code,
    seq: Number(r.seq_in_lot),
    status: r.status,
    onTruck: r.on_truck,
    over: r.over,
    byCount: r.by_count,
    qrless: r.qrless,
    loadedFrom: r.loaded_from,
    // Minted by a count press on THIS truck and never printed: its inverse
    // is a void and a smaller lot, never a shelf (review money-3).
    grown: grownHere.has(r.short_code) && r.unlabelled,
  }));
}

async function aboardCount(tx: Tx, batchId: string, lotId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM boxes
     WHERE lot_id = ${lotId}::uuid AND crate_id IS NULL
       AND current_batch_id = ${batchId}::uuid AND status = 'loading'
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

const capCodes = (codes: string[]) => codes.slice(0, AUDIT_CODES);

/**
 * «N of this lot are on the truck» — the office's press (decision 10: a
 * TOTAL with a compare-and-set, never «add N»).
 *
 * The same number twice is a no-op with no audit and no write; a number typed
 * over a screen that no longer shows the truck (`seenAboard` ≠ what is
 * aboard) is refused `count_stale` with the truth, so a stale press re-sent
 * from a second tab cannot undo a correction.
 */
export async function countLoadLot(
  input: CountLoadInput,
  ctx: AuditContext,
  door: CountDoor,
): Promise<CountLoadResult> {
  const actorId = ctx.actorId;
  if (!actorId) throw new CountError('forbidden');
  const batchId = input.batchId;
  const lotId = input.lotId;

  const result = await db.transaction(async (tx) => {
    await setCountLockTimeout(tx);
    await lockTruckLoading(tx, batchId);
    const batch = await tx.query.batches.findFirst({ where: eq(batches.id, batchId) });
    if (!batch) throw new CountError('batch_not_found');
    // The door must be THIS person's, at THIS truck's origin — a door minted
    // for another warehouse or another request opens nothing (#790).
    if (!doorOpens(door, batch.originWarehouseId, actorId)) throw new CountError('forbidden');
    if (!['forming', 'loading'].includes(batch.status)) throw new CountError('batch_not_loading');
    const lot = await lotLabel(tx, lotId);
    if (!lot) throw new CountError('lot_not_found');
    const originId = batch.originWarehouseId;
    const hasPlan = !!(await tx.query.loadPlans.findFirst({ where: eq(loadPlans.batchId, batchId) }));
    const planN = hasPlan ? await planNumber(tx, batchId, lotId) : 0;

    // The lot row before its cartons — the order the receipt card's switch
    // and the lot form take them in; a growth locks it too, and taking it
    // after the cartons deadlocked with those two doors (review lock-3).
    await tx.select({ id: receiptLots.id }).from(receiptLots).where(eq(receiptLots.id, lotId)).for('update');
    // Lock the lot's cartons in id order, THEN read them afresh: a phone
    // holding one of them makes this wait, and a statement that waited sees
    // the row it waited for but not what its own subqueries read before the
    // wait (decision 23) — so the numbers come from a second statement.
    await tx.execute(sql`
      SELECT b.id FROM boxes b
       WHERE ${candidatesSql('b', batchId, lotId, originId)}
       ORDER BY b.id
       FOR UPDATE
    `);
    const grownHere = await grownCodesOnTruck(tx, { receiptId: lot.receiptId, lotId, batchId });
    const rows = await countRows(tx, batchId, lotId, originId, grownHere);
    const before = rows.filter((r) => r.onTruck && r.status === 'loading').length;
    const phoneBefore = rows.filter((r) => r.onTruck && r.status === 'loading' && !r.byCount).length;
    const unchanged = (): CountLoadResult => ({
      lotId,
      lot: lot.label,
      before,
      aboard: before,
      plan: hasPlan ? planN : null,
      added: 0,
      over: 0,
      grown: 0,
      shrunk: 0,
      removed: 0,
      phoneScanned: phoneBefore,
      unchanged: true,
    });
    if (input.target === before) return unchanged();
    if (input.seenAboard !== before) throw new CountError('count_stale', { current: before });
    // A lot with nothing on this truck and nothing on the origin's shelf is
    // not this press's to count — and certainly not to grow from nothing.
    if (rows.length === 0) throw new CountError('lot_not_here');

    const move = planCountMove(rows, input.target, {
      hasPlan,
      planN,
      overReason: input.overReason,
      growMax: GROW_LOT_MAX,
    });
    if (move.kind === 'refuse') {
      throw new CountError(
        move.code,
        move.code === 'over_reason_required' ? { plan: move.plan, stock: move.stock } : { max: move.max },
      );
    }

    const reason = input.overReason?.trim() ?? '';
    const scannedAt = new Date().toISOString();
    // Every carton through the phone's own body, one event id per carton per
    // PRESS — a replay inside a press is a conflict, never a success (#11).
    const load = async (box: { id: string; shortCode: string }, over: boolean) => {
      const ack = await loadScanInTx(
        tx,
        {
          clientEventUuid: uuidv5(`load:${box.id}`, input.pressId),
          batchId,
          code: box.shortCode,
          method: 'manual',
          manualReason: COUNT_LOAD_REASON,
          addedOnSpot: over,
          addedReason: over ? reason : '',
          scannedAt,
        },
        actorId,
        { door: COUNT_LOAD_REASON, boxId: box.id, quietSpot: true },
      );
      if (ack.result !== 'ok' || ack.detail === 'replay') throw new CountError('count_conflict');
    };

    // The plan counted these, and «yuklash tugadi» or a removal gave them back
    // to the shelf: reserved onto the truck again, as the approval did.
    if (move.reReserve.length > 0) {
      await tx
        .update(boxes)
        .set({ status: 'planned', currentBatchId: batchId })
        .where(inArray(boxes.id, move.reReserve.map((r) => r.id)));
      await tx.insert(boxMovements).values(
        move.reReserve.map((r) => ({
          boxId: r.id,
          fromWarehouseId: originId,
          toWarehouseId: originId,
          fromStatus: r.status,
          toStatus: 'planned',
          cause: 'plan_approved',
          refType: 'batch',
          refId: batchId,
          actorId,
        })),
      );
    }
    for (const row of [...move.load, ...move.reReserve, ...move.loadSpare]) await load(row, false);
    for (const row of move.loadOver) await load(row, true);

    // More cartons than the prixod ever listed (Q3 = b): the lot grows by
    // exactly the missing number, born at this origin with the press's
    // reason — the lot's row lock taken AFTER the cartons' (decision 23) —
    // and the new cartons ride beyond the plan like any other extra.
    let grown: { id: string; shortCode: string }[] = [];
    if (move.grow > 0) {
      try {
        grown = (
          await growLotInTx(tx, {
            lotId,
            add: move.grow,
            warehouseId: originId,
            actorId,
            reason,
            batchId,
            side: 'load',
          })
        ).boxes;
      } catch (error) {
        if (error instanceof GrowLotError) throw new CountError('grow_refused', { reason: error.code });
        throw error;
      }
      for (const box of grown) await load(box, true);
    }

    // Down: the truck's reservation kept for a planned carton (the dial is
    // reversible with no false ⚠); everything else back to where it stood.
    // Scan events are never deleted — they are the history of the press.
    if (move.backToPlan.length > 0) {
      await tx
        .update(boxes)
        .set({ status: 'planned' })
        .where(inArray(boxes.id, move.backToPlan.map((r) => r.id)));
      await tx.insert(boxMovements).values(
        move.backToPlan.map((r) => ({
          boxId: r.id,
          fromWarehouseId: originId,
          toWarehouseId: originId,
          fromStatus: 'loading',
          toStatus: 'planned',
          cause: 'load_removed',
          refType: 'batch',
          refId: batchId,
          actorId,
        })),
      );
    }
    for (const status of ['in_stock', 'ready_for_pickup'] as const) {
      const home = move.backToShelf.filter((r) => shelfStatus(r.loadedFrom) === status);
      if (home.length === 0) continue;
      await tx
        .update(boxes)
        .set({ status, currentBatchId: null, flags: [] })
        .where(inArray(boxes.id, home.map((r) => r.id)));
      await tx.insert(boxMovements).values(
        home.map((r) => ({
          boxId: r.id,
          fromWarehouseId: originId,
          toWarehouseId: originId,
          fromStatus: 'loading',
          toStatus: status,
          cause: 'load_removed',
          refType: 'batch',
          refId: batchId,
          actorId,
        })),
      );
    }

    // The prixod's own growth, taken back: voided, and the lot shrinks by
    // exactly those cartons (review money-3) — a dial past the stock and
    // back lands on the lot it started from, in kg, m³ and money.
    let shrunk: string[] = [];
    if (move.shrink.length > 0) {
      try {
        shrunk = (
          await shrinkGrownInTx(tx, {
            lotId,
            boxIds: move.shrink.map((r) => r.id),
            actorId,
            reason: reason || 'ofis sonni kamaytirdi',
            batchId,
            side: 'load',
          })
        ).codes;
      } catch (error) {
        if (error instanceof GrowLotError) throw new CountError('grow_refused', { reason: error.code });
        throw error;
      }
    }

    // A press that only goes DOWN is a count too (his Q1 = b: after the
    // office's number the phone does not touch the lot). The up path writes
    // its count events through the phone's own body; the down path wrote
    // none, so a first press of «2» over three phone-scanned cartons left the
    // lot un-counted and the phone could scan the carton back on or take
    // others off (review cargo-3). One event per carton taken off — the
    // history Q5 asks for, and the stocktake's count-moved guard for it.
    const takenOff = [...move.backToPlan, ...move.backToShelf];
    if (takenOff.length > 0) {
      await tx.insert(scanEvents).values(
        takenOff.map((r) => ({
          clientEventUuid: uuidv5(`load-off:${r.id}`, input.pressId),
          boxId: r.id,
          batchId,
          type: 'load',
          method: 'manual',
          manualReason: COUNT_LOAD_REASON,
          addedOnSpot: false,
          scannedBy: actorId,
          scannedAt: new Date(scannedAt),
        })),
      );
    }

    // The number the office typed is now the truth, or nothing happened.
    if ((await aboardCount(tx, batchId, lotId)) !== input.target) throw new CountError('count_conflict');

    const overCodes = [...move.loadOver.map((r) => r.shortCode), ...grown.map((b) => b.shortCode)];
    if (overCodes.length > 0) {
      // ONE alarm for the whole press, never one per carton, and never to the
      // person who pressed it (0112, decision 13 / 27).
      await emitEvent(tx, {
        type: 'BoxScannedOnLoad',
        payload: {
          batchId,
          batchCode: batch.code,
          addedOnSpot: true,
          countLoad: true,
          presserId: actorId,
          reason: grown.length > 0 ? `${reason} · prixodga +${grown.length}` : reason,
          shortCodes: overCodes,
          lot: { label: lot.label, product: lot.product, n: overCodes.length },
          grown: grown.length,
        },
        entityType: 'batch',
        entityId: batchId,
        actorId,
      });
    }
    const plainCodes = [...move.load, ...move.reReserve, ...move.loadSpare].map((r) => r.shortCode);
    const removedCodes = [...move.backToPlan, ...move.backToShelf, ...move.shrink].map((r) => r.shortCode);
    await writeAudit(tx, { ...ctx, warehouseId: originId }, {
      entityType: 'batch',
      entityId: batchId,
      action: 'update',
      before: { countLoad: { lotId, aboard: before } },
      after: {
        countLoad: {
          lotId,
          lot: lot.label,
          pressId: input.pressId,
          target: input.target,
          aboard: input.target,
          plan: hasPlan ? planN : null,
          scannedByPhone: move.phoneScanned,
          added: capCodes(plainCodes),
          addedOver: capCodes(move.loadOver.map((r) => r.shortCode)),
          grown: capCodes(grown.map((b) => b.shortCode)),
          shrunk: capCodes(shrunk),
          reReserved: capCodes(move.reReserve.map((r) => r.shortCode)),
          removed: capCodes(removedCodes),
          overReason: reason || null,
          codesCapped: Math.max(plainCodes.length, overCodes.length, removedCodes.length) > AUDIT_CODES,
        },
      },
    });
    return {
      lotId,
      lot: lot.label,
      before,
      aboard: input.target,
      plan: hasPlan ? planN : null,
      added: plainCodes.length,
      over: move.loadOver.length,
      grown: grown.length,
      shrunk: shrunk.length,
      removed: removedCodes.length,
      phoneScanned: move.phoneScanned,
      unchanged: false,
    } satisfies CountLoadResult;
  });
  // The lot's cartons changed, so every cost shared over them re-splits —
  // after the commit, on the pool (#714).
  if (result.grown > 0 || result.shrunk > 0) await afterLotGrown(lotId);
  return result;
}

export interface CountCrateResult {
  code: string;
  loaded: number;
  unplanned: string[];
  unchanged: boolean;
}

/**
 * «Yuklash (1 joy)» — a crate on the count panel. A crate is ONE place with
 * its own CR- label, so the office presses it as the crate, through the
 * phone's crate branch; its events never make a lot «counted» (decision 24).
 */
export async function countLoadCrate(
  input: CountCrateInput,
  ctx: AuditContext,
  door: CountDoor,
): Promise<CountCrateResult> {
  const actorId = ctx.actorId;
  if (!actorId) throw new CountError('forbidden');
  return db.transaction(async (tx) => {
    await setCountLockTimeout(tx);
    await lockTruckLoading(tx, input.batchId);
    const batch = await tx.query.batches.findFirst({ where: eq(batches.id, input.batchId) });
    if (!batch) throw new CountError('batch_not_found');
    if (!doorOpens(door, batch.originWarehouseId, actorId)) throw new CountError('forbidden');
    if (!['forming', 'loading'].includes(batch.status)) throw new CountError('batch_not_loading');
    const crate = await tx.query.crates.findFirst({ where: eq(crates.id, input.crateId) });
    if (!crate || crate.status !== 'active') throw new CountError('crate_not_found');
    const ack = await loadScanInTx(
      tx,
      {
        clientEventUuid: uuidv5(`load:${crate.id}`, input.pressId),
        batchId: input.batchId,
        code: crate.code,
        method: 'manual',
        manualReason: COUNT_LOAD_REASON,
        addedOnSpot: false,
        addedReason: '',
        scannedAt: new Date().toISOString(),
      },
      actorId,
      { door: COUNT_LOAD_REASON, quietSpot: true },
    );
    if (ack.result === 'duplicate') {
      return { code: crate.code, loaded: 0, unplanned: ack.unplanned ?? [], unchanged: true };
    }
    if (ack.result === 'not_on_plan') throw new CountError('crate_not_on_plan');
    if (ack.result === 'unknown_code') throw new CountError('crate_not_found');
    if (ack.result !== 'ok' || ack.detail === 'replay') {
      throw new CountError(ack.result === 'rejected' ? 'crate_not_here' : 'count_conflict');
    }
    const aboard = await tx
      .select({ shortCode: boxes.shortCode })
      .from(boxes)
      .where(
        and(
          eq(boxes.crateId, crate.id),
          eq(boxes.currentBatchId, input.batchId),
          eq(boxes.status, 'loading'),
        ),
      );
    await writeAudit(tx, { ...ctx, warehouseId: batch.originWarehouseId }, {
      entityType: 'batch',
      entityId: input.batchId,
      action: 'update',
      after: {
        countLoadCrate: {
          crateCode: crate.code,
          pressId: input.pressId,
          aboard: capCodes(aboard.map((b) => b.shortCode)),
          unplanned: capCodes(ack.unplanned ?? []),
        },
      },
    });
    return { code: crate.code, loaded: aboard.length, unplanned: ack.unplanned ?? [], unchanged: false };
  });
}

// ---------------------------------------------------------------------------
// What the batch card shows the office — pooled reads, never inside a press.
// ---------------------------------------------------------------------------

export type CountPanelMode = 'counted' | 'qrless' | 'scanning' | 'none';

export interface CountPanelRow {
  lotId: string;
  label: string;
  sub: string | null;
  product: string;
  /** The approved plan's loose number; null on a quick truck. */
  plan: number | null;
  aboard: number;
  phoneScanned: number;
  over: number;
  reserved: number;
  /** Loose on the origin's shelf — what the count can still take. */
  spare: number;
  mode: CountPanelMode;
  /** Who counted it last, and when (the audit's own row — Q5: no second proof). */
  lastCount: { name: string | null; at: string } | null;
}

export interface CountPanelCrate {
  crateId: string;
  code: string;
  boxes: number;
  aboard: number;
}

/**
 * The count panel: every lot that touches this truck — reserved or aboard,
 * or counted onto it before (a lot dialled to 0 is still the office's) — and
 * the crates riding it. Five small reads, only for a door holder, only while
 * the truck is loading.
 */
export async function countLoadPanel(batch: {
  id: string;
  originWarehouseId: string;
}): Promise<{ rows: CountPanelRow[]; crates: CountPanelCrate[]; quick: boolean }> {
  const batchId = batch.id;
  const quick = !(await db.query.loadPlans.findFirst({ where: eq(loadPlans.batchId, batchId) }));
  const counted = await countOnlyLotsOnTruck(db, {
    batchId,
    side: 'load',
    countedSide: 'load',
    quickOriginId: null,
  });
  const onTruck = (await db.execute(sql`
    SELECT DISTINCT lot_id FROM boxes
     WHERE current_batch_id = ${batchId}::uuid AND crate_id IS NULL AND status IN ('planned', 'loading')
  `)) as unknown as { lot_id: string }[];
  const lotIds = [...new Set([...onTruck.map((r) => r.lot_id), ...counted.keys()])];

  const crateRows = (await db.execute(sql`
    SELECT cr.id, cr.code, count(*)::int AS boxes,
           count(*) FILTER (WHERE b.status = 'loading')::int AS aboard
      FROM boxes b JOIN crates cr ON cr.id = b.crate_id
     WHERE b.current_batch_id = ${batchId}::uuid AND b.status IN ('planned', 'loading')
     GROUP BY cr.id, cr.code
     ORDER BY cr.code
  `)) as unknown as { id: string; code: string; boxes: number; aboard: number }[];
  const cratesOut = crateRows.map((c) => ({
    crateId: c.id,
    code: c.code,
    boxes: Number(c.boxes),
    aboard: Number(c.aboard),
  }));
  if (lotIds.length === 0) return { rows: [], crates: cratesOut, quick };

  const idList = sql.join(
    lotIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const lots = (await db.execute(sql`
    SELECT l.id AS lot_id, l.letter, l.product_name_zh, l.product_name_ru,
           r.unclaimed_marking AS marking, c.client_code,
           count(b.id) FILTER (WHERE b.current_batch_id = ${batchId}::uuid AND b.status = 'planned')::int AS reserved,
           count(b.id) FILTER (WHERE b.current_batch_id = ${batchId}::uuid AND b.status = 'loading')::int AS aboard,
           count(b.id) FILTER (WHERE b.current_batch_id = ${batchId}::uuid AND b.status = 'loading'
                                 AND b.flags @> '["added_on_spot"]'::jsonb)::int AS over,
           count(b.id) FILTER (WHERE b.current_batch_id = ${batchId}::uuid AND b.status = 'loading'
                                 AND NOT ${byCountSql('b', batchId)})::int AS phone,
           count(b.id) FILTER (WHERE b.current_batch_id IS NULL)::int AS spare,
           coalesce(bool_or(${qrlessRowSql(sql`b`, sql`l`)} AND b.current_batch_id IS NOT NULL), false) AS qrless_truck,
           coalesce(bool_or(${qrlessRowSql(sql`b`, sql`l`)} AND b.current_batch_id IS NULL), false) AS qrless_shelf
      FROM receipt_lots l
      JOIN receipts r ON r.id = l.receipt_id
      LEFT JOIN clients c ON c.id = r.client_id
      LEFT JOIN boxes b ON b.lot_id = l.id
        AND b.crate_id IS NULL AND b.status <> 'void'
        AND ((b.current_batch_id = ${batchId}::uuid AND b.status IN ('planned', 'loading'))
          OR (b.current_batch_id IS NULL AND b.current_warehouse_id = ${batch.originWarehouseId}::uuid
              AND b.status IN ('in_stock', 'ready_for_pickup')))
     WHERE l.id IN (${idList})
     GROUP BY l.id, r.unclaimed_marking, c.client_code
     ORDER BY l.letter
  `)) as unknown as {
    lot_id: string;
    letter: string | null;
    product_name_zh: string;
    product_name_ru: string | null;
    marking: string | null;
    client_code: string | null;
    reserved: number;
    aboard: number;
    over: number;
    phone: number;
    spare: number;
    qrless_truck: boolean;
    qrless_shelf: boolean;
  }[];

  const plans = quick
    ? new Map<string, number>()
    : new Map(
        (
          (await db.execute(sql`
            SELECT pl.lot_id, sum(pl.planned_box_count)::int AS n
              FROM load_plan_lines pl
              JOIN load_plan_versions pv ON pv.id = pl.version_id
              JOIN load_plans p ON p.id = pv.plan_id
             WHERE p.batch_id = ${batchId}::uuid AND pl.crate_id IS NULL AND pv.agent_verdict = 'approved'
               AND pv.version_no = (
                 SELECT max(v2.version_no) FROM load_plan_versions v2
                  WHERE v2.plan_id = p.id AND v2.agent_verdict = 'approved'
               )
             GROUP BY pl.lot_id
          `)) as unknown as { lot_id: string; n: number }[]
        ).map((r) => [r.lot_id, Number(r.n)]),
      );

  // The latest press per lot — raw `execute` answers timestamps as TEXT, so
  // the screen parses them (#923's lesson).
  const last = new Map(
    (
      (await db.execute(sql`
        SELECT DISTINCT ON (a.after->'countLoad'->>'lotId')
               a.after->'countLoad'->>'lotId' AS lot_id, a.created_at, u.full_name
          FROM audit_log a
          LEFT JOIN users u ON u.id = a.actor_id
         WHERE a.entity_type = 'batch' AND a.entity_id = ${batchId}::uuid
           AND a.after ? 'countLoad'
         ORDER BY a.after->'countLoad'->>'lotId', a.created_at DESC
      `)) as unknown as { lot_id: string; created_at: string; full_name: string | null }[]
    ).map((r) => [r.lot_id, { name: r.full_name, at: String(r.created_at) }]),
  );

  const rows = lots.map((l): CountPanelRow => {
    const identity = codeIdentity(l.marking, l.client_code);
    const mode: CountPanelMode =
      counted.get(l.lot_id) === 'counted'
        ? 'counted'
        : l.qrless_truck || (quick && l.qrless_shelf)
          ? 'qrless'
          : Number(l.phone) > 0
            ? 'scanning'
            : 'none';
    return {
      lotId: l.lot_id,
      label: `${identity.main}-${l.letter ?? '?'}`,
      sub: identity.sub,
      product: l.product_name_ru || l.product_name_zh,
      plan: quick ? null : (plans.get(l.lot_id) ?? 0),
      aboard: Number(l.aboard),
      phoneScanned: Number(l.phone),
      over: Number(l.over),
      reserved: Number(l.reserved),
      spare: Number(l.spare),
      mode,
      lastCount: last.get(l.lot_id) ?? null,
    };
  });
  return { rows, crates: cratesOut, quick };
}

export interface CountableLot {
  lotId: string;
  label: string;
  sub: string | null;
  product: string;
  spare: number;
  qrless: boolean;
  photoId: string | null;
}

/** How many lots the picker lists at most — said when it bites (#758). */
export const COUNTABLE_LOTS_CAP = 300;

/**
 * The picker: lots with loose cartons on the origin's shelf that do not yet
 * touch this truck — how a quick truck, or an extra lot on a planned one,
 * reaches the count. Lot-level, so the scan screen's 1,500-row box list
 * cap does not apply; oldest prixod first, as the plan editor lists them.
 */
export async function countableLotsAt(
  batch: { id: string; originWarehouseId: string },
  q?: string,
): Promise<{ lots: CountableLot[]; total: number }> {
  const needle = q?.trim() ? likeNeedle(q.trim()) : null;
  const rows = (await db.execute(sql`
    SELECT l.id AS lot_id, l.letter, l.product_name_zh, l.product_name_ru,
           r.unclaimed_marking AS marking, c.client_code,
           count(*)::int AS spare,
           coalesce(bool_or(${qrlessRowSql(sql`b`, sql`l`)}), false) AS qrless,
           (SELECT a.id FROM attachments a
             WHERE a.entity_type = 'receipt_lot' AND a.entity_id = l.id AND a.kind = 'photo'
             ORDER BY a.created_at LIMIT 1) AS photo_id,
           count(*) OVER ()::int AS total
      FROM boxes b
      JOIN receipt_lots l ON l.id = b.lot_id
      JOIN receipts r ON r.id = l.receipt_id
      LEFT JOIN clients c ON c.id = r.client_id
     WHERE b.current_warehouse_id = ${batch.originWarehouseId}::uuid
       AND b.current_batch_id IS NULL AND b.crate_id IS NULL
       AND b.status IN ('in_stock', 'ready_for_pickup')
       AND NOT EXISTS (
         SELECT 1 FROM boxes tb WHERE tb.lot_id = l.id AND tb.current_batch_id = ${batch.id}::uuid
       )
       AND NOT ${countedOnTruckSql(batch.id, sql`l.id`, 'load')}
       ${
         needle
           ? sql`AND (c.client_code ILIKE ${needle} OR r.unclaimed_marking ILIKE ${needle}
                OR l.product_name_zh ILIKE ${needle} OR l.product_name_ru ILIKE ${needle}
                OR (coalesce(r.unclaimed_marking, c.client_code) || '-' || l.letter) ILIKE ${needle}
                OR (c.client_code || '-' || l.letter) ILIKE ${needle})`
           : sql``
       }
     GROUP BY l.id, r.id, c.client_code
     ORDER BY r.received_at, l.letter
     LIMIT ${COUNTABLE_LOTS_CAP}
  `)) as unknown as {
    lot_id: string;
    letter: string | null;
    product_name_zh: string;
    product_name_ru: string | null;
    marking: string | null;
    client_code: string | null;
    spare: number;
    qrless: boolean;
    photo_id: string | null;
    total: number;
  }[];
  return {
    total: Number(rows[0]?.total ?? 0),
    lots: rows.map((r) => {
      const identity = codeIdentity(r.marking, r.client_code);
      return {
        lotId: r.lot_id,
        label: `${identity.main}-${r.letter ?? '?'}`,
        sub: identity.sub,
        product: r.product_name_ru || r.product_name_zh,
        spare: Number(r.spare),
        qrless: r.qrless,
        photoId: r.photo_id,
      };
    }),
  };
}

/**
 * The header's «🔢 N sanab»: cartons of the lots the office counted onto this
 * truck that ride it now — before departure and after (the truck's real
 * cargo, `aboard`), with the lot ids the loaded-box list groups by.
 */
export async function countedOnTruck(batchId: string): Promise<{ cartons: number; lotIds: string[] }> {
  const counted = await countOnlyLotsOnTruck(db, {
    batchId,
    side: 'load',
    countedSide: 'load',
    quickOriginId: null,
  });
  const lotIds = [...counted.entries()].filter(([, mode]) => mode === 'counted').map(([id]) => id);
  if (lotIds.length === 0) return { cartons: 0, lotIds: [] };
  // Joined on purpose: in a one-table select drizzle writes `boxes.id` bare,
  // and inside the filter's correlated subquery a bare `id` binds to the
  // SUBQUERY's table (#128).
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(boxes)
    .innerJoin(receiptLots, eq(receiptLots.id, boxes.lotId))
    .where(and(inArray(boxes.lotId, lotIds), isNull(boxes.crateId), aboardFilter(batchId)));
  return { cartons: Number(row?.n ?? 0), lotIds };
}
