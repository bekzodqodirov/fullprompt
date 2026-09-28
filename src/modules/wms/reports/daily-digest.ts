import type PgBoss from 'pg-boss';
import { and, eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { notifications, telegramLinks, users } from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { logger } from '../../platform/logger';
import { isTelegramMuted } from '../../platform/notifications/mutes';
import { usersWithRoles } from '../../platform/notifications/service';
import { unclaimedReport, warehouseFill, type WarehouseFillRow } from './queries';
import { waitingDigestSection } from '../issue/waiting-alerts';

export const JOB_DAILY_DIGEST = 'notify.digest';

/**
 * Daily 09:00 Tashkent digest (spec 6.7 + §11, owner's answer Q5: ONE
 * consolidated message for all warehouses, sectioned per WH) to logist +
 * admins: unclaimed receipts older than `unclaimed_aging_days`, stock older
 * than `stale_stock_days`, and — since 0116 — the clients whose cargo has
 * waited past the warn line in the issuing warehouses. Empty digests are
 * suppressed.
 *
 * Moved here from `platform/jobs/digest.ts` when it began to read three wms
 * functions (platform must not import wms). Every section is now the OWN
 * function of the screen it summarises, where two of them used to restate
 * it: «Uzoq turgan yuk» dated a Tashkent carton by its CHINA receipt and
 * asked for `in_stock` alone, so cargo landed `ready_for_pickup` a month ago
 * was never old and a week-old arrival from a 40-day-old receipt always was;
 * «Egasiz yuk» asked for `in_stock` too and dropped exactly the unclaimed
 * cargo that had reached Tashkent. Now `warehouseFill` (the dashboard's fill
 * card) and `unclaimedReport` (/reports/unclaimed) answer, so the message and
 * the screens cannot disagree (#513).
 *
 * `waitingClientIds` is the tests' seam for the waiting section, whose sweep
 * CLAIMS and MESSAGES — on CI's one shared database an unbounded sweep would
 * act on every other file's fixtures (#713). Production passes nothing.
 */
export async function sendDailyDigest(
  now = new Date(),
  opts: { waitingClientIds?: string[] } = {},
): Promise<boolean> {
  const agingDays = Number(await getSetting('unclaimed_aging_days')) || 7;
  const staleDays = Number(await getSetting('stale_stock_days')) || 30;

  const unclaimed = (await unclaimedReport(undefined, now)).filter((r) => r.days >= agingDays);
  const stale = (await warehouseFill(undefined, staleDays, now)).filter((w) => w.staleCount > 0);

  // The sweep runs FIRST so the section can say what crossed this morning;
  // a failure there (a half-applied deploy's missing table, #472) costs the
  // section and never the svodka.
  let waiting: string[] = [];
  try {
    waiting = await waitingDigestSection({ asOf: now, clientIds: opts.waitingClientIds });
  } catch (err) {
    logger.error({ err }, 'daily digest: the waiting-cargo section failed');
  }

  if (unclaimed.length === 0 && stale.length === 0 && waiting.length === 0) return false;
  const text = dailyDigestText({ agingDays, staleDays, unclaimed, stale, waiting });

  // Active people only (`usersWithRoles`): the raw role query this replaced
  // kept writing a deactivated logist's svodka.
  const userIds = await usersWithRoles(['logist', 'admin', 'super_admin']);

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
 *
 * The waiting section goes LAST: it ends with the list's link, and the drain
 * turns an own-origin link on the last line into «↗️ Ochish».
 */
export function dailyDigestText(input: {
  agingDays: number;
  staleDays: number;
  unclaimed: { whCode: string; number: string | null; marking: string | null; boxesInStock: number; days: number }[];
  stale: Pick<WarehouseFillRow, 'code' | 'staleCount' | 'oldestDays'>[];
  waiting?: string[];
}): string {
  const lines: string[] = ['📊 GSR — kunlik hisobot'];
  if (input.unclaimed.length > 0) {
    lines.push('', `❓ Egasiz yuk (${input.agingDays} kundan eski):`);
    for (const r of input.unclaimed.slice(0, DIGEST_UNCLAIMED_SHOWN)) {
      lines.push(
        `• ${r.whCode} ${r.number ?? ''}${r.marking ? ` [${r.marking}]` : ''} — ${r.boxesInStock} kor., ${r.days} kun`,
      );
    }
    if (input.unclaimed.length > DIGEST_UNCLAIMED_SHOWN) {
      lines.push(`… yana ${input.unclaimed.length - DIGEST_UNCLAIMED_SHOWN} ta`);
    }
  }
  if (input.stale.length > 0) {
    lines.push('', `🕸 Uzoq turgan yuk (${input.staleDays} kundan eski):`);
    for (const s of input.stale) {
      lines.push(`• ${s.code}: ${s.staleCount} kor., eng eskisi — ${s.oldestDays ?? '?'} kun`);
    }
  }
  if (input.waiting && input.waiting.length > 0) {
    lines.push('', ...input.waiting);
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
