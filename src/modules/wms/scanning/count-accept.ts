import { cache } from 'react';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { batchTabHref } from '../batches/card-door';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import { batches, boxes, boxMovements, crates, receiptLots, users, warehouses } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { emitEvent } from '../../platform/events/service';
import { isBusyError } from '../../platform/db/errors';
import { ARRIVED_ON_A_TRUCK } from '../documents/arrivals';
import { codeIdentity } from '../labels/code-identity';
import { qrlessJoinedSql } from '../labels/qrless-sql';
import { landedStatusFor } from '../warehouses/landed';
import { byShelf, shelfBefore } from '../boxes/shelf';
import {
  afterLotGrown,
  GROW_LOT_MAX,
  GrowLotError,
  grownCodesOnTruck,
  growLotInTx,
  shrinkGrownInTx,
} from '../receipts/grow-lot';
import { ScanError } from './service';
import { batchMemberFilter, landUnloadInput } from './unload';
import {
  COUNT_ACCEPT_REASON,
  COUNT_OVER_REASON,
  OFFICE_NOTICE_WINDOW_MINUTES,
  countOnlyLotsOnTruck,
  countedOnTruckSql,
  isPhoneScanSql,
  lockLotOnTruck,
  setCountLockTimeout,
} from './count-rules';
import { doorOpens, type CountDoor } from './count-door';
import { notifyPricedCargoGrew, notifyPricedCargoTakenBack } from '../finance/off-truck';

/*
 * «Sanab qabul» — the office's count at unloading (0112, the owner's Q1-Q7).
 *
 * A truck whose cartons carry no sticker of ours (or one the road tore off)
 * cannot be scanned off; the logist or the admin types, per lot, how many
 * cartons came off this truck, and the system picks the cartons. His Q1 (b):
 * the number is the lot's TOTAL here — cartons the phones already scanned
 * INCLUDED — so a lot half-scanned and half-stickerless is finished by one
 * number, and after it the lot is the office's on this truck (the kernel
 * refuses the phone). Nothing is un-landed: a number below what already
 * arrived is refused in words.
 *
 * Every carton lands through the SAME body a phone scan runs
 * (`landUnloadInput`), so movements, scan events, the crate warehouse, the
 * client's single «yukingiz keldi» claim and the rider money cannot tell a
 * count from a scan — only the reason can, and only a server door may write
 * it (Q5: the history is the proof).
 *
 * Beyond the truck (Q3 b): cartons beyond everything the lot has — what is
 * still aboard plus the lot's loose stock at the truck's ORIGIN — GROW THE
 * LOT, minted where the cargo came from and landed as the truck's riders in
 * the same transaction. Never a second prixod.
 *
 * Membership is `batchMemberFilter`'s: this file never names the departure
 * movement, so there is one sentence for «rode this truck» (#513).
 */

export const countAcceptSchema = z.object({
  batchId: z.string().uuid(),
  lotId: z.string().uuid(),
  target: z.coerce.number().int().min(1).max(10_000),
  seenArrived: z.coerce.number().int().min(0).max(100_000),
  pressId: z.string().uuid(),
  overReason: z.string().trim().max(500).optional().or(z.literal('')),
  confirmArrival: z.boolean().default(false),
  /**
   * The destination the panel was rendered for (the reroute round): the
   * action authorizes and mints its door THERE, so a stale page's press on a
   * truck rerouted since is refused `batch_rerouted` in words — never landed
   * at the new warehouse by an unscoped logist, never «Ruxsat yo'q».
   */
  seenDestWarehouseId: z.string().uuid().optional(),
});
export type CountAcceptInput = z.infer<typeof countAcceptSchema>;

export const countAcceptCrateSchema = z.object({
  batchId: z.string().uuid(),
  crateId: z.string().uuid(),
  pressId: z.string().uuid(),
  confirmArrival: z.boolean().default(false),
  /** As on the lot press. */
  seenDestWarehouseId: z.string().uuid().optional(),
});
export type CountAcceptCrateInput = z.infer<typeof countAcceptCrateSchema>;

/**
 * Every refusal the door can give, each a sentence on the panel (the panel's
 * literal map is fenced against this union, #906).
 */
export type CountAcceptRefusal =
  | 'forbidden'
  | 'batch_not_found'
  | 'batch_not_unloading'
  | 'confirm_arrival_required'
  | 'lot_not_on_truck'
  | 'count_stale'
  | 'count_below_arrived'
  | 'over_needs_reason'
  | 'undo_needs_reason'
  | 'over_needs_origin_scope'
  | 'grow_limit'
  | 'grow_refused'
  | 'count_conflict'
  | 'busy_retry'
  | 'crate_not_on_batch'
  // The destination moved after the panel was drawn (the reroute round).
  | 'batch_rerouted';

export class CountError extends Error {
  constructor(
    readonly code: CountAcceptRefusal,
    readonly detail: Record<string, number | string> = {},
  ) {
    super(code);
  }
}

/**
 * A destination door that does not open for the truck as it stands: minted
 * for THIS person, it was minted at the warehouse the panel was drawn for, so
 * the truck was rerouted since — the person is told so. Any other door (none,
 * another person's) is a plain refusal, as it always was (#790).
 */
function reroutedOrForbidden(door: CountDoor | null | undefined, actorId: string): CountAcceptRefusal {
  return door && door.actorId === actorId ? 'batch_rerouted' : 'forbidden';
}

/**
 * Cartons per transaction. A press of up to this many is atomic; a bigger
 * one commits in chunks, each re-checking the lot (`count_stale`) — a crash
 * between two leaves a partial count the refreshed panel shows and a second
 * press completes. Measured: see DECISIONS (#1135).
 */
export const COUNT_CHUNK = 200;
/** What an audit row or an alarm carries of a code list — the rest is counted. */
const CODES_KEPT = 500;

/** One lot of one truck, loose cartons only — what the panel shows and the press decides on. */
export interface LotLedger {
  lotId: string;
  label: string;
  sub: string | null;
  product: string;
  productRu: string | null;
  clientId: string | null;
  /** Rode this truck (manifest). */
  departed: number;
  /** Came off it HERE: scanned, counted, or landed as a rider (`ARRIVED_ON_A_TRUCK`). */
  arrived: number;
  /** …of which a phone scanned. */
  phoneScanned: number;
  /** Still aboard: the live pointer, not yet landed. */
  awaiting: number;
  /** The lot's loose stock standing at the truck's origin — where an over-count comes from. */
  spare: number;
}

