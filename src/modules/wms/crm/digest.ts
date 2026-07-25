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
import { dormantClients, followUps } from './service';

export const JOB_CRM_FOLLOWUPS = 'crm.followups';
export const JOB_CRM_DORMANT = 'crm.dormant';

/**
 * The two CRM messages the owner asked for (answers 4 and 5).
 *
 * Both are PER RECIPIENT, not one broadcast: a sales manager must get their
 * own list, because a message about someone else's clients is a message they
 * learn to ignore. The owner and the logist, who hold `crm.leads.view_all`,
 * get everything.
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
 * "Who am I calling today" — leads and clients whose follow-up date has
 * arrived. Silence when there is nothing due: a daily message that is usually
 * empty trains people to swipe it away.
 */
export async function sendFollowUpDigest(now = new Date()): Promise<number> {
  const asOf = now.toISOString().slice(0, 10);
  let sent = 0;

  for (const recipient of await crmRecipients()) {
    const due = await followUps(asOf, recipient.seesAll ? undefined : recipient.userId);
    if (due.length === 0) continue;

    const lines = due
      .slice(0, 30)
      .map((item) => {
        const late = item.dueOn < asOf ? ` ⚠️ ${item.dueOn}` : '';
        const icon = item.kind === 'lead' ? '🆕' : '👤';
        return `${icon} ${item.title}${item.subtitle ? ` · ${item.subtitle}` : ''}${late}\n   ${
          item.note ?? ''
        }`.trimEnd();
      })
      .join('\n');
    const more = due.length > 30 ? `\n… va yana ${due.length - 30} ta` : '';
    await deliver(
      recipient.userId,
      'CrmFollowUps',
      `📞 Bugun bog‘lanish kerak (${due.length})\n\n${lines}${more}`,
    );
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
