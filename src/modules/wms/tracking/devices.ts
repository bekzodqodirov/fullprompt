import { cache } from 'react';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import { batches, driverDevices, driverPositions } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { FRESH_MINUTES, type BorderPost } from './engine';
import { GATE_RADIUS_DEG, gateYard, HELD_QUEUE_RADIUS_DEG, isHeldQueue, type PlacementFix } from './eta';
import { routeFor } from './map-data';

/**
 * Driver phone pairing + position ingest (owner's flow): at loading, the
 * warehouse worker installs the app on the driver's phone, types the trip's
 * pair code once, and the phone streams fixes for THAT trip only. Pairing is
 * trip-scoped, so tracking ends by itself when the cargo is delivered.
 */

export class TrackingError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** Ambiguous characters (0/O, 1/I) are out — the code is read off a screen. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newPairCode(): string {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

// The freshness line lives with the engine (pure — eta.ts judges it); the
// silent-truck sweep and the tests read it from here as they always did.
export { FRESH_MINUTES };

/**
 * Every trip is born with a code (owner: "code shu plan yaratilgani o'zida
 * yaratilib bu sarlavhaga yozib qo'yilsa bo'ladimi").
 *
 * It rides in the same transaction as the batch, so there is no window where a
 * trip exists without one: the loader reads it off the batch header while the
 * driver is still at the gate instead of hunting for a button. Pairing burns
 * the code, which is why the manual "new code" button stays.
 */
export async function mintBatchPairCode(dbOrTx: Db | Tx, batchId: string, actorId: string) {
  const [row] = await dbOrTx
    .insert(driverDevices)
    .values({ batchId, pairCode: newPairCode(), createdBy: actorId })
    .returning();
  return row!;
}

/** Mint a pairing code for a trip. The phone exchanges it for a token. */
export async function createDriverDevice(
  input: { batchId: string; label?: string | null },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new TrackingError('unauthenticated');
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, input.batchId) });
  if (!batch) throw new TrackingError('batch_not_found');
  if (['closed', 'cancelled'].includes(batch.status)) throw new TrackingError('batch_closed');

  const [row] = await db
    .insert(driverDevices)
    .values({
      batchId: input.batchId,
      label: input.label || null,
      pairCode: newPairCode(),
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'driver_device',
    entityId: row!.id,
    action: 'create',
    after: { batchId: input.batchId, label: input.label ?? null },
  });
  return row!;
}

export async function revokeDriverDevice(deviceId: string, ctx: AuditContext) {
  if (!ctx.actorId) throw new TrackingError('unauthenticated');
  const device = await db.query.driverDevices.findFirst({
    where: eq(driverDevices.id, deviceId),
  });
  if (!device || device.revokedAt) return;
  // The pair code goes; the token hash stays so the phone can be TOLD the
  // trip is over (410) instead of being met with a 401 it retries for ever.
  await db
    .update(driverDevices)
    .set({ revokedAt: new Date(), pairCode: null })
    .where(eq(driverDevices.id, deviceId));
  await writeAudit(db, ctx, {
    entityType: 'driver_device',
    entityId: deviceId,
    action: 'void',
    after: { batchId: device.batchId },
  });
}

/**
 * The app sends the pair code once and gets a long-lived trip token back.
 * Single use: the code is cleared, so a screenshot of it is worthless later.
 */
export async function pairDevice(pairCode: string, platform: 'android' | 'other' = 'android') {
  const code = pairCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw new TrackingError('bad_code');
  const device = await db.query.driverDevices.findFirst({
    where: eq(driverDevices.pairCode, code),
  });
  if (!device || device.revokedAt) throw new TrackingError('bad_code');
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, device.batchId) });
  if (!batch || ['closed', 'cancelled'].includes(batch.status)) throw new TrackingError('batch_closed');

  const token = randomBytes(32).toString('base64url');
  await db
    .update(driverDevices)
    .set({ tokenHash: hashToken(token), pairCode: null, pairedAt: new Date(), platform })
    .where(eq(driverDevices.id, device.id));
  return {
    token,
    deviceId: device.id,
    batchCode: batch.code,
    driverName: batch.driverName,
    vehiclePlate: batch.vehiclePlate,
  };
}