interface LedgerRow {
  lot_id: string;
  departed: number;
  arrived: number;
  phone: number;
  awaiting: number;
  spare: number;
  letter: string | null;
  product_zh: string;
  product_ru: string | null;
  client_code: string | null;
  marking: string | null;
  client_id: string | null;
}

/**
 * THE ledger, one home for the page (pool) and the press (its transaction,
 * holding its locks — the handle is required, #714). Candidate lots are
 * found through two indexed lookups first (the live pointer, the truck's
 * movements), so `batchMemberFilter`'s per-row EXISTS runs over those lots'
 * cartons and never over the whole book (#152).
 */
async function readLedger(
  exec: Db | Tx,
  a: { batchId: string; originId: string; lotId: string | null },
): Promise<LotLedger[]> {
  const T = a.batchId;
  const only = (col: SQL) => (a.lotId ? sql`AND ${col} = ${a.lotId}::uuid` : sql``);
  const causes = sql.join(
    ARRIVED_ON_A_TRUCK.map((c) => sql`${c}`),
    sql`, `,
  );
  const rows = (await exec.execute(sql`
    WITH cand AS (
      SELECT cb.lot_id FROM boxes cb WHERE cb.current_batch_id = ${T}::uuid ${only(sql`cb.lot_id`)}
      UNION
      SELECT mb.lot_id FROM box_movements cm JOIN boxes mb ON mb.id = cm.box_id
       WHERE cm.ref_type = 'batch' AND cm.ref_id = ${T}::uuid ${only(sql`mb.lot_id`)}
    ),
    dep AS (
      SELECT boxes.lot_id, count(*)::int AS n FROM boxes
       WHERE boxes.lot_id IN (SELECT lot_id FROM cand)
         AND ${batchMemberFilter(T)}
         AND boxes.crate_id IS NULL AND boxes.status <> 'void'
       GROUP BY boxes.lot_id
    ),
    arr AS (
      SELECT ab.lot_id, count(DISTINCT ab.id)::int AS n
        FROM box_movements am JOIN boxes ab ON ab.id = am.box_id
       WHERE am.ref_type = 'batch' AND am.ref_id = ${T}::uuid AND am.cause IN (${causes})
         AND ab.crate_id IS NULL AND ab.status <> 'void' ${only(sql`ab.lot_id`)}
         -- An over-landing a press below «arrived» sent back to the origin's
         -- shelf did not arrive after all (review money-1).
         AND NOT EXISTS (
           SELECT 1 FROM box_movements back
            WHERE back.box_id = ab.id AND back.ref_type = 'batch' AND back.ref_id = ${T}::uuid
              AND back.cause = 'found_at_origin' AND (back.created_at, back.id) > (am.created_at, am.id)
         )
       GROUP BY ab.lot_id
    ),
    phone AS (
      SELECT pb.lot_id, count(DISTINCT pb.id)::int AS n
        FROM scan_events pse JOIN boxes pb ON pb.id = pse.box_id
       WHERE pse.batch_id = ${T}::uuid AND pse.type = 'unload' AND pse.crate_id IS NULL
         AND ${isPhoneScanSql('pse')} ${only(sql`pb.lot_id`)}
       GROUP BY pb.lot_id
    ),
    aw AS (
      SELECT wb.lot_id, count(*)::int AS n FROM boxes wb
       WHERE wb.current_batch_id = ${T}::uuid AND wb.status = 'in_transit' AND wb.crate_id IS NULL
         ${only(sql`wb.lot_id`)}
       GROUP BY wb.lot_id
    ),
    lots AS (SELECT lot_id FROM dep UNION SELECT lot_id FROM arr UNION SELECT lot_id FROM aw),
    spare AS (
      SELECT sb.lot_id, count(*)::int AS n FROM boxes sb
       WHERE sb.lot_id IN (SELECT lot_id FROM lots)
         AND sb.current_warehouse_id = ${a.originId}::uuid
         AND sb.status IN ('in_stock', 'ready_for_pickup')
         AND sb.current_batch_id IS NULL AND sb.crate_id IS NULL
       GROUP BY sb.lot_id
    )
    SELECT l.lot_id,
           coalesce(dep.n, 0) AS departed, coalesce(arr.n, 0) AS arrived,
           coalesce(phone.n, 0) AS phone, coalesce(aw.n, 0) AS awaiting,
           coalesce(spare.n, 0) AS spare,
           rl.letter, rl.product_name_zh AS product_zh, rl.product_name_ru AS product_ru,
           c.client_code, r.unclaimed_marking AS marking, r.client_id
      FROM lots l
      JOIN receipt_lots rl ON rl.id = l.lot_id
      JOIN receipts r ON r.id = rl.receipt_id
      LEFT JOIN clients c ON c.id = r.client_id
      LEFT JOIN dep ON dep.lot_id = l.lot_id
      LEFT JOIN arr ON arr.lot_id = l.lot_id
      LEFT JOIN phone ON phone.lot_id = l.lot_id
      LEFT JOIN aw ON aw.lot_id = l.lot_id
      LEFT JOIN spare ON spare.lot_id = l.lot_id
  `)) as unknown as LedgerRow[];
  return rows.map((r) => {
    const id = codeIdentity(r.marking, r.client_code);
    return {
      lotId: r.lot_id,
      label: `${id.main}-${r.letter ?? '?'}`,
      sub: id.sub,
      product: r.product_zh,
      productRu: r.product_ru,
      clientId: r.client_id,
      departed: Number(r.departed),
      arrived: Number(r.arrived),
      phoneScanned: Number(r.phone),
      awaiting: Number(r.awaiting),
      spare: Number(r.spare),
    };
  });
}

/** Still aboard T, loose, this lot — the rows a count lands first. */
function awaitingOf(batchId: string, lotId: string) {
  return and(
    eq(boxes.lotId, lotId),
    eq(boxes.currentBatchId, batchId),
    eq(boxes.status, 'in_transit'),
    isNull(boxes.crateId),
  )!;
}

