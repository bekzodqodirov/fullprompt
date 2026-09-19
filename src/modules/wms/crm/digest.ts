import type PgBoss from 'pg-boss';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  notifications,
  roles,
  telegramLinks,
  userRoles,
  users,
} from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { logger } from '../../platform/logger';
import { isTelegramMuted } from '../../platform/notifications/mutes';
import { dayCalls, othersLine } from './day';
import { dormantClients } from './service';

export const JOB_CRM_FOLLOWUPS = 'crm.followups';
export const JOB_CRM_DORMANT = 'crm.dormant';

/**
 * The two CRM messages the owner asked for (answers 4 and 5).
 *
 * Both are PER RECIPIENT, not one broadcast: a sales manager must get their
 * own list, because a message about someone else's clients is a message they
 * learn to ignore. Which turned out to be true of the owner as well — he
 * holds `crm.leads.view_all` and was therefore sent EVERYBODY's every
 * morning, and said so (item 4). Since then a supervisor gets their own
 * list too, with the other sellers as a line of counts.
 */

/** Everyone who works leads, with a flag for "sees all of them". */
async function crmRecipients() {
  const rows = await db
    .select({ userId: userRoles.userId, role: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(inArray(roles.code, ['sales_manager', 'logist', 'admin', 'super_admin']));

  const byUser = new Map<string, boolean>();
  for (const row of rows) {
    const seesAll = row.role !== 'sales_manager';
    byUser.set(row.userId, (byUser.get(row.userId) ?? false) || seesAll);
  }
  return [...byUser.entries()].map(([userId, seesAll]) => ({ userId, seesAll }));
}

async function deliver(userId: string, type: string, text: string) {
  await db.insert(notifications).values({
    userId,
    channel: 'in_app',
    type,
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
  const muted = isTelegramMuted(user?.mutedNotificationTypes, type);
  await db.insert(notifications).values({
    userId,
    channel: 'telegram',
    type,
    payload: { text },
    status: link && !muted ? 'pending' : 'muted',
    error: muted ? 'muted by user' : link ? null : 'telegram not linked',
  });
}

/**
 * "Who am I calling today" — MY leads and clients, and how the sellers stand.
 *
 * The owner, 2026-09-14: «telegramdan ham har kuni bugun boglanilishi kerak
 * deb kelib yotibti». What arrived every morning was every seller's list
 * flattened into one message, because `crm.leads.view_all` was read as «send
 * them everything». His answer 4.3c: the message carries MY OWN calls, and
 * then one line of counts — «alisher 4ta Bekzod 5 ta» — which is the part a
 * supervisor actually acts on. Names and numbers, never a hundred rows: the
 * screen is one tap away and a phone is the wrong place to read somebody
 * else's day.
 *
 * Silence when there is nothing due, as before — a daily message that is
 * usually empty trains people to swipe it away. For a supervisor «nothing»
 * now includes the counts: if no seller owes a call either, nobody hears from
 * us. And it has its own mute switch (4.3b), so «stop sending me this one»
 * no longer means muting the warehouse summary with it.
 */
export async function sendFollowUpDigest(now = new Date()): Promise<number> {
  const asOf = now.toISOString().slice(0, 10);
  let sent = 0;

  for (const recipient of await crmRecipients()) {
    const calls = await dayCalls({
      actorId: recipient.userId,
      seesAll: recipient.seesAll,
      asOf,
      includeOthers: recipient.seesAll,
    });
    const own = [...calls.mine, ...calls.stale];
    if (own.length === 0 && calls.othersCount === 0) continue;

    const lines = own
      .slice(0, 30)
      .map((item) => {
        const late = item.dueOn < asOf ? ` ⚠️ ${item.dueOn}` : '';
        const icon = item.kind === 'lead' ? '🆕' : '👤';
        return `${icon} ${item.title}${item.subtitle ? ` · ${item.subtitle}` : ''}${late}\n   ${
          item.note ?? ''
        }`.trimEnd();
      })
      .join('\n');
    const more = own.length > 30 ? `\n… va yana ${own.length - 30} ta` : '';
    const others = othersLine(calls.others);
    const tail = others ? `\n\n👥 Sotuvchilar: ${others}` : '';
    const head =
      own.length > 0
        ? `📞 Bugun bog‘lanish kerak (${own.length})\n\n${lines}${more}`
        : '📞 Bugun sizda qo‘ng‘iroq yo‘q';

    await deliver(recipient.userId, 'CrmFollowUps', `${head}${tail}`);
    sent += 1;
  }
  return sent;
}

/**
 * Clients who have gone quiet (owner's answer 4). Weekly, not daily: the list
 * barely changes day to day, and a daily copy of the same names is noise.
 */
export async function sendDormantDigest(): Promise<number> {
  const days = Number(await getSetting('crm_dormant_days')) || 60;
  let sent = 0;

  for (const recipient of await crmRecipients()) {
    const rows = await dormantClients(days, recipient.seesAll ? undefined : recipient.userId);
    if (rows.length === 0) continue;

    const lines = rows
      .slice(0, 25)
      .map(
        (row) =>
          `😴 ${row.code} · ${row.name} — ${row.daysQuiet} kun${
            row.balanceUsd > 0 ? ` · qarz ${row.balanceUsd}$` : ''
          }`,
      )
      .join('\n');
    const more = rows.length > 25 ? `\n… va yana ${rows.length - 25} ta` : '';
    await deliver(
      recipient.userId,
      'CrmDormant',
      `😴 ${days} kundan beri yuk yubormagan mijozlar (${rows.length})\n\n${lines}${more}`,
    );
    sent += 1;
  }
  return sent;
}

export async function registerCrmWorkers(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CRM_FOLLOWUPS);
  await boss.createQueue(JOB_CRM_DORMANT);
  // 08:30 Asia/Tashkent (UTC+5, no DST) — before the working day, and half an
  // hour ahead of the warehouse digest so the two do not arrive as one wall
  // of text.
  await boss.schedule(JOB_CRM_FOLLOWUPS, '30 3 * * *');
  // Monday 09:00 Tashkent.
  await boss.schedule(JOB_CRM_DORMANT, '0 4 * * 1');

  await boss.work(JOB_CRM_FOLLOWUPS, async () => {
    try {
      const sent = await sendFollowUpDigest();
      logger.info({ sent }, 'crm follow-up digest run');
    } catch (err) {
      logger.error({ err }, 'crm follow-up digest failed');
      throw err;
    }
  });
  await boss.work(JOB_CRM_DORMANT, async () => {
    try {
      const sent = await sendDormantDigest();
      logger.info({ sent }, 'crm dormant digest run');
    } catch (err) {
      logger.error({ err }, 'crm dormant digest failed');
      throw err;
    }
  });
}
