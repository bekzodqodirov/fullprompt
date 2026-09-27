import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { clients, clientTelegramLinks, telegramLinks, users } from '../db/schema';
import { getStorage } from '../files/storage';
import { logger } from '../logger';
import { cardLink } from '../notifications/links';
import { isTelegramMuted } from '../notifications/mutes';
import { notifyStaffTelegram } from '../notifications/staff';
import {
  activeClientsByPhone,
  linkPhoneSiblings,
  cargoOverview,
  clientsForChat,
  debtSummary,
  issuedHandovers,
  paidHistory,
  lotPhotoKeys,
  phoneBelongsToClient,
  phonesOverlap,
} from '../../wms/client-cabinet/service';
import {
  CLIENT_LOCALES,
  allLabelVariants,
  clientLabels,
  isClientLocale,
  localeFromTelegram,
  type ClientLocale,
} from './client-labels';
import { chatLocaleFor, setChatLocale } from './cabinet-locale';
import { h } from './format';
import { cabinetInlineKeyboard, setCabinetMenuButton } from './menu-button';
import { adVisitFor, clearAdVisit } from './ad-intake';
import { editText, sendAlbum, sendPhoto, sendText, type ChatId } from './send';
import { isCabinetText, staffForChat } from './staff-bot';

/**
 * The client cabinet inside the bot (Phase 2.2, owner's spec 3.1/3.2) — the
 * conversation a CUSTOMER has with us.
 *
 * The chat's linked client set is resolved on EVERY request, so a revoked link
 * cuts access at once, and the identity is always the CHAT, never an id a
 * button carried (#273). The language is the chat's: whatever the person chose
 * with «🌐 Til» (or the Mini App's switch), else the one their phone reported
 * when they linked, else Russian — `clientLabels`' fallback, and the owner's
 * answer when round C asked (Q2).
 *
 * Round C moved every WORD out of this file into
 * `wms/client-cabinet/bot-text.ts`, which is pure and tested; what is left
 * here is the conversation's shape — who may ask, in what order the handlers
 * run, and what is sent where. Two rules hold throughout:
 *   - every answer that carries markup leaves through `sendText` (the plain
 *     fallback, a deadline, a verdict) — never `ctx.reply` with a parse mode;
 *   - anything that may take seconds (several messages, a photo upload) is
 *     dispatched OFF grammy's sequential poller (#706), or one customer's slow
 *     answer holds every other customer's tap.
 */

type LinkedClient = Awaited<ReturnType<typeof clientsForChat>>[number];

/** The words, reached lazily: platform does not grow new static imports of wms. */
const botText = () => import('../../wms/client-cabinet/bot-text');
/** The two wms reads round C added (the manager, the office), the same way. */
const cabinetReads = () => import('../../wms/client-cabinet/service');

/**
 * The cabinet keyboard, in one client's language.
 *
 * Built per chat rather than once at module load, because the labels are now
 * translated and a keyboard is bound to the person looking at it.
 */
export function cabinetKeyboard(locale?: string | null): Keyboard {
  const t = clientLabels(locale);
  // «💬 Menejer» joined in round C as a third row: ADDED, never replacing a
  // label, because a persistent keyboard already on a phone is matched by its
  // exact old text.
  return new Keyboard()
    .text(t.btnCargo)
    .text(t.btnBalance)
    .row()
    .text(t.btnHistory)
    .text(t.btnLanguage)
    .row()
    .text(t.btnManager)
    .resized()
    .persistent();
}

/** Each language written in itself — nobody looks for "Uzbek" in Russian. */
const LANGUAGE_NAMES: Record<(typeof CLIENT_LOCALES)[number], string> = {
  uz: '🇺🇿 O‘zbekcha',
  ru: '🇷🇺 Русский',
  en: '🇬🇧 English',
};

/**
 * The language of the chat, taken from its linked clients.
 *
 * One person holds several codes in one chat (the owner's reality: 777, 555,
 * 444…), so the FIRST answer wins rather than rendering one reply in two
 * languages. NULL — nobody asked yet — falls back inside `clientLabels`.
 */
function chatLocale(linked: { locale: string | null }[]): string | null {
  return linked.find((c) => c.locale)?.locale ?? null;
}