/** The lot's loose stock at the truck's origin — where cartons beyond the truck come from. */
function spareOf(originId: string, lotId: string) {
  return and(
    eq(boxes.lotId, lotId),
    eq(boxes.currentWarehouseId, originId),
    inArray(boxes.status, ['in_stock', 'ready_for_pickup']),
    isNull(boxes.currentBatchId),
    isNull(boxes.crateId),
  )!;
}

/**
 * Which carton the count «is»: the stickerless ones first, then the ones
 * nobody ever printed, then the lowest number — the cartons a phone could
 * never have scanned are the likeliest to be the ones standing there
 * uncounted. An identity guess either way; totals per lot and client are
 * what it conserves.
 */
async function pickRows(tx: Tx, where: ReturnType<typeof awaitingOf>, n: number) {
  if (n <= 0) return [];
  return tx
    .select({ id: boxes.id, shortCode: boxes.shortCode })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .where(where)
    .orderBy(
      sql`${qrlessJoinedSql()} DESC`,
      sql`(${boxes.labelPrintedAt} IS NULL) DESC`,
      asc(boxes.seqInLot),
      asc(boxes.id),
    )
    .limit(n);
}

export interface CountAcceptResult {
  lotId: string;
  label: string;
  departed: number;
  arrivedBefore: number;
  arrived: number;
  awaiting: number;
  /** Cartons this press landed, the three kinds together. */
  landed: number;
  /** …of which beyond the truck (the origin's stock and the lot's growth). */
  over: number;
  /** …of which minted onto the prixod (Q3 b). */
  grown: number;
  /** A press below «arrived»: this truck's over-landings taken back (review money-1). */
  undone?: number;
  shortfall: number;
  /** Nothing to do: the lot already stood at this number. No write, no audit. */
  replay: boolean;
}

interface PressState {
  /** A press below «arrived» sent over-landings back to the origin's shelf. */
  returnedToOrigin?: boolean;
  landed: number;
  landedCodes: string[];
  overCodes: string[];
  grownCodes: string[];
  first: LotLedger | null;
  arrivalMarked: boolean;
}

/**
 * The office's count of one lot off one truck (0112). `doors.dest` opens the
 * press; `doors.origin` is asked only for cartons beyond the truck, which
 * come off the ORIGIN's books — a logist scoped to Tashkent does not write
 * off Yiwu's stock (Q3: scope at the end you touch).
 */
export async function countAcceptLot(
  input: CountAcceptInput,
  ctx: AuditContext,
  doors: { dest: CountDoor; origin: CountDoor | null },
): Promise<CountAcceptResult> {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  const pre = await db.query.batches.findFirst({ where: eq(batches.id, input.batchId) });
  if (!pre) throw new CountError('batch_not_found');
  // The door is the FIRST refusal, before anything is read about the cargo
  // (#790: an absent answer fails closed; #531: the service says it too).
  // A door minted for THIS person at another warehouse means only that the
  // destination moved since the panel was drawn — said as the reroute, not
  // as «Ruxsat yo'q» (the reroute round).
  if (!doorOpens(doors.dest, pre.destWarehouseId, actorId)) throw new CountError(reroutedOrForbidden(doors.dest, actorId));
  if (!['in_transit', 'arrived'].includes(pre.status)) throw new CountError('batch_not_unloading');
  // Decision 16: a count onto a truck still «on the road» declares it
  // arrived and may tell its clients so. The screen asks in words; the
  // service demands that the answer was POSTED (#531).
  if (pre.status === 'in_transit' && !input.confirmArrival) {
    throw new CountError('confirm_arrival_required');
  }
  const overReason = (input.overReason ?? '').trim();
  /** What the press lands if the lot still stands where the person saw it. */
  const need = input.target - input.seenArrived;
  const rogueTrucks = new Set<string>();
  const state: PressState = {
    landed: 0,
    landedCodes: [],
    overCodes: [],
    grownCodes: [],
    first: null,
    arrivalMarked: false,
  };
  let grew = false;
  let done: CountAcceptResult | null = null;
  try {
    for (let chunk = 0; ; chunk += 1) {
      const step = await db.transaction((tx) =>
        countChunk(tx, { input, ctx, actorId, doors, overReason, need, chunk, state, rogueTrucks }),
      );
      if (step.grew) grew = true;
      if (step.result) {
        done = step.result;
        return step.result;
      }
    }
  } catch (err) {
    if (isBusyError(err)) throw new CountError('busy_retry');
    if (err instanceof GrowLotError) throw new CountError('grow_refused', { detail: err.code });
    throw err;
  } finally {
    // After every commit, never inside one (#714), and never failing the
    // press: the cartons beyond the truck are its riders for money now, and
    // a grown lot re-splits whatever was shared over its cartons.
    if (rogueTrucks.size > 0) {
      try {
        const { queueRiderChange } = await import('../costing/service');
        await queueRiderChange([...rogueTrucks], 'undocumented_transfer');
      } catch (err) {
        console.error('[count-accept] rider re-split could not be arranged', [...rogueTrucks], err);
      }
    }
    if (state.returnedToOrigin) {
      // They no longer ride this truck: its money re-splits without them.
      try {
        const { queueRiderChange } = await import('../costing/service');
        await queueRiderChange([input.batchId], 'found_at_origin');
      } catch (err) {
        console.error('[count-accept] rider re-split after an undo could not be arranged', input.batchId, err);
      }
    }
    if (grew) await afterLotGrown(input.lotId);
    // Beyond the truck onto a price already typed: the accountant hears it
    // (review money-4). Only a finished press — a refused one changed nothing.
    if (done && done.over > 0) {
      await notifyPricedCargoGrew(input.batchId, input.lotId, actorId).catch((err) =>
        console.error('[count-accept] priced-then-grew notice failed', input.batchId, err),
      );
    }
    // …and a press below «arrived» that took cartons back off a priced truck
    // (review of the fixes, money-2).
    if (done && (done.undone ?? 0) > 0) {
      await notifyPricedCargoTakenBack(input.batchId, input.lotId, actorId).catch((err) =>
        console.error('[count-accept] priced-then-taken-back notice failed', input.batchId, err),
      );
    }
  }
}

/**
 * «Landed here as over by this truck's count» (alias-free, one lot): the
 * cartons an office press landed beyond the truck (`count_over` on T) that
 * still stand at the destination, loose and unissued — the only cartons a
 * press below «arrived» may take back. A phone's landing and a plain count
 * landing are never un-landed (decision 10).
 */
