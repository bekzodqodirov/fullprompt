import type PgBoss from 'pg-boss';
import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { clients, clientTelegramLinks, warehouses } from '@/modules/platform/db/schema';
import { logger } from '@/modules/platform/logger';
import { cabinetInlineKeyboard } from '@/modules/platform/telegram/menu-button';
import {
  arrivedSummary,
  dueArrivalNotices,
  isPermanentNoticeFailure,
  MAX_NOTICE_ATTEMPTS,
  settleArrivalNotice,
} from './arrival';
import { arrivalText } from './arrival-text';

export const JOB_CLIENT_NOTICES = 'notices.client';

/**
 * Send the arrival notices whose window has closed.
 *
 * Every two minutes, because the window itself is measured in minutes and a
 * customer standing in the yard should not learn later than the person who
 * telephoned. The sweep is a partial index over pending rows and does nothing
 * at all when nothing has landed.
 *
 * The totals are read HERE and not when the notice was claimed — that is the
 * whole design (`arrival.ts`): the first carton reserves the message, the rest
 * of the truck is scanned while it waits, and what goes out is the delivery
 * as it really is.
 */
export async function sendDueArrivalNotices(now = new Date()): Promise<number> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const due = await dueArrivalNotices(50, now);
  if (due.length === 0) return 0;
  // No bot configured is not a failure to retry for ever — it is a machine
  // that cannot send, and the cabinet still shows the same state.
  if (!token) {
    for (const notice of due) await settleArrivalNotice(notice.id, 'skipped', 'no_bot_token');
    return 0;
  }

  let sent = 0;
  for (const notice of due) {
    try {
      const client = await db.query.clients.findFirst({
        where: eq(clients.id, notice.clientId),
      });
      if (!client) {
        await settleArrivalNotice(notice.id, 'skipped', 'client_gone');
        continue;
      }
      // The destination is a fact about the batch, read now rather than
      // carried on the claim: a truck re-routed between the claim and the
      // send would otherwise name the wrong warehouse.
      const batch = await db.query.batches.findFirst({
        where: (b, { eq: is }) => is(b.id, notice.refId),
      });
      if (!batch) {
        await settleArrivalNotice(notice.id, 'skipped', 'batch_gone');
        continue;
      }
      const summary = await arrivedSummary(notice.clientId, notice.refId, batch.destWarehouseId);
      if (!summary) {
        // Everything this client had on the truck was voided, returned or
        // moved on before the window closed. There is nothing true to say.
        await settleArrivalNotice(notice.id, 'skipped', 'nothing_landed');
        continue;
      }
      const wh = await db.query.warehouses.findFirst({
        where: eq(warehouses.id, batch.destWarehouseId),
      });
      const text = arrivalText(
        { ...summary, warehouseCode: wh?.code ?? '' },
        client.clientCode,
        client.locale,
      );

      const links = await db
        .select()
        .from(clientTelegramLinks)
        .where(eq(clientTelegramLinks.clientId, notice.clientId));
      // One message per CHAT, not per link row — `client_telegram_links` has
      // no unique constraint on (client, chat) and two paths can insert a
      // second 'linked' row for the same pair (#267).
      const chats = new Set<bigint>();
      for (const link of links) {
        if (link.status === 'linked' && link.telegramChatId) chats.add(link.telegramChatId);
      }
      if (chats.size === 0) {
        await settleArrivalNotice(notice.id, 'skipped', 'no_linked_chat');
        continue;
      }

      const app = cabinetInlineKeyboard(process.env.APP_URL, client.locale);
      let delivered = 0;
      // Every refusal so far permanent? Only then is giving up honest.
      let allPermanent = true;
      let lastDetail = '';
      for (const chatId of chats) {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: Number(chatId),
            text,
            ...(app ? { reply_markup: app } : {}),
          }),
        });
        if (res.ok) delivered += 1;
        else {
          const detail = await res.text().catch(() => '');
          if (!isPermanentNoticeFailure(res.status)) allPermanent = false;
          lastDetail = `${res.status} ${detail.slice(0, 200)}`;
          // A client who BLOCKED the bot looks exactly like a client who was
          // reached unless the answer is read (#268).
          logger.warn(
            { clientId: notice.clientId, status: res.status, detail: detail.slice(0, 200) },
            'client arrival notice rejected',
          );
        }
      }
      // Reaching one of a person's chats is reaching the person. Zero is a
      // RETRY when anything about it was transient — a 429 during the burst
      // that follows a truck landing is the likeliest failure there is, and
      // `dueArrivalNotices` only ever re-reads 'pending', so writing 'failed'
      // here is the customer never being told. Permanent refusals (blocked,
      // no such chat) and a spent attempt budget settle for good.
      const outcome =
        delivered > 0
          ? 'sent'
          : allPermanent || notice.attempts + 1 >= MAX_NOTICE_ATTEMPTS
            ? 'failed'
            : 'pending';
      await settleArrivalNotice(notice.id, outcome, delivered > 0 ? undefined : lastDetail);
      if (delivered > 0) sent += 1;
    } catch (err) {
      // The throw is almost always the network or the database, i.e. this
      // moment rather than this message — keep it queued until the budget
      // runs out.
      logger.warn({ err, noticeId: notice.id }, 'client arrival notice failed');
      await settleArrivalNotice(
        notice.id,
        notice.attempts + 1 >= MAX_NOTICE_ATTEMPTS ? 'failed' : 'pending',
        String(err),
      ).catch(() => {});
    }
  }
  return sent;
}

export async function registerClientNoticeWorker(boss: PgBoss): Promise<void> {
  await boss.createQueue(JOB_CLIENT_NOTICES);
  await boss.schedule(JOB_CLIENT_NOTICES, '*/2 * * * *');
  await boss.work(JOB_CLIENT_NOTICES, async () => {
    try {
      const sent = await sendDueArrivalNotices();
      if (sent > 0) logger.info({ sent }, 'client arrival notices sent');
    } catch (err) {
      logger.error({ err }, 'client arrival notice sweep failed');
      throw err;
    }
  });
}
