import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  clients,
  clientTelegramLinks,
  events,
  notifications,
  permissions,
  rolePermissions,
  roles,
  telegramLinks,
  userRoles,
  users,
} from '../db/schema';
import { logger } from '../logger';
import { runAutomationRules } from '../automation/service';
import { clientLabels } from '../telegram/client-labels';
import { cabinetInlineKeyboard } from '../telegram/menu-button';
import { buttonsFor } from '../telegram/staff-bot';
import { notificationLabels } from './labels';
import { isTelegramMuted } from './mutes';

/**
 * Event → recipient rules (spec §11). Each event fans out to notification
 * rows (one per user per channel); Telegram rows are then sent by the
 * telegram worker with retry, in-app rows feed the bell.
 */

/**
 * Telegram tries this many times before a message is written off. Six
 * attempts across pg-boss's backoff is roughly a day — long enough to ride
 * out an outage, short enough that a blocked bot stops being retried.
 */
const MAX_TELEGRAM_ATTEMPTS = 6;

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

/**
 * Everyone whose CURRENT grants include a permission. Resolved from
 * role_permissions, never from the seed matrix: grants have been editable
 * data since Phase 1, and a role the owner invented must be reachable too.
 */
export async function usersWithPermission(code: string): Promise<string[]> {
  const rows = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(permissions.code, code));
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
    // Price control (docs/DEALS.md). The alert is worth nothing unless it
    // reaches somebody who can act on it WHILE the cargo is still in China, so
    // it goes to the deal's owner if it has one, otherwise to the client's
    // sales manager — never broadcast, because a list of somebody else's
    // pricing problems is a message people learn to swipe away.
    case 'UnquotedCargo':
    case 'DealDeviation':
    case 'DealDeferralEnded': {
      const clientId = event.payload.clientId as string | null;
      if (!clientId) return [];
      const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
      const owner = (event.payload.ownerId as string | null) ?? client?.salesManagerId ?? null;
      if (!owner) {
        // A client with nobody assigned would otherwise lose the alert
        // silently — which is the very failure this feature exists to stop.
        const userIds = await usersWithRoles(['admin', 'super_admin']);
        return userIds.map((userId) => ({ userId, type: event.type, payload: event.payload }));
      }
      return [
        {
          userId: owner,
          type: event.type,
          payload: {
            ...event.payload,
            clientCode: client?.clientCode,
            clientName: client?.name,
          },
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
    // Phase 6: the request reaches everyone who may decide it; the decision
    // reaches exactly the person who asked.
    case 'DebtApprovalRequested': {
      const userIds = await usersWithPermission('finance.debt_override');
      return userIds.map((userId) => ({ userId, type: event.type, payload: event.payload }));
    }
    case 'DebtApprovalDecided': {
      const requestedBy = event.payload.requestedBy as string | null;
      if (!requestedBy) return [];
      return [{ userId: requestedBy, type: event.type, payload: event.payload }];
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

  /**
   * A digest carries its own text and that text IS the message.
   *
   * Checked BEFORE the switch, not as one more case: a digest is composed per
   * recipient from rows no case here could reproduce, so every digest that
   * will ever be written needs this branch. `DailyDigest` had a case; the two
   * CRM digests shipped without one and every reader got the literal string
   * "CrmFollowUps" followed by a link to /receipts/undefined.
   */
  const preRendered = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (preRendered) return preRendered;

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
    // Cargo that landed with no agreed price — the single biggest source of
    // "it came out expensive" arguments, caught while it is still in China.
    case 'UnquotedCargo':
      return (
        `💰❓ ${L.unquotedCargo} — ${payload.number}\n` +
        `${L.client}: ${payload.clientCode} (${payload.clientName})\n` +
        `${L.warehouse}: ${payload.warehouseCode}\n` +
        `${payload.volumeM3} ${L.m3} · ${payload.weightKg} ${L.kg} · ${payload.boxCount} ${L.boxesShort}\n\n` +
        `${L.setPrice}\n${link}`
      );
    // Quoted, but the cargo is more than the threshold away from the quote.
    case 'DealDeviation': {
      const pct = Number(payload.worstPct ?? 0);
      const sign = pct > 0 ? '+' : '';
      return (
        `⚖️ ${L.dealDeviation} — ${payload.dealCode}\n` +
        `${L.client}: ${payload.clientCode} (${payload.clientName})\n` +
        `${L.quoted}: ${payload.quotedVolumeM3 ?? '—'} ${L.m3} · ${payload.quotedWeightKg ?? '—'} ${L.kg}` +
        (payload.quotedAmount ? ` · ${payload.quotedAmount} ${payload.quotedCurrency ?? ''}` : '') +
        `\n${L.actual}: ${payload.actualVolumeM3} ${L.m3} · ${payload.actualWeightKg} ${L.kg}` +
        ` (${sign}${pct.toFixed(1)} %)\n` +
        (payload.suggestedAmount !== null && payload.suggestedAmount !== undefined
          ? `${L.suggested}: ${payload.suggestedAmount} ${payload.quotedCurrency ?? ''}\n`
          : '') +
        `\n${appUrl}/bitimlar/${payload.dealId}`
      );
    }
    case 'DealDeferralEnded':
      return (
        `⏰ ${L.deferralEnded} — ${payload.dealCode}\n` +
        `${payload.reason === 'all_arrived' ? L.allBoxesArrived : L.datePassed}\n\n` +
        `${appUrl}/bitimlar/${payload.dealId}`
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
    case 'DebtApprovalRequested':
      return (
        `🔐 ${L.debtApprovalRequested}\n` +
        `${L.client}: ${payload.clientCode} (${payload.clientName}) · ${L.warehouse} ${payload.warehouseCode}\n` +
        `${L.debtLine}: $${payload.blockingDebtUsd}\n` +
        `${L.requestedByWord}: ${payload.requestedByName}` +
        (payload.note ? `\n${L.comment}: ${payload.note}` : '') +
        `\n\n${appUrl}/approvals`
      );
    case 'DebtApprovalDecided':
      return (
        `${payload.verdict === 'approved' ? `✅ ${L.debtApprovalYes}` : `⛔ ${L.debtApprovalNo}`}\n` +
        `${L.client}: ${payload.clientCode} (${payload.clientName})\n` +
        `${L.decidedByWord}: ${payload.decidedByName}` +
        (payload.note ? `\n${L.comment}: ${payload.note}` : '') +
        `\n\n${appUrl}/issue`
      );
    case 'RestoreTestFailed':
      return `🆘 ${L.restoreFailed}\n${payload.error}\n${L.restoreCheck}`;
    // Without this case the most important alert in the system fell to the
    // default below and reached the owner's phone as the literal word
    // "BackupFailed" and a URL — with `payload.error`, the one thing that
    // says WHAT broke, dropped on the floor. A nightly backup that did not
    // happen is not something to find out about from a bare event name.
    case 'BackupFailed':
      return `🆘 ${L.backupFailed}\n${payload.error ?? ''}\n${L.backupCheck}`;
    default:
      // No case and no pre-rendered text. Say what happened and point at the
      // app — never at `/receipts/undefined`, which is what this branch used
      // to send for every event that had no receipt.
      return payload.receiptId ? `${type}\n${link}` : `${type}\n${appUrl}`;
  }
}

/** The per-lot summary `confirmReceipt` puts on a ReceiptConfirmed event. */
interface ArrivedLot {
  letter: string | null;
  productNameZh: string;
  productNameRu: string | null;
  boxCount: number;
  totalWeightKg: string | number | null;
  totalVolumeM3: string | number | null;
}

/** Two decimals, without a trailing `.00` on a whole number. */
function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/**
 * Direct message to the client's own linked Telegram chats (Phase 2.2
 * cabinet). Best-effort: a send failure is logged and never blocks the event
 * — the client can always open the cabinet and see the same state.
 */
export function renderClientCabinetText(
  type: string,
  payload: Record<string, unknown>,
  locale?: string | null,
): string | null {
  const t = clientLabels(locale);
  switch (type) {
    /**
     * Cargo reached the CHINESE warehouse — the owner's first ask, and the
     * message a client wants most: "did my goods arrive?" is the question the
     * office answers by telephone all day. Until now the only client-facing
     * events were arrival in Uzbekistan and handover, so the whole first half
     * of the journey was silent.
     */
    case 'ReceiptConfirmed': {
      const lots = Array.isArray(payload.lots) ? (payload.lots as ArrivedLot[]) : [];
      if (lots.length === 0) return null;
      const boxes = lots.reduce((sum, lot) => sum + Number(lot.boxCount ?? 0), 0);
      const kg = lots.reduce((sum, lot) => sum + Number(lot.totalWeightKg ?? 0), 0);
      const m3 = lots.reduce((sum, lot) => sum + Number(lot.totalVolumeM3 ?? 0), 0);
      const lines = lots.map((lot) => {
        // The product name is Chinese with a NULLABLE Russian translation, so
        // a client reading Uzbek would be shown 手机壳 unless the fallback is
        // deliberate: prefer the translated name, keep the Chinese beside it
        // only when there is nothing else.
        const name = lot.productNameRu?.trim() || lot.productNameZh;
        return `· ${lot.letter ?? ''} ${name} — ${lot.boxCount} ${t.pieces}`;
      });
      return (
        `${t.arrivedTitle}\n` +
        `${payload.clientCode} · ${payload.number}\n` +
        `${t.arrivedWarehouse}: ${payload.warehouseCode}\n\n` +
        `${lines.join('\n')}\n\n` +
        `${t.arrivedTotal}: ${boxes} ${t.pieces} · ${round(kg)} ${t.kg} · ${round(m3)} ${t.m3}\n` +
        t.seeDetails
      );
    }
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
  // In the CLIENT's language, not the office's (migration 0033). NULL means
  // nobody has asked them yet, and `clientLabels` falls back.
  const text = renderClientCabinetText(
    event.type,
    { ...event.payload, clientCode: client?.clientCode ?? '' },
    client?.locale,
  );
  if (!text) return;
  const links = await db
    .select()
    .from(clientTelegramLinks)
    .where(
      and(eq(clientTelegramLinks.clientId, clientId), eq(clientTelegramLinks.status, 'linked')),
    );
  /**
   * One message per CHAT, not per link row.
   *
   * `client_telegram_links` has no unique constraint on (client_id, chat_id),
   * and two paths can insert a second 'linked' row for the same pair — the
   * phone verification and `autoLinkClientToVerifiedChats`. Every duplicate
   * row would have sent the client another copy of the same sentence, and a
   * cabinet that says the same thing twice is one people stop reading.
   */
  const chats = new Set<bigint>();
  for (const link of links) if (link.telegramChatId) chats.add(link.telegramChatId);

  const app = cabinetInlineKeyboard(process.env.APP_URL, client?.locale);

  for (const chatId of chats) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The wide "open my cargo" button rides on the notification itself.
        // This is the moment a client cares most — their goods just moved —
        // so it is the one place the app should be a single tap away rather
        // than an icon they have to go looking for.
        body: JSON.stringify({
          chat_id: Number(chatId),
          text,
          ...(app ? { reply_markup: app } : {}),
        }),
      });
      // The answer was never read before, so a client who had BLOCKED the bot
      // looked exactly like a client who received the message — and the whole
      // point of these is knowing they went out.
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        logger.warn({ clientId, status: res.status, detail: detail.slice(0, 200) }, 'client notify rejected');
      }
    } catch (err) {
      logger.warn({ err, clientId }, 'client cabinet notify failed');
    }
  }
}

