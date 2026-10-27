import { sql, type SQL } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { logger } from '../../platform/logger';
import { PLANNABLE_STATUSES } from '../boxes/shelf';
import { codeIdentity } from '../labels/code-identity';

/**
 * Yo'ldagi yuk — a plan line may promise cartons still on a truck bound for the
 * plan's origin (docs/YOLDAGI-YUK.md; the owner's 1a 2a 3a 4a 5a, 2026-10-27).
 *
 * This module is the only writer of `plan_line_road` and `plan_road_claims`
 * (0137) and the one home of the sentences every reader asks: what a road
 * carton is, what is still owed, what the loading ended without.
 */

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

declare const roadBrand: unique symbol;
/**
 * Whether 0137 is on this server, as a value only `planRoadReady()` mints. It
 * is a REQUIRED argument of every body that touches the tables, so a door
 * cannot forget to ask (a forgotten optional flag would land a road carton
 * free on the shelf with no error anywhere) — and it is asked on the POOL,
 * before the door opens its transaction (#714).
 */
export interface RoadOn {
  readonly on: boolean;
  readonly [roadBrand]: true;
}

const mint = (on: boolean) => ({ on }) as RoadOn;
let ready = false;

/** Is 0137 here? One catalog lookup; «yes» is remembered, «no» asked again (#472). */
export async function planRoadReady(): Promise<RoadOn> {
  if (ready) return mint(true);
  try {
    const rows = (await db.execute(sql`
      SELECT to_regclass('public.plan_line_road') IS NOT NULL
         AND to_regclass('public.plan_road_claims') IS NOT NULL AS ok`)) as unknown as { ok: boolean }[];
    ready = rows[0]?.ok === true;
  } catch (err) {
    logger.error({ err }, '[plan-road] readiness probe failed');
    return mint(false);
  }
  return mint(ready);
}

/** Only for a test that proves the off branch. */
export function forgetPlanRoadReady(): void {
  ready = false;
}

/** The off value, for a test that proves what a server without 0137 does. */
export function roadOffForTest(): RoadOn {
  return mint(false);
}

// ---------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------