function landedOverOf(batchId: string, destId: string, lotId: string) {
  return and(
    eq(boxes.lotId, lotId),
    eq(boxes.currentWarehouseId, destId),
    inArray(boxes.status, ['in_stock', 'ready_for_pickup']),
    isNull(boxes.currentBatchId),
    isNull(boxes.crateId),
    sql`EXISTS (SELECT 1 FROM scan_events ose
      WHERE ose.box_id = ${boxes}.id AND ose.batch_id = ${batchId}::uuid AND ose.type = 'unload'
        AND ose.crate_id IS NULL AND ose.manual_reason = ${COUNT_OVER_REASON})`,
  )!;
}

/**
 * A press BELOW what arrived — the office typed «50» for 5 and confirmed
 * (review money-1). It takes back exactly this truck's over-landings, the
 * prixod's own growth first (voided, the lot shrinks — `shrinkGrownInTx`),
 * then the cartons taken off the origin's stock (back on the origin's
 * shelf, `found_at_origin` on this truck, so they stop riding it for
 * money). Nothing a phone scanned and nothing the truck carried is ever
 * un-landed: below that the press is still `count_below_arrived`, naming
 * the lowest number it could reach. The same reason and the ORIGIN's door
 * the over-count needed — it moves the origin's books back.
 */
async function undoOver(
  tx: Tx,
  a: Parameters<typeof countChunk>[1],
  batch: typeof batches.$inferSelect,
  led: LotLedger,
  wasInTransit: boolean,
): Promise<{ result: CountAcceptResult; grew: boolean }> {
  const { input, actorId, state } = a;
  const T = input.batchId;
  const L = input.lotId;
  const rows = await tx
    .select({ id: boxes.id, shortCode: boxes.shortCode, seq: boxes.seqInLot, status: boxes.status })
    .from(boxes)
    .where(landedOverOf(T, batch.destWarehouseId, L))
    .orderBy(desc(boxes.seqInLot));
  const n = led.arrived - input.target;
  if (rows.length < n) {
    throw new CountError('count_below_arrived', { arrived: led.arrived, min: led.arrived - rows.length });
  }
  // Its own word: «to accept MORE, write the reason» named the opposite of
  // what a person lowering the number is doing (review of the fixes, ui2-2).
  if (a.overReason.length < 3) throw new CountError('undo_needs_reason', { arrived: led.arrived });
  if (!doorOpens(a.doors.origin, batch.originWarehouseId, actorId)) {
    throw new CountError('over_needs_origin_scope', { max: led.arrived });
  }
  const [lotRow] = await tx
    .select({ receiptId: receiptLots.receiptId })
    .from(receiptLots)
    .where(eq(receiptLots.id, L));
  const grownHere = await grownCodesOnTruck(tx, { receiptId: lotRow!.receiptId, lotId: L, batchId: T });
  // A carton this truck's growth MINTED never stood on the origin's shelf, so
  // it goes out of the prixod whatever happened to it since — a sticker
  // printed for it at the destination included (review of the fixes,
  // money-1: sending it «back» put phantom stock in Yiwu). Its sticker dies
  // with it: the code answers «void» to every scanner.
  const isGrown = (r: (typeof rows)[number]) => grownHere.has(r.shortCode);
  // The growth went on last, so it comes off first; then the highest numbers.
  const picked = [...rows.filter(isGrown), ...rows.filter((r) => !isGrown(r))].slice(0, n);
  const toShrink = picked.filter(isGrown);
  const toOrigin = picked.filter((r) => !isGrown(r));
  const shrunk = toShrink.length
    ? (
        await shrinkGrownInTx(tx, {
          lotId: L,
          boxIds: toShrink.map((r) => r.id),
          actorId,
          reason: a.overReason,
          batchId: T,
          side: 'unload',
        })
      ).codes
    : [];
  // Back on the origin's shelf as each stood there before the over-count
  // took it (`shelfBefore` — «tayyor» at a collection warehouse stays so).
  const back = await shelfBefore(tx, T, toOrigin.map((r) => r.id));
  for (const [status, home] of byShelf(toOrigin, back)) {
    await tx
      .update(boxes)
      .set({ status, currentWarehouseId: batch.originWarehouseId, flags: [] })
      .where(inArray(boxes.id, home.map((r) => r.id)));
    await tx.insert(boxMovements).values(
      home.map((r) => ({
        boxId: r.id,
        fromWarehouseId: batch.destWarehouseId,
        toWarehouseId: batch.originWarehouseId,
        fromStatus: r.status,
        toStatus: status,
        cause: 'found_at_origin',
        refType: 'batch',
        refId: T,
        actorId,
      })),
    );
  }
  if (toOrigin.length > 0) state.returnedToOrigin = true;
  const [after] = await readLedger(tx, { batchId: T, originId: batch.originWarehouseId, lotId: L });
  if (!after || after.arrived !== input.target) throw new CountError('count_conflict');
  const destWh = (await tx.query.warehouses.findFirst({ where: eq(warehouses.id, batch.destWarehouseId) }))!;
  const { shortfall, alertedShortfall } = await sayShortfall(tx, { batch, after, actorId, destCode: destWh.code });
  await writeAudit(tx, { ...a.ctx, warehouseId: batch.destWarehouseId }, {
    entityType: 'batch',
    entityId: T,
    action: 'update',
    before: { countAccept: { lotId: L, arrived: led.arrived } },
    after: {
      countAccept: {
        pressId: input.pressId,
        lotId: L,
        lot: after.label,
        target: input.target,
        departed: after.departed,
        arrivedBefore: led.arrived,
        arrived: after.arrived,
        undone: {
          shrunk,
          toOrigin: toOrigin.map((r) => r.shortCode).slice(0, CODES_KEPT),
          reason: a.overReason,
        },
        arrivalMarked: wasInTransit,
        shortfall,
        alertedShortfall,
        chunk: 0,
        last: true,
      },
    },
  });
  return {
    grew: shrunk.length > 0,
    result: {
      lotId: L,
      label: after.label,
      departed: after.departed,
      arrivedBefore: led.arrived,
      arrived: after.arrived,
      awaiting: after.awaiting,
      landed: 0,
      over: 0,
      grown: 0,
      undone: n,
      shortfall,
      replay: false,
    },
  };
}

