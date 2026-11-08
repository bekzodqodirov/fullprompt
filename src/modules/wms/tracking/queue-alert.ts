import { inArray, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches } from '../../platform/db/schema';
import { isServerBehind } from '../../platform/db/errors';
import { logger } from '../../platform/logger';
import { kickTelegramDrain, queueStaffTelegram } from '../../platform/notifications/staff';
import { usersWithPermission } from '../../platform/notifications/service';
import { batchTabHref } from '../batches/card-door';
import type { BorderPost } from './engine';
import { hoursAsDays, queueDayNo, type QueueHold } from './eta';
import { roadRowsNow } from './on-road';

/**
 * «Agar ko'pi bilan kiritilgan kundan o'tib ketsa logistga ogohlantirish
 * kelsin» — the owner, 2026-11-08, answers 2a and 3a (docs/XORGOS-NAVBAT.md
 * §3).
 *
 * A truck held in a typed queue (Horgos, Yallama) does not leave it by time
 * alone (his 1a, `placeTruck`). So nothing but a person can end the wait on
 * the screen, and a truck nobody presses past would sit «navbatda» for ever.
 * This is the one alarm about that, said ONCE per (truck, post, wait): the
 * claim row (0140) and the message rows are one transaction, so a crash
 * between them leaves either both or neither, and two overlapping sweeps
 * cannot both win the claim. Time never re-arms it — 3a is «har bir navbat
 * uchun bir marta», not «each half hour it is still there» — but a LATER
 * entry does: a «Chegarada» press after the call counts the wait again from
 * the press, and if THAT runs out the logists are told again.
 *
 * «Late» is `placeTruck`'s own `queue.late` (more than `QUEUE_LATE_HOURS`
 * past the LONGEST wait it was given, his 2a), read off the same rows the
 * dashboard draws — the alarm and the card cannot disagree about a truck.
 */

/**
 * The buttons that end the wait, as the Mashina tab draws them — the flag
 * first, so a logist reading the Russian screen («🇰🇿 В Казахстане») finds the
 * one this Uzbek message names (`CHECKPOINT_LABEL`'s icons).
 */
const KZ_BUTTON = '«🇰🇿 Qozog‘istonda»';
const UZ_BUTTON = '«🇺🇿 O‘zbekistonda»';

/**
 * What to press. «Navbatida turibdi» is what the system knows: nobody has
 * said it is through. So the press for the next leg AND, from Horgos, the
 * one for a truck already in Uzbekistan — pressing «Qozog‘istonda» for it
 * would hold it at Yallama and warn again a week later (the judge).
 */
const NEXT_PRESS: Record<BorderPost, string> = {
  khorgos: `chegaradan o‘tgan bo‘lsa ${KZ_BUTTON}, O‘zbekistonga kirgan bo‘lsa ${UZ_BUTTON}`,
  yallama: `O‘zbekistonga kirgan bo‘lsa ${UZ_BUTTON}`,
};

/** The post as the message names it — the /trucks panel's own short names. */
const POST_NAME: Record<BorderPost, string> = {
  khorgos: 'Horgos',
  yallama: 'Yallama',
};

/** Hours as days as the message writes them — the panel's rounding (`hoursAsDays`), a comma: «2,5», «3». */
export function queueDays(hours: number): string {
  return String(hoursAsDays(hours)).replace('.', ',');
}

/** «2–3» for a range, «3» when both ends are one number. */
export function queueRangeDays(hours: readonly [number, number]): string {
  const [a, b] = [queueDays(hours[0]), queueDays(hours[1])];
  return a === b ? a : `${a}–${b}`;
}

export interface LateQueueTruck {
  batchId: string;
  code: string;
  vehiclePlate: string | null;
  driverName: string | null;
  queue: QueueHold;
}

/** One truck's line: who, where, how long against what — «kiritilgan» only for a typed number. */
function truckLine(truck: LateQueueTruck): string {
  const who = [truck.vehiclePlate, truck.driverName].filter(Boolean).join(' · ');
  const q = truck.queue;
  return (
    `${truck.code}${who ? ` (${who})` : ''}: ${POST_NAME[q.post]} navbatida ${queueDayNo(q.stoodHours)}-kun turibdi — ` +
    `${q.typed ? 'kiritilgan' : 'odatdagi'} ${queueRangeDays(q.given)} kundan oshdi`
  );
}

/** At most this many trucks in one message; the rest are counted and the board lists them all. */
export const LATE_QUEUE_LINES = 15;