/**
 * The ENVELOPE only. A fix is judged one at a time (`readPosition`), never
 * with the batch: the phone sends its queue OLDEST FIRST and deletes a batch
 * only after a 2xx, so a batch refused for one unreadable fix is re-sent with
 * that same fix at its head every cycle — one bad point (a GPS chip reporting
 * a speed no truck reaches) stopped the whole trip's tracking for good, and
 * the only trace on the driver's screen was «HTTP 400» (the owner's report of
 * 2026-11-10: «faqat boshida joylashuvini jonatyabti keyin uzilib qolyabti»).
 * The 400 stays only for a body that is not a batch at all.
 */
export const positionBatchSchema = z.object({
  positions: z.array(z.unknown()).min(1).max(500),
});

/** Why a fix is dropped whole: without a place or a time it is no fix. */
export type PositionDrop = 'not_a_fix' | 'bad_coords' | 'bad_time';

export interface ReadPosition {
  lat: number;
  lon: number;
  accuracyM: number | null;
  speedKmh: number | null;
  recordedAt: Date;
}

/**
 * Plausible bounds of the two OPTIONAL measurements; outside them the
 * measurement is trimmed, never the fix (`readPosition`).
 */
export const POSITION_BOUNDS = { accuracyM: 100_000, speedKmh: 400 } as const;

/** Which optional measurement a fix had trimmed, said in the `[track]` log line. */
export type PositionTrim = 'accuracyM' | 'speedKmh';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const LATEST_FIX_MS = Date.UTC(9999, 11, 31);

/**
 * One fix, read the way the batch is not: a fix with a place and a time is
 * KEPT even when an optional measurement is nonsense, and that measurement is
 * trimmed (`trimmed` names it), because where the truck was is the whole
 * reason the phone exists. The two trims are NOT alike:
 *  - a speed no truck reaches is CLEARED — nothing reads the speed;
 *  - an accuracy that cannot be read or believed becomes the COARSEST one
 *    (`POSITION_BOUNDS.accuracyM`), never null — every reader takes a null
 *    accuracy as a GOOD fix (`COARSE_FIX_M`'s `IS NULL OR`), so clearing it
 *    would promote a cell-tower guess 150 km wide into a placed truck. Coarse,
 *    it stays in the history and places nothing.
 * A fix with no readable place or time is dropped (`why`), and only that
 * fix. The time is anything `Date` reads — the app sends `…Z`, but an offset
 * or epoch milliseconds is the same instant, not a reason to lose it.
 */
export function readPosition(
  raw: unknown,
): { ok: true; position: ReadPosition; trimmed: PositionTrim[] } | { ok: false; why: PositionDrop } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, why: 'not_a_fix' };
  const fix = raw as Record<string, unknown>;
  const { lat, lon } = fix;
  if (!finite(lat) || !finite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return { ok: false, why: 'bad_coords' };
  }
  const at = fix.recordedAt;
  const ms = typeof at === 'string' ? Date.parse(at) : finite(at) ? at : Number.NaN;
  // A time postgres cannot bind would turn the whole batch into a 500 and jam
  // the queue all over again — past year 9999 it refuses it (measured:
  // «time zone displacement out of range»), past ±8.64e15 ms there is no
  // Date at all; and before 1970 is no phone's clock either.
  if (!Number.isFinite(ms) || ms < 0 || ms > LATEST_FIX_MS) return { ok: false, why: 'bad_time' };

  const trimmed: PositionTrim[] = [];
  const plausible = (key: PositionTrim): number | null | 'bad' => {
    const value = fix[key];
    if (value === undefined || value === null) return null;
    if (finite(value) && value >= 0 && value <= POSITION_BOUNDS[key]) return value;
    trimmed.push(key);
    return 'bad';
  };
  const accuracy = plausible('accuracyM');
  const speed = plausible('speedKmh');
  return {
    ok: true,
    position: {
      lat,
      lon,
      accuracyM: accuracy === 'bad' ? POSITION_BOUNDS.accuracyM : accuracy === null ? null : Math.round(accuracy),
      speedKmh: speed === 'bad' ? null : speed,
      recordedAt: new Date(ms),
    },
    trimmed,
  };
}