async function countChunk(
  tx: Tx,
  a: {
    input: CountAcceptInput;
    ctx: AuditContext;
    actorId: string;
    doors: { dest: CountDoor; origin: CountDoor | null };
    overReason: string;
    need: number;
    chunk: number;
    state: PressState;
    rogueTrucks: Set<string>;
  },
): Promise<{ result: CountAcceptResult | null; grew: boolean }> {
  const { input, actorId, state } = a;
  const T = input.batchId;
  const L = input.lotId;
  await setCountLockTimeout(tx);
  // Lock order (decision 23): the truck row → the lot row → the lot's
  // cartons by id → the (truck, lot) lock → a FRESH read. The truck row first
  // because a phone's first scan of an in-transit truck updates it before it
  // takes its carton, so a count holding cartons and waiting for the truck
  // would deadlock with it. NO KEY UPDATE and not UPDATE: every scan event a
  // phone writes on an ARRIVED truck takes the key-share lock of its foreign
  // key on this row, and a FOR UPDATE here closed a cycle with that phone's
  // carton lock — and froze every scan of the truck for the chunk (review
  // lock-1). The lot row before the cartons, as the receipt card's switch and
  // the lot form take it, or a growth — which locks it — would deadlock with
  // them (review lock-3).
  const [batch] = await tx.select().from(batches).where(eq(batches.id, T)).for('no key update');
  if (!batch || !['in_transit', 'arrived'].includes(batch.status)) {
    throw new CountError('batch_not_unloading');
  }
  // Asked again on the LOCKED row: the reroute takes the same lock, so a
  // destination moved between the pre-check and here is seen now (the
  // reroute round).
  if (!doorOpens(a.doors.dest, batch.destWarehouseId, actorId)) throw new CountError('batch_rerouted');
  const wasInTransit = batch.status === 'in_transit';
  if (wasInTransit && !input.confirmArrival) throw new CountError('confirm_arrival_required');
  await tx.select({ id: receiptLots.id }).from(receiptLots).where(eq(receiptLots.id, L)).for('update');
  const remainingPlan = a.need - state.landed;
  const awaitLocked = await tx
    .select({ id: boxes.id })
    .from(boxes)
    .where(awaitingOf(T, L))
    .orderBy(asc(boxes.id))
    .for('update');
  const fromAwaitPlan = Math.min(Math.max(remainingPlan, 0), awaitLocked.length, COUNT_CHUNK);
  // The origin's rows only when this chunk will reach them — and before the
  // lot lock, like every other row.
  const originLocked = remainingPlan > fromAwaitPlan && fromAwaitPlan < COUNT_CHUNK;
  if (originLocked) {
    await tx
      .select({ id: boxes.id })
      .from(boxes)
      .where(spareOf(batch.originWarehouseId, L))
      .orderBy(asc(boxes.id))
      .for('update');
  }
  // A press BELOW what arrived takes back this truck's own over-landings
  // (review money-1): they stand at the destination, so they are locked here,
  // with every other carton row, before the lot lock.
  const undoing = a.chunk === 0 && input.target < input.seenArrived;
  if (undoing) {
    await tx
      .select({ id: boxes.id })
      .from(boxes)
      .where(landedOverOf(T, batch.destWarehouseId, L))
      .orderBy(asc(boxes.id))
      .for('update');
  }
  await lockLotOnTruck(tx, T, L);
  const [led] = await readLedger(tx, { batchId: T, originId: batch.originWarehouseId, lotId: L });
  if (!led || led.departed + led.arrived + led.awaiting === 0) throw new CountError('lot_not_on_truck');

  if (a.chunk === 0) {
    // Decision 10, in this order: a press that says what already stands is
    // nothing at all (a double press, a retry); a press made against a lot
    // that moved since the person looked is refused with what it is now;
    // and nothing is ever un-landed.
    if (input.target === led.arrived) {
      return {
        grew: false,
        result: {
          lotId: L,
          label: led.label,
          departed: led.departed,
          arrivedBefore: led.arrived,
          arrived: led.arrived,
          awaiting: led.awaiting,
          landed: 0,
          over: 0,
          grown: 0,
          shortfall: Math.max(0, led.departed - led.arrived),
          replay: true,
        },
      };
    }
    if (led.arrived !== input.seenArrived) throw new CountError('count_stale', { arrived: led.arrived });
    if (input.target < led.arrived) return undoOver(tx, a, batch, led, wasInTransit);
    const overTotal = a.need - led.awaiting;
    if (overTotal > 0) {
      if (a.overReason.length < 3) {
        throw new CountError('over_needs_reason', { max: led.arrived + led.awaiting });
      }
      if (!doorOpens(a.doors.origin, batch.originWarehouseId, actorId)) {
        throw new CountError('over_needs_origin_scope', { max: led.arrived + led.awaiting });
      }
      // Q3 b: the only refusal left beyond the truck is the size of one
      // press's growth.
      if (overTotal - led.spare > GROW_LOT_MAX) {
        throw new CountError('grow_limit', {
          max: led.arrived + led.awaiting + led.spare + GROW_LOT_MAX,
        });
      }
    }
    state.first = led;
  } else if (led.arrived !== input.seenArrived + state.landed) {
    // Somebody else's hand touched the lot between two chunks; what landed
    // so far stays landed and the panel shows it.
    throw new CountError('count_stale', { arrived: led.arrived });
  }

  const remaining = a.need - state.landed;
  const takeAwait = Math.min(remaining, led.awaiting, COUNT_CHUNK);
  let room = COUNT_CHUNK - takeAwait;
  let overLeft = remaining - takeAwait;
  const takeOrigin = overLeft > 0 && room > 0 ? Math.min(overLeft, led.spare, room) : 0;
  // Rows taken that were not locked before the lot lock would break the
  // order every unload path keeps; it cannot happen while the CAS holds.
  if (takeOrigin > 0 && !originLocked) throw new CountError('count_conflict');
  room -= takeOrigin;
  overLeft -= takeOrigin;
  const takeGrow = overLeft > 0 && room > 0 && takeOrigin === led.spare ? Math.min(overLeft, room) : 0;
  if (takeOrigin + takeGrow > 0) {
    // Re-said for every chunk that reaches beyond the truck (#531).
    if (a.overReason.length < 3) throw new CountError('over_needs_reason', { max: led.arrived + led.awaiting });
    if (!doorOpens(a.doors.origin, batch.originWarehouseId, actorId)) {
      throw new CountError('over_needs_origin_scope', { max: led.arrived + led.awaiting });
    }
  }
  if (takeAwait + takeOrigin + takeGrow === 0) throw new CountError('count_conflict');

  const awaitPicks = await pickRows(tx, awaitingOf(T, L), takeAwait);
  const originPicks = await pickRows(tx, spareOf(batch.originWarehouseId, L), takeOrigin);
  // The lot row was locked before the cartons (review lock-3); growLotInTx
  // takes it again, re-entrantly.
  const grown =
    takeGrow > 0
      ? await growLotInTx(tx, {
          lotId: L,
          add: takeGrow,
          warehouseId: batch.originWarehouseId,
          actorId,
          reason: a.overReason,
          batchId: T,
          side: 'unload',
        })
      : null;
  if (awaitPicks.length !== takeAwait || originPicks.length !== takeOrigin) {
    throw new CountError('count_conflict');
  }

  const scannedAt = new Date().toISOString();
  const land = (box: { id: string; shortCode: string }, reason: typeof COUNT_ACCEPT_REASON | typeof COUNT_OVER_REASON) =>
    landUnloadInput(
      tx,
      {
        // Per PRESS (decision 11): a scan event outlives a correction, so a
        // per-truck id would answer a new press with an old one's replay.
        clientEventUuid: uuidv5(`unload:${box.id}`, input.pressId),
        batchId: T,
        code: box.shortCode,
        method: 'manual',
        manualReason: reason,
        scannedAt,
      },
      actorId,
      a.rogueTrucks,
      {
        door: reason,
        boxId: box.id,
        quietSpot: true,
        noticeWindowMinutes: OFFICE_NOTICE_WINDOW_MINUTES,
      },
    );
  for (const box of awaitPicks) {
    const ack = await land(box, COUNT_ACCEPT_REASON);
    // A replay inside a press is not a success: it means this carton was
    // already written under this very press (#1135).
    if (ack.result !== 'ok' || ack.detail) throw new CountError('count_conflict', { code: box.shortCode });
  }
  const overRows = [...originPicks, ...(grown?.boxes ?? [])];
  for (const box of overRows) {
    const ack = await land(box, COUNT_OVER_REASON);
    if (ack.result !== 'auto_transfer') throw new CountError('count_conflict', { code: box.shortCode });
  }

  // Decision 11: the post-state is re-read and must be exactly what this
  // chunk claims, or nothing of it is kept.
  const landedNow = awaitPicks.length + overRows.length;
  const [after] = await readLedger(tx, { batchId: T, originId: batch.originWarehouseId, lotId: L });
  if (!after || after.arrived !== led.arrived + landedNow) throw new CountError('count_conflict');
  state.landed += landedNow;
  state.landedCodes.push(...awaitPicks.map((b) => b.shortCode));
  state.overCodes.push(...overRows.map((b) => b.shortCode));
  state.grownCodes.push(...(grown?.boxes ?? []).map((b) => b.shortCode));
  if (wasInTransit) state.arrivalMarked = true;
  const last = state.landed >= a.need;
  if (last && after.arrived !== input.target) throw new CountError('count_conflict');

  const destWh = (await tx.query.warehouses.findFirst({ where: eq(warehouses.id, batch.destWarehouseId) }))!;
  const notifies = landedStatusFor(destWh.type) === 'ready_for_pickup';
  let shortfall = Math.max(0, after.departed - after.arrived);
  let alertedShortfall = await lastAlertedShortfall(tx, T, L);
  if (last) {
    ({ shortfall, alertedShortfall } = await sayShortfall(tx, { batch, after, actorId, destCode: destWh.code }));
    // ONE alarm for the cartons beyond the truck, not one per carton — and
    // it says how many the prixod itself grew by (Q3 b).
    if (state.overCodes.length > 0) {
      const grownN = state.grownCodes.length;
      await emitEvent(tx, {
        type: 'UndocumentedTransfer',
        payload: {
          batchId: T,
          batchCode: batch.code,
          warehouseId: batch.destWarehouseId,
          shortCodes: state.overCodes.slice(0, CODES_KEPT),
          lot: { label: after.label, product: alarmProduct(after), n: state.overCodes.length },
          reason:
            grownN > 0 ? `${a.overReason} · prixodga +${grownN} karobka qo‘shildi` : a.overReason,
          via: 'count',
          presserId: actorId,
          grown: grownN,
        },
        entityType: 'batch',
        entityId: T,
        actorId,
      });
    }
  }

  await writeAudit(tx, { ...a.ctx, warehouseId: batch.destWarehouseId }, {
    entityType: 'batch',
    entityId: T,
    action: 'update',
    before: { countAccept: { lotId: L, arrived: led.arrived } },
    after: {
      countAccept: {
        pressId: input.pressId,
        lotId: L,
        lot: after.label,
        target: input.target,
        departed: after.departed,
        arrivedBefore: led.arrived,
        arrived: after.arrived,
        landed: awaitPicks.map((b) => b.shortCode).slice(0, CODES_KEPT),
        landedCount: awaitPicks.length,
        over: overRows.map((b) => b.shortCode).slice(0, CODES_KEPT),
        overCount: overRows.length,
        // Q3 b: the codes the prixod grew by, named on the press that minted them.
        grown: (grown?.boxes ?? []).map((b) => b.shortCode),
        overReason: a.overReason || null,
        arrivalMarked: wasInTransit,
        noticeClientIds: notifies && landedNow > 0 && after.clientId ? [after.clientId] : [],
        shortfall,
        alertedShortfall,
        chunk: a.chunk,
        last,
      },
    },
  });

  if (!last) return { result: null, grew: !!grown };
  return {
    grew: !!grown,
    result: {
      lotId: L,
      label: after.label,
      departed: after.departed,
      arrivedBefore: state.first!.arrived,
      arrived: after.arrived,
      awaiting: after.awaiting,
      landed: state.landed,
      over: state.overCodes.length,
      grown: state.grownCodes.length,
      shortfall,
      replay: false,
    },
  };
}

