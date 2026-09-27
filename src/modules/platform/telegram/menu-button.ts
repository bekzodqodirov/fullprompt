import { logger } from '../logger';
import { clientLabels } from './client-labels';
import { botCall } from './send';

/**
 * The blue button in the corner of the chat — how a client actually REACHES
 * the Mini App.
 *
 * There is no other door. A `web_app` button on a reply keyboard looks
 * identical and opens the same page, but Telegram hands it EMPTY `initData`,
 * so the cabinet would refuse every client who arrived that way and the
 * failure would look like a broken app rather than a wrong button. The chat
 * menu button is the one placement that carries a signed blob.
 *
 * Set per chat, in the client's own language, rather than once globally: the
 * default button takes a single string, and a Russian-speaking client should
 * not read «Mening yuklarim» in the corner of their screen.
 */

export interface MenuButton {
  type: 'web_app';
  text: string;
  web_app: { url: string };
}

/** An inline keyboard holding one wide `web_app` button. */
export interface CabinetInlineKeyboard {
  inline_keyboard: { text: string; web_app: { url: string } }[][];
}

/**
 * Where the cabinet lives, or null when it cannot be opened at all.
 *
 * Telegram refuses a Mini App on anything but public HTTPS, so an `APP_URL`
 * that is empty or plain http means no button MUST be sent anywhere — the API
 * call fails, and worse, a stale button pointing at a dead URL is a client
 * tapping into nothing.
 */
export function cabinetUrl(appUrl: string | undefined): string | null {
  const base = (appUrl ?? '').trim().replace(/\/+$/, '');
  return base.startsWith('https://') ? `${base}/cabinet` : null;
}

/** The corner button, in one client's language. */
export function cabinetMenuButton(appUrl: string | undefined, locale?: string | null): MenuButton | null {
  const url = cabinetUrl(appUrl);
  return url ? { type: 'web_app', text: clientLabels(locale).appTitle, web_app: { url } } : null;
}

/**
 * The BIG button (owner: "buttonga urg'u ber … glavniy katta button bo'lib
 * ko'rinib tursin").
 *
 * The corner menu button is one icon among the chat's furniture and people do
 * not find it. An inline button sits under a message at full width, which is
 * where a client's thumb already is — so the cabinet is offered exactly where
 * the cargo is being discussed: on the arrival message, on the cargo list, and
 * once at linking.
 *
 * INLINE, not a reply-keyboard button. The two look the same and open the same
 * page, but a reply-keyboard `web_app` button hands the app an empty
 * `initData` (#275) — every client would be refused, and it would read as a
 * broken app rather than the wrong kind of button.
 */
export function cabinetInlineKeyboard(
  appUrl: string | undefined,
  locale?: string | null,
): CabinetInlineKeyboard | null {
  const url = cabinetUrl(appUrl);
  if (!url) return null;
  return { inline_keyboard: [[{ text: clientLabels(locale).openApp, web_app: { url } }]] };
}

/**
 * Put the button in one client's chat (or set the default when `chatId` is
 * null). Best-effort: a client whose button fails to set still has the bot's
 * text cabinet, so this must never break linking.
 */
export async function setCabinetMenuButton(
  chatId: number | null,
  locale?: string | null,
): Promise<boolean> {
  const button = cabinetMenuButton(process.env.APP_URL, locale);
  if (!process.env.TELEGRAM_BOT_TOKEN || !button) return false;
  // Through the one sender since round C: this call had NO deadline, and it is
  // awaited on the sequential poller at a chat's first update and at every
  // language switch — a hung socket there froze every customer's cabinet.
  const answer = await botCall(
    'setChatMenuButton',
    chatId === null ? { menu_button: button } : { chat_id: chatId, menu_button: button },
    10_000,
  );
  if (!answer.ok) logger.warn({ chatId, description: answer.description }, 'setChatMenuButton refused');
  return answer.ok;
}

/**
 * The cabinet opened on ONE lot (round C) — the push about a lot opens the
 * Mini App scrolled to that lot rather than to the top of everything the
 * customer owns. A parameter the app READS; the identity is still the signed
 * chat, so a hand-edited id opens nothing that is not theirs (#273).
 */
export function cabinetLotUrl(appUrl: string | undefined, lotId: string | null | undefined): string | null {
  const url = cabinetUrl(appUrl);
  if (!url) return null;
  return lotId ? `${url}?lot=${encodeURIComponent(lotId)}` : url;
}

/** What a push carries: the wide «open» button and, below it, the manager door. */
export interface PushKeyboard {
  inline_keyboard: ({ text: string; web_app: { url: string } } | { text: string; callback_data: string })[][];
}

/**
 * The keyboard under a push (round C).
 *
 * Row 1 is the wide web_app button, opened on the lot the message is about.
 * Row 2 is a door to the customer's manager — a CALLBACK (`mg`), deliberately
 * not a link: a push stays in the chat for ever, and a person's URL written
 * into it would go on sending customers to a manager who has left, or to a
 * handle a stranger has since registered (the judge's PRIV-2). The callback is
 * answered when it is PRESSED, from the chat's own codes, by whoever the
 * manager is that day.
 *
 * `cabinetInlineKeyboard` stays one row, one button — its test pins that shape
 * and the /start and cargo-list messages still use it.
 */
export function clientPushKeyboard(
  appUrl: string | undefined,
  locale: string | null | undefined,
  opts: { lotId?: string | null; contact?: boolean } = {},
): PushKeyboard | null {
  const t = clientLabels(locale);
  const rows: PushKeyboard['inline_keyboard'] = [];
  const url = cabinetLotUrl(appUrl, opts.lotId);
  if (url) rows.push([{ text: t.openApp, web_app: { url } }]);
  if (opts.contact !== false) rows.push([{ text: t.contactManager, callback_data: 'mg' }]);
  return rows.length ? { inline_keyboard: rows } : null;
}
