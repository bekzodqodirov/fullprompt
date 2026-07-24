import { Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { telegramLinks, users } from '../db/schema';
import { logger } from '../logger';
import { clientsForChat } from '../../wms/client-cabinet/service';
import { CABINET_KEYBOARD, linkClientChat, registerClientCabinet } from './client-cabinet';

/**
 * Staff-linking bot (spec 4.5): handles `/start <one-time-code>` from the
 * profile deep link and confirms the account link. Long polling — fine for a
 * single-process deployment; a webhook can replace it later without touching
 * the linking flow.
 */

const globalForBot = globalThis as unknown as { telegramBot?: Bot; botUsername?: string };

export async function getBotUsername(): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  if (globalForBot.botUsername) return globalForBot.botUsername;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const body = (await res.json()) as { ok: boolean; result?: { username: string } };
    if (body.ok && body.result) {
      globalForBot.botUsername = body.result.username;
      return body.result.username;
    }
  } catch (err) {
    logger.warn({ err }, 'telegram getMe failed');
  }
  return null;
}

export function startTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  // TELEGRAM_POLLING=0 disables receiving (linking) on this instance —
  // Telegram allows only ONE getUpdates poller per bot, so extra
  // environments (CI, staging, a second dev machine) must opt out.
  // Sending notifications still works everywhere.
  if (!token || process.env.TELEGRAM_POLLING === '0' || globalForBot.telegramBot) return;

  const bot = new Bot(token);
  globalForBot.telegramBot = bot;

  bot.command('start', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) {
      // A linked client without a code gets the cabinet menu back.
      const linkedClients = await clientsForChat(BigInt(ctx.chat.id));
      if (linkedClients.length) {
        await ctx.reply(
          `Assalomu alaykum! Kabinet: ${linkedClients.map((c) => c.clientCode).join(', ')}`,
          { reply_markup: CABINET_KEYBOARD },
        );
        return;
      }
      await ctx.reply('GSR LOGISTICS. Профиль → «Подключить Telegram» — ссылка оттуда.');
      return;
    }
    const link = await db.query.telegramLinks.findFirst({
      where: eq(telegramLinks.linkCode, code),
    });
    if (!link || link.status === 'revoked') {
      // Not a staff code — maybe a client cabinet code (Phase 2.2).
      const client = await linkClientChat(code, ctx.chat.id);
      if (client) {
        await ctx.reply(
          `✅ Assalomu alaykum, ${client.name}!\n` +
            `Kod: ${client.clientCode}. Bu yerda yuklaringiz holati, rasmlari va balansingizni ko‘rasiz.`,
          { reply_markup: CABINET_KEYBOARD },
        );
        return;
      }
      await ctx.reply('Код не найден или устарел. Откройте профиль и попробуйте снова.');
      return;
    }
    await db
      .update(telegramLinks)
      .set({
        telegramChatId: BigInt(ctx.chat.id),
        status: 'linked',
        linkedAt: new Date(),
        linkCode: null,
      })
      .where(eq(telegramLinks.id, link.id));
    const user = await db.query.users.findFirst({ where: eq(users.id, link.userId) });
    await ctx.reply(`✅ Telegram подключён: ${user?.fullName ?? ''}. Уведомления будут приходить сюда.`);
  });

  registerClientCabinet(bot);

  bot.catch((err) => logger.error({ err: err.error }, 'telegram bot error'));

  const startPolling = (retryMs: number) => {
    void bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
      const is409 =
        typeof err === 'object' && err !== null && 'error_code' in err && err.error_code === 409;
      if (is409) {
        // Another instance holds the getUpdates lock (e.g. a dev machine and
        // a server sharing one token). Keep retrying — when the other side
        // stops, this instance takes over. Never crashes anything.
        logger.warn(
          `telegram: another bot instance is polling this token; retrying in ${retryMs / 1000}s`,
        );
      } else {
        logger.error({ err }, 'telegram bot polling failed; retrying');
      }
      setTimeout(() => startPolling(Math.min(retryMs * 2, 300_000)), retryMs);
    });
  };
  startPolling(30_000);
  logger.info('telegram bot polling started');
}