/**
 * The goods' name an alarm prints — the Russian one when the prixod has it,
 * as every other count alarm does (count-load's BoxScannedOnLoad), so one lot
 * is not Chinese in one message and Russian in the next (review ui-6). The
 * panel keeps both names side by side.
 */
function alarmProduct(lot: Pick<LotLedger, 'product' | 'productRu'>): string {
  return lot.productRu || lot.product;
}

/**
 * The shortfall alarm, de-duplicated per (truck, lot) against what the last
 * press already said: the first shortfall, a growth, and the closure — never
 * one alarm per press while the lot is still coming off. One home for the
 * landing press and the undo (review money-1), which can open a shortfall too.
 */
async function sayShortfall(
  tx: Tx,
  a: { batch: typeof batches.$inferSelect; after: LotLedger; actorId: string; destCode: string },
): Promise<{ shortfall: number; alertedShortfall: number }> {
  const T = a.batch.id;
  const L = a.after.lotId;
  const shortfall = Math.max(0, a.after.departed - a.after.arrived);
  const prevAlerted = await lastAlertedShortfall(tx, T, L);
  let alertedShortfall = prevAlerted;
  let text: string | null = null;
  if (shortfall > 0 && shortfall > prevAlerted) {
    text = await shortfallText(tx, a.batch, a.after, shortfall, a.actorId, a.destCode);
    alertedShortfall = shortfall;
  } else if (shortfall === 0 && prevAlerted > 0) {
    text = await closedText(tx, a.batch, a.after, a.actorId);
    alertedShortfall = 0;
  }
  if (text) {
    await emitEvent(tx, {
      type: 'CountShortfall',
      payload: { batchId: T, batchCode: a.batch.code, lotId: L, presserId: a.actorId, text },
      entityType: 'batch',
      entityId: T,
      actorId: a.actorId,
    });
  }
  return { shortfall, alertedShortfall };
}