const shelfList = sql.join(
  PLANNABLE_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * A ROAD carton for warehouse `w` (1a): loose, `in_transit` on a truck that has
 * departed towards `w` and is not yet unloaded there — `in_transit`, or
 * `arrived` at the gate. A truck still loading at Yiwu is not «on the road».
 */
export function roadCartonSql(box: string, w: SQL): SQL {
  const b = sql.raw(box);
  return sql`(${b}.crate_id IS NULL AND ${b}.status = 'in_transit' AND EXISTS (
    SELECT 1 FROM batches rib
     WHERE rib.id = ${b}.current_batch_id AND rib.dest_warehouse_id = ${w}
       AND rib.status IN ('in_transit', 'arrived')))`;
}

/** A carton free on `w`'s shelf for a plan: loose, a shelf status, at `w`. */
export function shelfCartonSql(box: string, w: SQL): SQL {
  const b = sql.raw(box);
  return sql`(${b}.crate_id IS NULL AND ${b}.status IN (${shelfList}) AND ${b}.current_warehouse_id = ${w})`;
}

/**
 * A carton truck `batch`'s plan has NOT reserved before — the only kind a road
 * claim for that truck may take. One its plan reserved (the approval's shelf
 * part, an earlier claim, the count door's re-reservation — every one writes
 * `plan_approved` with the truck's ref) and a removal or a give-back put back
 * on the shelf is the plan's own cargo: claimed again, it spent a second unit
 * of the road's owed while the carton it stood for stayed on the shelf, and the
 * truck left short with nothing reported (review locks#0, numbers#3).
 */
export function claimableForSql(box: string, batch: SQL): SQL {
  const b = sql.raw(box);
  return sql`NOT EXISTS (
    SELECT 1 FROM box_movements rbm
     WHERE rbm.box_id = ${b}.id AND rbm.ref_type = 'batch' AND rbm.ref_id = ${batch}
       AND rbm.cause = 'plan_approved')`;
}

/**
 * The lines that still owe lot `lot` onto a truck at origin `w`: an approved,
 * current version of a plan that is approved or loading, its truck still
 * forming or loading. Aliases: `plr`, `pl`, `pv`, `p`, `ob` (the truck).
 */
function owingLinesFrom(w: SQL, lot: SQL): SQL {
  return sql`plan_line_road plr
    JOIN load_plan_lines pl ON pl.id = plr.line_id
    JOIN load_plan_versions pv ON pv.id = pl.version_id
    JOIN load_plans p ON p.id = pv.plan_id
    JOIN batches ob ON ob.id = p.batch_id
   WHERE p.origin_warehouse_id = ${w} AND pl.lot_id = ${lot} AND pl.crate_id IS NULL
     AND p.status IN ('approved', 'loading') AND pv.agent_verdict = 'approved'
     AND pv.version_no = p.current_version_no
     AND ob.status IN ('forming', 'loading')
     AND plr.road_owed > 0`;
}

/**
 * One origin's road lock (docs/YOLDAGI-YUK.md §3) — between the approval and the
 * landing hook ONLY. The approval takes it before its first carton read; the
 * hook takes it last, holding nothing but the cartons it is landing, whose
 * committed version no shelf predicate matches — so neither waits on the other
 * while holding what the other needs. The count door and the phone's claim do
 * not take it: their claim is the plan-line row's own lock.
 */
export async function roadLock(tx: Tx, warehouseId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('plan-road'), hashtext(${warehouseId}::text))`);
}

export interface LotSplit {
  /** Free on the origin's shelf (the plan's own sentence, `availableByLot`'s). */
  shelf: number;
  /** Road cartons of the lot bound for the origin. */
  road: number;
  /** What approved plans at the origin still owe of it. */
  owed: number;
  /** `road − owed`, floored: what a new plan may still promise from the road. */
  roadFree: number;
}

/**
 * Shelf and road for a set of lots at `w`, in ONE statement — one snapshot, so
 * a landing that commits between two reads cannot be counted on both sides
 * (objection editor#3). A pending plan holds nothing here, on the shelf or on
 * the road (counts#6): only an approved plan's owed is subtracted.
 */
export async function lotSplitAt(
  exec: Db | Tx,
  warehouseId: string,
  lotIds: readonly string[],
): Promise<Map<string, LotSplit>> {
  if (lotIds.length === 0) return new Map();
  const w = sql`${warehouseId}::uuid`;
  const rows = (await exec.execute(sql`
    SELECT l.id AS lot_id,
      (SELECT count(*) FROM boxes b WHERE b.lot_id = l.id AND ${shelfCartonSql('b', w)})::int AS shelf,
      (SELECT count(*) FROM boxes b WHERE b.lot_id = l.id AND ${roadCartonSql('b', w)})::int AS road,
      (SELECT coalesce(sum(plr.road_owed), 0) FROM ${owingLinesFrom(w, sql`l.id`)})::int AS owed
      FROM receipt_lots l
     WHERE l.id IN (${sql.join(
       lotIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
  `)) as unknown as { lot_id: string; shelf: number; road: number; owed: number }[];
  return new Map(
    rows.map((r) => [
      r.lot_id,
      {
        shelf: Number(r.shelf),
        road: Number(r.road),
        owed: Number(r.owed),
        roadFree: Math.max(0, Number(r.road) - Number(r.owed)),
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// The writers
// ---------------------------------------------------------------------------

/** `submitPlan`'s write: the road part of each line (owed 0 until the approval). */
export async function writeRoadParts(
  tx: Tx,
  parts: readonly { lineId: string; roadBoxCount: number }[],
): Promise<void> {
  const rows = parts.filter((p) => p.roadBoxCount > 0);
  if (rows.length === 0) return;
  await tx.execute(sql`
    INSERT INTO plan_line_road (line_id, road_box_count)
    VALUES ${sql.join(
      rows.map((p) => sql`(${p.lineId}::uuid, ${p.roadBoxCount})`),
      sql`, `,
    )}
  `);
}

/** The road parts of a version's lines (line id → road part), for the approval and the resubmit. */
export async function roadPartsOfVersion(exec: Db | Tx, versionId: string): Promise<Map<string, number>> {
  const rows = (await exec.execute(sql`
    SELECT plr.line_id, plr.road_box_count FROM plan_line_road plr
      JOIN load_plan_lines pl ON pl.id = plr.line_id
     WHERE pl.version_id = ${versionId}::uuid
  `)) as unknown as { line_id: string; road_box_count: number }[];
  return new Map(rows.map((r) => [r.line_id, Number(r.road_box_count)]));
}

/** The approval's write: what each line still owes once the shelf part is reserved. */
export async function setRoadOwed(tx: Tx, lineId: string, owed: number): Promise<void> {
  await tx.execute(sql`UPDATE plan_line_road SET road_owed = ${owed} WHERE line_id = ${lineId}::uuid`);
}

/**
 * Reserve `boxes` onto truck `batchId` for `lineId` — the approval's exact
 * shape (planned, the truck, one `plan_approved` movement from = to = the
 * shelf, its status recorded so every give-back reads it with `shelfBefore`),
 * plus the claim row naming the truck it landed off.
 */
async function reserveClaimed(
  tx: Tx,
  a: {
    lineId: string;
    batchId: string;
    warehouseId: string;
    boxes: readonly { id: string; status: string }[];
    inboundBatchId: string | null;
    actorId: string;
  },
): Promise<void> {
  if (a.boxes.length === 0) return;
  const ids = sql.join(
    a.boxes.map((b) => sql`${b.id}::uuid`),
    sql`, `,
  );
  await tx.execute(sql`
    UPDATE boxes SET status = 'planned', current_batch_id = ${a.batchId}::uuid
     WHERE id IN (${ids})
  `);
  await tx.execute(sql`
    INSERT INTO box_movements
      (box_id, from_warehouse_id, to_warehouse_id, from_status, to_status, cause, ref_type, ref_id, actor_id)
    VALUES ${sql.join(
      a.boxes.map(
        (b) => sql`(${b.id}::uuid, ${a.warehouseId}::uuid, ${a.warehouseId}::uuid, ${b.status}, 'planned',
                    'plan_approved', 'batch', ${a.batchId}::uuid, ${a.actorId}::uuid)`,
      ),
      sql`, `,
    )}
  `);
  await tx.execute(sql`
    INSERT INTO plan_road_claims (line_id, box_id, inbound_batch_id)
    VALUES ${sql.join(
      a.boxes.map((b) => sql`(${a.lineId}::uuid, ${b.id}::uuid, ${a.inboundBatchId}::uuid)`),
      sql`, `,
    )}
    ON CONFLICT (line_id, box_id) DO UPDATE SET inbound_batch_id = EXCLUDED.inbound_batch_id,
                                                claimed_at = now()
  `);
}

/**
 * One claim of up to `k` against a line: the row's lock IS the serialisation.
 * It takes what the line owes NOW, read under that lock — never «exactly `k`
 * or nothing»: a concurrent claim that took one first left a `road_owed >= k`
 * update matching no row, and the claimer gave up with the line still owing
 * and the cartons free on the shelf (review locks#2). Returns how many it took.
 */
async function takeOwed(tx: Tx, lineId: string, k: number): Promise<number> {
  const rows = (await tx.execute(sql`
    SELECT road_owed FROM plan_line_road WHERE line_id = ${lineId}::uuid FOR UPDATE
  `)) as unknown as { road_owed: number }[];
  const take = Math.min(k, Number(rows[0]?.road_owed ?? 0));
  if (take <= 0) return 0;
  await tx.execute(sql`
    UPDATE plan_line_road SET road_owed = road_owed - ${take} WHERE line_id = ${lineId}::uuid
  `);
  return take;
}

/** Of `cartons`, the ones truck `batchId` may claim (`claimableForSql`), in their order. */
async function claimableFor<C extends { id: string }>(tx: Tx, batchId: string, cartons: readonly C[]): Promise<C[]> {
  if (cartons.length === 0) return [];
  const rows = (await tx.execute(sql`
    SELECT b.id FROM boxes b
     WHERE b.id IN (${sql.join(
       cartons.map((c) => sql`${c.id}::uuid`),
       sql`, `,
     )})
       AND ${claimableForSql('b', sql`${batchId}::uuid`)}
  `)) as unknown as { id: string }[];
  const ok = new Set(rows.map((r) => r.id));
  return cartons.filter((c) => ok.has(c.id));
}

interface OwingLine {
  lineId: string;
  batchId: string;
  owed: number;
}

async function owingLines(tx: Tx, warehouseId: string, lotId: string, batchId?: string): Promise<OwingLine[]> {
  const rows = (await tx.execute(sql`
    SELECT plr.line_id, ob.id AS batch_id, plr.road_owed
      FROM ${owingLinesFrom(sql`${warehouseId}::uuid`, sql`${lotId}::uuid`)}
       ${batchId ? sql`AND ob.id = ${batchId}::uuid` : sql``}
     ORDER BY pv.verdict_recorded_at, plr.line_id
  `)) as unknown as { line_id: string; batch_id: string; road_owed: number }[];
  return rows.map((r) => ({ lineId: r.line_id, batchId: r.batch_id, owed: Number(r.road_owed) }));
}

/**
 * Hand `cartons` (of one lot, held by the caller, free on `w`'s shelf) to the
 * lines that owe their lot — oldest approval first; each line takes what it
 * owes at its own lock (`takeOwed`), and only cartons its truck never reserved
 * (`claimableForSql`). Returns how many were claimed.
 */
async function claimInto(
  tx: Tx,
  a: {
    warehouseId: string;
    lotId: string;
    cartons: { id: string; status: string; seq: number }[];
    inboundBatchId: string | null;
    actorId: string;
    onlyBatchId?: string;
  },
): Promise<number> {
  const left = [...a.cartons].sort((x, y) => x.seq - y.seq);
  let claimed = 0;
  // Bounded: every pass either claims at least one carton or ends.
  for (let pass = 0; pass < 50 && left.length > 0; pass++) {
    const lines = await owingLines(tx, a.warehouseId, a.lotId, a.onlyBatchId);
    if (lines.length === 0) break;
    let moved = false;
    for (const line of lines) {
      const eligible = await claimableFor(tx, line.batchId, left);
      if (eligible.length === 0) continue;
      const took = await takeOwed(tx, line.lineId, eligible.length);
      if (took <= 0) continue;
      const take = eligible.slice(0, took);
      const taken = new Set(take.map((c) => c.id));
      left.splice(0, left.length, ...left.filter((c) => !taken.has(c.id)));
      await reserveClaimed(tx, {
        lineId: line.lineId,
        batchId: line.batchId,
        warehouseId: a.warehouseId,
        boxes: take,
        inboundBatchId: a.inboundBatchId,
        actorId: a.actorId,
      });
      claimed += took;
      moved = true;
      if (left.length === 0) break;
    }
    if (!moved) break;
  }
  return claimed;
}

/**
 * The landing hook (3a): cartons this call has just put on `w`'s shelf are
 * reserved onto the trucks whose plans owe their lot, in the landing's own
 * transaction — so they appear in the loader's list the moment they land.
 *
 * `landed` is what THIS call moved (never an office over-count's cartons — they
 * were taken from the inbound origin or minted, and `undoOver` must find them
 * on the shelf). The caller holds them. The cheap unlocked question first: no
 * live plan at `w` has a road line for these lots → nothing, and no lock.
 */
export async function claimLandedForRoadTx(
  tx: Tx,
  road: RoadOn,
  a: {
    warehouseId: string;
    landed: readonly { id: string; lotId: string; crateId: string | null }[];
    inboundBatchId: string | null;
    actorId: string;
  },
): Promise<number> {
  if (!road.on) return 0;
  const loose = a.landed.filter((b) => b.crateId === null);
  if (loose.length === 0) return 0;
  const lotIds = [...new Set(loose.map((b) => b.lotId))];
  const lotList = sql.join(
    lotIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const live = (await tx.execute(sql`
    SELECT 1 FROM plan_line_road plr
      JOIN load_plan_lines pl ON pl.id = plr.line_id
      JOIN load_plan_versions pv ON pv.id = pl.version_id
      JOIN load_plans p ON p.id = pv.plan_id
     WHERE p.origin_warehouse_id = ${a.warehouseId}::uuid AND pl.lot_id IN (${lotList})
       AND p.status IN ('pending_agent', 'approved', 'loading')
       AND pv.version_no = p.current_version_no
     LIMIT 1
  `)) as unknown as unknown[];
  if (live.length === 0) return 0;
  await roadLock(tx, a.warehouseId);
  // Read the cartons as they stand now — still free on this shelf, still loose.
  const ids = sql.join(
    loose.map((b) => sql`${b.id}::uuid`),
    sql`, `,
  );
  const cartons = (await tx.execute(sql`
    SELECT b.id, b.lot_id, b.status, b.seq_in_lot FROM boxes b
     WHERE b.id IN (${ids}) AND ${shelfCartonSql('b', sql`${a.warehouseId}::uuid`)}
  `)) as unknown as { id: string; lot_id: string; status: string; seq_in_lot: number }[];
  let claimed = 0;
  for (const lotId of lotIds) {
    claimed += await claimInto(tx, {
      warehouseId: a.warehouseId,
      lotId,
      cartons: cartons
        .filter((c) => c.lot_id === lotId)
        .map((c) => ({ id: c.id, status: c.status, seq: Number(c.seq_in_lot) })),
      inboundBatchId: a.inboundBatchId,
      actorId: a.actorId,
    });
  }
  return claimed;
}

/**
 * The loading-time claim (self-healing, objection counts#1): free cartons of a
 * lot truck `batchId` still owes, standing on its origin's shelf however they
 * got there, are reserved onto it — the count door before it computes, the
 * phone's scan of one such carton. The caller holds the cartons (FOR UPDATE)
 * and the truck's loading lock; no road lock (the line's row is the claim).
 */
export async function claimFromShelfTx(
  tx: Tx,
  road: RoadOn,
  a: {
    batchId: string;
    warehouseId: string;
    lotId: string;
    /** The cartons to consider — the count door's locked shelf rows, or the one the phone scanned. */
    cartons: readonly { id: string; status: string; seq: number }[];
    actorId: string;
  },
): Promise<number> {
  if (!road.on || a.cartons.length === 0) return 0;
  return claimInto(tx, {
    warehouseId: a.warehouseId,
    lotId: a.lotId,
    cartons: [...a.cartons],
    inboundBatchId: null,
    actorId: a.actorId,
    onlyBatchId: a.batchId,
  });
}

/** What truck `batchId`'s plan still owes of `lotId` (0 = nothing, or no road part). */
export async function owedOnTruck(tx: Db | Tx, road: RoadOn, batchId: string, lotId?: string): Promise<number> {
  if (!road.on) return 0;
  const rows = (await tx.execute(sql`
    SELECT coalesce(sum(plr.road_owed), 0)::int AS n
      FROM plan_line_road plr
      JOIN load_plan_lines pl ON pl.id = plr.line_id
      JOIN load_plan_versions pv ON pv.id = pl.version_id
      JOIN load_plans p ON p.id = pv.plan_id
     WHERE p.batch_id = ${batchId}::uuid AND pv.agent_verdict = 'approved'
       AND pv.version_no = p.current_version_no
       ${lotId ? sql`AND pl.lot_id = ${lotId}::uuid` : sql``}
  `)) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

export interface RoadMissed {
  lotId: string;
  missed: number;
}

/**
 * The doors that end truck `batchId`'s loading — «yuklash tugadi», the cancel —
 * move what is still owed into MISSED, first thing after the truck's lock (4a).
 * Never zeroed and forgotten: the count door subtracts it for the truck's whole
 * life, or «Hammasi» would ask for it again and mint cartons that later land as
 * duplicates (objection counts#0).
 */
export async function closeRoadOwedTx(tx: Tx, road: RoadOn, batchId: string): Promise<RoadMissed[]> {
  if (!road.on) return [];
  const rows = (await tx.execute(sql`
    WITH owing AS (
      SELECT plr.line_id, plr.road_owed, pl.lot_id
        FROM plan_line_road plr
        JOIN load_plan_lines pl ON pl.id = plr.line_id
        JOIN load_plan_versions pv ON pv.id = pl.version_id
        JOIN load_plans p ON p.id = pv.plan_id
       WHERE p.batch_id = ${batchId}::uuid AND pv.agent_verdict = 'approved'
         AND pv.version_no = p.current_version_no AND plr.road_owed > 0
       ORDER BY plr.line_id
         FOR UPDATE OF plr
    )
    UPDATE plan_line_road u SET road_missed = u.road_missed + owing.road_owed, road_owed = 0
      FROM owing WHERE u.line_id = owing.line_id
    RETURNING owing.lot_id, owing.road_owed AS missed
  `)) as unknown as { lot_id: string; missed: number }[];
  const byLot = new Map<string, number>();
  for (const r of rows) byLot.set(r.lot_id, (byLot.get(r.lot_id) ?? 0) + Number(r.missed));
  return [...byLot].map(([lotId, missed]) => ({ lotId, missed }));
}

/**
 * The road's correction to the plan number of truck `batchId` for one lot:
 * `Σ (owed + missed)` — the part of the plan that cannot be on the truck now.
 * The count door subtracts it (§9).
 */
export function roadNotHereSql(lineAlias: string): SQL {
  const pl = sql.raw(lineAlias);
  return sql`coalesce((SELECT plr.road_owed + plr.road_missed FROM plan_line_road plr WHERE plr.line_id = ${pl}.id), 0)`;
}

/**
 * The claimed cartons among `boxIds` that `batchId`'s loading gave back, with
 * the client and the truck each one landed off — a give-back to
 * `ready_for_pickup` re-announces them (§8: reserved onward in the landing's
 * own transaction, they were never «ready» and never announced).
 */
export async function claimedLandingsOf(
  tx: Tx,
  road: RoadOn,
  batchId: string,
  boxIds: readonly string[],
): Promise<{ boxId: string; clientId: string | null; inboundBatchId: string }[]> {
  if (!road.on || boxIds.length === 0) return [];
  const rows = (await tx.execute(sql`
    SELECT DISTINCT c.box_id, r.client_id, c.inbound_batch_id
      FROM plan_road_claims c
      JOIN load_plan_lines pl ON pl.id = c.line_id
      JOIN load_plan_versions pv ON pv.id = pl.version_id
      JOIN load_plans p ON p.id = pv.plan_id
      JOIN boxes b ON b.id = c.box_id
      JOIN receipt_lots l ON l.id = b.lot_id
      JOIN receipts r ON r.id = l.receipt_id
     WHERE p.batch_id = ${batchId}::uuid AND c.inbound_batch_id IS NOT NULL
       AND c.box_id IN (${sql.join(
         boxIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
  `)) as unknown as { box_id: string; client_id: string | null; inbound_batch_id: string }[];
  return rows.map((r) => ({ boxId: r.box_id, clientId: r.client_id, inboundBatchId: r.inbound_batch_id }));
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** Codes shipped for a truck's owed lots, over the whole snapshot (said when it bites). */
export const ROAD_CODES_CAP = 2000;

/** The loading snapshot's road half (`roadOwedForTruck`). */
export interface RoadSnapshot {
  lots: RoadOwedLot[];
  /** Free on the origin's shelf and claimable by this truck. */
  shelf: { code: string; lotId: string }[];
  /** Still on an inbound truck, with that truck's code. */
  inbound: { code: string; truck: string }[];
  capped: boolean;
}

export interface RoadOwedLot {
  lotId: string;
  /** «GS777-A», the label every screen prints. */
  label: string;
  owed: number;
  /** The inbound trucks its road cartons are on, by code. */
  trucks: string[];
}

/**
 * What truck `batchId`'s plan still owes from the road, per lot, and the codes
 * of its lots' cartons in two kinds — free on the origin's shelf and claimable
 * by this truck (the phone accepts one while it has taken fewer of that lot
 * than the lot owes, and the server claims it), and still on an inbound truck
 * (the phone refuses it at once, naming that truck: accepted green and taken
 * back at the flush, a carton physically loaded went unrecorded — #221, review
 * numbers#5). So a road carton never opens the red «not on plan».
 */
export async function roadOwedForTruck(
  exec: Db | Tx,
  road: RoadOn,
  batchId: string,
  originId: string,
): Promise<RoadSnapshot> {
  const none: RoadSnapshot = { lots: [], shelf: [], inbound: [], capped: false };
  if (!road.on) return none;
  const owed = (await exec.execute(sql`
    SELECT pl.lot_id, sum(plr.road_owed)::int AS owed, l.letter,
           r.unclaimed_marking AS marking, c.client_code
      FROM plan_line_road plr
      JOIN load_plan_lines pl ON pl.id = plr.line_id
      JOIN load_plan_versions pv ON pv.id = pl.version_id
      JOIN load_plans p ON p.id = pv.plan_id
      JOIN receipt_lots l ON l.id = pl.lot_id
      JOIN receipts r ON r.id = l.receipt_id
      LEFT JOIN clients c ON c.id = r.client_id
     WHERE p.batch_id = ${batchId}::uuid AND pv.agent_verdict = 'approved'
       AND pv.version_no = p.current_version_no AND plr.road_owed > 0
     GROUP BY pl.lot_id, l.letter, r.unclaimed_marking, c.client_code
     ORDER BY l.letter
  `)) as unknown as {
    lot_id: string;
    owed: number;
    letter: string | null;
    marking: string | null;
    client_code: string | null;
  }[];
  if (owed.length === 0) return none;
  const lotList = sql.join(
    owed.map((o) => sql`${o.lot_id}::uuid`),
    sql`, `,
  );
  const w = sql`${originId}::uuid`;
  const cartons = (await exec.execute(sql`
    SELECT b.lot_id, b.short_code, rib.code AS truck
      FROM boxes b
      LEFT JOIN batches rib ON rib.id = b.current_batch_id
     WHERE b.lot_id IN (${lotList})
       AND ((${shelfCartonSql('b', w)} AND ${claimableForSql('b', sql`${batchId}::uuid`)})
            OR ${roadCartonSql('b', w)})
     ORDER BY b.lot_id, b.seq_in_lot
     LIMIT ${ROAD_CODES_CAP + 1}
  `)) as unknown as { lot_id: string; short_code: string; truck: string | null }[];
  const shipped = cartons.slice(0, ROAD_CODES_CAP);
  const trucks = new Map<string, Set<string>>();
  for (const c of cartons) {
    if (!c.truck) continue;
    const set = trucks.get(c.lot_id) ?? new Set<string>();
    set.add(c.truck);
    trucks.set(c.lot_id, set);
  }
  return {
    lots: owed.map((o) => ({
      lotId: o.lot_id,
      label: `${codeIdentity(o.marking, o.client_code).main}-${o.letter ?? '?'}`,
      owed: Number(o.owed),
      trucks: [...(trucks.get(o.lot_id) ?? [])].sort(),
    })),
    shelf: shipped.filter((c) => !c.truck).map((c) => ({ code: c.short_code, lotId: c.lot_id })),
    inbound: shipped.filter((c) => c.truck).map((c) => ({ code: c.short_code, truck: c.truck! })),
    capped: cartons.length > ROAD_CODES_CAP,
  };
}

export interface LineRoad {
  /** The road part as promised. */
  part: number;
  owed: number;
  missed: number;
  /** Cartons claimed onto the truck for it (landed, or taken from the shelf at loading). */
  came: number;
}

/** A version's lines' road parts, line id → the four figures the plan view prints. */
export async function roadOfVersion(exec: Db | Tx, road: RoadOn, versionId: string): Promise<Map<string, LineRoad>> {
  if (!road.on) return new Map();
  const rows = (await exec.execute(sql`
    SELECT plr.line_id, plr.road_box_count, plr.road_owed, plr.road_missed,
           (SELECT count(*) FROM plan_road_claims c WHERE c.line_id = plr.line_id)::int AS came
      FROM plan_line_road plr
      JOIN load_plan_lines pl ON pl.id = plr.line_id
     WHERE pl.version_id = ${versionId}::uuid
  `)) as unknown as { line_id: string; road_box_count: number; road_owed: number; road_missed: number; came: number }[];
  return new Map(
    rows.map((r) => [
      r.line_id,
      {
        part: Number(r.road_box_count),
        owed: Number(r.road_owed),
        missed: Number(r.road_missed),
        came: Number(r.came),
      },
    ]),
  );
}

/** The inbound trucks (by code) carrying each lot's road cartons for `warehouseId` — the agent sheet's «on the road» block. */
export async function roadTrucksByLot(
  exec: Db | Tx,
  road: RoadOn,
  warehouseId: string,
  lotIds: readonly string[],
): Promise<Map<string, string[]>> {
  if (!road.on || lotIds.length === 0) return new Map();
  const rows = (await exec.execute(sql`
    SELECT DISTINCT b.lot_id, rib.code FROM boxes b
      JOIN batches rib ON rib.id = b.current_batch_id
     WHERE b.lot_id IN (${sql.join(
       lotIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND ${roadCartonSql('b', sql`${warehouseId}::uuid`)}
     ORDER BY rib.code
  `)) as unknown as { lot_id: string; code: string }[];
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.lot_id, [...(out.get(r.lot_id) ?? []), r.code]);
  return out;
}

/** What each truck's plan still owes from the road, in ONE grouped statement for a board of trucks (#432). */
export async function roadOwedByTruck(exec: Db | Tx, road: RoadOn, batchIds: readonly string[]): Promise<Map<string, number>> {
  if (!road.on || batchIds.length === 0) return new Map();
  const rows = (await exec.execute(sql`
    SELECT p.batch_id, sum(plr.road_owed)::int AS owed
      FROM plan_line_road plr
      JOIN load_plan_lines pl ON pl.id = plr.line_id
      JOIN load_plan_versions pv ON pv.id = pl.version_id
      JOIN load_plans p ON p.id = pv.plan_id
     WHERE p.batch_id IN (${sql.join(
       batchIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
       AND pv.agent_verdict = 'approved' AND pv.version_no = p.current_version_no AND plr.road_owed > 0
     GROUP BY p.batch_id
  `)) as unknown as { batch_id: string; owed: number }[];
  return new Map(rows.map((r) => [r.batch_id, Number(r.owed)]));
}

/** What truck `batchId`'s plan still owes from the road, per lot (the count panel's rows). */
export async function owedByLotOnTruck(exec: Db | Tx, road: RoadOn, batchId: string): Promise<Map<string, number>> {
  if (!road.on) return new Map();
  const rows = (await exec.execute(sql`
    SELECT pl.lot_id, sum(plr.road_owed)::int AS owed
      FROM plan_line_road plr
      JOIN load_plan_lines pl ON pl.id = plr.line_id
      JOIN load_plan_versions pv ON pv.id = pl.version_id
      JOIN load_plans p ON p.id = pv.plan_id
     WHERE p.batch_id = ${batchId}::uuid AND pv.agent_verdict = 'approved'
       AND pv.version_no = p.current_version_no AND plr.road_owed > 0
     GROUP BY pl.lot_id
  `)) as unknown as { lot_id: string; owed: number }[];
  return new Map(rows.map((r) => [r.lot_id, Number(r.owed)]));
}

/** Does any plan still owe one of `lotIds` from the road? (The annul's refusal.) */
export async function anyRoadOwedFor(exec: Db | Tx, road: RoadOn, lotIds: readonly string[]): Promise<boolean> {
  if (!road.on || lotIds.length === 0) return false;
  const rows = (await exec.execute(sql`
    SELECT 1 FROM plan_line_road plr
      JOIN load_plan_lines pl ON pl.id = plr.line_id
     WHERE plr.road_owed > 0 AND pl.lot_id IN (${sql.join(
       lotIds.map((id) => sql`${id}::uuid`),
       sql`, `,
     )})
     LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/**
 * The road part a truck's loading ended without, for a truck column `batch`
 * (the register's ⤵️ — short «as a short-loaded carton is today», 4a). `0`
 * on a server without 0137.
 */
export function roadMissedSql(road: RoadOn, batch: SQL): SQL {
  if (!road.on) return sql`0`;
  return sql`coalesce((
    SELECT sum(plr.road_missed) FROM plan_line_road plr
      JOIN load_plan_lines pl ON pl.id = plr.line_id
      JOIN load_plan_versions pv ON pv.id = pl.version_id
      JOIN load_plans p ON p.id = pv.plan_id
     WHERE p.batch_id = ${batch} AND pv.version_no = p.current_version_no
  ), 0)`;
}
