import type PgBoss from 'pg-boss';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  boxes,
  notifications,
  receiptLots,
  receipts,
  roles,
  telegramLinks,
  userRoles,
  users,
  warehouses,
} from '../db/schema';
import { getSetting } from '../settings/service';
import { logger } from '../logger';
import { isTelegramMuted } from '../notifications/mutes';

export const JOB_DAILY_DIGEST = 'notify.digest';

/**
 * Daily 09:00 Tashkent digest (spec 6.7 + §11, owner's answer Q5: ONE
 * consolidated message for all warehouses, sectioned per WH) to logist +
 * admins: unclaimed receipts older than `unclaimed_aging_days` and stock
 * older than `stale_stock_days`. Empty digests are suppressed.
 */
export async function sendDailyDigest(now = new Date()): Promise<boolean> {
  const agingDays = Number(await getSetting('unclaimed_aging_days')) || 7;
  const staleDays = Number(await getSetting('stale_stock_days')) || 30;
  const agingBefore = new Date(now.getTime() - agingDays * 24 * 3600 * 1000);
  const staleBefore = new Date(now.getTime() - staleDays * 24 * 3600 * 1000);

  const unclaimed = await db
    .select({
      whCode: warehouses.code,
      number: receipts.number,
      marking: receipts.unclaimedMarking,
      receivedAt: receipts.receivedAt,
      boxCount: sql<number>`(
        SELECT count(*) FROM ${boxes} b JOIN ${receiptLots} rl ON b.lot_id = rl.id
        WHERE rl.receipt_id = ${receipts.id} AND b.status = 'in_stock'
      )`,
    })
    .from(receipts)
    .innerJoin(warehouses, eq(receipts.warehouseId, warehouses.id))
    .where(
      and(
        isNull(receipts.clientId),
        eq(receipts.status, 'confirmed'),
        lt(receipts.receivedAt, agingBefore),
      ),
    )
    .orderBy(warehouses.code, receipts.receivedAt);
  // Only receipts that still have boxes on hand belong in the digest.
  const unclaimedLive = unclaimed.filter((r) => Number(r.boxCount) > 0);

  const stale = await db
    .select({
      whCode: warehouses.code,
      boxCount: sql<number>`count(*)`,
      oldestAt: sql<string>`min(${receipts.receivedAt})`,
    })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .where(and(eq(boxes.status, 'in_stock'), lt(receipts.receivedAt, staleBefore)))
    .groupBy(warehouses.code)
    .orderBy(warehouses.code);

  if (unclaimedLive.length === 0 && stale.length === 0) return false;
  const text = dailyDigestText({ now, agingDays, staleDays, unclaimed: unclaimedLive, stale });

  const recipientRows = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(inArray(roles.code, ['logist', 'admin', 'super_admin']));
  const userIds = [...new Set(recipientRows.map((r) => r.userId))];

  for (const userId of userIds) {
    await db.insert(notifications).values({
      userId,
      channel: 'in_app',
      type: 'DailyDigest',
      payload: { text },
      status: 'sent',
      sentAt: new Date(),
    });
    const link = await db.query.telegramLinks.findFirst({
      where: and(eq(telegramLinks.userId, userId), eq(telegramLinks.status, 'linked')),
    });
    const user = await db.query.users.findFirst({
      columns: { mutedNotificationTypes: true },
      where: eq(users.id, userId),
    });
    const userMuted = isTelegramMuted(user?.mutedNotificationTypes, 'DailyDigest');
    await db.insert(notifications).values({
      userId,
      channel: 'telegram',
      type: 'DailyDigest',
      payload: { text },
      status: link && !userMuted ? 'pending' : 'muted',
      error: userMuted ? 'muted by user' : link ? null : 'telegram not linked',
    });
  }
  return true;
}

/** How many unclaimed receipts the digest names before it only counts. */
export const DIGEST_UNCLAIMED_SHOWN = 20;

/**
 * The svodka's words (round C). It was the one staff message still written in
 * Russian — every other thing the office reads from the bot is Uzbek — and
 * its unclaimed list had no end: a quiet month of egasiz cargo made a text
 * Telegram refuses whole, retried into `failed`, so the digest went missing
 * exactly when it had the most to say. Twenty lines and then the count.
 */
export function dailyDigestText(input: {
  now: Date;
  agingDays: number;
  staleDays: number;
  unclaimed: { whCode: string; number: string | null; marking: string | null; receivedAt: Date; boxCount: number | string }[];
  stale: { whCode: string; boxCount: number | string; oldestAt: string | Date }[];
}): string {
  const { now } = input;
  const lines: string[] = ['📊 GSR — kunlik hisobot'];
  if (input.unclaimed.length > 0) {
    lines.push('', `❓ Egasiz yuk (${input.agingDays} kundan eski):`);
    for (const r of input.unclaimed.slice(0, DIGEST_UNCLAIMED_SHOWN)) {
      const days = Math.floor((now.getTime() - r.receivedAt.getTime()) / 86_400_000);
      lines.push(
        `• ${r.whCode} ${r.number ?? ''}${r.marking ? ` [${r.marking}]` : ''} — ${r.boxCount} kor., ${days} kun`,
      );
    }
    if (input.unclaimed.length > DIGEST_UNCLAIMED_SHOWN) {
      lines.push(`… yana ${input.unclaimed.length - DIGEST_UNCLAIMED_SHOWN} ta`);
    }
  }
  if (input.stale.length > 0) {
    lines.push('', `🕸 Uzoq turgan yuk (${input.staleDays} kundan eski):`);
    for (const s of input.stale) {
      const days = Math.floor((now.getTime() - new Date(s.oldestAt).getTime()) / 86_400_000);
      lines.push(`• ${s.whCode}: ${s.boxCount} kor., eng eskisi — ${days} kun`);
    }
  }
  return lines.join('\n');
}

export async function registerDigestWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_DAILY_DIGEST);
  // 09:00 Asia/Tashkent (UTC+5, no DST) = 04:00 UTC. pg-boss cron fires
  // exactly once per slot, which gives per-day idempotency for free.
  await boss.schedule(JOB_DAILY_DIGEST, '0 4 * * *');
  await boss.work(JOB_DAILY_DIGEST, async () => {
    try {
      const sent = await sendDailyDigest();
      logger.info({ sent }, 'daily digest run');
    } catch (err) {
      logger.error({ err }, 'daily digest failed');
      throw err;
    }
  });
}