/**
 * What the last press of this lot on this truck already alarmed about — 0 if
 * nothing. By insertion order, not by `created_at`: that is the moment a
 * transaction BEGAN, and a press that began first can commit second.
 */
async function lastAlertedShortfall(tx: Tx, batchId: string, lotId: string): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT a.after->'countAccept'->>'alertedShortfall' AS alerted
      FROM audit_log a
     WHERE a.entity_type = 'batch' AND a.entity_id = ${batchId}::uuid
       AND a.after->'countAccept'->>'lotId' = ${lotId}
     ORDER BY a.id DESC
     LIMIT 1
  `)) as unknown as { alerted: string | null }[];
  const n = Number(rows[0]?.alerted ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function presserName(tx: Tx, actorId: string): Promise<string> {
  const [u] = await tx.select({ name: users.fullName }).from(users).where(eq(users.id, actorId));
  return u?.name ?? '—';
}

/*
 * The shortfall texts are plain Uzbek composed where the cargo lives, like
 * BoxLost's (round C: the stored text stays plain; the drain bolds nothing
 * it did not write). The owner and the logists read them — his Q6c.
 */
async function shortfallText(
  tx: Tx,
  batch: typeof batches.$inferSelect,
  led: LotLedger,
  short: number,
  actorId: string,
  destCode: string,
): Promise<string> {
  const [origin] = await tx
    .select({ code: warehouses.code })
    .from(warehouses)
    .where(eq(warehouses.id, batch.originWarehouseId));
  const appUrl = process.env.APP_URL ?? '';
  return (
    `⚠️ ${batch.code} (${origin?.code ?? '?'}→${destCode}) — sanab qabul: kamomad\n` +
    `${led.label} · ${alarmProduct(led)}\n` +
    `Jo‘natilgan: ${led.departed} · Sanaldi: ${led.arrived} · Yetmaydi: ${short}\n` +
    `Sanadi: ${await presserName(tx, actorId)}\n` +
    // The count panel is where the answer is given — the truck card's
    // unloading tab, at its anchor (a link from Telegram lands on it).
    `${appUrl}${batchTabHref(batch.id, 'yuklash')}#count-accept`
  );
}

async function closedText(
  tx: Tx,
  batch: typeof batches.$inferSelect,
  led: LotLedger,
  actorId: string,
): Promise<string> {
  const appUrl = process.env.APP_URL ?? '';
  return (
    `✅ ${batch.code} — ${led.label} · ${alarmProduct(led)}: endi ${led.arrived}/${led.departed}, kamomad yopildi\n` +
    `Sanadi: ${await presserName(tx, actorId)}\n` +
    `${appUrl}${batchTabHref(batch.id, 'yuklash')}#count-accept`
  );
}

/**
 * A crate is one place (Q10 d): the office accepts it whole, through the
 * crate branch the phone's CR- scan runs, and any member that never rode
 * this truck is NAMED, never moved (round 31). Crate events never make a
 * lot «counted».
 */
