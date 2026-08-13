import { Bot, InlineKeyboard, InputFile, Keyboard } from 'grammy';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { clients, clientTelegramLinks, telegramLinks } from '../db/schema';
import { getStorage } from '../files/storage';
import { logger } from '../logger';
import {
  activeClientsByPhone,
  cargoOverview,
  clientsForChat,
  debtSummary,
  issuedHistory,
  lotPhotoKeys,
  phoneBelongsToClient,
  phonesOverlap,
  type CabinetLot,
} from '../../wms/client-cabinet/service';
import {
  CLIENT_LOCALES,
  allLabelVariants,
  clientLabels,
  isClientLocale,
  localeFromTelegram,
  formatEtaRange,
  stageLabel,
  type ClientLabels,
} from './client-labels';
import { cabinetInlineKeyboard, setCabinetMenuButton } from './menu-button';
import { adVisitFor, clearAdVisit } from './ad-intake';

/**
 * Client cabinet inside the staff bot (Phase 2.2, owner's spec 3.1/3.2):
 * clients are Uzbek-speaking, so all cabinet texts are uz. The chat's linked
 * client set is resolved on EVERY request — a revoked link cuts access
 * immediately.
 */

/**
 * The cabinet keyboard, in one client's language.
 *
 * Built per chat rather than once at module load, because the labels are now
 * translated and a keyboard is bound to the person looking at it.
 */
export function cabinetKeyboard(locale?: string | null): Keyboard {
  const t = clientLabels(locale);
  return new Keyboard()
    .text(t.btnCargo)
    .text(t.btnBalance)
    .row()
    .text(t.btnHistory)
    .text(t.btnLanguage)
    .resized()
    .persistent();
}

/**
 * The language of the chat, taken from its linked clients.
 *
 * One person holds several codes in one chat (the owner's reality: 777, 555,
 * 444…), so the FIRST answer wins rather than rendering one reply in two
 * languages. NULL — nobody asked yet — falls back inside `clientLabels`.
 */
/** Each language written in itself — nobody looks for "Uzbek" in Russian. */
const LANGUAGE_NAMES: Record<(typeof CLIENT_LOCALES)[number], string> = {
  uz: "🇺🇿 O'zbekcha",
  ru: '🇷🇺 Русский',
  en: '🇬🇧 English',
};

function chatLocale(linked: { locale: string | null }[]): string | null {
  return linked.find((c) => c.locale)?.locale ?? null;
}

function lotLine(lot: CabinetLot, t: ClientLabels, locale: string | null): string {
  // The translated name first: the client asked for their goods in a language
  // they read, and the Chinese original is only useful when there is nothing
  // else. (The staff screens keep zh-first — a Yiwu operator needs it.)
  const name = lot.productNameRu?.trim() || lot.productNameZh;
  // One line per rung, because a customer whose lot is split reads two
  // different facts and «6 dona skladda, 4 dona yo'lda» on one line hides the
  // date that belongs to only one of them.
  const groups = lot.groups
    .map((g) => {
      // The road as words, since a bot message has no bar: how much is behind,
      // and when the schedule says it lands.
      const road = g.transit
        ? ` · ${Math.round(g.transit.progress * 100)}%` +
          (g.transit.etaFromIso && g.transit.etaToIso
            ? ` · ${g.transit.toPlace}: ${t.etaAbout} ${formatEtaRange(g.transit.etaFromIso, g.transit.etaToIso, locale)}`
            : '')
        : '';
      return `   ${g.n} ${t.pieces} — ${stageLabel(g.stage, t)}${road}`;
    })
    .join('\n');
  const wh = lot.warehousePlaces.length ? `\n   📍 ${lot.warehousePlaces.join(', ')}` : '';
  return `${lot.letter ?? '·'} — ${name}\n${groups}${wh}`;
}

/**
 * Linking is TWO-step (owner's incident: a link minted for client A reached
 * person B, who instantly saw A's cargo and debt). Tapping the link no longer
 * links or reveals anything — the bot first asks the person to share their
 * OWN phone number (Telegram contact button, spoof-proof) and completes the
 * link only when it matches one of the client's registered phones.
 */

