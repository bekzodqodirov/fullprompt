import { createHash, randomBytes, randomInt } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Db, type Tx } from '../../platform/db/client';
import { batches, driverDevices, driverPositions } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';

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

/**
 * Positions older than this are shown as stale (the estimate takes over).
 *
 * The driver app reports every 2-3 hours by design — the owner asked for a
 * schedule the driver's battery survives, not a live dot. So "fresh" has to
 * cover a missed cycle plus a dead zone; anything tighter would paint every
 * real fix as stale and hand the map back to the estimate.
 */
export const FRESH_MINUTES = 8 * 60;

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

export const positionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).optional(),
  speedKmh: z.number().min(0).max(400).optional(),
  recordedAt: z.string().datetime(),
});
export const positionBatchSchema = z.object({
  positions: z.array(positionSchema).min(1).max(500),
});

/**
 * Ingest a batch of fixes from one paired phone (the app queues them offline
 * and flushes on reconnect). Duplicates from a re-flush are ignored.
 */
export async function ingestPositions(
  token: string,
  input: z.infer<typeof positionBatchSchema>,
): Promise<{ accepted: number }> {
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

  const rows = input.positions.map((p) => ({
    batchId: device.batchId,
    deviceId: device.id,
    lat: String(p.lat),
    lon: String(p.lon),
    accuracyM: p.accuracyM !== undefined ? Math.round(p.accuracyM) : null,
    speedKmh: p.speedKmh !== undefined ? String(p.speedKmh) : null,
    recordedAt: new Date(p.recordedAt),
    source: 'device' as const,
  }));
  const inserted = await db.insert(driverPositions).values(rows).onConflictDoNothing().returning({
    id: driverPositions.id,
  });
  await db
    .update(driverDevices)
    .set({ lastSeenAt: new Date() })
    .where(eq(driverDevices.id, device.id));
  return { accepted: inserted.length };
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
  recordedAt: Date;
  source: string;
  ageMinutes: number;
  fresh: boolean;
}

/** Newest fix per batch (device or manual, whichever is more recent). */
export async function latestPositions(batchIds: string[]): Promise<Map<string, LatestPosition>> {
  if (batchIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([driverPositions.batchId], {
      batchId: driverPositions.batchId,
      lat: driverPositions.lat,
      lon: driverPositions.lon,
      recordedAt: driverPositions.recordedAt,
      source: driverPositions.source,
    })
    .from(driverPositions)
    .where(inArray(driverPositions.batchId, batchIds))
    .orderBy(driverPositions.batchId, desc(driverPositions.recordedAt));

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
        },
      ];
    }),
  );
}

/** Paired devices of a trip for the batch card (never exposes the token). */
export async function devicesForBatch(batchId: string) {
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
}
