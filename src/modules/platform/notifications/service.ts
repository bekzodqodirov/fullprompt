import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  clients,
  events,
  notifications,
  roles,
  telegramLinks,
  userRoles,
} from '../db/schema';
import { logger } from '../logger';

/**
 * Event → recipient rules (spec §11). Each event fans out to notification
 * rows (one per user per channel); Telegram rows are then sent by the
 * telegram worker with retry, in-app rows feed the bell.
 */

interface RecipientNotification {
  userId: string;
  type: string;
  payload: Record<string, unknown>;
}

async function usersWithRoles(roleCodes: string[]): Promise<string[]> {
  const rows = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(inArray(roles.code, roleCodes));
  return [...new Set(rows.map((r) => r.userId))];
}

async function buildRecipients(event: {
  type: string;
  payload: Record<string, unknown>;
}): Promise<RecipientNotification[]> {
  switch (event.type) {
    case 'ReceiptConfirmed': {
      const clientId = event.payload.clientId as string | null;
      if (!clientId) return [];
      const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
      if (!client?.salesManagerId) return [];
      return [
        {
          userId: client.salesManagerId,
          type: 'ReceiptConfirmed',
          payload: { ...event.payload, clientCode: client.clientCode, clientName: client.name },
        },
      ];
    }
    case 'UnknownCargoReceived': {
      const userIds = await usersWithRoles(['logist', 'admin', 'super_admin']);
      return userIds.map((userId) => ({
        userId,
        type: 'UnknownCargoReceived',
        payload: event.payload,
      }));
    }
    // Plan verdict + not-on-plan alerts go to logists (spec §11).
    case 'PlanApproved':
    case 'PlanChangesRequested': {
      const userIds = await usersWithRoles(['logist', 'admin', 'super_admin']);
      return userIds.map((userId) => ({ userId, type: event.type, payload: event.payload }));
    }
    case 'BoxScannedOnLoad': {
      if (!event.payload.addedOnSpot) return [];
      const userIds = await usersWithRoles(['logist', 'admin', 'super_admin']);
      return userIds.map((userId) => ({ userId, type: event.type, payload: event.payload }));
    }
    default:
      return [];
  }
}

/** Render the Telegram message text (ru — staff channel language). */
export function renderTelegramText(type: string, payload: Record<string, unknown>): string {
  const appUrl = process.env.APP_URL ?? '';
  const lots =
    (payload.lots as {
      letter: string;
      productNameZh: string;
      productNameRu: string | null;
      boxCount: number;
      totalWeightKg: number;
      totalVolumeM3: number;
    }[]) ?? [];
  const lotLines = lots
    .map(
      (l) =>
        `${l.letter} — ${l.productNameZh}${l.productNameRu ? ` (${l.productNameRu})` : ''}: ${l.boxCount} кор., ${l.totalWeightKg} кг, ${l.totalVolumeM3} м³`,
    )
    .join('\n');
  const link = `${appUrl}/receipts/${payload.receiptId}`;

  switch (type) {
    case 'ReceiptConfirmed':
      return (
        `📥 Приёмка ${payload.number}\n` +
        `Клиент: ${payload.clientCode} (${payload.clientName})\n` +
        `Склад: ${payload.warehouseCode}\n\n${lotLines}\n\n${link}`
      );
    case 'UnknownCargoReceived':
      return (
        `❓ Неопознанный груз ${payload.number}\n` +
        (payload.unclaimedMarking ? `Маркировка: ${payload.unclaimedMarking}\n` : '') +
        `Склад: ${payload.warehouseCode}\n\n${lotLines}\n\n${link}`
      );
    case 'PlanApproved':
      return `✅ План одобрен агентом — партия ${payload.batchCode}\n${appUrl}/batches/${payload.batchId}`;
    case 'PlanChangesRequested':
      return (
        `✏️ Агент просит изменить план (v${payload.versionNo})\n` +
        (payload.comment ? `Комментарий: ${payload.comment}\n` : '') +
        `${appUrl}/plans/${payload.planId}`
      );
    case 'BoxScannedOnLoad':
      return (
        `🚨 Груз вне плана погружен в ${payload.batchCode}\n` +
        `Коробки: ${(payload.shortCodes as string[] | undefined)?.join(', ') ?? ''}\n` +
        (payload.reason ? `Причина: ${payload.reason}\n` : '') +
        `${appUrl}/batches/${payload.batchId}`
      );
    case 'DailyDigest':
      return String(payload.text ?? '');
    default:
      return `${type}\n${link}`;
  }
}

/** Fan out unprocessed events into notification rows. Called by the events worker. */
export async function processPendingEvents(): Promise<number> {
  const pending = await db
    .select()
    .from(events)
    .where(isNull(events.processedAt))
    .orderBy(events.id)
    .limit(50);

  let created = 0;
  for (const event of pending) {
    const recipients = await buildRecipients({
      type: event.type,
      payload: event.payload as Record<string, unknown>,
    });
    for (const recipient of recipients) {
      // In-app bell row
      await db.insert(notifications).values({
        userId: recipient.userId,
        eventId: event.id,
        channel: 'in_app',
        type: recipient.type,
        payload: recipient.payload,
        status: 'sent',
        sentAt: new Date(),
      });
      // Telegram row (pending → sent by the telegram worker)
      const link = await db.query.telegramLinks.findFirst({
        where: and(
          eq(telegramLinks.userId, recipient.userId),
          eq(telegramLinks.status, 'linked'),
        ),
      });
      await db.insert(notifications).values({
        userId: recipient.userId,
        eventId: event.id,
        channel: 'telegram',
        type: recipient.type,
        payload: recipient.payload,
        status: link ? 'pending' : 'muted',
        error: link ? null : 'telegram not linked',
      });
      created += 1;
    }
    await db.update(events).set({ processedAt: new Date() }).where(eq(events.id, event.id));
  }
  return created;
}

/** Send all pending Telegram notifications. Called by the telegram worker. */
export async function sendPendingTelegram(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const pending = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.channel, 'telegram'), eq(notifications.status, 'pending')))
    .limit(30);

  for (const notification of pending) {
    const link = await db.query.telegramLinks.findFirst({
      where: and(
        eq(telegramLinks.userId, notification.userId),
        eq(telegramLinks.status, 'linked'),
      ),
    });
    if (!link?.telegramChatId) {
      await db
        .update(notifications)
        .set({ status: 'muted', error: 'telegram not linked' })
        .where(eq(notifications.id, notification.id));
      continue;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: Number(link.telegramChatId),
          text: renderTelegramText(
            notification.type,
            notification.payload as Record<string, unknown>,
          ),
        }),
      });
      const body = (await res.json()) as { ok: boolean; description?: string };
      if (!body.ok) throw new Error(body.description ?? 'telegram send failed');
      await db
        .update(notifications)
        .set({ status: 'sent', sentAt: new Date(), error: null })
        .where(eq(notifications.id, notification.id));
    } catch (err) {
      logger.error({ err, notificationId: notification.id }, 'telegram send failed');
      await db
        .update(notifications)
        .set({ error: String(err) })
        .where(eq(notifications.id, notification.id));
      throw err; // let pg-boss retry with backoff
    }
  }
}

export async function unreadCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.channel, 'in_app'),
        isNull(notifications.readAt),
      ),
    );
  return Number(row?.n ?? 0);
}