/** A fix the batch dropped or trimmed, said once per request in the log — the only place the cause can be read. */
function sampleOf(raw: unknown): string {
  try {
    return JSON.stringify(raw).slice(0, 300);
  } catch {
    return String(raw).slice(0, 300);
  }
}

/**
 * Ingest a batch of fixes from one paired phone (the app queues them offline
 * and flushes on reconnect). Duplicates from a re-flush are ignored
 * (0018's `driver_positions_device_time_unique`). Every fix is read on its
 * own (`readPosition`): the readable ones land, the unreadable ones are
 * dropped and COUNTED, and the answer is 2xx either way — so the phone
 * deletes the batch and its queue moves on instead of jamming on one point.
 */
export async function ingestPositions(
  token: string,
  input: z.infer<typeof positionBatchSchema>,
): Promise<{ accepted: number; dropped: number }> {
  const device = await db.query.driverDevices.findFirst({
    where: eq(driverDevices.tokenHash, hashToken(token)),
  });
  if (!device) throw new TrackingError('unauthorized');
  // A REVOKED device is not an intruder — it is a phone whose trip is over,
  // and the difference decides whether it stops or retries for ever. 401 is
  // read by the Android client as a server hiccup: it keeps its queue and
  // tries again every tick, into a SQLite table with no ceiling. 410 is the
  // only answer that makes it call `clearTrip()` and stop the service.
  if (device.revokedAt) throw new TrackingError('trip_finished');
  const batch = await db.query.batches.findFirst({ where: eq(batches.id, device.batchId) });
  if (!batch || ['closed', 'cancelled'].includes(batch.status)) {
    // The trip is over — tell the phone to stop instead of collecting for ever.
    throw new TrackingError('trip_finished');
  }

  const kept: ReadPosition[] = [];
  const drops: Partial<Record<PositionDrop, number>> = {};
  const trims: Partial<Record<PositionTrim, number>> = {};
  let sample: unknown = undefined;
  for (const raw of input.positions) {
    const read = readPosition(raw);
    if (!read.ok) {
      drops[read.why] = (drops[read.why] ?? 0) + 1;
      sample ??= raw;
      continue;
    }
    for (const key of read.trimmed) trims[key] = (trims[key] ?? 0) + 1;
    if (read.trimmed.length) sample ??= raw;
    kept.push(read.position);
  }
  const dropped = input.positions.length - kept.length;
  if (sample !== undefined) {
    console.warn(
      '[track] device',
      device.id,
      'batch',
      batch.code,
      JSON.stringify({ received: input.positions.length, dropped: drops, trimmed: trims }),
      'sample:',
      sampleOf(sample),
    );
  }
  // Nothing readable: no position to store and nothing to tell the silence
  // alarm — a phone that sends only unreadable points still leaves the logist
  // without a truck, so its last_seen_at stays where it was.
  if (!kept.length) return { accepted: 0, dropped };

  const rows = kept.map((p) => ({
    batchId: device.batchId,
    deviceId: device.id,
    lat: String(p.lat),
    lon: String(p.lon),
    accuracyM: p.accuracyM,
    speedKmh: p.speedKmh === null ? null : String(p.speedKmh),
    recordedAt: p.recordedAt,
    source: 'device' as const,
  }));
  const inserted = await db.insert(driverPositions).values(rows).onConflictDoNothing().returning({
    id: driverPositions.id,
  });
  await db
    .update(driverDevices)
    // The phone spoke: any reported silence is over, so a NEW one can be
    // reported again later (round 55's silent-truck alarm).
    .set({ lastSeenAt: new Date(), silentNotifiedAt: null })
    .where(eq(driverDevices.id, device.id));
  return { accepted: inserted.length, dropped };
}

