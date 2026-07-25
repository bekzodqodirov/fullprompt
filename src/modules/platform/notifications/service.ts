import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  clients,
  clientTelegramLinks,
  events,
  notifications,
  roles,
  telegramLinks,
  userRoles,
  users,
} from '../db/schema';
import { logger } from '../logger';
import { notificationLabels } from './labels';
import { isTelegramMuted } from './mutes';

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
    // UZ side: arrival summary and issue confirmations go to the client's
    // sales manager with a shareable client-message draft (spec 6.6/6.7).
    case 'ReadyForPickup':
    case 'BoxIssued': {
      const clientId = event.payload.clientId as string | null;
      if (!clientId) return [];
      const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
      if (!client?.salesManagerId) return [];
      return [
        {
          userId: client.salesManagerId,
          type: event.type,
          payload: { ...event.payload, clientCode: client.clientCode, clientName: client.name },
        },
      ];
    }
    // Plan verdict, not-on-plan and unload discrepancies go to logists (spec §11).
    case 'PlanApproved':
    case 'PlanChangesRequested':
    case 'UndocumentedTransfer':
    case 'MissingInTransit':
    // Inventory result goes to the owner/admins (owner's answer: the
    // warehouse manager decides, the boss gets the Telegram).
    case 'InventoryCompleted': {
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

/**
 * Render the Telegram message text in the RECIPIENT's language.
 *
 * Every staff message is rendered once per reader, so a warehouse manager
 * working in Uzbek and an accountant working in English get the same event in
 * their own words. The client-facing drafts inside ReadyForPickup stay as they
 * are: the manager forwards those to the client, and the client's language has
 * nothing to do with the manager's.
 */
export function renderTelegramText(
  type: string,
  payload: Record<string, unknown>,
  locale?: string | null,
): string {
  const L = notificationLabels(locale);
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
        `${l.letter} — ${l.productNameZh}${l.productNameRu ? ` (${l.productNameRu})` : ''}: ${l.boxCount} ${L.boxesShort}, ${l.totalWeightKg} ${L.kg}, ${l.totalVolumeM3} ${L.m3}`,
    )
    .join('\n');
  const link = `${appUrl}/receipts/${payload.receiptId}`;
  const codes = (payload.shortCodes as string[] | undefined)?.join(', ') ?? '';

  switch (type) {
    case 'ReceiptConfirmed':
      return (
        `📥 ${L.receiptConfirmed} ${payload.number}\n` +
        `${L.client}: ${payload.clientCode} (${payload.clientName})\n` +
        `${L.warehouse}: ${payload.warehouseCode}\n\n${lotLines}\n\n${link}`
      );
    case 'UnknownCargoReceived':
      return (
        `❓ ${L.unknownCargo} ${payload.number}\n` +
        (payload.unclaimedMarking ? `${L.marking}: ${payload.unclaimedMarking}\n` : '') +
        `${L.warehouse}: ${payload.warehouseCode}\n\n${lotLines}\n\n${link}`
      );
    case 'PlanApproved':
      return `✅ ${L.planApproved} ${payload.batchCode}\n${appUrl}/batches/${payload.batchId}`;
    case 'PlanChangesRequested':
      return (
        `✏️ ${L.planChanges} (v${payload.versionNo})\n` +
        (payload.comment ? `${L.comment}: ${payload.comment}\n` : '') +
        `${appUrl}/plans/${payload.planId}`
      );
    case 'BoxScannedOnLoad':
      return (
        `🚨 ${L.offPlanLoaded} ${payload.batchCode}\n` +
        `${L.boxesLine}: ${codes}\n` +
        (payload.reason ? `${L.reason}: ${payload.reason}\n` : '') +
        `${appUrl}/batches/${payload.batchId}`
      );
    case 'UndocumentedTransfer':
      return (
        `📦❗ ${L.undocumented} ${payload.batchCode}\n` +
        `${L.boxesLine}: ${codes}\n` +
        `${appUrl}/batches/${payload.batchId}`
      );
    case 'MissingInTransit':
      return (
        `🔍 ${L.missingInTransit} ${payload.batchCode}\n` +
        `${L.boxesLine}: ${codes}\n` +
        `${appUrl}/batches/${payload.batchId}`
      );
    case 'InventoryCompleted': {
      const moved = (payload.moved as string[] | undefined) ?? [];
      const lost = (payload.lost as string[] | undefined) ?? [];
      return (
        `📋 ${L.inventoryAt} ${payload.warehouseCode}\n` +
        `${L.scanned}: ${payload.scanned}\n` +
        (moved.length ? `↩️ ${L.movedHere}: ${moved.join(', ')}\n` : '') +
        (lost.length ? `❌ ${L.markedLost}: ${lost.join(', ')}\n` : '') +
        (!moved.length && !lost.length ? `✅ ${L.noDiscrepancies}\n` : '') +
        `${appUrl}/dashboard`
      );
    }
    case 'ReadyForPickup':
      // The second half is the ready client-message draft (uz + ru) the
      // manager forwards as-is (owner's Q5 wording: arrived, being cleared).
      return (
        `📦 ${L.cargoArrived} ${payload.clientCode} (${payload.clientName}) ${L.arrivedWord}: ${payload.boxCount} ${L.boxesShort} · ${L.warehouse} ${payload.warehouseCode} · ${L.batchWord} ${payload.batchCode}\n\n` +
        `— ${L.forTheClient} (uz):\nAssalomu alaykum! ${payload.clientCode} kodli yukingiz (${payload.boxCount} karobka) ${payload.warehouseCode} omboriga yetib keldi. Rasmiylashtiruv tugagach olib ketish vaqtini kelishamiz.\n\n` +
        `— ${L.forTheClient} (ru):\nЗдравствуйте! Ваш груз с кодом ${payload.clientCode} (${payload.boxCount} кор.) прибыл на склад ${payload.warehouseCode}. Согласуем выдачу после оформления.`
      );
    case 'BoxIssued':
      return (
        `🤝 ${L.issuedTo} ${payload.clientCode} (${payload.clientName}): ${payload.boxCount} ${L.boxesShort} · ${L.warehouse} ${payload.warehouseCode}\n` +
        `${L.receivedBy}: ${payload.personName}${payload.personPhone ? ` (${payload.personPhone})` : ''}` +
        (payload.remaining ? `\n${L.leftInStock}: ${payload.remaining} ${L.boxesShort}` : '')
      );
    case 'DailyDigest':
      return String(payload.text ?? '');
    case 'RestoreTestFailed':
      return `🆘 ${L.restoreFailed}\n${payload.error}\n${L.restoreCheck}`;
    default:
      return `${type}\n${link}`;
  }
}