interface PendingLink {
  linkId: string;
  clientId: string;
}
const pendingByChat = new Map<number, PendingLink>();

export function phoneKeyboard(locale?: string | null): Keyboard {
  return new Keyboard().requestContact(clientLabels(locale).sharePhone).resized().oneTime();
}

/**
 * Step 1: /start <code>. Returns what the bot should do next:
 * ask_phone (verification starts), no_phone (client card lacks a phone —
 * staff must add one first; the code is NOT burned), or null (unknown code).
 */
export async function beginClientLink(
  code: string,
  chatId: number,
): Promise<'ask_phone' | 'no_phone' | null> {
  const link = await db.query.clientTelegramLinks.findFirst({
    where: eq(clientTelegramLinks.linkCode, code),
  });
  if (!link || link.status !== 'pending') return null;
  const client = await db.query.clients.findFirst({ where: eq(clients.id, link.clientId) });
  if (!client) return null;
  const phones = (client.phones as unknown[]) ?? [];
  if (!Array.isArray(phones) || phones.length === 0) {
    await notifyStaff(
      link.createdBy,
      `⚠️ Кабинет: у клиента ${client.clientCode} не указан телефон — ссылку нельзя подтвердить. Добавьте номер в карточку клиента, затем клиент может открыть ту же ссылку ещё раз.`,
    );
    return 'no_phone';
  }
  pendingByChat.set(chatId, { linkId: link.id, clientId: link.clientId });
  return 'ask_phone';
}

/** Step 2: verified — actually link. A chat may already hold this client. */
export async function completeClientLink(linkId: string, chatId: number) {
  const link = await db.query.clientTelegramLinks.findFirst({
    where: eq(clientTelegramLinks.id, linkId),
  });
  if (!link || link.status !== 'pending') return null;
  const dup = await db.query.clientTelegramLinks.findFirst({
    where: and(
      eq(clientTelegramLinks.clientId, link.clientId),
      eq(clientTelegramLinks.telegramChatId, BigInt(chatId)),
      eq(clientTelegramLinks.status, 'linked'),
    ),
  });
  if (dup) {
    await db
      .update(clientTelegramLinks)
      .set({ status: 'revoked', linkCode: null })
      .where(eq(clientTelegramLinks.id, link.id));
  } else {
    await db
      .update(clientTelegramLinks)
      .set({
        telegramChatId: BigInt(chatId),
        status: 'linked',
        linkedAt: new Date(),
        linkCode: null,
      })
      .where(eq(clientTelegramLinks.id, link.id));
  }
  return db.query.clients.findFirst({ where: eq(clients.id, link.clientId) });
}

/**
 * One person = one phone = possibly MANY marking codes (owner: 777, 555,
 * 444, 333…). Once the phone is verified, every active client registered
 * under that number joins the same chat — one link covers them all.
 */
export async function linkAllClientsForPhone(
  phone: string,
  chatId: number,
  /** NULL = the client linked themselves by sharing their number (item 13). */
  createdBy: string | null,
): Promise<{ clientCode: string; name: string }[]> {
  const owners = await activeClientsByPhone(phone);
  const already = new Set((await clientsForChat(BigInt(chatId))).map((c) => c.id));
  for (const client of owners) {
    if (already.has(client.id)) continue;
    await db.insert(clientTelegramLinks).values({
      clientId: client.id,
      telegramChatId: BigInt(chatId),
      status: 'linked',
      linkedAt: new Date(),
      createdBy,
    });
  }
  return (await clientsForChat(BigInt(chatId))).map((c) => ({
    clientCode: c.clientCode,
    name: c.name,
  }));
}

/**
 * A NEW code opened for an already-verified person appears in their cabinet
 * automatically (called after client create/update). Best-effort ping tells
 * them about it. Returns how many chats were attached.
 */