/** Logist's manual pin for phones that cannot stream (iPhone / HarmonyOS). */
export async function addManualPosition(
  input: { batchId: string; lat: number; lon: number; recordedAt?: Date },
  ctx: AuditContext,
) {
  if (!ctx.actorId) throw new TrackingError('unauthenticated');
  const [row] = await db
    .insert(driverPositions)
    .values({
      batchId: input.batchId,
      lat: String(input.lat),
      lon: String(input.lon),
      recordedAt: input.recordedAt ?? new Date(),
      source: 'manual',
      createdBy: ctx.actorId,
    })
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'batch',
    entityId: input.batchId,
    action: 'update',
    after: { manualPosition: { lat: input.lat, lon: input.lon } },
  });
  return row!;
}

export interface LatestPosition {
  batchId: string;
  lat: number;
  lon: number;
  /** When the fix was taken, as far as we can trust it — see `latestPositions`. */
  recordedAt: Date;
  source: string;
  ageMinutes: number;
  fresh: boolean;
  /**
   * When the phone FIRST put the truck at its destination's yard (`gateYard`,
   * `GATE_RADIUS_DEG` — the placement's own test, in SQL), or null. The
   * newest fix says it is at the gate; only this says since when — the clock
   * «standing unloaded for two days» runs on (the board's third recheck: a
   * schedule-based clock flagged a truck the minute it pulled in, or never).
   */
  gateSince: Date | null;
  /**
   * Since when the phone has had it in each HELD queue on its road (Horgos,
   * Yallama — `queueSinceFor`): the first fix within `HELD_QUEUE_RADIUS_DEG`
   * of the post after the last one outside, when there was one outside.
   * The newest fix says it is in the queue; only this says since when, so a
   * phone reporting from the queue does not restart its clock.
   */
  queueSince: Partial<Record<BorderPost, Date>>;
}

/**
 * A fix less accurate than this cannot say which side of a border post a
 * truck stands on (the queue radius is ~5 km), so it places nothing. The
 * phone sends an unknown accuracy as 0, which is kept.
 */
export const COARSE_FIX_M = 5000;

/**
 * Newest fix per batch (device or manual, whichever is more recent).
 *
 * «Newest» by `least(recorded_at, received_at)`: the phone stamps
 * `recorded_at` with its OWN clock and nothing bounds it, so a phone running
 * a day ahead would hand in a fix that stayed «fresh» for a day and outranked
 * every pin pressed meanwhile (the board's review, D2). No fix is newer than
 * the moment it reached us. A coarse fix (`COARSE_FIX_M`) is skipped, so the
 * newest one that can place the truck answers.
 */
export interface PositionTrip {
  id: string;
  originCode: string;
  destCode: string;
  /** The yard's clock counts no fix before it (the origin's yard is not the destination's). */
  departedAt?: Date | null;
  /**
   * An ARRIVED truck: the yard's clock counts no fix after its first unload
   * scan — since when it had stood there when the scan flipped it (the fifth
   * recheck: the first scan reset «4 kundan beri» to «bugun yetib keldi»).
   */
  until?: Date | null;
}

export async function latestPositions(trips: readonly PositionTrip[]): Promise<Map<string, LatestPosition>> {
  if (trips.length === 0) return new Map();
  const batchIds = [...new Set(trips.map((t) => t.id))];
  const at = sql<Date>`least(${driverPositions.recordedAt}, ${driverPositions.receivedAt})`;
  const rows = await db
    .selectDistinctOn([driverPositions.batchId], {
      batchId: driverPositions.batchId,
      lat: driverPositions.lat,
      lon: driverPositions.lon,
      recordedAt: at.mapWith(driverPositions.recordedAt),
      source: driverPositions.source,
    })
    .from(driverPositions)
    .where(
      and(
        inArray(driverPositions.batchId, batchIds),
        sql`(${driverPositions.accuracyM} IS NULL OR ${driverPositions.accuracyM} <= ${COARSE_FIX_M})`,
      ),
    )
    // Equal times (one upload's backlog from a phone whose clock runs ahead
    // all reads `received_at`) fall back to the phone's own order.
    .orderBy(driverPositions.batchId, desc(at), desc(driverPositions.recordedAt), desc(driverPositions.id));

  const [since, queued] = rows.length
    ? await Promise.all([gateSinceFor(trips), queueSinceFor(trips)])
    : [new Map<string, Date>(), new Map<string, Partial<Record<BorderPost, Date>>>()];

  const now = Date.now();
  return new Map(
    rows.map((r) => {
      const ageMinutes = Math.round((now - r.recordedAt.getTime()) / 60_000);
      return [
        r.batchId,
        {
          batchId: r.batchId,
          lat: Number(r.lat),
          lon: Number(r.lon),
          recordedAt: r.recordedAt,
          source: r.source,
          ageMinutes,
          fresh: ageMinutes <= FRESH_MINUTES,
          gateSince: since.get(r.batchId) ?? null,
          queueSince: queued.get(r.batchId) ?? {},
        },
      ];
    }),
  );
}

