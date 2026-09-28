import { Bot } from 'grammy';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { telegramLinks, users } from '../db/schema';
import { logger } from '../logger';
import { clientsForChat } from '../../wms/client-cabinet/service';
import {
  beginClientLink,
  dispatch,
  phoneKeyboard,
  registerClientCabinet,
  sendInOrder,
  type Outgoing,
} from './client-cabinet';
import { clientLabels, localeFromTelegram } from './client-labels';
import { adSourceFromPayload, rememberAdVisit } from './ad-intake';
import { h } from './format';
import { cabinetInlineKeyboard } from './menu-button';
import { linkStaffChat, staffForChat, startMenuFor } from './staff-bot';
import { askStaffPhone, entryKeyboard, registerStaffBot } from './staff-handlers';
import { replyKeyboardFor } from './keyboards';
import { ensureBotProfile, offerStaffCommands } from './commands';
import { botCall, noteBotAnswer } from './send';

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
  // Through the one sender (round C): this read had no deadline, and the
  // arrivals screen awaits it while it renders.
  const answer = await botCall('getMe', {}, 10_000);
  const me = answer.result as { username?: string } | null;
  if (answer.ok && me?.username) {
    globalForBot.botUsername = me.username;
    return me.username;
  }
  if (!answer.ok) logger.warn({ description: answer.description }, 'telegram getMe failed');
  return null;
}

/**
 * Tell the phone that just lost the link that it lost it.
 *
 * Without this the old chat keeps a staff keyboard whose buttons now fall
 * through to the cabinet and answer nothing — the bot looks alive and does
 * nothing, which is exactly the silence rounds 89 and 97 were spent removing.
 * Best effort: the move has already happened and must not be undone by a
 * message that would not send.
 */
async function tellOldChat(
  ctx: { api: { sendMessage: (chat: number, text: string) => Promise<unknown> } },
  previousChatId: bigint | null,
): Promise<void> {
  if (previousChatId === null) return;
  await ctx.api
    .sendMessage(
      Number(previousChatId),
      'ℹ️ Sizning hodim akkountingiz boshqa Telegramga ko‘chirildi. Xabarnomalar endi bu yerga kelmaydi.',
    )
    .catch(() => {});
}

/**
 * A 401/404 from grammy's own getMe/getUpdates is the TOKEN, noticed with
 * nothing queued to send — told to the same memo every `botCall` feeds, so
 * the admin screens turn red whichever door found it first (B9).
 */
function noteRefusedToken(err: unknown): void {
  if (typeof err !== 'object' || err === null || !('error_code' in err)) return;
  const code = Number(err.error_code);
  if (code !== 401 && code !== 404) return;
  noteBotAnswer(code, 'description' in err ? String(err.description) : `HTTP ${code}`);
}

