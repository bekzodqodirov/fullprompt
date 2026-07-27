import { logger } from '../logger';
import { clientLabels } from './client-labels';

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
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const button = cabinetMenuButton(process.env.APP_URL, locale);
  if (!token || !button) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatId === null ? { menu_button: button } : { chat_id: chatId, menu_button: button }),
    });
    const body = (await res.json()) as { ok: boolean; description?: string };
    if (!body.ok) logger.warn({ chatId, description: body.description }, 'setChatMenuButton refused');
    return body.ok;
  } catch (err) {
    logger.warn({ err, chatId }, 'setChatMenuButton failed');
    return false;
  }
}