export async function autoLinkClientToVerifiedChats(
  clientId: string,
  actorId: string,
): Promise<number> {
  const client = await db.query.clients.findFirst({ where: eq(clients.id, clientId) });
  if (!client || !client.active) return 0;
  const phones = client.phones as unknown[];
  if (!Array.isArray(phones) || phones.length === 0) return 0;

  // Chats verified for OTHER clients that share a phone with this one.
  const linkedRows = await db
    .select({ chatId: clientTelegramLinks.telegramChatId, phones: clients.phones })
    .from(clientTelegramLinks)
    .innerJoin(clients, eq(clientTelegramLinks.clientId, clients.id))
    .where(eq(clientTelegramLinks.status, 'linked'));
  const targetChats = new Set<bigint>();
  for (const row of linkedRows) {
    if (row.chatId && phonesOverlap(phones, row.phones)) targetChats.add(row.chatId);
  }
  if (targetChats.size === 0) return 0;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  let added = 0;
  for (const chatId of targetChats) {
    const already = (await clientsForChat(chatId)).some((c) => c.id === clientId);
    if (already) continue;
    await db.insert(clientTelegramLinks).values({
      clientId,
      telegramChatId: chatId,
      status: 'linked',
      linkedAt: new Date(),
      createdBy: actorId,
    });
    added += 1;
    if (token) {
      try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: Number(chatId),
            text: `${clientLabels(client.locale).codeAdded}: ${client.clientCode}`,
          }),
        });
      } catch (err) {
        logger.warn({ err, clientId }, 'auto-link notify failed');
      }
    }
  }
  return added;
}

/** Verification failed: burn the code so it cannot be retried or passed on. */
export async function failClientLink(linkId: string): Promise<void> {
  const link = await db.query.clientTelegramLinks.findFirst({
    where: eq(clientTelegramLinks.id, linkId),
  });
  if (!link || link.status !== 'pending') return;
  await db
    .update(clientTelegramLinks)
    .set({ status: 'revoked', linkCode: null })
    .where(eq(clientTelegramLinks.id, link.id));
  const client = await db.query.clients.findFirst({ where: eq(clients.id, link.clientId) });
  await notifyStaff(
    link.createdBy,
    `🚨 Кабинет: ссылку клиента ${client?.clientCode ?? '?'} открыл человек с ДРУГИМ номером телефона. Ссылка аннулирована — проверьте, кому вы её отправили, и при необходимости создайте новую.`,
  );
}

/** Best-effort Telegram ping to the staff user who minted the link. */
async function notifyStaff(userId: string | null, text: string): Promise<void> {
  // NULL author = a self-service link (item 13) — there is no minting staff
  // member to warn, and both callers are on the staff-minted code path.
  if (!userId) return;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const staff = await db.query.telegramLinks.findFirst({
    where: and(eq(telegramLinks.userId, userId), eq(telegramLinks.status, 'linked')),
  });
  if (!staff?.telegramChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(staff.telegramChatId), text }),
    });
  } catch (err) {
    logger.warn({ err, userId }, 'cabinet staff notify failed');
  }
}

/** Chats whose menu button this process has already dealt with. */
const menuButtonDone = new Set<number>();

