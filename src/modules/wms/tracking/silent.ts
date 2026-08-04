import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches, driverDevices } from '../../platform/db/schema';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission } from '../../platform/notifications/service';
import { FRESH_MINUTES } from './devices';

/**
 * A truck that went quiet, noticed by the server (round 55).
 *
 * The driver app can die in ways no code inside it survives — a vendor
 * battery killer, a force stop, a phone left on a charger in the cab. Every
 * alarm the app could raise dies with it, so the only alarm that always
 * works is the one at the other end of the wire: the server watching for the
 * phone that stopped calling in. Same rule as the listener's two alarms
 * (round 49): an alarm about a component must never depend on that
 * component.
 *
 * The threshold is FRESH_MINUTES — the exact moment the map dot goes grey.
 * One definition of "stale", shared by the screen and the alarm, so the
 * message arrives when the logist would have seen the grey dot anyway (had
 * they been looking). Judged on `last_seen_at` (when the phone last talked
 * to us, whatever it sent) with `paired_at` as the floor for a phone that
 * never reported at all.
 *
 * Only trips that are actually under way: a phone paired at loading is
 * expected to sit quiet in a warehouse, and an arrived batch has nothing
 * left to report.
 */

export interface SilentTruck {
  deviceId: string;
  batchId: string;
  batchCode: string;
  /** Whatever names the trip best for a human: plate, driver, or nothing. */
  driverName: string | null;
  vehiclePlate: string | null;
  silentSinceMs: number;
}

export async function silentTrucks(now = new Date()): Promise<SilentTruck[]> {
  const cutoff = new Date(now.getTime() - FRESH_MINUTES * 60_000);
  const rows = await db
    .select({
      deviceId: driverDevices.id,
      batchId: batches.id,
      batchCode: batches.code,
      driverName: batches.driverName,
      vehiclePlate: batches.vehiclePlate,
      lastSeenAt: driverDevices.lastSeenAt,
      pairedAt: driverDevices.pairedAt,
    })
    .from(driverDevices)
    .innerJoin(batches, eq(batches.id, driverDevices.batchId))
    .where(
      and(
        eq(batches.status, 'in_transit'),
        // Paired means the code was exchanged for a token — a minted-but-
        // never-used code is not a phone.
        isNotNull(driverDevices.pairedAt),
        isNull(driverDevices.revokedAt),
        isNull(driverDevices.silentNotifiedAt),
        // ISO string + ::timestamptz, not a Date: a Date bound beside a raw
        // fragment reaches postgres.js untyped and is refused (#156).
        sql`COALESCE(${driverDevices.lastSeenAt}, ${driverDevices.pairedAt}) < ${cutoff.toISOString()}::timestamptz`,
      ),
    );

  return rows.map((r) => ({
    deviceId: r.deviceId,
    batchId: r.batchId,
    batchCode: r.batchCode,
    driverName: r.driverName,
    vehiclePlate: r.vehiclePlate,
    silentSinceMs:
      now.getTime() - (r.lastSeenAt ?? r.pairedAt ?? now).getTime(),
  }));
}

/** The alarm's text — says "check it", because silence has two causes. */
export function silentTruckText(truck: SilentTruck, appUrl: string): string {
  const hours = Math.max(1, Math.floor(truck.silentSinceMs / 3_600_000));
  const who = [truck.vehiclePlate, truck.driverName].filter(Boolean).join(' · ');
  return (
    `📵 ${truck.batchCode}${who ? ` (${who})` : ''}: haydovchi telefoni ${hours} soatdan beri jim.\n` +
    `Aloqa yo'q hududda bo'lishi ham mumkin — haydovchidan so'rang; kerak bo'lsa ilovani ochib «Hozir yuborish»ni bosish kifoya.\n` +
    `${appUrl}/batches/${truck.batchId}`
  );
}

/**
 * Tell the people who plan trips, once per silence. The stamp is set whether
 * or not anybody has the type muted — it records "reported", not
 * "delivered" — and the next position from the phone clears it, so a NEW
 * silence later is a new report.
 */
export async function alertSilentTrucks(now = new Date()): Promise<number> {
  const due = await silentTrucks(now);
  if (due.length === 0) return 0;
  const userIds = await usersWithPermission('plans.manage');
  const appUrl = process.env.APP_URL ?? '';

  let sent = 0;
  for (const truck of due) {
    await notifyStaffTelegram({
      userIds,
      type: 'TruckSilent',
      text: silentTruckText(truck, appUrl),
    });
    await db
      .update(driverDevices)
      .set({ silentNotifiedAt: now })
      .where(eq(driverDevices.id, truck.deviceId));
    sent += 1;
  }
  return sent;
}
