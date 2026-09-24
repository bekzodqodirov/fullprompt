import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  clientNotices,
  clients,
  clientTelegramLinks,
  pickupLines,
  pickups,
  pickupStops,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { clientLabels } from '../../platform/telegram/client-labels';
import {
  isPermanentNoticeFailure,
  MAX_NOTICE_ATTEMPTS,
  RECLAIM_MINUTES,
  settleArrivalNotice,
} from '../notices/arrival';
import { NOTICE_PICKED_UP } from './service';

/**
 * «Yukingiz zavoddan olindi» (owner's B4a: a message when it is picked up,
 * and again at the warehouse). Claimed by `collectStop` inside the press's
 * own transaction, sent here by the SAME drain and the same rules as «yukingiz
 * keldi» (notices/arrival-jobs.ts): a CLAIM so two overlapping sweeps split
 * the work, a deadline on every call, transient-vs-permanent refusals, and a
 * five-attempt budget — a row a 429 settled as failed is a customer never
 * told.
 *
 * What it deliberately does not carry: a date (a single figure from an
 * uncalibrated estimate is a promise nobody made), the truck, and the cabinet
 * button — the cabinet is built from boxes, and there are none yet.
 */

export interface PickedUpLine {
  goods: string;
  boxes: number;
}

/** Pure — the wording is testable in every language without Telegram or a database. */
export function pickedUpText(
  lines: PickedUpLine[],
  clientCode: string,
  warehouseCode: string,
  locale?: string | null,
): string {
  const t = clientLabels(locale);
  const total = lines.reduce((sum, line) => sum + line.boxes, 0);
  return (
    `${t.pickedUpTitle}\n` +
    `${clientCode}\n\n` +
    `${lines.map((line) => `· ${line.goods} — ${line.boxes} ${t.pieces}`).join('\n')}\n` +
    `${t.arrivedTotal}: ${total} ${t.pieces}\n\n` +
    `${t.pickedUpOnWay}: ${warehouseCode}\n` +
    t.pickedUpNote
  );
}

async function claimPickupNotices(limit = 50, now = new Date()) {
  return db
    .update(clientNotices)
    .set({ status: 'sending', claimedAt: now })
    .where(
      sql`${clientNotices.id} IN (
        SELECT id FROM client_notices
        WHERE kind = ${NOTICE_PICKED_UP}
          AND send_after <= ${now.toISOString()}::timestamptz
          AND (
            status = 'pending'
            OR (status = 'sending' AND claimed_at < ${now.toISOString()}::timestamptz - make_interval(mins => ${RECLAIM_MINUTES}))
          )
        ORDER BY send_after
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning();
}

/** What to say, read at SEND time: the trip may have been cancelled, the cargo already received. */
export async function pickedUpMessageFor(noticeClientId: string, stopId: string) {
  const [row] = await db
    .select({ status: pickups.status, destCode: warehouses.code })
    .from(pickupStops)
    .innerJoin(pickups, eq(pickupStops.pickupId, pickups.id))
    .innerJoin(warehouses, eq(pickups.destWarehouseId, warehouses.id))
    .where(eq(pickupStops.id, stopId));
  if (!row) return { skip: 'stop_gone' as const };
  if (row.status === 'cancelled') return { skip: 'cancelled' as const };
  const [received] = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(and(eq(receipts.pickupStopId, stopId), eq(receipts.clientId, noticeClientId), isNull(receipts.voidedAt)))
    .limit(1);
  // The warehouse got there first: «keldi» has been (or is being) said, and
  // «olindi» after it would tell the customer something older than they know.
  if (received) return { skip: 'already_received' as const };
  const lines = await db
    .select({ goods: pickupLines.goods, factoryBoxes: pickupLines.factoryBoxes, driverBoxes: pickupLines.driverBoxes })
    .from(pickupLines)
    .where(and(eq(pickupLines.stopId, stopId), eq(pickupLines.clientId, noticeClientId)));
  if (!lines.length) return { skip: 'no_lines' as const };
  return {
    // The driver's recount when he gave one: it is what is on the truck.
    lines: lines.map((l) => ({ goods: l.goods, boxes: l.driverBoxes ?? l.factoryBoxes })),
    warehouseCode: row.destCode,
  };
}

export async function sendDuePickupNotices(now = new Date()): Promise<number> {
  const due = await claimPickupNotices(50, now);
  if (due.length === 0) return 0;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  // No token is not this message's fault: back to pending, untouched.
  if (!token) {
    await db
      .update(clientNotices)
      .set({ status: 'pending' })
      .where(sql`${clientNotices.id} IN (${sql.join(due.map((n) => sql`${n.id}`), sql`, `)})`);
    return 0;
  }
  let sent = 0;
  for (const notice of due) {
    try {
      const client = await db.query.clients.findFirst({ where: eq(clients.id, notice.clientId) });
      if (!client) {
        await settleArrivalNotice(notice.id, 'skipped', 'client_gone');
        continue;
      }
      const message = await pickedUpMessageFor(notice.clientId, notice.refId);
      if ('skip' in message) {
        await settleArrivalNotice(notice.id, 'skipped', message.skip);
        continue;
      }
      const text = pickedUpText(message.lines, client.clientCode, message.warehouseCode, client.locale);
      const links = await db
        .select()
        .from(clientTelegramLinks)
        .where(eq(clientTelegramLinks.clientId, notice.clientId));
      const chats = new Set<bigint>();
      for (const link of links) {
        if (link.status === 'linked' && link.telegramChatId) chats.add(link.telegramChatId);
      }
      if (chats.size === 0) {
        await settleArrivalNotice(notice.id, 'skipped', 'no_linked_chat');
        continue;
      }
      let delivered = 0;
      let allPermanent = true;
      let lastDetail = '';
      for (const chatId of chats) {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: Number(chatId), text }),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) delivered += 1;
        else {
          const detail = await res.text().catch(() => '');
          if (!isPermanentNoticeFailure(res.status)) allPermanent = false;
          lastDetail = `${res.status} ${detail.slice(0, 200)}`;
        }
      }
      const outcome =
        delivered > 0
          ? 'sent'
          : allPermanent || notice.attempts + 1 >= MAX_NOTICE_ATTEMPTS
            ? 'failed'
            : 'pending';
      await settleArrivalNotice(notice.id, outcome, delivered > 0 ? undefined : lastDetail);
      if (delivered > 0) sent += 1;
    } catch (err) {
      logger.warn({ err, noticeId: notice.id }, 'client pickup notice failed');
      await settleArrivalNotice(
        notice.id,
        notice.attempts + 1 >= MAX_NOTICE_ATTEMPTS ? 'failed' : 'pending',
        String(err),
      ).catch(() => {});
    }
  }
  return sent;
}
