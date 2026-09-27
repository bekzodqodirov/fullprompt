import { sql, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../../platform/db/client';
import { qrlessRowSql } from '../labels/qrless-sql';

/*
 * QR-siz qabul va yuklash (0112, the owner's Q1-Q10) — the rules every count
 * door and both scan bodies share. Kept free of the ingest itself so the
 * phone path, the office doors and the screens can all ask the same
 * questions without importing each other.
 */

/**
 * The reasons only a SERVER door writes onto a scan event.
 *
 * A count is recorded as ordinary scan events, through the very same ingest
 * body the phone uses — so the movements, the costing, the claim and the
 * client's «yukingiz keldi» cannot tell an office count from a scan (the
 * owner's Q5: no second proof, the history is the proof). What CAN tell them
 * apart is this reason, and that is why the phone may never write one: a
 * forged `count_load` from an outbox would make a lot «counted» and lock the
 * operators out of it.
 */
export const COUNT_LOAD_REASON = 'count_load' as const;
export const COUNT_ACCEPT_REASON = 'count_accept' as const;
export const COUNT_OVER_REASON = 'count_over' as const;
/** «Hammasini qabul qilish» — a server door since round 45, never a count. */
export const BULK_ACCEPT_REASON = 'bulk_accept' as const;

export const COUNT_REASONS = [COUNT_LOAD_REASON, COUNT_ACCEPT_REASON, COUNT_OVER_REASON] as const;
export const SERVER_SCAN_REASONS = [...COUNT_REASONS, BULK_ACCEPT_REASON] as const;
export type CountReason = (typeof COUNT_REASONS)[number];
export type IngestDoor = (typeof SERVER_SCAN_REASONS)[number];

/** Exact, after trimming — a reason with a space in front is still the reason. */
export function isServerScanReason(r: string | null | undefined): r is IngestDoor {
  if (typeof r !== 'string') return false;
  return (SERVER_SCAN_REASONS as readonly string[]).includes(r.trim());
}

/**
 * What a server door tells the shared ingest body. The sync route passes
 * NOTHING — every field is a door's, and an absent field is the phone's
 * answer.
 */
export interface DoorOpts {
  /** Server doors ONLY; the input's `manualReason` must equal it. */
  door?: IngestDoor;
  /** Resolve the loose box by primary key and assert its short code. */
  boxId?: string;
  /**
   * Suppress the per-input off-plan / undocumented alarm: a count door sends
   * ONE aggregated event per press instead of one per carton.
   */
  quietSpot?: boolean;
  /** Unload: the client arrival notice's claim window, in minutes. */
  noticeWindowMinutes?: number;
}

/**
 * An office count walks a truck lot by lot, often an hour apart; the phone's
 * 20-minute arrival window would send a customer one «yukingiz keldi» per
 * lot. «Tushirish tugadi» still releases the notice at once.
 */
export const OFFICE_NOTICE_WINDOW_MINUTES = 90;

export type CountSide = 'load' | 'unload' | 'any';

/** Which count reasons make a lot «counted» on one side of a truck. */
export function countReasonsFor(side: CountSide): readonly CountReason[] {
  if (side === 'load') return [COUNT_LOAD_REASON];
  if (side === 'unload') return [COUNT_ACCEPT_REASON, COUNT_OVER_REASON];
  return COUNT_REASONS;
}

function reasonList(reasons: readonly string[]): SQL {
  return sql.join(
    reasons.map((r) => sql`${r}`),
    sql`, `,
  );
}

/**
 * A count press can wait behind a phone holding one of its rows; ten seconds
 * and it answers «busy, press again» instead of hanging the office screen.
 */
export async function setCountLockTimeout(tx: Tx): Promise<void> {
  await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
}

/**
 * One loading change at a time per truck: a count press, «yuklash tugadi»,
 * departure, a removal and a cancel all take this first, so a count cannot
 * read a truck that «yuklash tugadi» is half-way through emptying.
 */
export async function lockTruckLoading(tx: Tx, batchId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('truck-load'), hashtext(${batchId}::text))`,
  );
}

/**
 * One unload change at a time per LOT on a truck: the office count and a
 * phone's first scan of the same lot must not both decide «nobody has
 * counted this yet».
 */
export async function lockLotOnTruck(tx: Tx, batchId: string, lotId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('unload-lot'), hashtext(${`${batchId}:${lotId}`}::text))`,
  );
}

/** The count events of one side of a truck — loose cartons only (alias `cse`). */
function countEventsWhere(batchId: string, side: CountSide): SQL {
  return sql`cse.batch_id = ${batchId}::uuid
    AND cse.crate_id IS NULL
    AND cse.manual_reason IN (${reasonList(countReasonsFor(side))})`;
}

/**
 * Q4 — «this lot was counted on this truck», ONE home. Only loose cartons
 * count: a crate is scanned (or pressed) as the crate, and its events never
 * make its members' lot «counted».
 */
export function countedOnTruckSql(batchId: string, lotId: SQL, side: CountSide): SQL {
  return sql`EXISTS (
    SELECT 1 FROM scan_events cse
    JOIN boxes cb ON cb.id = cse.box_id
    WHERE ${countEventsWhere(batchId, side)}
      AND cb.lot_id = ${lotId}
  )`;
}

/**
 * «This truck's rows» (alias `qb`): the cartons pointing at it — and, on a
 * quick truck at loading, the loose cartons at its origin, since a quick
 * truck has no plan to reserve them first.
 */
