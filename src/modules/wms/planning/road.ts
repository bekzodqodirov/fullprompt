import { sql, type SQL } from 'drizzle-orm';
import { db, type Db, type Tx } from '../../platform/db/client';
import { logger } from '../../platform/logger';
import { PLANNABLE_STATUSES } from '../boxes/shelf';

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

/** One claim of `k` against a line: the row's lock IS the serialisation. Null = the line no longer owes `k`. */
async function takeOwed(tx: Tx, lineId: string, k: number): Promise<boolean> {
  const rows = (await tx.execute(sql`
    UPDATE plan_line_road SET road_owed = road_owed - ${k}
     WHERE line_id = ${lineId}::uuid AND road_owed >= ${k}
    RETURNING line_id
  `)) as unknown as { line_id: string }[];
  return rows.length > 0;
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
 * lines that owe their lot — oldest approval first; a line that raced to zero
 * makes the next one be read again (objection locks#6). Returns how many were
 * claimed.
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
      const k = Math.min(line.owed, left.length);
      if (k <= 0) continue;
      if (!(await takeOwed(tx, line.lineId, k))) continue;
      const take = left.splice(0, k);
      await reserveClaimed(tx, {
        lineId: line.lineId,
        batchId: line.batchId,
        warehouseId: a.warehouseId,
        boxes: take,
        inboundBatchId: a.inboundBatchId,
        actorId: a.actorId,
      });
      claimed += k;
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
