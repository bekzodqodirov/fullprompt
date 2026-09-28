import { and, eq, gte, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client';
import {
  clients,
  events,
  issueApprovals,
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
import { botRefused } from '../diagnostics/signals';
import { buttonsFor } from '../telegram/staff-bot';
import { approvalVerdictLine, fillCount, notificationLabels } from './labels';
import { isTelegramMuted } from './mutes';
import { sendsSilently } from './night';
import { h } from '../telegram/format';
import {
  botCall,
  editText,
  isBotFailure,
  isPermanentFailure,
  sendText,
  type SendResult,
} from '../telegram/send';
import { appendLine, composeStaffHtml, keyboardOf, type StaffMessage } from './staff-html';

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

export async function usersWithRoles(roleCodes: string[]): Promise<string[]> {
  const rows = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    // Deactivation is the only removal the app offers, and it must mean
    // removed: a logist who left the company kept receiving every alarm —
    // debt approvals with the client's name and figure on them — because the
    // recipient lists asked who holds the ROLE and never who still works
    // here. Their user_roles rows survive deactivation by design (a
    // reactivated person gets their job back), so the filter lives HERE.
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(and(inArray(roles.code, roleCodes), eq(users.active, true)));
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
    // Same rule as usersWithRoles above: a grant belongs to the role, but a
    // notification belongs to a person who still works here.
    .innerJoin(users, eq(userRoles.userId, users.id))
    .where(and(eq(permissions.code, code), eq(users.active, true)));
  return [...new Set(rows.map((r) => r.userId))];
}

/**
 * How many staff messages actually FAILED to leave in the window (round 107,
 * the admin home's «yuborilmagan» signal). Deliberately narrower than the
 * /admin/notifications list's own marker: `muted` there includes by-design
 * settlements — a user's own mute, «telegram not linked», «user deactivated»
 * — which on this production are never zero, and a warn that never clears
 * teaches the eye to skip it. Failed, a pending row that already errored,
 * or a claim stuck in 'sending' past the reclaim window (0082) — those are
 * the three that mean somebody should look.
 *
 * And a fourth (B9): a row still PENDING a quarter of an hour after it was
 * written. The first three need a send to have been ATTEMPTED — and a dead
 * bot attempts nothing: a revoked token pauses the drain and puts every row
 * back untouched, a missing token returns before claiming one. So the day the
 * bot died, 37 messages sat pending with no error and this counter read 0.
 * Fifteen minutes is fifteen of the drain's one-minute ticks; nothing healthy
 * waits that long.
 */
export const TELEGRAM_BACKLOG_MINUTES = 15;

/**
 * «Pending past the backlog window» — the fourth clause above, in one place:
 * the problem list counts it and the bot's red line fires on it, and a second
 * copy of the fifteen minutes (it once lived in JS beside this one) is two
 * clocks for one sentence.
 */
function telegramBacklogSql(): SQL {
  return sql`(${notifications.status} = 'pending'
          AND ${notifications.createdAt} < now() - make_interval(mins => ${TELEGRAM_BACKLOG_MINUTES}))`;
}

/**
 * The ONE sentence «this staff message is a delivery problem», shared by the
 * home counter and the /admin/notifications «problems» list — so the 37 on the
 * home screen and the 37 rows behind its link are one predicate (#513; the
 * page used to keep its own copy, with `muted` in it and no window).
 */
export function telegramProblemSql(since: Date): SQL {
  return and(
    eq(notifications.channel, 'telegram'),
    gte(notifications.createdAt, since),
    sql`(${notifications.status} = 'failed'
          OR (${notifications.status} = 'pending' AND ${notifications.error} IS NOT NULL)
          OR ${telegramBacklogSql()}
          OR (${notifications.status} = 'sending' AND ${notifications.claimedAt} < now() - interval '10 minutes'))`,
  )!;
}

/** The window both the counter and the page read — one week. */
export function problemSince(sinceDays = 7, now = Date.now()): Date {
  return new Date(now - sinceDays * 86_400_000);
}

export async function notificationProblemCount(sinceDays = 7): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(telegramProblemSql(problemSince(sinceDays)));
  return Number(row?.n ?? 0);
}

/**
 * Is the staff bot delivering at all (B9)? Everything a red line needs, and
 * nothing it would have to guess:
 *
 *  - `refused` — Telegram took the token back (401/404), recorded by the one
 *    sender every Bot API call goes through, with the moment it began;
 *  - `noToken` — this process has no token at all, read from its own
 *    environment and never stored (a test run without one must not write the
 *    company's alarm state);
 *  - `waiting` / `oldestPendingAt` — the PENDING rows of the problem list the
 *    red line links to (`telegramProblemSql` over the same week), so «N ta
 *    xabar kutmoqda» is a count of rows the reader finds behind the link and
 *    not a second, wider count of every queued row; a backlog past the window
 *    (`telegramBacklogSql`, the list's own clause) is the symptom that needs
 *    no cause to be named;
 *  - `clientWaiting` — customer notices the same dead bot is holding (their own
 *    sweep pauses on the same refusal), so the sentence can say they wait too.
 *
 * Never sent through the bot. The bot is the thing that died.
 */
export interface TelegramBotState {
  refused: { since: Date; detail: string | null } | null;
  noToken: boolean;
  waiting: number;
  oldestPendingAt: Date | null;
  clientWaiting: number;
  /** A red line is due: refused, tokenless, or a backlog past the window. */
  down: boolean;
}

export async function telegramBotState(sinceDays = 7): Promise<TelegramBotState> {
  const [refused, [queue], clientRows] = await Promise.all([
    botRefused(),
    db
      .select({
        n: sql<number>`count(*)`,
        backlog: sql<number>`count(*) FILTER (WHERE ${telegramBacklogSql()})`,
        oldest: sql<string | null>`min(${notifications.createdAt})`,
      })
      .from(notifications)
      .where(and(telegramProblemSql(problemSince(sinceDays)), eq(notifications.status, 'pending'))),
    db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM client_notices
       WHERE status = 'pending'
         AND send_after < now() - make_interval(mins => ${TELEGRAM_BACKLOG_MINUTES})`),
  ]);
  const noToken = !process.env.TELEGRAM_BOT_TOKEN;
  // Raw aggregates come back as TEXT (#923): through Date before any maths.
  const oldestPendingAt = queue?.oldest ? new Date(queue.oldest) : null;
  return {
    refused,
    noToken,
    waiting: Number(queue?.n ?? 0),
    oldestPendingAt,
    clientWaiting: Number(clientRows[0]?.n ?? 0),
    down: refused !== null || noToken || Number(queue?.backlog ?? 0) > 0,
  };
}

/**
 * An office count press (0112) names who pressed; that person made the
 * deviation on purpose and needs no alarm about it. An event without the
 * field — every phone scan, every event written before — reaches everyone,
 * as it always did (#688's rule).
 */
function withoutPresser(userIds: string[], payload: Record<string, unknown>): string[] {
  const presser = typeof payload.presserId === 'string' ? payload.presserId : null;
  return presser ? userIds.filter((id) => id !== presser) : userIds;
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
    // «Attach it» rides the same road as «price it» (round 107, item 3): the
    // deal exists, the receipt just was not linked — same seller, same
    // fallback to the admins when the client has no seller.
    case 'UnlinkedCargo':
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
    case 'MissingInTransit':
    // Inventory result goes to the owner/admins (owner's answer: the
    // warehouse manager decides, the boss gets the Telegram).
    case 'InventoryCompleted': {
      const userIds = await usersWithRoles(['logist', 'admin', 'super_admin']);
      return userIds.map((userId) => ({ userId, type: event.type, payload: event.payload }));
    }
    case 'UndocumentedTransfer': {
      const userIds = await usersWithRoles(['logist', 'admin', 'super_admin']);
      return withoutPresser(userIds, event.payload).map((userId) => ({
        userId,
        type: event.type,
        payload: event.payload,
      }));
    }
    case 'BoxScannedOnLoad': {
      if (!event.payload.addedOnSpot) return [];
      const userIds = await usersWithRoles(['logist', 'admin', 'super_admin']);
      return withoutPresser(userIds, event.payload).map((userId) => ({
        userId,
        type: event.type,
        payload: event.payload,
      }));
    }
    // An office count found fewer cartons than the truck carried (0112, the
    // owner's Q6c: «menga va logistga darrov»). Him and the logists — by ROLE,
    // his words — never the person who pressed, who already knows. The text
    // is composed where the cargo lives (wms) and arrives finished.
    case 'CountShortfall': {
      const userIds = await usersWithRoles(['super_admin', 'logist']);
      return withoutPresser(userIds, event.payload).map((userId) => ({
        userId,
        type: event.type,
        payload: event.payload,
      }));
    }
    // Phase 6: the request reaches everyone who may decide it; the decision
    // reaches exactly the person who asked. Since 0104 the request names its
    // own recipients — every holder minus the sellers of OTHER clients, round
    // 91's money rule reaching the ping — computed where the money rule lives
    // (wms), because platform must not import it. An event written before
    // that carries no list and reaches every holder, as it always did.
    case 'DebtApprovalRequested': {
      const named = event.payload.recipientIds;
      const userIds = Array.isArray(named)
        ? named.filter((id): id is string => typeof id === 'string')
        : await usersWithPermission('finance.debt_override');
      return userIds.map((userId) => ({ userId, type: event.type, payload: event.payload }));
    }
    case 'DebtApprovalDecided': {
      const requestedBy = event.payload.requestedBy as string | null;
      if (!requestedBy) return [];
      return [{ userId: requestedBy, type: event.type, payload: event.payload }];
    }
    // Round 107: the rasxod xabari reaches everyone who may enter the
    // expense — minus the reporter, when an admin reports their own (round
    // 36's exceptUserId, one layer down) — and the decision reaches exactly
    // the reporter.
    case 'ExpenseRequested': {
      const requestedBy = event.payload.requestedBy as string | null;
      const userIds = await usersWithPermission('finance.expenses');
      return userIds
        .filter((userId) => userId !== requestedBy)
        .map((userId) => ({ userId, type: event.type, payload: event.payload }));
    }
    case 'ExpenseRequestDecided': {
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
  const codes = capCodes((payload.shortCodes as string[] | undefined) ?? [], L.andMore);

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
    case 'ReceiptConfirmed': {
      // The deal marker (round 107, item 3): the owner reads the prixod
      // message and wants to see «bitimi yo'q» right there. Strict === false,
      // so the years of events that predate the field render exactly as they
      // always did (#688's Array.isArray rule).
      const dealMark =
        payload.dealLinked === false
          ? Array.isArray(payload.openDealCodes) && payload.openDealCodes.length > 0
            ? `📎 ${L.unlinkedMark}\n`
            : `⚠️ ${L.noDealMark}\n`
          : '';
      return (
        `📥 ${L.receiptConfirmed} ${payload.number}\n` +
        `${L.client}: ${payload.clientCode} (${payload.clientName})\n` +
        dealMark +
        `${L.warehouse}: ${payload.warehouseCode}\n\n${lotLines}\n\n${link}`
      );
    }
    case 'UnknownCargoReceived':
      return (
        `❓ ${L.unknownCargo} ${payload.number}\n` +
        (payload.unclaimedMarking ? `${L.marking}: ${payload.unclaimedMarking}\n` : '') +
        `${L.warehouse}: ${payload.warehouseCode}\n\n${lotLines}\n\n${link}`
      );
    // The deal exists and the receipt was not linked to it — the seller's job
    // is one tap on the receipt card, and the message says which deals are
    // open so they know it is an attach, not a pricing exercise (round 107).
    case 'UnlinkedCargo': {
      const openCodes = Array.isArray(payload.openDealCodes)
        ? (payload.openDealCodes as string[]).join(', ')
        : '';
      return (
        `📎 ${L.unlinkedCargo} — ${payload.number}\n` +
        `${L.client}: ${payload.clientCode} (${payload.clientName})\n` +
        `${L.warehouse}: ${payload.warehouseCode}\n` +
        `${payload.volumeM3} ${L.m3} · ${payload.weightKg} ${L.kg} · ${payload.boxCount} ${L.boxesShort}\n` +
        (openCodes ? `${L.openDealsWord}: ${openCodes}\n` : '') +
        `\n${L.attachDeal}\n${link}`
      );
    }
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
        `${countLotLine(payload.lot) ?? `${L.boxesLine}: ${codes}`}\n` +
        (payload.reason ? `${L.reason}: ${payload.reason}\n` : '') +
        `${appUrl}/batches/${payload.batchId}`
      );
    case 'UndocumentedTransfer':
      return (
        `📦❗ ${L.undocumented} ${payload.batchCode}\n` +
        `${countLotLine(payload.lot) ?? `${L.boxesLine}: ${codes}`}\n` +
        (payload.reason ? `${L.reason}: ${payload.reason}\n` : '') +
        `${appUrl}/batches/${payload.batchId}`
      );
    case 'MissingInTransit': {
      // Per lot when the event names its lots (0112): an office count closes
      // a truck whose missing cartons carry no sticker to list by code.
      const missingLots = Array.isArray(payload.lots)
        ? (payload.lots as unknown[])
            .map((lot) => countLotLine(lot, false))
            .filter((l): l is string => !!l)
        : [];
      const body =
        missingLots.length > 0
          ? missingLots.slice(0, 12).join('\n') +
            (missingLots.length > 12 ? `\n${fillCount(L.andMore, missingLots.length - 12)}` : '')
          : `${L.boxesLine}: ${codes}`;
      return (
        `🔍 ${L.missingInTransit} ${payload.batchCode}\n` +
        `${body}\n` +
        `${appUrl}/batches/${payload.batchId}`
      );
    }
    case 'InventoryCompleted': {
      const moved = (payload.moved as string[] | undefined) ?? [];
      const lost = (payload.lost as string[] | undefined) ?? [];
      return (
        `📋 ${L.inventoryAt} ${payload.warehouseCode}\n` +
        `${L.scanned}: ${payload.scanned}\n` +
        (moved.length ? `↩️ ${L.movedHere}: ${capCodes(moved, L.andMore)}\n` : '') +
        (lost.length ? `❌ ${L.markedLost}: ${capCodes(lost, L.andMore)}\n` : '') +
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
        `🤝 ${L.issuedTo} ${payload.clientCode} (${payload.clientName}): ${payload.boxCount} ${L.boxesShort}` +
        // Only events emitted since round 100 carry the totals.
        (payload.weightKg !== undefined
          ? ` · ${round(Number(payload.weightKg))} ${L.kg} · ${round(Number(payload.volumeM3))} ${L.m3}`
          : '') +
        ` · ${L.warehouse} ${payload.warehouseCode}\n` +
        `${L.receivedBy}: ${payload.personName}${payload.personPhone ? ` (${payload.personPhone})` : ''}` +
        (payload.remaining ? `\n${L.leftInStock}: ${payload.remaining} ${L.boxesShort}` : '')
      );
    case 'DebtApprovalRequested': {
      // 0104: the title names the question(s) asked, and the debt line prints
      // only for a debt — a price-only request never reads «Qarz: $0.00». An
      // event without `reasons` (every row before 0104) renders exactly as it
      // always did.
      const reasons = payload.reasons as string | undefined;
      const title =
        reasons === 'price'
          ? L.unpricedApprovalRequested
          : reasons === 'both'
            ? L.issueApprovalRequested
            : L.debtApprovalRequested;
      const showDebt = reasons === undefined || (reasons !== 'price' && Number(payload.blockingDebtUsd) > 0.009);
      const unpriced =
        (payload.unpriced as { number: string; trucks: string; boxes: number }[] | undefined) ?? [];
      const more = Number(payload.unpricedMore ?? 0);
      return (
        `🔐 ${title}\n` +
        `${L.client}: ${payload.clientCode} (${payload.clientName}) · ${L.warehouse} ${payload.warehouseCode}\n` +
        (showDebt ? `${L.debtLine}: $${payload.blockingDebtUsd}\n` : '') +
        (unpriced.length
          ? `💰 ${L.unpricedLine}:\n` +
            unpriced
              .map((r) => `  ${r.number}${r.trucks ? ` (${r.trucks})` : ''} · ${r.boxes} ${L.boxesShort}`)
              .join('\n') +
            (more > 0 ? `\n  … +${more}` : '') +
            '\n'
          : '') +
        `${L.requestedByWord}: ${payload.requestedByName}` +
        (payload.note ? `\n${L.comment}: ${payload.note}` : '') +
        `\n\n${appUrl}/approvals`
      );
    }
    case 'DebtApprovalDecided': {
      // One home for the verdict's words (round C): the deciders' own copies
      // are closed with the same line once the question is settled.
      return (
        `${approvalVerdictLine(
          {
            verdict: payload.verdict === 'approved' ? 'approved' : 'refused',
            reasons: payload.reasons as string | undefined,
          },
          locale,
        )}\n` +
        `${L.client}: ${payload.clientCode} (${payload.clientName})\n` +
        `${L.decidedByWord}: ${payload.decidedByName}` +
        (payload.note ? `\n${L.comment}: ${payload.note}` : '') +
        `\n\n${appUrl}/issue`
      );
    }
    // Round 107: the rasxod xabari and its answer.
    // 0101: a report from /profile names no warehouse — its heading says
    // «from a colleague» instead of printing «— null» — and an own-pocket
    // one says so, because it books a DEBT to the reporter, not cash.
    case 'ExpenseRequested':
      return (
        `💸 ${payload.warehouseCode ? `${L.expenseRequested} — ${payload.warehouseCode}` : L.expenseRequestedStaff}\n` +
        `${L.requestedByWord}: ${payload.requesterName}\n` +
        `${payload.amount} ${payload.currency}${payload.paidBySelf ? ` — 👤 ${L.expensePaidBySelf}` : ''}\n` +
        `${payload.note}\n\n${appUrl}/accounting/expenses`
      );
    case 'ExpenseRequestDecided':
      return payload.verdict === 'rejected'
        ? `⛔ ${L.expenseRejected}\n${payload.amount} ${payload.currency} — ${payload.note}\n` +
            `${L.comment}: ${payload.rejectReason}`
        : `✅ ${L.expenseEntered}\n${payload.amount} ${payload.currency} — ${payload.note}`;
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

/**
 * Box codes in a staff message, at most thirty and then the COUNT of the
 * rest. An uncapped list is the one way these texts outgrew 4096 characters,
 * and Telegram refuses such a message whole — a truck with two hundred
 * unplanned cartons produced an alarm nobody ever received (round C).
 */
const CODES_SHOWN = 30;
/**
 * One lot of an office count (0112): `{label, product, n}` → «GS777-A ·
 * kurtka: +3» for cartons beyond the plan, «… : 3» for cartons missing.
 * Anything else — every event that predates the field — is null,
 * and the caller prints its codes line as it always did (#688).
 */
function countLotLine(lot: unknown, extra = true): string | null {
  if (!lot || typeof lot !== 'object') return null;
  const { label, product, n } = lot as { label?: unknown; product?: unknown; n?: unknown };
  if (typeof label !== 'string' || typeof n !== 'number') return null;
  const goods = typeof product === 'string' && product.trim() ? ` · ${product.trim()}` : '';
  return `${label}${goods}: ${extra && n > 0 ? '+' : ''}${n}`;
}

function capCodes(codes: string[], andMore: string): string {
  if (codes.length <= CODES_SHOWN) return codes.join(', ');
  return `${codes.slice(0, CODES_SHOWN).join(', ')} ${fillCount(andMore, codes.length - CODES_SHOWN)}`;
}

/** Two decimals, without a trailing `.00` on a whole number. */
function round(value: number): string {
  return String(Math.round(value * 100) / 100);
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

/**
 * Take the oldest unprocessed event, atomically — `claimNext`'s shape, one
 * table over.
 *
 * This used to be a plain `SELECT … WHERE processed_at IS NULL LIMIT 50`, with
 * the row marked processed only AFTER it had been handled. Two drains
 * overlapping therefore read the SAME rows and both fanned them out, and the
 * drains overlap routinely: a pg-boss sweep runs every minute and every CRM
 * action kicks `JOB_PROCESS_EVENTS` the moment somebody moves a card. The
 * visible consequence is a phase-7 rule firing twice — one stage move, two
 * identical tasks, or the same Telegram message to the same person twice.
 *
 * `FOR UPDATE SKIP LOCKED` inside the subquery is what makes two drains SPLIT
 * the work instead of duplicating it, and the claim must be the UPDATE itself:
 * a read followed by a write is two statements with a gap, and the gap is
 * where the second drain reads the same id.
 *
 * ONE row per claim, not fifty. The claim marks the event processed BEFORE it
 * is handled, so a crash mid-event loses that event's notifications — at one
 * row that is a single missed message, where a fifty-row claim would lose a
 * whole batch. The alternative (a separate `claimed_at` column plus a
 * releasing sweep) buys at-least-once delivery for a migration and a second
 * failure mode, and duplicate tasks are the complaint that exists.
 */
async function claimNextEvent(): Promise<typeof events.$inferSelect | null> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    UPDATE events SET processed_at = now()
    WHERE id = (
      SELECT id FROM events
      WHERE processed_at IS NULL
      ORDER BY id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, payload, entity_type, entity_id, actor_id
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorId: row.actor_id,
  } as typeof events.$inferSelect;
}

async function processEventBatch(): Promise<{ created: number; full: boolean }> {
  // Claimed one at a time and processed as they come, so this loop is a work
  // QUEUE rather than a snapshot: a second drain running beside it takes the
  // rows this one has not reached, and neither sees the other's.
  const pending: (typeof events.$inferSelect)[] = [];
  for (let i = 0; i < 50; i++) {
    const next = await claimNextEvent();
    if (!next) break;
    pending.push(next);
  }

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
    // The CUSTOMER hears nothing from here since round C: «qabul qilindi» and
    // «berildi» are claimed `client_notices` rows written with the fact and
    // sent by the notices sweep (wms/notices/client-claims.ts).
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
    // Already marked processed by the claim above — see `claimNextEvent`.
  }
  return { created, full: pending.length === 50 };
}

/** Send all pending Telegram notifications. Called by the telegram worker. */
/**
 * Put back what a dead drain took.
 *
 * A claimed row whose drain crashed before settling would sit in 'sending'
 * for ever; ten minutes is far beyond any real batch. The attempt is counted
 * here — the send may or may not have happened, and counting it is what
 * stops a crash-looping process from re-sending the same row without limit.
 * A row already out of attempts goes terminal instead of back in the queue,
 * or it would be re-claimed and re-parked nightly for ever.
 */
export async function reclaimStaleTelegram(): Promise<void> {
  await db.execute(sql`
    UPDATE notifications
    SET status = CASE WHEN attempts + 1 >= ${MAX_TELEGRAM_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
        attempts = attempts + 1,
        error = 'drain died mid-send'
    WHERE channel = 'telegram' AND status = 'sending'
      AND claimed_at < now() - interval '10 minutes'`);
}

/**
 * Take up to `limit` pending rows, so that no other drain can take them.
 *
 * ONE statement, atomic: the audit found that two drains ever running at
 * once — a twice-registered worker, the tg-listen container booting the
 * fleet — both read the same thirty 'pending' rows and both POSTed them,
 * because nothing flipped a row until after the Telegram round trip. Both
 * sources are fixed this round; the claim is what makes the next such
 * regression a non-event instead of every staff message arriving twice.
 * `FOR UPDATE SKIP LOCKED` splits concurrent claimers instead of blocking
 * them — round 83's event-drain rule, applied to the other queue.
 */
export async function claimPendingTelegram(limit: number): Promise<string[]> {
  const rows = (await db.execute(sql`
    UPDATE notifications SET status = 'sending', claimed_at = now()
    WHERE id IN (
      SELECT id FROM notifications
      WHERE channel = 'telegram' AND status = 'pending' AND attempts < ${MAX_TELEGRAM_ATTEMPTS}
      ORDER BY created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED)
    RETURNING id`)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Not before this moment (epoch ms) — the drain's own pause.
 *
 * A 429 is Telegram saying «not now», and a refused TOKEN (401/404) is the
 * bot itself being down; neither is a fact about the message in hand, and
 * before round C both were counted as a failed attempt on it, so a burst
 * could spend all six in minutes and write off messages that were never
 * wrong. Module-level because the drain is kicked from everywhere (every
 * `notifyStaffTelegram` enqueues one, and a minute cron runs beside them):
 * without a shared «wait until» each kick walked straight back into the
 * wall it had just been told about.
 */
let notBefore = 0;

/** Tests only: forget a pause a previous case set. */
export function __resetTelegramPause(): void {
  notBefore = 0;
}

/**
 * A staff notification as Telegram will show it — the recipient's words,
 * HTML from the escaped stored text, and our own card link lifted into a
 * «↗️ Ochish» button (staff-html.ts). Exported because an EDIT of a sent
 * message (the approval copies below) must rebuild exactly what was sent.
 *
 * A pre-rendered text was written in Uzbek by its caller, so its button is
 * Uzbek too; an event-rendered one is in the reader's own language.
 */
export function composeStaffMessage(
  type: string,
  payload: Record<string, unknown>,
  locale?: string | null,
): StaffMessage {
  const preRendered = typeof payload.text === 'string' && payload.text.trim() !== '';
  return composeStaffHtml(type, renderTelegramText(type, payload, locale), {
    appUrl: process.env.APP_URL,
    openLabel: notificationLabels(preRendered ? 'uz' : locale).openInApp,
  });
}

/** A Bot API answer as the sender's verdict — for the one call made by hand. */
function answerAsResult(answer: Awaited<ReturnType<typeof botCall>>): SendResult {
  const result = answer.result as { message_id?: number } | null;
  return {
    ok: answer.ok,
    status: answer.status,
    description: answer.description,
    messageId: answer.ok && typeof result?.message_id === 'number' ? result.message_id : null,
    retryAfter: answer.retryAfter,
    permanent: !answer.ok && isPermanentFailure(answer.status),
    botDown: !answer.ok && isBotFailure(answer.status),
    usedFallback: false,
  };
}

/** Telegram refused a BUTTON (not our markup, not the chat). */
const BUTTON_REFUSAL = /button|keyboard|reply.?markup/i;

/**
 * Send one staff message.
 *
 * The ordinary path is the one sender and its fallbacks. The exception is a
 * message whose card link was lifted into a button: the sender's own answer to
 * a refused keyboard is to send the text WITHOUT it — which here would deliver
 * a message that lost its link altogether. So that one attempt is made by
 * hand, and a refused button puts the link back into the text (REL: the
 * sentence must never depend on the button, map-link.ts's rule).
 */
async function deliverStaffMessage(
  chatId: bigint,
  message: StaffMessage,
  buttons: { text: string; callback_data: string }[][] | null,
  // Carried into ALL THREE sends, the hand-made one included: a night-silent
  // push whose card link became a button used to ring, because that attempt
  // never went through `sendText` (0113, the design judge's finding 1).
  silent = false,
): Promise<SendResult> {
  const rows = [...(buttons ?? []), ...(message.urlRow ? [message.urlRow] : [])];
  if (!message.url) {
    return sendText({ chatId, html: message.html, replyMarkup: keyboardOf(rows), silent });
  }
  const first = await botCall('sendMessage', {
    chat_id: Number(chatId),
    text: message.html,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(silent ? { disable_notification: true } : {}),
    reply_markup: { inline_keyboard: rows },
  });
  if (first.ok || first.status !== 400) return answerAsResult(first);
  if (BUTTON_REFUSAL.test(first.description)) {
    logger.warn({ description: first.description }, 'telegram refused the link button — the link goes back in the text');
    return sendText({
      chatId,
      html: `${message.html}\n${h(message.url)}`,
      replyMarkup: keyboardOf(buttons),
      silent,
    });
  }
  // Anything else Telegram refused (our HTML, most likely): the sender's own
  // fallbacks know what to do with it.
  return sendText({ chatId, html: message.html, replyMarkup: keyboardOf(rows), silent });
}

/**
 * Show a colleague the customer's OWN message before our sentence about it
 * (round C, contract 2): a photo of a damaged carton or a voice note is not
 * something a line of text can carry. Best-effort — the sentence goes either
 * way — and remembered on the row, so a retry of the sentence after a 429
 * does not forward the same photo twice.
 */
async function forwardOriginal(
  notificationId: string,
  staffChatId: bigint,
  payload: Record<string, unknown>,
): Promise<SendResult | null> {
  const from = payload.forwardFrom as { chatId?: unknown; messageId?: unknown } | undefined;
  if (!from || payload.forwarded === true) return null;
  const fromChat = Number(from.chatId);
  const messageId = Number(from.messageId);
  if (!Number.isFinite(fromChat) || !Number.isInteger(messageId)) return null;
  const answer = await botCall('forwardMessage', {
    chat_id: Number(staffChatId),
    from_chat_id: fromChat,
    message_id: messageId,
  });
  if (!answer.ok && !isPermanentFailure(answer.status)) {
    /*
     * A MOMENT, not the message (round C review, CONV-4): a 5xx, a deadline, a
     * 429 or a refused token. The customer's file exists nowhere but in their
     * private chat with the bot, which no person can open — so the row is
     * NOT sent without it. Handed back as this row's failure: the drain's own
     * rules (pause, release, or an attempt counted) bring it round again, and
     * the next run forwards first.
     */
    logger.warn({ notificationId, status: answer.status, description: answer.description }, 'customer message not forwarded yet — retrying');
    return {
      ok: false,
      status: answer.status,
      description: answer.description,
      messageId: null,
      retryAfter: answer.retryAfter,
      permanent: false,
      botDown: isBotFailure(answer.status),
      usedFallback: false,
    };
  }
  if (!answer.ok) {
    // Refused for good (the customer deleted it, the chat is gone): the text
    // still goes on its own.
    logger.warn({ notificationId, description: answer.description }, 'customer message cannot be forwarded — the text still goes');
    return null;
  }
  await db.execute(sql`
    UPDATE notifications SET payload = payload || '{"forwarded": true}'::jsonb
    WHERE id = ${notificationId}`);
  return null;
}

/**
 * Hand the rest of a run back to the queue exactly as it was: pending, no
 * claim, no attempt counted. ONE statement, so a pause can never leave half a
 * run parked in 'sending' for the ten-minute reclaim to charge an attempt for.
 */
async function releaseClaims(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(notifications)
    .set({ status: 'pending', claimedAt: null })
    .where(and(inArray(notifications.id, ids), eq(notifications.status, 'sending')));
}

export async function sendPendingTelegram(now: Date = new Date()): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  // Asked BEFORE claiming, so the kicks that arrive during a pause cost a
  // clock read and not a claim-and-release of thirty rows each.
  if (Date.now() < notBefore) return;

  await reclaimStaleTelegram();
  const claimedIds = await claimPendingTelegram(30);
  if (claimedIds.length === 0) return;
  const pending = await db
    .select()
    .from(notifications)
    .where(inArray(notifications.id, claimedIds))
    .orderBy(notifications.createdAt);

  // One dead chat must not hold up the queue. Every row is attempted, its
  // own failure recorded, and the batch reports at the end — before this,
  // the first driver who blocked the bot stopped every message behind them,
  // including "boxes missing in transit".
  let failed = 0;
  const settled = new Set<string>();

  for (const notification of pending) {
    const recipient = await db.query.users.findFirst({
      columns: { locale: true, active: true },
      where: eq(users.id, notification.userId),
    });
    // Asked at DELIVERY as well as at recipient-building: rows queued before
    // the person was deactivated must stop too, and a person deactivated
    // between the two moments must not get one last debt figure.
    if (!recipient?.active) {
      await db
        .update(notifications)
        .set({ status: 'muted', error: 'user deactivated' })
        .where(eq(notifications.id, notification.id));
      settled.add(notification.id);
      continue;
    }
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
      settled.add(notification.id);
      continue;
    }
    const payload = notification.payload as Record<string, unknown>;
    // A debtor question already DECIDED is never asked with live buttons.
    // Asked at SEND time because a decision cannot see every copy: one written
    // after it (the event fan-out lagging a restart), or one the drain held in
    // «sending» at that moment and later put back (round C review's verifier;
    // `retireApprovalCopies` mutes the plainly-pending ones as a cheap belt).
    if (notification.type === 'DebtApprovalRequested' && (await approvalDecided(payload.approvalId))) {
      await db
        .update(notifications)
        .set({ status: 'muted', error: 'decided before it was sent' })
        .where(eq(notifications.id, notification.id));
      settled.add(notification.id);
      continue;
    }

    let res: SendResult;
    try {
      // Inline buttons ride on the send, by type (staff bot, round 35): a
      // task lands with «Bajarildi», a debtor request with «Ruxsat / Yo‘q».
      // INSIDE the try (round C review): a payload a renderer chokes on fails
      // its own row, where outside it threw the whole run and parked every
      // claimed row behind it in «sending» until the reclaim charged them.
      const buttons = buttonsFor(notification.type, payload);
      const message = composeStaffMessage(notification.type, payload, recipient.locale);
      res =
        (await forwardOriginal(notification.id, link.telegramChatId, payload)) ??
        (await deliverStaffMessage(
          link.telegramChatId,
          message,
          buttons,
          sendsSilently(notification.type, payload, now),
        ));
    } catch (err) {
      // The sender answers rather than throws; this is the database under
      // it, or a payload no renderer can read.
      res = {
        ok: false,
        status: 0,
        description: String(err),
        messageId: null,
        retryAfter: null,
        permanent: false,
        botDown: false,
        usedFallback: false,
      };
    }

    if (res.ok) {
      // Which message it became (round C): an approval settled elsewhere
      // edits every decider's copy by this, so nobody presses a question
      // that is already answered. jsonb, so no migration.
      const tg =
        res.messageId !== null
          ? { chatId: Number(link.telegramChatId), messageId: res.messageId }
          : null;
      await db
        .update(notifications)
        .set({
          status: 'sent',
          sentAt: new Date(),
          error: null,
          // Merged in SQL, not spread from the row read above: the forward
          // may have written `forwarded` onto it since.
          ...(tg ? { payload: sql`${notifications.payload} || ${JSON.stringify({ tg })}::jsonb` } : {}),
        })
        .where(eq(notifications.id, notification.id));
      settled.add(notification.id);
      continue;
    }

    if (res.status === 429 || res.botDown) {
      // Not this message's fault: pause the drain, put the whole rest of the
      // run back untouched (this row included) and stop. The next kick after
      // the pause resumes where this left off.
      const waitMs = res.botDown ? 60_000 : Math.max(1, res.retryAfter ?? 1) * 1000;
      notBefore = Date.now() + waitMs;
      await releaseClaims(pending.map((row) => row.id).filter((id) => !settled.has(id)));
      logger.warn(
        { status: res.status, description: res.description, waitMs },
        res.botDown ? 'telegram refused the bot token — drain paused' : 'telegram rate limit — drain paused',
      );
      break;
    }

    logger.error({ notificationId: notification.id, status: res.status, description: res.description }, 'telegram send failed');
    failed += 1;
    const attempts = notification.attempts + 1;
    await db
      .update(notifications)
      .set({
        attempts,
        error: res.description || `HTTP ${res.status}`,
        // Out of attempts: stop asking. A blocked bot or a deleted chat
        // never becomes deliverable, and a row that retries for ever keeps
        // the whole job failing. Not terminal yet → back to 'pending', so
        // the claim this drain took does not outlive it.
        status: attempts >= MAX_TELEGRAM_ATTEMPTS ? 'failed' : 'pending',
      })
      .where(eq(notifications.id, notification.id));
    settled.add(notification.id);
  }

  // Still throw so pg-boss retries — but only after every row had its turn.
  // Rows already marked `sent` are excluded from the next pass, so a retry
  // re-sends nothing.
  if (failed > 0) throw new Error(`${failed} telegram message(s) failed`);
}

/**
 * Close every decider's copy of a settled debtor/unpriced request (round C).
 *
 * The request goes to everyone who may decide it, each copy carrying «✅
 * Ruxsat / ⛔ Yo‘q». Until now the copies were never touched: the second
 * decider pressed a button on a question already answered and read «allaqachon
 * hal qilingan» — or, worse, a copy that looked open sat in three phones for
 * days. ONE place both doors reach (the web action and the bot), called after
 * the decision is written: each copy that remembers where it went
 * (`payload.tg`, the drain writes it) is rewritten to its own text plus the
 * verdict, the buttons gone and its link kept.
 *
 * Best-effort by nature: Telegram refuses edits to a message older than 48
 * hours, and each edit carries the sender's short deadline.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this issue approval no longer waiting? A malformed or missing id answers no — the copy goes as it always did. */
async function approvalDecided(approvalId: unknown): Promise<boolean> {
  if (typeof approvalId !== 'string' || !UUID_RE.test(approvalId)) return false;
  const [row] = await db
    .select({ status: issueApprovals.status })
    .from(issueApprovals)
    .where(eq(issueApprovals.id, approvalId));
  return row !== undefined && row.status !== 'pending';
}

export async function retireApprovalCopies(input: {
  approvalId: string;
  /** When the request was made — nothing older can be one of its copies. */
  since: Date;
  /** Everyone who could have been sent one. */
  userIds: string[];
  verdict: 'approved' | 'refused';
  reasons?: string | null;
  decidedByName?: string | null;
}): Promise<number> {
  // Copies nobody has SENT yet — a drain paused on a 429, a 5xx backoff, a
  // bot token being rotated — would otherwise go out AFTER the decision with
  // live «Ruxsat / Yo‘q» buttons, and nothing would ever retire them (round
  // C review, STAFF-APPROVAL-UNSENT-COPY). `muted` is terminal and is not a
  // delivery problem; a row the drain has already claimed is its to finish.
  await db
    .update(notifications)
    .set({ status: 'muted', error: 'decided before it was sent' })
    .where(
      and(
        gte(notifications.createdAt, input.since),
        eq(notifications.channel, 'telegram'),
        eq(notifications.type, 'DebtApprovalRequested'),
        eq(notifications.status, 'pending'),
        sql`${notifications.payload}->>'approvalId' = ${input.approvalId}`,
      ),
    );
  // No bot, no copies to close — the drain made none (its own first line).
  if (!process.env.TELEGRAM_BOT_TOKEN || input.userIds.length === 0) return 0;
  const rows = await db
    .select({
      id: notifications.id,
      type: notifications.type,
      payload: notifications.payload,
      locale: users.locale,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(
      and(
        inArray(notifications.userId, input.userIds),
        gte(notifications.createdAt, input.since),
        eq(notifications.channel, 'telegram'),
        eq(notifications.type, 'DebtApprovalRequested'),
        sql`${notifications.payload}->>'approvalId' = ${input.approvalId}`,
        sql`${notifications.payload}->'tg' IS NOT NULL`,
      ),
    );
  let edited = 0;
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    const tg = payload.tg as { chatId?: unknown; messageId?: unknown } | undefined;
    const chatId = Number(tg?.chatId);
    const messageId = Number(tg?.messageId);
    if (!Number.isFinite(chatId) || !Number.isInteger(messageId)) continue;
    const message = composeStaffMessage(row.type, payload, row.locale);
    const verdict = approvalVerdictLine(
      { verdict: input.verdict, reasons: input.reasons, decidedByName: input.decidedByName },
      row.locale,
    );
    const res = await editText({
      chatId,
      messageId,
      html: appendLine(message.html, verdict),
      replyMarkup: keyboardOf(message.urlRow ? [message.urlRow] : null),
    });
    if (res.ok) edited += 1;
    else logger.warn({ notificationId: row.id, description: res.description }, 'approval copy not closed');
  }
  return edited;
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