/**
 * Blocks joined into messages under a limit, never split inside one — the
 * plain-text packer, kept for its pinned test. The cabinet's own answers are
 * HTML now and pack through `packHtmlBlocks`, which is the same rule with one
 * more: a cut must never land inside a tag.
 */
export function chunkBlocks(blocks: string[], limit: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of blocks) {
    const b = raw.slice(0, limit);
    if (cur && cur.length + 2 + b.length > limit) {
      out.push(cur);
      cur = b;
    } else {
      cur = cur ? `${cur}\n\n${b}` : b;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** One message of an answer: safe HTML and, optionally, its keyboard. */
export interface Outgoing {
  html: string;
  replyMarkup?: unknown;
}

/**
 * An answer of one or more messages, in order, through the one sender.
 *
 * It stops at the first refusal: the second half of a cargo list arriving
 * without its first reads as the whole answer, and the next press asks again.
 * Logged, never thrown — by the time this runs the handler has returned.
 */
export async function sendInOrder(chatId: ChatId, messages: Outgoing[], what: string): Promise<boolean> {
  for (const m of messages) {
    const sent = await sendText({ chatId, html: m.html, replyMarkup: m.replyMarkup });
    if (!sent.ok) {
      logger.warn(
        { chatId: String(chatId), what, status: sent.status, description: sent.description },
        'cabinet answer not delivered',
      );
      return false;
    }
  }
  return true;
}

/**
 * Off the sequential poller (#706): grammy handles ONE update at a time, so an
 * answer that waits on Telegram for seconds would hold every other customer's
 * tap — the zametka send and the AI answer already learned this.
 */
export function dispatch(what: string, chatId: ChatId, work: () => Promise<unknown>): void {
  void work().catch((err: unknown) =>
    logger.error({ err, chatId: String(chatId), what }, 'cabinet answer failed'),
  );
}

/** The keyboard this chat is owed — re-derived, never named (round 100, 13A). */
async function replyKeyboard(chatId: number, locale: string | null) {
  const { replyKeyboardFor } = await import('./keyboards');
  return replyKeyboardFor(BigInt(chatId), locale);
}

/** The answer's LAST message carries the keyboard; the rest carry nothing. */
function withLast(messages: string[], replyMarkup: unknown): Outgoing[] {
  return messages.map((html, i) => ({ html, replyMarkup: i === messages.length - 1 ? replyMarkup : undefined }));
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
 * A warning to the member of staff who minted a cabinet link — in Uzbek like
 * every staff message, and through the notification queue since round C: it
 * was a raw fetch with no deadline, awaited on the poller, in RUSSIAN, with no
 * mute group and no retry, so a Telegram blip lost it and nobody could turn
 * it off. The card link is the last line, where the drain makes it a button.
 *
 * NULL author = a self-service link (item 13): there is nobody to warn.
 * Best-effort: a warning that fails must never fail the link itself.
 */
async function alertLinkMinter(userId: string | null, clientId: string, text: string): Promise<void> {
  if (!userId) return;
  const link = cardLink('client', clientId);
  await notifyStaffTelegram({
    userIds: [userId],
    type: 'CabinetLinkAlert',
    text: link && /^https?:\/\//.test(link) ? `${text}\n${link}` : text,
  }).catch((err: unknown) => logger.warn({ err, userId }, 'cabinet link alert not queued'));
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
    await alertLinkMinter(
      link.createdBy,
      client.id,
      `⚠️ Kabinet: ${client.clientCode} mijozining kartasida telefon raqami yo‘q — havolani tasdiqlab bo‘lmaydi. ` +
        'Kartaga raqamni qo‘shing, so‘ng mijoz shu havolani qayta ochadi.',
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
 * automatically (called after client create/update). A message tells them
 * about it. Returns how many chats were attached.
 *
 * Round C: the message is in the language the PERSON chose — read from the
 * chat, not from the new code, which has no language of its own yet — and the
 * new code takes that language too, or its first push would come in the
 * Russian fallback (judge CX-7). It carries the wide button, and it goes
 * through the one sender with a short deadline, because this runs inside the
 * web request that saved the client.
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
    const locale = (await chatLocaleFor(chatId)) ?? client.locale;
    if (locale && !client.locale) {
      await db
        .update(clients)
        .set({ locale })
        .where(and(eq(clients.id, clientId), isNull(clients.locale)));
    }
    if (process.env.TELEGRAM_BOT_TOKEN) {
      const { codeAddedHtml } = await botText();
      const sent = await sendText({
        chatId,
        html: codeAddedHtml(client.clientCode, locale),
        replyMarkup: cabinetInlineKeyboard(process.env.APP_URL, locale) ?? undefined,
        timeoutMs: 10_000,
      });
      if (!sent.ok) logger.warn({ clientId, description: sent.description }, 'auto-link notice not delivered');
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
  await alertLinkMinter(
    link.createdBy,
    link.clientId,
    `🚨 Kabinet: ${client?.clientCode ?? '?'} havolasini BOSHQA telefon raqamli odam ochdi. ` +
      'Havola bekor qilindi — kimga yuborganingizni tekshiring va kerak bo‘lsa yangisini yarating.',
  );
}

/**
 * Where a customer's own words land (judge CX-1/PRIV-10).
 *
 * Before round C a linked customer who TYPED to the bot — «yukim qachon
 * keladi?», a photo of a damaged box — got silence: no handler listened, and
 * the words went nowhere at all. They now go to a PERSON: the manager of the
 * chat's first code that has one (the person `managersFor` would show them),
 * else everybody who manages the client book. The customer is told who.
 */
export type ForwardOutcome =
  | { to: 'manager'; managerName: string; locale: string | null }
  | { to: 'office'; locale: string | null }
  | { to: 'throttled'; managerName: string | null; locale: string | null };

const FORWARD_WINDOW_MS = 10 * 60_000;
/**
 * At most this many forwards per chat per window. A customer pasting a long
 * story line by line is ten messages; a script, or a child with the phone, is
 * a hundred — and each one is a Telegram message in a manager's pocket.
 */
export const FORWARD_MAX_PER_WINDOW = 10;
const forwardLog = new Map<string, number[]>();
/**
 * An album is one update per photo, but it is ONE thing the customer said: it
 * takes one slot, and every photo in it shares the first one's verdict — or a
 * customer's ten photographs of a broken carton would spend the whole window
 * and the sentence they typed next would reach nobody.
 */
const albumVerdict = new Map<string, { album: string; admitted: boolean }>();

/**
 * Which of these people a staff Telegram message would actually REACH: active,
 * a linked staff chat, and not muting this type — the three questions the
 * drain asks before it settles a row `muted` for ever (notifications/
 * service.ts). Asked here first, because «delivered to your manager
 * Dilnoza» about a row the drain will silently mute is the lie phase C's
 * `hasLinkedChat` exists to prevent: a seller who never linked their
 * Telegram is most sellers on day one.
 */
async function reachableStaff(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ id: users.id, muted: users.mutedNotificationTypes })
    .from(users)
    .innerJoin(
      telegramLinks,
      and(eq(telegramLinks.userId, users.id), eq(telegramLinks.status, 'linked'), isNotNull(telegramLinks.telegramChatId)),
    )
    .where(and(inArray(users.id, [...new Set(userIds)]), eq(users.active, true)));
  return new Set(rows.filter((r) => !isTelegramMuted(r.muted, 'ClientBotMessage')).map((r) => r.id));
}

function takeForwardSlot(chatKey: string, now: number): boolean {
  const recent = (forwardLog.get(chatKey) ?? []).filter((t) => now - t < FORWARD_WINDOW_MS);
  if (recent.length >= FORWARD_MAX_PER_WINDOW) {
    forwardLog.set(chatKey, recent);
    return false;
  }
  recent.push(now);
  forwardLog.set(chatKey, recent);
  return true;
}

/**
 * Hand one customer message to a person. Null = not a customer's chat (or a
 * chat that is ALSO staff, whose words are the staff bot's business).
 *
 * A text is quoted into the staff copy; a file is announced and carries
 * `forwardFrom`, so the drain forwards the very message — the staff copy's
 * text still stands on its own if that forward fails.
 */
export async function forwardClientMessage(input: {
  chatId: bigint;
  messageId: number;
  /** The text, or a file's caption. */
  text: string | null;
  media: boolean;
  /** Telegram's `media_group_id` when the file is one photo of an album. */
  albumId?: string | null;
  now?: Date;
}): Promise<ForwardOutcome | null> {
  const linked = await clientsForChat(input.chatId);
  if (!linked.length) return null;
  if (await staffForChat(input.chatId)) return null;
  const locale = chatLocale(linked);
  const { managersFor } = await cabinetReads();
  const managers = await managersFor(linked.map((c) => c.id));
  // The first code whose manager the message would actually REACH:
  // `managersFor` has dropped a deactivated one, and `reachableStaff` one with
  // no linked Telegram (or who muted these) — so a customer is never told «your
  // manager has it» about a message nobody will read.
  const reach = await reachableStaff(linked.flatMap((c) => (c.salesManagerId ? [c.salesManagerId] : [])));
  const owner =
    linked.find((c) => c.salesManagerId && managers.has(c.id) && reach.has(c.salesManagerId)) ?? null;
  const managerName = owner ? managers.get(owner.id)!.name : null;
  const chatKey = String(input.chatId);
  const known = input.albumId ? albumVerdict.get(chatKey) : undefined;
  const admitted =
    known && known.album === input.albumId
      ? known.admitted
      : takeForwardSlot(chatKey, (input.now ?? new Date()).getTime());
  if (input.albumId) albumVerdict.set(chatKey, { album: input.albumId, admitted });
  if (!admitted) {
    logger.info({ chatId: String(input.chatId) }, 'client bot message not forwarded — over the per-chat limit');
    return { to: 'throttled', managerName, locale };
  }
  // The office: whoever manages the client book and can be reached. When
  // nobody can, the rows are still written to all of them — the notifications
  // screen shows them, which is more than silence.
  const office = owner
    ? []
    : await (await import('../notifications/service')).usersWithPermission('clients.manage');
  const officeReach = owner ? new Set<string>() : await reachableStaff(office);
  const recipients = owner?.salesManagerId
    ? [owner.salesManagerId]
    : officeReach.size
      ? office.filter((id) => officeReach.has(id))
      : office;
  const first = owner ?? linked[0]!;
  const card = cardLink('client', first.id);
  const { forwardStaffText } = await botText();
  await notifyStaffTelegram({
    userIds: recipients,
    type: 'ClientBotMessage',
    text: forwardStaffText({
      codes: [first.clientCode, ...linked.filter((c) => c.id !== first.id).map((c) => c.clientCode)],
      name: first.name,
      text: input.text,
      media: input.media,
      cardUrl: card && /^https?:\/\//.test(card) ? card : null,
    }),
    extra: input.media
      ? { forwardFrom: { chatId: Number(input.chatId), messageId: input.messageId } }
      : undefined,
  });
  return owner ? { to: 'manager', managerName: managerName!, locale } : { to: 'office', locale };
}

/** «✅ Xabaringiz menejeringizga yetkazildi: Dilnoza.» — with the keyboard back. */
async function acknowledge(chatId: number, outcome: ForwardOutcome): Promise<void> {
  const { deliveredHtml } = await botText();
  const name = outcome.to === 'office' ? null : outcome.managerName;
  await sendInOrder(
    chatId,
    [{ html: deliveredHtml(name, outcome.locale), replyMarkup: await replyKeyboard(chatId, outcome.locale) }],
    'forward-ack',
  );
}

/**
 * Right after a chat becomes a customer's: what the cabinet is, which codes it
 * holds, then the wide button — two messages, because a reply keyboard and an
 * inline one cannot ride the same message.
 *
 * The language is the one the person ALREADY chose when any of their codes
 * carries one (a re-link, a second phone), and only otherwise the phone's
 * (judge CX-7) — the old path used the phone's even over a stored choice, so
 * the corner button came back in the wrong language until «🌐 Til». Seeded
 * onto NULL codes only; a choice somebody made is never overridden.
 */
async function welcomeLinked(chatId: number, codes: string[], tgLocale: ClientLocale | null): Promise<void> {
  const ids = (await clientsForChat(BigInt(chatId))).map((c) => c.id);
  const locale = (await chatLocaleFor(BigInt(chatId))) ?? tgLocale;
  if (locale && ids.length) {
    await db
      .update(clients)
      .set({ locale })
      .where(and(inArray(clients.id, ids), isNull(clients.locale)));
  }
  await setCabinetMenuButton(chatId, locale);
  const { linkedWelcomeHtml } = await botText();
  const t = clientLabels(locale);
  const app = cabinetInlineKeyboard(process.env.APP_URL, locale);
  const messages: Outgoing[] = [
    { html: linkedWelcomeHtml(codes, locale), replyMarkup: await replyKeyboard(chatId, locale) },
  ];
  // The corner button is set above; the BIG one is offered straight away. The
  // first thing a client does after linking is look for their cargo, and an
  // icon among the chat's furniture is not where they look.
  if (app) messages.push({ html: h(t.openAppPrompt), replyMarkup: app });
  dispatch('welcome', chatId, () => sendInOrder(chatId, messages, 'welcome'));
}

/**
 * A refusal that is not a dead end (judge CX-16): the sentence, then the
 * office's name and phone. The contact keyboard goes — pressing it again can
 * only send the same number and hear the same answer — and the office is the
 * way forward instead.
 */
async function refuseWithOffice(chatId: number, sentence: string, locale: string | null): Promise<void> {
  const { officeContact } = await cabinetReads();
  const { officeLinesHtml } = await botText();
  const office = await officeContact();
  dispatch('refusal', chatId, () =>
    sendInOrder(
      chatId,
      [{ html: `${h(sentence)}\n\n${officeLinesHtml(office, locale)}`, replyMarkup: { remove_keyboard: true } }],
      'refusal',
    ),
  );
}

/** «📦 Yuklarim»: one answer per code, each as many messages as it takes. */
async function sendCargo(chatId: number, linked: LinkedClient[], locale: string | null): Promise<void> {
  const { cargoMessages, photoButtonRows } = await botText();
  // The wide button goes on the last row — under the cargo, where the thumb
  // already is, and without costing a message of its own.
  const app = cabinetInlineKeyboard(process.env.APP_URL, locale);
  const out: Outgoing[] = [];
  for (const client of linked) {
    const lots = await cargoOverview(client.id);
    const messages = cargoMessages(client, lots, locale);
    const rows = [...photoButtonRows(lots), ...(lots.length && app ? app.inline_keyboard : [])];
    messages.forEach((html, i) => {
      const last = i === messages.length - 1;
      out.push({ html, replyMarkup: last && rows.length ? { inline_keyboard: rows } : undefined });
    });
  }
  await sendInOrder(chatId, out, 'cargo');
}

/** «💰 Balans»: one answer for the whole chat, with the keyboard (CX-17's rollout). */
async function sendBalance(chatId: number, linked: LinkedClient[], locale: string | null): Promise<void> {
  const { balanceMessages } = await botText();
  const entries = [];
  // One code at a time: a person holds a handful, and a burst of parallel
  // ledger reads for one tap is a pool of ten spent on one customer.
  for (const client of linked) entries.push({ clientCode: client.clientCode, debt: await debtSummary(client.id) });
  // The balance answer carries the reply keyboard, so a phone still holding
  // the pre-round-C keyboard receives «💬 Menejer» the next time it asks.
  await sendInOrder(chatId, withLast(balanceMessages(entries, locale), await replyKeyboard(chatId, locale)), 'balance');
}

/** «🗄 Tarix»: three months of handovers and payments, per code. */
async function sendHistory(chatId: number, linked: LinkedClient[], locale: string | null): Promise<void> {
  const { historyMessages } = await botText();
  const all: string[] = [];
  for (const client of linked) {
    const [handed, paid] = await Promise.all([issuedHandovers(client.id), paidHistory(client.id)]);
    all.push(...historyMessages(client.clientCode, handed, paid, locale));
  }
  await sendInOrder(chatId, withLast(all, await replyKeyboard(chatId, locale)), 'history');
}

/** «💬 Menejer» and the push's `mg`: who to write to, per distinct person. */
async function sendManagers(chatId: number, linked: LinkedClient[], locale: string | null): Promise<void> {
  const { managersFor, officeContact } = await cabinetReads();
  const { managerCards } = await botText();
  const [managers, office] = await Promise.all([managersFor(linked.map((c) => c.id)), officeContact()]);
  const t = clientLabels(locale);
  const cards = managerCards(
    linked.map((c) => ({ clientCode: c.clientCode, manager: managers.get(c.id) ?? null })),
    office,
    locale,
  );
  await sendInOrder(
    chatId,
    cards.map((card) => ({
      html: card.html,
      replyMarkup: card.url ? { inline_keyboard: [[{ text: t.managerWrite, url: card.url }]] } : undefined,
    })),
    'manager',
  );
}

/**
 * 📷: one lot's photographs, as one album with a caption saying what they are.
 *
 * Ownership is re-proved by `lotPhotoKeys` (a button's data is a stranger's
 * string). Each file is read in its own try — one missing object costs one
 * photo, not the answer. The caption reads the SAME cargo list the button came
 * from, so it says what the list said.
 */
async function sendLotPhotos(chatId: number, lotId: string, linked: LinkedClient[], locale: string | null): Promise<void> {
  const t = clientLabels(locale);
  const { photoSource, photoCaption, productName } = await botText();
  const photos = await lotPhotoKeys(lotId, linked.map((c) => c.id));
  if (!photos.length) {
    await sendText({ chatId, text: t.noPhotos });
    return;
  }
  const storage = getStorage();
  const files: { bytes: Buffer; filename: string; contentType: string }[] = [];
  for (const p of photos) {
    const source = photoSource(p);
    if (!source) continue;
    try {
      files.push({
        bytes: await storage.get(source.key),
        filename: source.key.split('/').pop() || 'photo.jpg',
        contentType: source.contentType,
      });
    } catch (err) {
      logger.warn({ err, lotId }, 'cabinet photo unreadable — skipped');
    }
  }
  if (!files.length) {
    await sendText({ chatId, text: t.photoError });
    return;
  }
  let caption: string | undefined;
  for (const client of linked) {
    const lot = (await cargoOverview(client.id)).find((l) => l.lotId === lotId);
    if (lot) {
      caption = photoCaption(
        { clientCode: client.clientCode, letter: lot.letter, name: productName(lot), boxes: lot.total },
        locale,
      );
      break;
    }
  }
  const sent = files.length === 1
    ? await sendPhoto({ chatId, photo: files[0]!, captionHtml: caption })
    : await sendAlbum({ chatId, photos: files, captionHtml: caption });
  if (!sent.ok) {
    logger.warn({ lotId, status: sent.status, description: sent.description }, 'cabinet photos not delivered');
    if (!sent.botDown) await sendText({ chatId, text: t.photoError });
  }
}

/** Chats whose menu button this process has already dealt with. */
const menuButtonDone = new Set<number>();
/** Chats with a 📷 answer on its way — a second tap waits for the first. */
const photoInFlight = new Set<number>();
/** The last album a chat sent us — its many updates are acknowledged once. */
const ackedAlbum = new Map<number, string>();

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
      // The same person's other codes join first (a shared phone), so the
      // text cabinet below answers about all of them.
      await linkPhoneSiblings(BigInt(chatId)).catch(() => 0);
      const linked = await clientsForChat(BigInt(chatId));
      if (linked.length) await setCabinetMenuButton(chatId, chatLocale(linked));
    }
    await next();
  });

  // Step 2 of linking: the person shares their phone via the contact button.
  bot.on('message:contact', async (ctx) => {
    const chatId = ctx.chat.id;
    // Nothing is linked yet, so there is no stored language to read — the only
    // clue is the phone's own, normalised: «en-GB» and «uz-Latn» are English
    // and Uzbek, not the Russian fallback.
    const tgLocale = localeFromTelegram(ctx.from?.language_code);
    const contact = ctx.message.contact;
    const pending = pendingByChat.get(chatId);
    if (!pending) {
      // No staff-minted code in flight: the SELF-SERVICE door (owner, item
      // 13 — "nomerni o'zini kiritib ko'rsa bo'ladigan qilsak"). Telegram
      // itself has verified the number belongs to the sender — that is the
      // whole security model, and it is stronger than any typed code: a
      // stranger can only ever test their own number.
      if (contact.user_id !== ctx.from?.id) {
        // Somebody else's contact card. There is no link here to cancel, so
        // the answer is the one thing that works: send your OWN (CX-16).
        await ctx.reply(clientLabels(tgLocale).selfPhoneMismatch, { reply_markup: phoneKeyboard(tgLocale) });
        return;
      }
      const all = await linkAllClientsForPhone(contact.phone_number, chatId, null).catch(
        () => [] as { clientCode: string; name: string }[],
      );
      if (all.length === 0) {
        // Nobody we know — and if an ADVERT brought this chat here, that is
        // not a dead end, it is the enquiry. Same landing as the public form
        // and the Meta webhook, so the caps, the client-book check and the
        // rotation are the ones already proven. The answer is the advert
        // door's constant thank-you: what became of it is our business.
        const adSource = adVisitFor(chatId);
        if (adSource) {
          clearAdVisit(chatId);
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
        await refuseWithOffice(chatId, clientLabels(tgLocale).phoneNotFound, tgLocale);
        return;
      }
      // Already a customer, and an advert brought them back: the cabinet
      // below is the right answer, so the visit is simply forgotten.
      clearAdVisit(chatId);
      await welcomeLinked(chatId, all.map((c) => c.clientCode), tgLocale);
      return;
    }
    pendingByChat.delete(chatId);
    // The button always sends the sender's OWN number; a manually forwarded
    // contact card (someone else's number) has a different user_id — treat
    // it as an impersonation attempt.
    const ownContact = contact.user_id === ctx.from?.id;
    const client = ownContact
      ? await db.query.clients.findFirst({ where: eq(clients.id, pending.clientId) })
      : null;
    if (!client || !phoneBelongsToClient(contact.phone_number, client.phones)) {
      await failClientLink(pending.linkId);
      await refuseWithOffice(chatId, clientLabels(tgLocale).phoneMismatch, tgLocale);
      return;
    }
    const linkRow = await db.query.clientTelegramLinks.findFirst({
      where: eq(clientTelegramLinks.id, pending.linkId),
    });
    const linked = await completeClientLink(pending.linkId, chatId);
    if (!linked) {
      await refuseWithOffice(chatId, clientLabels(tgLocale).linkExpired, tgLocale);
      return;
    }
    // One phone, many codes (owner): connect every code registered under
    // the verified number in one go.
    const all = linkRow
      ? await linkAllClientsForPhone(contact.phone_number, chatId, linkRow.createdBy).catch(
          () => [{ clientCode: linked.clientCode, name: linked.name }],
        )
      : [{ clientCode: linked.clientCode, name: linked.name }];
    await welcomeLinked(chatId, all.map((c) => c.clientCode), tgLocale);
  });

  bot.hears(allLabelVariants('btnCargo'), async (ctx) => {
    const chatId = ctx.chat.id;
    const linked = await clientsForChat(BigInt(chatId));
    if (!linked.length) return;
    dispatch('cargo', chatId, () => sendCargo(chatId, linked, chatLocale(linked)));
  });

  bot.hears(allLabelVariants('btnBalance'), async (ctx) => {
    const chatId = ctx.chat.id;
    const linked = await clientsForChat(BigInt(chatId));
    if (!linked.length) return;
    dispatch('balance', chatId, () => sendBalance(chatId, linked, chatLocale(linked)));
  });

  bot.hears(allLabelVariants('btnHistory'), async (ctx) => {
    const chatId = ctx.chat.id;
    const linked = await clientsForChat(BigInt(chatId));
    if (!linked.length) return;
    dispatch('history', chatId, () => sendHistory(chatId, linked, chatLocale(linked)));
  });

  bot.hears(allLabelVariants('btnManager'), async (ctx) => {
    const chatId = ctx.chat.id;
    const linked = await clientsForChat(BigInt(chatId));
    if (!linked.length) return;
    dispatch('manager', chatId, () => sendManagers(chatId, linked, chatLocale(linked)));
  });

  /**
   * 🌐 Language.
   *
   * The client picks for themselves, and that choice sticks: the Telegram
   * seed only ever fills a NULL. A person holding several codes in one chat
   * has all of them set together (`setChatLocale`, the one writer the Mini
   * App's switch uses too), or the next reply would come back in two
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
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.from.id;
    if (!isClientLocale(picked) || !(await clientsForChat(BigInt(chatId))).length) {
      await ctx.answerCallbackQuery();
      return;
    }
    const t = clientLabels(picked);
    await ctx.answerCallbackQuery(t.languageSet);
    await setChatLocale(BigInt(chatId), picked);
    // The chooser is EDITED into the answer: its three buttons stayed under
    // the message for ever and offered a choice already made.
    const pressed = ctx.callbackQuery.message?.message_id;
    if (pressed) await editText({ chatId, messageId: pressed, html: h(t.languageSet) });
    // Re-derived (round 100, 13A): a staff+client chat switching language
    // used to get the bare cabinet keyboard and lose its staff row. A reply
    // keyboard changes only by SENDING a message, so this one says what the
    // cabinet is — in the language just chosen.
    const { replyKeyboardFor } = await import('./keyboards');
    await ctx.reply(t.welcome, { reply_markup: await replyKeyboardFor(BigInt(ctx.chat!.id), picked) });
  });

  bot.callbackQuery(/^ph:(.+)$/, async (ctx) => {
    const lotId = ctx.match[1]!;
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.from.id;
    const linked = await clientsForChat(BigInt(chatId));
    const locale = chatLocale(linked);
    // Answered at once: the upload takes seconds and a button that spins that
    // long reads as broken. A second tap while the first is on its way hears
    // the same toast and starts nothing (judge REL-12/PRIV-9).
    await ctx.answerCallbackQuery({ text: clientLabels(locale).photoSending });
    if (!linked.length || photoInFlight.has(chatId)) return;
    photoInFlight.add(chatId);
    dispatch('photos', chatId, () =>
      sendLotPhotos(chatId, lotId, linked, locale).finally(() => photoInFlight.delete(chatId)),
    );
  });

  /**
   * `mg` — the manager door under every push (contract 1). A CALLBACK, so it
   * is answered from the chat's codes on the day it is pressed, never from a
   * person's link frozen into an old message (PRIV-2). ALWAYS answered, first:
   * a callback nobody answers spins for fifteen seconds with no error.
   */
  bot.callbackQuery('mg', async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = ctx.chat?.id ?? ctx.callbackQuery.from.id;
    const linked = await clientsForChat(BigInt(chatId));
    if (!linked.length) return;
    dispatch('manager', chatId, () => sendManagers(chatId, linked, chatLocale(linked)));
  });

  /*
   * LAST: a customer's own words (judge CX-1). Every handler above has had its
   * chance — the labels, the language, the photos — and whatever a linked
   * customer typed or sent that nothing answered reaches a person instead of
   * vanishing. A command is not words (it is answered or ignored above), and a
   * label with stray spaces is still a label.
   */
  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat.type !== 'private') return next();
    const text = ctx.message.text;
    if (text.trim().startsWith('/') || isCabinetText(text)) return next();
    const chatId = ctx.chat.id;
    const outcome = await forwardClientMessage({
      chatId: BigInt(chatId),
      messageId: ctx.message.message_id,
      text,
      media: false,
    });
    if (!outcome) return next();
    dispatch('forward-ack', chatId, () => acknowledge(chatId, outcome));
  });

  bot.on(
    ['message:photo', 'message:document', 'message:voice', 'message:audio', 'message:video', 'message:video_note'],
    async (ctx, next) => {
      if (ctx.chat.type !== 'private') return next();
      const chatId = ctx.chat.id;
      const album = ctx.message.media_group_id ?? null;
      const outcome = await forwardClientMessage({
        chatId: BigInt(chatId),
        messageId: ctx.message.message_id,
        text: ctx.message.caption ?? null,
        media: true,
        albumId: album,
      });
      if (!outcome) return next();
      // An album is one update per photo: each is forwarded, the customer is
      // told once.
      if (album && ackedAlbum.get(chatId) === album) return;
      if (album) ackedAlbum.set(chatId, album);
      dispatch('forward-ack', chatId, () => acknowledge(chatId, outcome));
    },
  );
}