function truckRowsSql(batchId: string, quickOriginId: string | null): SQL {
  return quickOriginId
    ? sql`(qb.current_batch_id = ${batchId}::uuid
        OR (qb.current_warehouse_id = ${quickOriginId}::uuid
          AND qb.status IN ('in_stock', 'ready_for_pickup')))`
    : sql`qb.current_batch_id = ${batchId}::uuid`;
}

/** A scan event a PHONE made: a QR, or a typed code under a person's own reason. */
export function isPhoneScanSql(alias: string): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.method = 'qr' OR (${a}.method = 'manual'
    AND (${a}.manual_reason IS NULL OR ${a}.manual_reason NOT IN (${reasonList(SERVER_SCAN_REASONS)}))))`;
}

/**
 * The stocktake's guard: the box's latest load/unload WITNESS was a count.
 * A counted pile has no per-carton witness, so «not scanned at the
 * stocktake» says nothing about whether it is standing there. Pass the table
 * reference (`sql\`${boxes}\``), never a column (#128).
 *
 * Two kinds of event are not witnesses and are skipped. «Hammasini qabul
 * qilish» (`bulk_accept`) is the door that lands a load-counted lot the
 * phone was refused — reading it as «the latest event» un-guarded exactly
 * the pile the round promised never to write off (review cargo-2 /
 * phone-1). And a crate event: a crate is scanned — or pressed «(1 joy)» —
 * as the crate, its CR- label is the witness, and counting its members as
 * count-moved kept a really-missing pallet off every write-off for ever
 * (review cargo-5), the rule `countedOnTruckSql` already keeps.
 */
export function lastScanIsCountSql(boxRef: SQL): SQL {
  return sql`COALESCE((
    SELECT lse.manual_reason IN (${reasonList(COUNT_REASONS)})
    FROM scan_events lse
    WHERE lse.box_id = ${boxRef}.id AND lse.type IN ('load', 'unload')
      AND lse.crate_id IS NULL
      AND lse.manual_reason IS DISTINCT FROM ${BULK_ACCEPT_REASON}
    ORDER BY lse.created_at DESC, lse.scanned_at DESC, lse.id DESC
    LIMIT 1
  ), false)`;
}

export type LotMode = 'counted' | 'qrless' | null;

/**
 * Why a lot is office-only on this truck, in one SELECT, or null.
 *
 * `counted` wins over `qrless`: once the office has counted a lot the phone
 * has nothing to add either way. `qrless` is the owner's «never mixed» (Q4 ×
 * Q8): a lot with ANY stickerless loose carton among this truck's rows is
 * counted by the office as a whole, or the stickered half would be scanned,
 * the rest counted, and the two would never add up to the lot.
 *
 * «This truck's rows»: the cartons pointing at it — and, on a quick truck at
 * loading, the loose cartons at its origin, since a quick truck has no plan
 * to reserve them first. The handle is REQUIRED: the answer must come from
 * the caller's own transaction, holding its locks (#714).
 */
export async function lotModeOnTruck(
  exec: Db | Tx,
  a: {
    batchId: string;
    lotId: string;
    side: 'load' | 'unload';
    countedSide: CountSide;
    quickOriginId: string | null;
  },
): Promise<LotMode> {
  const rows = (await exec.execute(sql`
    SELECT
      ${countedOnTruckSql(a.batchId, sql`${a.lotId}::uuid`, a.countedSide)} AS counted,
      EXISTS (
        SELECT 1 FROM boxes qb
        JOIN receipt_lots ql ON ql.id = qb.lot_id
        WHERE qb.lot_id = ${a.lotId}::uuid
          AND ${truckRowsSql(a.batchId, a.side === 'load' ? a.quickOriginId : null)}
          AND ${qrlessRowSql(sql`qb`, sql`ql`)}
      ) AS qrless
  `)) as unknown as { counted: boolean; qrless: boolean }[];
  const row = rows[0];
  if (row?.counted) return 'counted';
  if (row?.qrless) return 'qrless';
  return null;
}

/**
 * `lotModeOnTruck` for every lot of a truck at once — what the scan screens'
 * snapshot ships so the phone can refuse a count-only lot before the server
 * does, offline. The same two fragments, so the phone and the server can
 * never disagree about which lot is the office's (#513). `counted` wins.
 */
export async function countOnlyLotsOnTruck(
  exec: Db | Tx,
  a: { batchId: string; side: 'load' | 'unload'; countedSide: CountSide; quickOriginId: string | null },
): Promise<Map<string, Exclude<LotMode, null>>> {
  const rows = (await exec.execute(sql`
    SELECT DISTINCT cb.lot_id AS lot_id, 'counted' AS mode
    FROM scan_events cse
    JOIN boxes cb ON cb.id = cse.box_id
    WHERE ${countEventsWhere(a.batchId, a.countedSide)}
    UNION ALL
    SELECT DISTINCT qb.lot_id AS lot_id, 'qrless' AS mode
    FROM boxes qb
    JOIN receipt_lots ql ON ql.id = qb.lot_id
    WHERE ${truckRowsSql(a.batchId, a.side === 'load' ? a.quickOriginId : null)}
      AND ${qrlessRowSql(sql`qb`, sql`ql`)}
  `)) as unknown as { lot_id: string; mode: 'counted' | 'qrless' }[];
  const out = new Map<string, Exclude<LotMode, null>>();
  for (const r of rows) {
    if (r.mode === 'counted' || !out.has(r.lot_id)) out.set(r.lot_id, r.mode);
  }
  return out;
}