/**
 * Since when each trip has stood at its destination's yard by the phone: the
 * first fix there after the last one anywhere else (a truck that left the
 * yard and came back is judged from its return), or none. Asked on its own
 * for an ARRIVED truck, whose newest fix nobody reads — only how long the
 * phone had it in the yard before the first unload scan (`until`).
 */
export async function gateSinceFor(trips: readonly PositionTrip[]): Promise<Map<string, Date>> {
  if (trips.length === 0) return new Map();
  // Counted in the phone's own order, so one upload's backlog — every row the same `received_at` — still reads in the
  // order it was taken. One grouped pass, the yards (`gateYard` — none for a
  // trip that starts in its destination's yard) bound as a VALUES list, the
  // distance `chordDeg`'s own formula, ISO strings for the bounds (#156).
  const yards = trips.flatMap((t) => {
    const y = gateYard(t.originCode, t.destCode);
    return y
      ? [
          sql`(${t.id}::uuid, ${y.x}::float8, ${y.y}::float8, ${t.departedAt?.toISOString() ?? null}::timestamptz, ${t.until?.toISOString() ?? null}::timestamptz)`,
        ]
      : [];
  });
  const since = new Map<string, Date>();
  if (yards.length) {
    const found = await db.execute<{ batch_id: string; since_ms: string | null }>(sql`
      WITH f AS (
        SELECT p.batch_id, p.id, p.recorded_at, least(p.recorded_at, p.received_at) AS at,
               sqrt(power((p.lon::float8 - y.lon) * cos(radians((p.lat::float8 + y.lat) / 2)), 2)
                    + power(p.lat::float8 - y.lat, 2)) <= ${GATE_RADIUS_DEG} AS inside
          FROM ${driverPositions} p
          JOIN (VALUES ${sql.join(yards, sql`, `)}) AS y(batch_id, lon, lat, from_at, until_at) ON y.batch_id = p.batch_id
         WHERE (p.accuracy_m IS NULL OR p.accuracy_m <= ${COARSE_FIX_M})
           AND (y.from_at IS NULL OR least(p.recorded_at, p.received_at) >= y.from_at)
           AND (y.until_at IS NULL OR least(p.recorded_at, p.received_at) <= y.until_at)
      ), n AS (
        SELECT f.*, row_number() OVER (PARTITION BY batch_id ORDER BY at, recorded_at, id) AS k FROM f
      ), g AS (
        SELECT n.*, max(k) FILTER (WHERE NOT inside) OVER (PARTITION BY batch_id) AS last_out FROM n
      )
      SELECT batch_id, extract(epoch FROM min(at)) * 1000 AS since_ms
        FROM g
       WHERE inside AND (last_out IS NULL OR k > last_out)
       GROUP BY batch_id`);
    for (const r of found) if (r.since_ms !== null) since.set(r.batch_id, new Date(Number(r.since_ms)));
  }
  return since;
}

/**
 * Since when each trip's phone has stood in each HELD queue on its road
 * (docs/XORGOS-NAVBAT.md §2.1): `gateSinceFor`'s rule, one post at a time —
 * the first fix within `HELD_QUEUE_RADIUS_DEG` of the post after the last
 * one outside it, from the departure — with one difference: a fix OUTSIDE
 * must come first. Only then did the phone SEE the truck arrive; a phone
 * switched on in the queue says nothing about how long it had stood there,
 * and the walk's arrival stays the better word (`fixAnchor`). One statement
 * for every trip on a road that has such a queue (the HOR roads today), none
 * for the rest.
 */