export function registerClientCabinet(bot: Bot): void {
  /**
   * Give already-linked clients the Mini App button too.
   *
   * The button is set when a client links — but everyone who linked BEFORE
   * the Mini App existed would otherwise never get one, and the fix cannot be
   * a default button: the same bot carries the staff notifications, and every
   * employee would find a customer's «Mening yuklarim» in the corner of their
   * chat, opening a cabinet that refuses them.
   *
   * So: the first time a chat says anything in this process, if it belongs to
   * a client, it gets the button. Marked done before the await, so a client
   * tapping twice does not send it twice.
   */
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId && ctx.chat?.type === 'private' && !menuButtonDone.has(chatId)) {
      menuButtonDone.add(chatId);
      const linked = await clientsForChat(BigInt(chatId));
      if (linked.length) await setCabinetMenuButton(chatId, chatLocale(linked));
    }
    await next();
  });

  // Step 2 of linking: the person shares their phone via the contact button.
  bot.on('message:contact', async (ctx) => {
    const pending = pendingByChat.get(ctx.chat.id);
    if (!pending) {
      // No staff-minted code in flight: the SELF-SERVICE door (owner, item
      // 13 — "nomerni o'zini kiritib ko'rsa bo'ladigan qilsak"). Telegram
      // itself has verified the number belongs to the sender — that is the
      // whole security model, and it is stronger than any typed code: a
      // stranger can only ever test their own number. The same forwarded-
      // contact guard as the code flow; the fallback names NO client.
      const tgLocale = ctx.from?.language_code ?? null;
      const contact = ctx.message.contact;
      if (contact.user_id !== ctx.from?.id) {
        await ctx.reply(clientLabels(tgLocale).phoneMismatch, {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }
      const all = await linkAllClientsForPhone(contact.phone_number, ctx.chat.id, null).catch(
        () => [] as { clientCode: string; name: string }[],
      );
      if (all.length === 0) {
        // Nobody we know — and if an ADVERT brought this chat here, that is
        // not a dead end, it is the enquiry. Same landing as the public form
        // and the Meta webhook, so the caps, the client-book check and the
        // rotation are the ones already proven. The answer is the advert
        // door's constant thank-you: what became of it is our business.
        const adSource = adVisitFor(ctx.chat.id);
        if (adSource) {
          clearAdVisit(ctx.chat.id);
          const { landInboundLead } = await import('../../wms/crm/inbound');
          await landInboundLead({
            channel: 'telegram',
            sourceKey: adSource,
            name: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || null,
            phone: contact.phone_number,
            note: ctx.from?.username ? `@${ctx.from.username}` : null,
          }).catch((err) => {
            // A person standing in a chat must not be shown a failure they
            // can do nothing about, and must not be invited to press again —
            // the second press is the one that duplicates.
            logger.error({ err }, '[ad-intake] landing failed');
            return null;
          });
          await ctx.reply(clientLabels(tgLocale).adThanks, {
            reply_markup: { remove_keyboard: true },
          });
          return;
        }
        await ctx.reply(clientLabels(tgLocale).phoneNotFound, {
          reply_markup: { remove_keyboard: true },
        });
        return;
      }
      // Already a customer, and an advert brought them back: the cabinet
      // below is the right answer, so the visit is simply forgotten.
      clearAdVisit(ctx.chat.id);
      const allIds = (await clientsForChat(BigInt(ctx.chat.id))).map((c) => c.id);
      const seeded = localeFromTelegram(tgLocale);
      if (seeded) {
        await db
          .update(clients)
          .set({ locale: seeded })
          .where(and(inArray(clients.id, allIds), isNull(clients.locale)));
      }
      const t = clientLabels(seeded);
      await setCabinetMenuButton(ctx.chat.id, seeded);
      await ctx.reply(
        `✅ ${t.welcome}\n${t.yourCodes}: ${all.map((c) => c.clientCode).join(', ')}.`,
        { reply_markup: cabinetKeyboard(seeded) },
      );
      const app = cabinetInlineKeyboard(process.env.APP_URL, seeded);
      if (app) await ctx.reply(t.openAppPrompt, { reply_markup: app });
      return;
    }
    pendingByChat.delete(ctx.chat.id);
    // Nothing is linked yet, so there is no stored language to read — the
    // only clue at this moment is the phone's own.
    const tgLocale = ctx.from?.language_code ?? null;
    const contact = ctx.message.contact;
    // The button always sends the sender's OWN number; a manually forwarded
    // contact card (someone else's number) has a different user_id — treat
    // it as an impersonation attempt.
    const ownContact = contact.user_id === ctx.from?.id;
    const client = ownContact
      ? await db.query.clients.findFirst({ where: eq(clients.id, pending.clientId) })
      : null;
    if (!client || !phoneBelongsToClient(contact.phone_number, client.phones)) {
      await failClientLink(pending.linkId);
      await ctx.reply(clientLabels(tgLocale).phoneMismatch, {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }
    const linkRow = await db.query.clientTelegramLinks.findFirst({
      where: eq(clientTelegramLinks.id, pending.linkId),
    });
    const linked = await completeClientLink(pending.linkId, ctx.chat.id);
    if (!linked) {
      await ctx.reply(clientLabels(tgLocale).linkExpired, {
        reply_markup: { remove_keyboard: true },
      });
      return;
    }
    // One phone, many codes (owner): connect every code registered under
    // the verified number in one go.
    const all = linkRow
      ? await linkAllClientsForPhone(contact.phone_number, ctx.chat.id, linkRow.createdBy).catch(
          () => [{ clientCode: linked.clientCode, name: linked.name }],
        )
      : [{ clientCode: linked.clientCode, name: linked.name }];
    const codes = all.map((c) => c.clientCode).join(', ');
    const allIds = (await clientsForChat(BigInt(ctx.chat.id))).map((c) => c.id);
    // Seed the language from Telegram's own — once, and only for clients who
    // have never been asked. A client who later picks for themselves is never
    // overridden by the phone they happen to be holding.
    const seeded = localeFromTelegram(tgLocale);
    if (seeded) {
      await db
        .update(clients)
        .set({ locale: seeded })
        .where(and(inArray(clients.id, allIds), isNull(clients.locale)));
    }
    const t = clientLabels(seeded);
    // The Mini App button goes up the moment the chat becomes a client's, in
    // the language just seeded from their phone.
    await setCabinetMenuButton(ctx.chat.id, seeded);
    await ctx.reply(
      `✅ ${t.welcome}\n${t.yourCodes}: ${codes}.`,
      { reply_markup: cabinetKeyboard(seeded) },
    );
    // The corner button is set above; the BIG one is offered straight away.
    // The first thing a client does after linking is look for their cargo, and
    // an icon among the chat's furniture is not where they look.
    const app = cabinetInlineKeyboard(process.env.APP_URL, seeded);
    if (app) await ctx.reply(t.openAppPrompt, { reply_markup: app });
  });

  bot.hears(allLabelVariants('btnCargo'), async (ctx) => {
    const linked = await clientsForChat(BigInt(ctx.chat.id));
    if (!linked.length) return;
    const locale = chatLocale(linked);
    const t = clientLabels(locale);
    for (const client of linked) {
      const lots = await cargoOverview(client.id);
      if (!lots.length) {
        await ctx.reply(`${client.clientCode} — ${t.noCargo}`);
        continue;
      }
      const header = `📦 ${client.clientCode} — ${client.name}\n\n`;
      const text = header + lots.map((lot) => lotLine(lot, t, locale)).join('\n\n');
      const kb = new InlineKeyboard();
      let buttons = 0;
      for (const lot of lots) {
        if (lot.hasPhotos && buttons < 12) {
          kb.text(`📷 ${lot.letter ?? '·'}`, `ph:${lot.lotId}`);
          buttons += 1;
          if (buttons % 4 === 0) kb.row();
        }
      }
      // The wide button goes on its own last row — under the cargo, where the
      // thumb already is, and without costing a second message.
      const app = cabinetInlineKeyboard(process.env.APP_URL, chatLocale(linked));
      if (app) kb.row().webApp(t.openApp, app.inline_keyboard[0]![0]!.web_app.url);
      await ctx.reply(text.slice(0, 4000), buttons || app ? { reply_markup: kb } : undefined);
    }
  });

  bot.hears(allLabelVariants('btnBalance'), async (ctx) => {
    const linked = await clientsForChat(BigInt(ctx.chat.id));
    if (!linked.length) return;
    const t = clientLabels(chatLocale(linked));
    for (const client of linked) {
      const debt = await debtSummary(client.id);
      const lines = debt.recent
        .filter((r) => !r.voided)
        .map(
          (r) =>
            `${r.txDate} — ${r.type === 'charge' ? t.charged : t.paid}: ${r.amount} ${r.currency}` +
            (r.currency !== 'USD' ? ` (≈ $${r.amountUsd.toFixed(2)})` : ''),
        )
        .join('\n');
      const head =
        debt.balanceUsd > 0.009
          ? `💰 ${client.clientCode} — ${t.debtYes}: $${debt.balanceUsd.toFixed(2)}`
          : `✅ ${client.clientCode} — ${t.debtNo}` +
            (debt.balanceUsd < -0.009
              ? ` (${t.credit} $${(-debt.balanceUsd).toFixed(2)})`
              : '');
      await ctx.reply(head + (lines ? `\n\n${t.recentMoves}:\n${lines}` : ''));
    }
  });

  bot.hears(allLabelVariants('btnHistory'), async (ctx) => {
    const linked = await clientsForChat(BigInt(ctx.chat.id));
    if (!linked.length) return;
    const t = clientLabels(chatLocale(linked));
    const dateLocale = chatLocale(linked) === 'en' ? 'en-GB' : chatLocale(linked) === 'ru' ? 'ru-RU' : 'uz-UZ';
    for (const client of linked) {
      const rows = await issuedHistory(client.id);
      if (!rows.length) {
        await ctx.reply(`${client.clientCode} — ${t.noHistory}`);
        continue;
      }
      const text =
        `🗄 ${client.clientCode} — ${t.issued}:\n\n` +
        rows
          .map(
            (r) =>
              `${r.letter ?? '·'} — ${r.productNameRu?.trim() || r.productNameZh}: ${r.n} ${t.pieces} · ${new Date(r.lastAt).toLocaleDateString(dateLocale)}`,
          )
          .join('\n');
      await ctx.reply(text.slice(0, 4000));
    }
  });

  /**
   * 🌐 Language.
   *
   * The client picks for themselves, and that choice sticks: the Telegram
   * seed only ever fills a NULL. A person holding several codes in one chat
   * has all of them set together, or the next reply would come back in two
   * languages.
   */
  bot.hears(allLabelVariants('btnLanguage'), async (ctx) => {
    const linked = await clientsForChat(BigInt(ctx.chat.id));
    if (!linked.length) return;
    const kb = new InlineKeyboard();
    for (const locale of CLIENT_LOCALES) kb.text(LANGUAGE_NAMES[locale], `lang:${locale}`);
    await ctx.reply(clientLabels(chatLocale(linked)).chooseLanguage, { reply_markup: kb });
  });

  bot.callbackQuery(/^lang:(.+)$/, async (ctx) => {
    const picked = ctx.match[1]!;
    if (!isClientLocale(picked)) {
      await ctx.answerCallbackQuery();
      return;
    }
    const linked = await clientsForChat(BigInt(ctx.chat!.id));
    if (!linked.length) {
      await ctx.answerCallbackQuery();
      return;
    }
    await db
      .update(clients)
      .set({ locale: picked })
      .where(inArray(clients.id, linked.map((c) => c.id)));
    const t = clientLabels(picked);
    // The corner button carries a word too, and leaving it in the old language
    // is the one bit of the cabinet a language switch would visibly miss.
    await setCabinetMenuButton(ctx.chat!.id, picked);
    await ctx.answerCallbackQuery(t.languageSet);
    await ctx.reply(t.languageSet, { reply_markup: cabinetKeyboard(picked) });
  });

  bot.callbackQuery(/^ph:(.+)$/, async (ctx) => {
    const lotId = ctx.match[1]!;
    const linked = await clientsForChat(BigInt(ctx.chat!.id));
    const photos = await lotPhotoKeys(lotId, linked.map((c) => c.id));
    await ctx.answerCallbackQuery();
    if (!photos.length) {
      await ctx.reply(clientLabels(chatLocale(linked)).noPhotos);
      return;
    }
    const storage = getStorage();
    try {
      const files = await Promise.all(
        photos.map(async (p) => {
          // Thumbnails are ~0.1 MB vs multi-MB originals — plenty for a phone.
          const key = p.thumb800Key ?? p.storageKey;
          return new InputFile(await storage.get(key), key.split('/').pop());
        }),
      );
      if (files.length === 1) {
        await ctx.replyWithPhoto(files[0]!);
      } else {
        await ctx.replyWithMediaGroup(files.map((f) => ({ type: 'photo' as const, media: f })));
      }
    } catch (err) {
      logger.error({ err, lotId }, 'cabinet photo send failed');
      await ctx.reply(clientLabels(chatLocale(linked)).photoError);
    }
  });
}