export async function countAcceptCrate(
  input: CountAcceptCrateInput,
  ctx: AuditContext,
  doors: { dest: CountDoor },
): Promise<{ code: string; landed: number; notArrived: string[]; replay: boolean }> {
  if (!ctx.actorId) throw new ScanError('unauthenticated');
  const actorId = ctx.actorId;
  const pre = await db.query.batches.findFirst({ where: eq(batches.id, input.batchId) });
  if (!pre) throw new CountError('batch_not_found');
  if (!doorOpens(doors.dest, pre.destWarehouseId, actorId)) throw new CountError(reroutedOrForbidden(doors.dest, actorId));
  if (!['in_transit', 'arrived'].includes(pre.status)) throw new CountError('batch_not_unloading');
  if (pre.status === 'in_transit' && !input.confirmArrival) throw new CountError('confirm_arrival_required');
  try {
    return await db.transaction(async (tx) => {
      await setCountLockTimeout(tx);
      const [batch] = await tx
        .select()
        .from(batches)
        .where(eq(batches.id, input.batchId))
        .for('no key update');
      if (!batch || !['in_transit', 'arrived'].includes(batch.status)) {
        throw new CountError('batch_not_unloading');
      }
      if (!doorOpens(doors.dest, batch.destWarehouseId, actorId)) throw new CountError('batch_rerouted');
      const [crate] = await tx.select().from(crates).where(eq(crates.id, input.crateId));
      if (!crate) throw new CountError('crate_not_on_batch');
      await tx.select({ id: boxes.id }).from(boxes).where(eq(boxes.crateId, crate.id)).orderBy(asc(boxes.id)).for('update');
      const ack = await landUnloadInput(
        tx,
        {
          clientEventUuid: uuidv5(`crate:${crate.id}`, input.pressId),
          batchId: batch.id,
          code: crate.code,
          method: 'manual',
          manualReason: COUNT_ACCEPT_REASON,
          scannedAt: new Date().toISOString(),
        },
        actorId,
        new Set(),
        { door: COUNT_ACCEPT_REASON, quietSpot: true, noticeWindowMinutes: OFFICE_NOTICE_WINDOW_MINUTES },
      );
      if (ack.result === 'duplicate' || ack.detail === 'replay') {
        return { code: crate.code, landed: 0, notArrived: ack.notArrived ?? [], replay: true };
      }
      if (ack.result === 'rejected' && ack.detail === 'crate_not_on_batch') {
        throw new CountError('crate_not_on_batch');
      }
      if (ack.result !== 'ok' && ack.result !== 'auto_transfer') throw new CountError('count_conflict');
      const landed = ack.boxes?.length ?? 0;
      await writeAudit(tx, { ...ctx, warehouseId: batch.destWarehouseId }, {
        entityType: 'batch',
        entityId: batch.id,
        action: 'update',
        after: {
          countAcceptCrate: {
            pressId: input.pressId,
            crateId: crate.id,
            code: crate.code,
            landed,
            notArrived: ack.notArrived ?? [],
            arrivalMarked: batch.status === 'in_transit',
          },
        },
      });
      return { code: crate.code, landed, notArrived: ack.notArrived ?? [], replay: false };
    });
  } catch (err) {
    if (isBusyError(err)) throw new CountError('busy_retry');
    throw err;
  }
}

/**
 * Loose cartons still aboard whose lot the office counted HERE — what
 * «Hammasini qabul qilish» will leave to the count, so its button can say
 * the number it will really land (decision 21). Crated members are not in it:
 * a crate is accepted as the crate.
 */
export const countedLotAwaiting = cache(async function countedLotAwaiting(batchId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(boxes)
    .where(
      and(
        eq(boxes.currentBatchId, batchId),
        eq(boxes.status, 'in_transit'),
        isNull(boxes.crateId),
        countedOnTruckSql(batchId, sql`${boxes}.lot_id`, 'unload'),
      ),
    );
  return Number(row?.n ?? 0);
});

export interface CountPanelLot extends LotLedger {
  /** Why the phone will not take it: counted (either end) or QR-siz aboard. */
  mode: 'counted' | 'qrless' | null;
  /** The last press on this lot — Q5 «kim va qachon». */
  last: { name: string; at: string; overReason: string | null } | null;
  /**
   * How many of this truck's office over-landings a press below «arrived»
   * could still take back (`landedOverOf`'s count) — so the panel never
   * promises «N go back» the service will refuse (review of the fixes, ui2-3).
   */
  takeBack: number;
}

/** The panel's data, on the pool — the page's read, never a press's. */
export const countAcceptPanel = cache(async function countAcceptPanel(batchId: string): Promise<{
  lots: CountPanelLot[];
  crates: { crateId: string; code: string; n: number }[];
}> {
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, batchId) });
  if (!batch) return { lots: [], crates: [] };
  const [ledger, modes, lastRows, crateRows, takeRows] = await Promise.all([
    readLedger(db, { batchId, originId: batch.originWarehouseId, lotId: null }),
    countOnlyLotsOnTruck(db, { batchId, side: 'unload', countedSide: 'any', quickOriginId: null }),
    db.execute(sql`
      SELECT DISTINCT ON (a.after->'countAccept'->>'lotId')
             a.after->'countAccept'->>'lotId' AS lot_id,
             a.created_at::text AS at,
             u.full_name AS name,
             a.after->'countAccept'->>'overReason' AS over_reason
        FROM audit_log a
        LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.entity_type = 'batch' AND a.entity_id = ${batchId}::uuid
         AND a.after->'countAccept' IS NOT NULL
       ORDER BY a.after->'countAccept'->>'lotId', a.created_at DESC
    `) as unknown as Promise<{ lot_id: string; at: string; name: string | null; over_reason: string | null }[]>,
    db
      .select({ crateId: crates.id, code: crates.code, n: sql<number>`count(*)::int` })
      .from(boxes)
      .innerJoin(crates, eq(boxes.crateId, crates.id))
      .where(and(eq(boxes.currentBatchId, batchId), eq(boxes.status, 'in_transit')))
      .groupBy(crates.id, crates.code)
      .orderBy(asc(crates.code)),
    // `landedOverOf` for every lot at once, from the truck's own events.
    db.execute(sql`
      SELECT b.lot_id, count(DISTINCT b.id)::int AS n
        FROM scan_events ose
        JOIN boxes b ON b.id = ose.box_id
       WHERE ose.batch_id = ${batchId}::uuid AND ose.type = 'unload'
         AND ose.crate_id IS NULL AND ose.manual_reason = ${COUNT_OVER_REASON}
         AND b.current_warehouse_id = ${batch.destWarehouseId}::uuid
         AND b.status IN ('in_stock', 'ready_for_pickup')
         AND b.current_batch_id IS NULL AND b.crate_id IS NULL
       GROUP BY b.lot_id
    `) as unknown as Promise<{ lot_id: string; n: number }[]>,
  ]);
  const takeBy = new Map(takeRows.map((r) => [r.lot_id, Number(r.n)]));
  const lastBy = new Map(
    lastRows.map((r) => [r.lot_id, { name: r.name ?? '—', at: r.at, overReason: r.over_reason }]),
  );
  const lots = ledger
    .map((lot) => ({
      ...lot,
      mode: modes.get(lot.lotId) ?? null,
      last: lastBy.get(lot.lotId) ?? null,
      takeBack: takeBy.get(lot.lotId) ?? 0,
    }))
    // The office's work first: what is still aboard and the phone cannot
    // take, then what is still aboard, then what is done — by label.
    .sort((x, y) => {
      const rank = (l: CountPanelLot) => (l.awaiting > 0 ? (l.mode ? 0 : 1) : 2);
      return rank(x) - rank(y) || x.label.localeCompare(y.label);
    });
  return { lots, crates: crateRows.map((c) => ({ ...c, n: Number(c.n) })) };
});