export async function queueSinceFor(
  trips: readonly PositionTrip[],
): Promise<Map<string, Partial<Record<BorderPost, Date>>>> {
  const out = new Map<string, Partial<Record<BorderPost, Date>>>();
  const posts = trips.flatMap((t) => {
    const route = routeFor(t.originCode, t.destCode);
    if (!route) return [];
    return route.segments.filter(isHeldQueue).map((seg) => {
      const p = route.points[seg.span[0]]!;
      return sql`(${t.id}::uuid, ${seg.post!}::text, ${p.x}::float8, ${p.y}::float8, ${t.departedAt?.toISOString() ?? null}::timestamptz, ${t.until?.toISOString() ?? null}::timestamptz)`;
    });
  });
  if (posts.length === 0) return out;
  const found = await db.execute<{ batch_id: string; post: string; since_ms: string | null }>(sql`
    WITH f AS (
      SELECT p.batch_id, y.post, p.id, p.recorded_at, least(p.recorded_at, p.received_at) AS at,
             sqrt(power((p.lon::float8 - y.lon) * cos(radians((p.lat::float8 + y.lat) / 2)), 2)
                  + power(p.lat::float8 - y.lat, 2)) <= ${HELD_QUEUE_RADIUS_DEG} AS inside
        FROM ${driverPositions} p
        JOIN (VALUES ${sql.join(posts, sql`, `)}) AS y(batch_id, post, lon, lat, from_at, until_at) ON y.batch_id = p.batch_id
       WHERE (p.accuracy_m IS NULL OR p.accuracy_m <= ${COARSE_FIX_M})
         AND (y.from_at IS NULL OR least(p.recorded_at, p.received_at) >= y.from_at)
         AND (y.until_at IS NULL OR least(p.recorded_at, p.received_at) <= y.until_at)
    ), n AS (
      SELECT f.*, row_number() OVER (PARTITION BY batch_id, post ORDER BY at, recorded_at, id) AS k FROM f
    ), g AS (
      SELECT n.*, max(k) FILTER (WHERE NOT inside) OVER (PARTITION BY batch_id, post) AS last_out FROM n
    )
    SELECT batch_id, post, extract(epoch FROM min(at)) * 1000 AS since_ms
      FROM g
     WHERE inside AND last_out IS NOT NULL AND k > last_out
     GROUP BY batch_id, post`);
  for (const r of found) {
    if (r.since_ms === null) continue;
    const posted = out.get(r.batch_id) ?? {};
    posted[r.post as BorderPost] = new Date(Number(r.since_ms));
    out.set(r.batch_id, posted);
  }
  return out;
}

/** The fix as the placement reads it — ONE mapping, so no reader drops `gateSince` or `queueSince`. */
export function placementFix(fix: LatestPosition | null | undefined): PlacementFix | null {
  return fix
    ? {
        lat: fix.lat,
        lon: fix.lon,
        recordedAt: fix.recordedAt,
        source: fix.source,
        gateSince: fix.gateSince,
        queueSince: fix.queueSince,
      }
    : null;
}

/** Paired devices of a trip for the batch card (never exposes the token). */
export const devicesForBatch = cache(async function devicesForBatch(batchId: string) {
  const devices = await db
    .select({
      id: driverDevices.id,
      platform: driverDevices.platform,
      label: driverDevices.label,
      pairCode: driverDevices.pairCode,
      pairedAt: driverDevices.pairedAt,
      lastSeenAt: driverDevices.lastSeenAt,
    })
    .from(driverDevices)
    .where(and(eq(driverDevices.batchId, batchId), isNull(driverDevices.revokedAt)))
    .orderBy(desc(driverDevices.createdAt));
  if (devices.length === 0) return [];

  const counts = await db
    .select({ deviceId: driverPositions.deviceId, n: sql<number>`count(*)` })
    .from(driverPositions)
    .where(inArray(driverPositions.deviceId, devices.map((d) => d.id)))
    .groupBy(driverPositions.deviceId);
  const byDevice = new Map(counts.map((c) => [c.deviceId, Number(c.n)]));
  return devices.map((d) => ({ ...d, fixes: byDevice.get(d.id) ?? 0 }));
});