/**
 * The message — pure. One truck: what is late, by how much, and the press
 * that ends it, with the link to its Mashina tab. Several at once (deploy
 * morning, when every truck nobody ever pressed past Horgos turns late
 * together — the judge): ONE message listing them, so each logist gets one
 * message and not one per truck.
 */
export function lateQueueText(trucks: readonly LateQueueTruck[], appUrl: string): string {
  if (trucks.length === 1) {
    const truck = trucks[0]!;
    return (
      `⏰ ${truckLine(truck)}.\n` +
      `Haydovchidan so‘rang: ${NEXT_PRESS[truck.queue.post]} tugmasini bosing.\n` +
      // The pins are on the truck card's «Mashina» tab.
      `${appUrl}${batchTabHref(truck.batchId, 'mashina')}`
    );
  }
  const shown = trucks.slice(0, LATE_QUEUE_LINES);
  const more = trucks.length - shown.length;
  return [
    `⏰ ${trucks.length} ta mashina chegara navbatida kechikdi:`,
    ...shown.map(
      (truck) => `• ${truckLine(truck)} — ${appUrl}${batchTabHref(truck.batchId, 'mashina')}`,
    ),
    ...(more > 0 ? [`… va yana ${more} ta — Partiya doskasida`] : []),
    `Haydovchilardan so‘rang: Horgosdan o‘tgan bo‘lsa ${KZ_BUTTON}, O‘zbekistonga kirgan bo‘lsa ${UZ_BUTTON} tugmasini bosing (mashina kartasida).`,
  ].join('\n');
}

/** Every truck on the road that is late in a held queue, with what the message names it by. */
export async function lateQueueTrucks(now = new Date()): Promise<LateQueueTruck[]> {
  const late = (await roadRowsNow(now)).filter((row) => row.queue?.late);
  if (late.length === 0) return [];
  const named = await db
    .select({ id: batches.id, plate: batches.vehiclePlate, driver: batches.driverName })
    .from(batches)
    .where(
      inArray(
        batches.id,
        late.map((row) => row.id),
      ),
    );
  const byId = new Map(named.map((n) => [n.id, n]));
  return late
    .map((row) => ({
      batchId: row.id,
      code: row.code,
      vehiclePlate: byId.get(row.id)?.plate ?? null,
      driverName: byId.get(row.id)?.driver ?? null,
      queue: row.queue!,
    }))
    .sort((a, b) => b.queue.stoodHours - a.queue.stoodHours || a.code.localeCompare(b.code));
}

/**
 * Tell the people who plan trips — once per (truck, post, wait). The
 * recipients are read on the pool BEFORE the transaction (#714); the claims
 * and the ONE message are one transaction, so a crash leaves both or
 * neither and two overlapping sweeps cannot both win a truck; the drain is
 * kicked after the commit. A claim is re-won only by a wait that BEGAN after
 * the warning (0140) — the «Chegarada» press after the call — never by a
 * guess about the old wait moving. `TruckSilent`'s audience, for `TruckSilent`'s
 * reason: everyone who plans trips (the logists, and the owner and admins
 * who hold every grant). One migration behind, the sweep says so once and
 * sends nothing.
 */
export async function alertLateQueues(now = new Date()): Promise<number> {
  const due = await lateQueueTrucks(now);
  if (due.length === 0) return 0;
  const userIds = await usersWithPermission('plans.manage');
  const appUrl = process.env.APP_URL ?? '';

  try {
    const told = await db.transaction(async (tx) => {
      const won: LateQueueTruck[] = [];
      for (const truck of due) {
        const rows = await tx.execute<{ batch_id: string }>(sql`
          INSERT INTO truck_queue_alerts (batch_id, post, entered_at)
          VALUES (${truck.batchId}, ${truck.queue.post}, ${truck.queue.enteredAt}::timestamptz)
          ON CONFLICT (batch_id, post) DO UPDATE
             SET entered_at = EXCLUDED.entered_at, alerted_at = now()
           -- A wait that began AFTER the warning — the press after the call —
           -- is a new wait; a shifted guess about the old one is not.
           WHERE truck_queue_alerts.alerted_at < EXCLUDED.entered_at
          RETURNING batch_id`);
        if (rows.length > 0) won.push(truck);
      }
      if (won.length > 0) {
        await queueStaffTelegram(tx, {
          userIds,
          type: 'TruckQueueLate',
          text: lateQueueText(won, appUrl),
        });
      }
      return won.length;
    });
    if (told > 0) await kickTelegramDrain();
    return told;
  } catch (err) {
    if (isServerBehind(err)) {
      logger.warn(
        '[late-queue] truck_queue_alerts is not there yet — run the migration; nothing sent',
      );
      return 0;
    }
    throw err;
  }
}
