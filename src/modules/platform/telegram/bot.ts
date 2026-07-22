import { Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { telegramLinks, users } from '../db/schema';
import { logger } from '../logger';

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
  if (!token || globalForBot.telegramBot) return;

  const bot = new Bot(token);
  globalForBot.telegramBot = bot;

  bot.command('start', async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) {
      await ctx.reply('GSR LOGISTICS. Профиль → «Подключить Telegram» — ссылка оттуда.');
      return;
    }
    const link = await db.query.telegramLinks.findFirst({
      where: eq(telegramLinks.linkCode, code),
    });
    if (!link || link.status === 'revoked') {
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

  bot.catch((err) => logger.error({ err: err.error }, 'telegram bot error'));

  void bot.start({ drop_pending_updates: true }).catch((err) => {
    logger.error({ err }, 'telegram bot polling failed');
    globalForBot.telegramBot = undefined;
  });
  logger.info('telegram bot polling started');
}