export function startTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  // TELEGRAM_POLLING=0 disables receiving (linking) on this instance —
  // Telegram allows only ONE getUpdates poller per bot, so extra
  // environments (CI, staging, a second dev machine) must opt out.
  // Sending notifications still works everywhere.
  //
  // Three exits, and the first two SAY so (B9, CLAUDE.md's «two silent bot
  // killers»): a missing token and a disabled poller used to return here with
  // nothing logged anywhere, so a server whose staff never got another
  // message looked exactly like a server whose staff had nothing to be told.
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN yo'q — xodimlarga Telegram xabari ketmaydi");
    return;
  }
  if (process.env.TELEGRAM_POLLING === '0') {
    logger.warn("TELEGRAM_POLLING=0 — bot xabar yuboradi, lekin tugmalar va /start qabul qilinmaydi");
    return;
  }
  if (globalForBot.telegramBot) return;

  const bot = new Bot(token);
  globalForBot.telegramBot = bot;

  bot.command('start', async (ctx) => {
    const code = ctx.match?.trim();
    // The phone's own language, NORMALISED: a raw «en-GB» or «uz-Latn» is not
    // a language the dictionary knows, and fell back to Russian.
    const tg = localeFromTelegram(ctx.from?.language_code);

    // An ADVERT brought them here (`?start=ad_instagram`). Not a link code and
    // not a menu: somebody who tapped an advert wants a price, so the only
    // question is their number, and the two-door «hodim yoki mijoz» choice
    // would be the wrong first thing to ask. A person who is ALREADY a client
    // falls through to the cabinet from the same contact — the advert visit is
    // remembered, not acted on.
    const adSource = adSourceFromPayload(code);
    if (adSource) {
      rememberAdVisit(ctx.chat.id, adSource);
      await ctx.reply(clientLabels(tg).askPhone, { reply_markup: phoneKeyboard(tg) });
      return;
    }

    /*
     * A bare /start. A function because a SPENT link code from a chat that is
     * already somebody's lands here too (round C review, CONV-5): a customer
     * tapping last month's link again was told «link expired» and handed the
     * one-time phone keyboard, which took their cabinet buttons away — while
     * the chat was connected all along.
     */
    const bareStart = async (): Promise<void> => {
      // One decision, made in the testable layer (round 100, 13A): the
      // owner's own people also ship cargo, and the staff menu used to
      // REPLACE their cabinet buttons — reply keyboards are exclusive.
      const chatId = ctx.chat.id;
      const staff = await staffForChat(BigInt(chatId));
      const linkedClients = await clientsForChat(BigInt(chatId));
      const menu = startMenuFor(staff, linkedClients.length);
      if (menu === 'both' || menu === 'cabinet') {
        // Round C: a greeting by the name Telegram knows the person by (the
        // client card's name is often a company or a marking), the codes, and
        // then — a SECOND message, since a reply keyboard and an inline one
        // cannot share one — the wide button. A client who types /start is
        // looking for their cargo, not for the corner icon. A chat that is
        // also staff is greeted by its staff name, as it always was.
        const locale = linkedClients.find((c) => c.locale)?.locale ?? null;
        const t = clientLabels(locale);
        const { startGreetingHtml } = await import('../../wms/client-cabinet/bot-text');
        const app = cabinetInlineKeyboard(process.env.APP_URL, locale);
        const messages: Outgoing[] = [
          {
            html: startGreetingHtml({
              codes: linkedClients.map((c) => c.clientCode),
              firstName: ctx.from?.first_name ?? null,
              staffName: menu === 'both' ? staff!.fullName : null,
              locale,
            }),
            // Re-derived, never named (13A): the both-keyboard now carries a
            // per-PERSON row («📊 Holat»), which only the one resolver asks.
            replyMarkup: await replyKeyboardFor(BigInt(chatId), locale),
          },
        ];
        if (app) messages.push({ html: h(t.openAppPrompt), replyMarkup: app });
        dispatch('start', chatId, () => sendInOrder(chatId, messages, 'start'));
        // The command menu is per PERSON too (/holat for the owner alone), and
        // a bare /start is the one thing a person is told to send after a
        // deploy — so it refreshes the menu as well as the keyboard.
        if (menu === 'both') void offerStaffCommands(ctx, chatId);
        return;
      }
      // A linked member of STAFF gets the staff menu (round 35).
      if (menu === 'staff') {
        await ctx.reply(`👋 ${staff!.fullName}`, { reply_markup: await replyKeyboardFor(BigInt(chatId)) });
        void offerStaffCommands(ctx, chatId);
        return;
      }
      // An unknown chat is offered the two doors (owner: «hodim yoki mijoz
      // alohida kirish bo'lsin buttonlar bilan»), asked in the person's own
      // language — the question used to be hardcoded in two languages under a
      // sentence in a third. The client door is the cabinet's phone flow; the
      // staff door matches the shared number against the employee list.
      const t = clientLabels(tg);
      await ctx.reply(`${t.notLinked}\n\n${t.entryQuestion}`, {
        reply_markup: entryKeyboard(tg),
      });
    };

    if (!code) {
      await bareStart();
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
      if (step === 'ask_phone') {
        await ctx.reply(clientLabels(tg).askPhone, { reply_markup: phoneKeyboard(tg) });
        return;
      }
      if (step === 'no_phone') {
        // The card has no phone to verify against — nothing this person can
        // press will change that, so the office is the way forward (CX-16).
        const chatId = ctx.chat.id;
        const { officeContact } = await import('../../wms/client-cabinet/service');
        const { officeLinesHtml } = await import('../../wms/client-cabinet/bot-text');
        const office = await officeContact();
        const html = `${h(clientLabels(tg).linkUnverifiable)}\n\n${officeLinesHtml(office, tg)}`;
        dispatch('link-unverifiable', chatId, () => sendInOrder(chatId, [{ html }], 'link-unverifiable'));
        return;
      }
      // A spent code from a chat that is already connected: nothing to link,
      // so it is the ordinary greeting — cabinet buttons and all.
      const chatId = BigInt(ctx.chat.id);
      if ((await clientsForChat(chatId)).length || (await staffForChat(chatId))) {
        await bareStart();
        return;
      }
      // A spent or unknown code is not the end: the self-service door needs no
      // code at all — if the number is ours, the cabinet connects itself.
      await ctx.reply(`${clientLabels(tg).linkExpired}\n\n${clientLabels(tg).linkByPhone}`, {
        reply_markup: phoneKeyboard(tg),
      });
      return;
    }
    // Through the same door the contact path uses (round 100, 13A): this
    // raw UPDATE used to skip the holder check, so a chat already held by
    // another colleague hit the column's UNIQUE index, the throw vanished
    // into bot.catch, and the person got silence. `linkStaffChat` refuses
    // only when the holder is a DIFFERENT user — re-opening your own link
    // from your own chat stays a re-link, not a refusal.
    const result = await linkStaffChat(link.userId, BigInt(ctx.chat.id), 'link_code');
    if (result.outcome === 'chat_taken') {
      await ctx.reply('Bu Telegram boshqa xodimga ulangan. Adminga ayting.');
      return;
    }
    await tellOldChat(ctx, result.previousChatId);
    const user = await db.query.users.findFirst({ where: eq(users.id, link.userId) });
    // Uzbek, like the phone-contact door's own success line and every other
    // staff sentence — this was the last Russian straggler on the path.
    await ctx.reply(`✅ Ulandi: ${user?.fullName ?? ''}. Xabarnomalar shu yerga keladi.`, {
      reply_markup: await replyKeyboardFor(BigInt(ctx.chat.id)),
    });
    void offerStaffCommands(ctx, ctx.chat.id);
  });

  /**
   * «/hodim» — the way into the STAFF side, from any chat (owner, 2026-09-05:
   * «hodim /hodim komandini qosh, shunday buyruq berganda hodim akkountiga
   * otsin»).
   *
   * A real grammy COMMAND and not a label in the text ladder, because that is
   * the only shape immune to all four things that would otherwise eat it: a
   * live «Hisoblatish» collection, a live zametka capture, `takeTaskPending`
   * (which deletes on read, so the branch below it would close a colleague's
   * task with the text «/hodim»), and the `if (!staff) return next()` fence
   * that makes everything under it staff-only — the very people this command
   * exists for are NOT staff-linked yet.
   *
   * Registered before `registerStaffBot`, so it wins over every one of them.
   *
   * What is genuinely NEW: /start already re-sends the staff keyboard to a
   * staff chat, but a chat that is a linked CLIENT gets `startMenuFor` →
   * 'cabinet' and RETURNS, so the «👨‍💼 Hodim» door is unreachable and that
   * person has no route into the staff side at all. That is the dead end.
   */
  bot.command('hodim', async (ctx) => {
    // Private chats only. In a group this would bind a staff member's
    // notifications to a room full of people, and Telegram delivers the
    // command to every member's bot the same way.
    if (ctx.chat.type !== 'private') {
      await ctx.reply('Bu buyruq faqat shaxsiy chatda ishlaydi.');
      return;
    }
    const chatId = BigInt(ctx.chat.id);
    const staff = await staffForChat(chatId);
    if (staff) {
      // Re-derived, never `staffKeyboard()`: reply keyboards are EXCLUSIVE and
      // naming one would take a both-chat's cabinet rows off the phone.
      await ctx.reply(`👋 ${staff.fullName} — hodim rejimi.`, {
        reply_markup: await replyKeyboardFor(chatId),
      });
      void offerStaffCommands(ctx, ctx.chat.id);
      return;
    }
    await askStaffPhone(ctx, chatId);
  });

  // Staff first: its handlers only act for staff-linked chats (or explicit
  // «Hodim» intent) and call next() otherwise, so a customer's contact and
  // texts fall through to the cabinet exactly as before.
  registerStaffBot(bot);
  registerClientCabinet(bot);

  bot.catch((err) => logger.error({ err: err.error }, 'telegram bot error'));

  // What a person reads before pressing Start, in their language (round C).
  // Off the poller and never fatal: a profile that fails to set is a log line.
  void ensureBotProfile().catch((err: unknown) => logger.warn({ err }, 'bot profile failed'));

  const startPolling = (retryMs: number) => {
    // `onStart` runs once grammy's getMe has answered — the token WORKS, which
    // clears a «bot ishlamayapti» left by a revoked one even when nothing is
    // queued to prove it (B9); `noteRefusedToken` records the opposite.
    void bot.start({ drop_pending_updates: true, onStart: () => noteBotAnswer(200, '', true) }).catch((err: unknown) => {
      noteRefusedToken(err);
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
