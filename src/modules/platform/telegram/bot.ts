import { Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { telegramLinks, users } from '../db/schema';
import { logger } from '../logger';
import { clientsForChat } from '../../wms/client-cabinet/service';
import {
  beginClientLink,
  cabinetKeyboard,
  phoneKeyboard,
  registerClientCabinet,
} from './client-cabinet';
import { clientLabels } from './client-labels';
import { adSourceFromPayload, rememberAdVisit } from './ad-intake';
import { cabinetInlineKeyboard } from './menu-button';
import { linkStaffChat, staffForChat, startMenuFor } from './staff-bot';
import { bothKeyboard, entryKeyboard, registerStaffBot, staffKeyboard } from './staff-handlers';

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

    // An ADVERT brought them here (`?start=ad_instagram`). Not a link code and
    // not a menu: somebody who tapped an advert wants a price, so the only
    // question is their number, and the two-door «hodim yoki mijoz» choice
    // would be the wrong first thing to ask. A person who is ALREADY a client
    // falls through to the cabinet from the same contact — the advert visit is
    // remembered, not acted on.
    const adSource = adSourceFromPayload(code);
    if (adSource) {
      const tg = ctx.from?.language_code;
      rememberAdVisit(ctx.chat.id, adSource);
      await ctx.reply(clientLabels(tg).askPhone, { reply_markup: phoneKeyboard(tg) });
      return;
    }

    if (!code) {
      // One decision, made in the testable layer (round 100, 13A): the
      // owner's own people also ship cargo, and the staff menu used to
      // REPLACE their cabinet buttons — reply keyboards are exclusive.
      const staff = await staffForChat(BigInt(ctx.chat.id));
      const linkedClients = await clientsForChat(BigInt(ctx.chat.id));
      const menu = startMenuFor(staff, linkedClients.length);
      if (menu === 'both') {
        const locale = linkedClients.find((c) => c.locale)?.locale ?? null;
        const t = clientLabels(locale);
        await ctx.reply(
          `👋 ${staff!.fullName}\n${t.yourCodes}: ${linkedClients.map((c) => c.clientCode).join(', ')}`,
          { reply_markup: bothKeyboard(locale) },
        );
        const app = cabinetInlineKeyboard(process.env.APP_URL, locale);
        if (app) await ctx.reply(t.openAppPrompt, { reply_markup: app });
        return;
      }
      // A linked member of STAFF gets the staff menu (round 35).
      if (menu === 'staff') {
        await ctx.reply(`👋 ${staff!.fullName}`, { reply_markup: staffKeyboard() });
        return;
      }
      // A linked client without a code gets the cabinet menu back.
      if (menu === 'cabinet') {
        const locale = linkedClients.find((c) => c.locale)?.locale ?? null;
        const t = clientLabels(locale);
        await ctx.reply(
          `${t.yourCodes}: ${linkedClients.map((c) => c.clientCode).join(', ')}`,
          { reply_markup: cabinetKeyboard(locale) },
        );
        // A client who types /start is looking for their cargo. Offer the app
        // as a wide button rather than making them find the corner icon.
        const app = cabinetInlineKeyboard(process.env.APP_URL, locale);
        if (app) await ctx.reply(t.openAppPrompt, { reply_markup: app });
        return;
      }
      // An unknown chat is offered the two doors (owner: «hodim yoki mijoz
      // alohida kirish bo'lsin buttonlar bilan»). The client door is the
      // cabinet's phone flow; the staff door matches the shared number
      // against the employee list.
      const t = clientLabels(ctx.from?.language_code);
      await ctx.reply(`${t.notLinked}\n\nKim sifatida kirasiz? / Кто вы?`, {
        reply_markup: entryKeyboard(),
      });
      return;
    }
    const link = await db.query.telegramLinks.findFirst({
      where: eq(telegramLinks.linkCode, code),
    });
    if (!link || link.status === 'revoked') {
      // Not a staff code — maybe a client cabinet code (Phase 2.2). Identity
      // is verified by phone BEFORE anything is linked or shown (owner's
      // incident: a link sent to the wrong person exposed another client).
      const step = await beginClientLink(code, ctx.chat.id);
      const tg = ctx.from?.language_code;
      if (step === 'ask_phone') {
        await ctx.reply(clientLabels(tg).askPhone, { reply_markup: phoneKeyboard(tg) });
        return;
      }
      if (step === 'no_phone') {
        await ctx.reply(clientLabels(tg).linkUnverifiable);
        return;
      }
      await ctx.reply(clientLabels(tg).linkExpired);
      return;
    }
    // Through the same door the contact path uses (round 100, 13A): this
    // raw UPDATE used to skip the holder check, so a chat already held by
    // another colleague hit the column's UNIQUE index, the throw vanished
    // into bot.catch, and the person got silence. `linkStaffChat` refuses
    // only when the holder is a DIFFERENT user — re-opening your own link
    // from your own chat stays a re-link, not a refusal.
    const outcome = await linkStaffChat(link.userId, BigInt(ctx.chat.id));
    if (outcome === 'chat_taken') {
      await ctx.reply('Bu Telegram boshqa xodimga ulangan. Adminga ayting.');
      return;
    }
    const user = await db.query.users.findFirst({ where: eq(users.id, link.userId) });
    await ctx.reply(`✅ Telegram подключён: ${user?.fullName ?? ''}. Уведомления будут приходить сюда.`);
  });

  // Staff first: its handlers only act for staff-linked chats (or explicit
  // «Hodim» intent) and call next() otherwise, so a customer's contact and
  // texts fall through to the cabinet exactly as before.
  registerStaffBot(bot);
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