/**
 * Fan out unprocessed events into notification rows. Called by the events
 * worker. Drains in batches until the backlog is empty (bounded), because a
 * backlog deeper than one batch used to advance only 50 events per MINUTE —
 * an hour of silence after any burst.
 */
export async function processPendingEvents(): Promise<number> {
  let created = 0;
  for (let batch = 0; batch < 40; batch++) {
    const processed = await processEventBatch();
    created += processed.created;
    if (!processed.full) break;
  }
  return created;
}

async function processEventBatch(): Promise<{ created: number; full: boolean }> {
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
    // Phase 7: the owner's rules hear the same event, fenced so a broken
    // rule can neither kill the fan-out nor leave the event unprocessed.
    try {
      await runAutomationRules({
        type: event.type,
        payload: event.payload as Record<string, unknown>,
        entityType: event.entityType,
        entityId: event.entityId,
        actorId: event.actorId,
      });
    } catch (err) {
      logger.error({ err, eventId: String(event.id) }, 'automation run failed');
    }
    // Round 26: linked cargo drives the deal funnel. The wms engine is
    // reached the way startBoss reaches wms workers — a dynamic import,
    // because platform never imports wms statically. Fenced the same as the
    // rules: a stuck funnel must not block the fan-out.
    try {
      const { runDealAutoStage } = await import('../../wms/deals/auto-stage');
      await runDealAutoStage({
        type: event.type,
        payload: event.payload as Record<string, unknown>,
        entityType: event.entityType,
        entityId: event.entityId,
        actorId: event.actorId,
      });
    } catch (err) {
      logger.error({ err, eventId: String(event.id) }, 'deal auto-stage failed');
    }
    await db.update(events).set({ processedAt: new Date() }).where(eq(events.id, event.id));
  }
  return { created, full: pending.length === 50 };
}