/**
 * Direct message to the client's own linked Telegram chats (Phase 2.2
 * cabinet). Best-effort: a send failure is logged and never blocks the event
 * — the client can always open the cabinet and see the same state.
 */
export function renderClientCabinetText(
  type: string,
  payload: Record<string, unknown>,
): string | null {
  switch (type) {
    case 'ReadyForPickup':
      // Owner's Q5 wording: arrived, being cleared — pickup after paperwork.
      return (
        `📦 Assalomu alaykum! ${payload.clientCode} kodli yukingiz (${payload.boxCount} karobka) ` +
        `${payload.warehouseCode} omboriga yetib keldi. Rasmiylashtiruv tugagach olib ketish vaqtini kelishamiz.`
      );
    case 'BoxIssued':
      return (
        `🤝 ${payload.clientCode}: ${payload.boxCount} karobka yukingiz berildi (sklad ${payload.warehouseCode}). ` +
        `Oluvchi: ${payload.personName}.` +
        (Number(payload.remaining) > 0 ? `\nSkladda qoldi: ${payload.remaining} karobka.` : '')
      );
    default:
      return null;
  }
}

async function notifyLinkedClients(event: {
  type: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const clientId = event.payload.clientId as string | null;
  if (!clientId) return;
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  const text = renderClientCabinetText(event.type, {
    ...event.payload,
    clientCode: client?.clientCode ?? '',
  });
  if (!text) return;
  const links = await db
    .select()
    .from(clientTelegramLinks)
    .where(
      and(eq(clientTelegramLinks.clientId, clientId), eq(clientTelegramLinks.status, 'linked')),
    );
  for (const link of links) {
    if (!link.telegramChatId) continue;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: Number(link.telegramChatId), text }),
      });
    } catch (err) {
      logger.warn({ err, clientId }, 'client cabinet notify failed');
    }
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
      const user = await db.query.users.findFirst({
        columns: { mutedNotificationTypes: true },
        where: eq(users.id, recipient.userId),
      });
      const userMuted = isTelegramMuted(user?.mutedNotificationTypes, recipient.type);
      await db.insert(notifications).values({
        userId: recipient.userId,
        eventId: event.id,
        channel: 'telegram',
        type: recipient.type,
        payload: recipient.payload,
        status: link && !userMuted ? 'pending' : 'muted',
        error: userMuted ? 'muted by user' : link ? null : 'telegram not linked',
      });
      created += 1;
    }
    await notifyLinkedClients({
      type: event.type,
      payload: event.payload as Record<string, unknown>,
    });
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
    const recipient = await db.query.users.findFirst({
      columns: { locale: true },
      where: eq(users.id, notification.userId),
    });
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
            recipient?.locale,
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