/** Send all pending Telegram notifications. Called by the telegram worker. */
export async function sendPendingTelegram(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const pending = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.channel, 'telegram'),
        eq(notifications.status, 'pending'),
        lt(notifications.attempts, MAX_TELEGRAM_ATTEMPTS),
      ),
    )
    .limit(30);

  // One dead chat must not hold up the queue. Every row is attempted, its
  // own failure recorded, and the batch reports at the end — before this,
  // the first driver who blocked the bot stopped every message behind them,
  // including "boxes missing in transit".
  let failed = 0;

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
      // Inline buttons ride on the send, by type (staff bot, round 35): a
      // task lands with «Bajarildi», a debtor request with «Ruxsat / Yo‘q».
      const buttons = buttonsFor(
        notification.type,
        notification.payload as Record<string, unknown>,
      );
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
          ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
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
      failed += 1;
      const attempts = notification.attempts + 1;
      await db
        .update(notifications)
        .set({
          attempts,
          error: String(err),
          // Out of attempts: stop asking. A blocked bot or a deleted chat
          // never becomes deliverable, and a row that retries for ever keeps
          // the whole job failing.
          status: attempts >= MAX_TELEGRAM_ATTEMPTS ? 'failed' : 'pending',
        })
        .where(eq(notifications.id, notification.id));
    }
  }

  // Still throw so pg-boss retries — but only after every row had its turn.
  // Rows already marked `sent` are excluded from the next pass, so a retry
  // re-sends nothing.
  if (failed > 0) throw new Error(`${failed} telegram message(s) failed`);
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
