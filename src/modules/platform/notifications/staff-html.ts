import { h, plainAsHtml } from '../telegram/format';

/**
 * A staff message as it reaches Telegram — built from its STORED plain text
 * at the moment of sending (round C).
 *
 * `payload.text` stays exactly what it always was: the lenta copies it, the
 * seller forwards the offer from it and a dozen tests read it. Everything
 * here is presentation added on the way out, and every piece of it is
 * reversible by reading the row:
 *
 *   - the first line bolded when it is a TITLE (it has a body under it and is
 *     short enough to be one) — never on an offer, whose first line is the
 *     customer's name in a text the seller forwards to that customer;
 *   - the card link at the foot turned into a «↗️ Ochish» button, only when it
 *     is OUR link — a raw URL in a message is the longest line on a phone and
 *     the one nobody reads;
 *   - capped with a visible «… (qisqartirildi)» instead of being refused whole
 *     by Telegram and retried six times into `failed`.
 *
 * Pure, so the rules are provable without a Telegram.
 */

/** Visible characters, safely under Telegram's 4096 with the cut mark added. */
export const STAFF_TEXT_CAP = 3900;
export const CUT_MARK = '… (qisqartirildi)';
/** A first line longer than this is a sentence, not a title. */
const TITLE_MAX = 80;

/**
 * Bold the first line? Only a real title: something follows it, it fits a
 * title's length, and it is not an offer (CalcOffer's first line is the
 * CUSTOMER's name, and that text is forwarded to the customer — STAFF-12).
 */
export function boldsTitle(type: string, text: string): boolean {
  if (type === 'CalcOffer') return false;
  const nl = text.indexOf('\n');
  if (nl === -1) return false;
  const first = text.slice(0, nl);
  if (first.trim() === '' || first.length > TITLE_MAX) return false;
  return text.slice(nl + 1).trim() !== '';
}

/** Cut to the cap, never through a surrogate pair, and say so. */
export function capStaffText(text: string): string {
  if (text.length <= STAFF_TEXT_CAP) return text;
  let cut = text.slice(0, STAFF_TEXT_CAP);
  // A lone high surrogate at the end is half an emoji — Telegram shows it as
  // a box, so the whole pair goes.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}\n${CUT_MARK}`;
}

const LINK_LINE = /^(?:🔗\s*|Karta:\s*)?(https:\/\/\S+)$/u;

/**
 * Lift our own card link off the foot of a text.
 *
 * Only the LAST non-empty line, only when that whole line is the link (with
 * the «🔗» or «Karta:» the pre-rendered texts put before it), and only when it
 * points at THIS app (same origin as an https `APP_URL`) — a foreign URL is
 * content somebody typed and stays in the sentence, and on CI's
 * `http://localhost` nothing moves at all, because Telegram refuses a button
 * that is not https and a refused keyboard takes the message with it.
 */
export function takeOwnLink(
  text: string,
  appUrl: string | null | undefined,
): { text: string; url: string | null } {
  const origin = httpsOrigin(appUrl);
  if (!origin) return { text, url: null };
  const lines = text.replace(/\s+$/, '').split('\n');
  const last = (lines[lines.length - 1] ?? '').trim();
  const match = LINK_LINE.exec(last);
  if (!match) return { text, url: null };
  const url = match[1]!;
  if (httpsOrigin(url) !== origin) return { text, url: null };
  const rest = lines.slice(0, -1).join('\n').replace(/\s+$/, '');
  // A message that WAS only the link keeps it: an empty text is refused.
  if (rest === '') return { text, url: null };
  return { text: rest, url };
}

function httpsOrigin(value: string | null | undefined): string | null {
  try {
    const url = new URL((value ?? '').trim());
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export interface UrlButton {
  text: string;
  url: string;
}

export interface StaffMessage {
  /** Safe HTML, as sent. */
  html: string;
  /** The link lifted off the foot, when one was. */
  url: string | null;
  /** The button that carries it — the LAST row of the keyboard. */
  urlRow: UrlButton[] | null;
}

/** The text, dressed for Telegram. `openLabel` is the button's words. */
export function composeStaffHtml(
  type: string,
  text: string,
  opts: { appUrl?: string | null; openLabel: string },
): StaffMessage {
  const lifted = takeOwnLink(text, opts.appUrl);
  const capped = capStaffText(lifted.text);
  const html = plainAsHtml(capped, { boldTitle: boldsTitle(type, capped) });
  return {
    html,
    url: lifted.url,
    urlRow: lifted.url ? [{ text: opts.openLabel, url: lifted.url }] : null,
  };
}

/**
 * A text that is ALREADY in a message (read back from `callbackQuery.message`)
 * dressed the same way again for an edit — the edit replaces the whole text,
 * so the title must be bolded again or it quietly loses it.
 */
export function staffTextHtml(text: string, type = ''): string {
  const capped = capStaffText(text);
  return plainAsHtml(capped, { boldTitle: boldsTitle(type, capped) });
}

/** A line added under a message by an edit («✅ Yopildi — …»), escaped. */
export function appendLine(html: string, line: string): string {
  return `${html}\n\n${h(line)}`;
}

export type InlineButton = { text?: string; url?: string; callback_data?: string };
type InlineMarkup = { inline_keyboard?: InlineButton[][] } | null | undefined;

/**
 * The keyboard rows that are LINKS. An edit that settles a question removes
 * its callback buttons and keeps these — an edit must never leave a message
 * with less to open than it had.
 */
export function urlRowsOf(markup: unknown): InlineButton[][] {
  const rows = (markup as InlineMarkup)?.inline_keyboard ?? [];
  return rows.filter((row) => row.length > 0 && row.every((button) => typeof button.url === 'string'));
}

/** The keyboard with one callback's row taken out — a list that shrinks. */
export function withoutCallback(markup: unknown, data: string): InlineButton[][] {
  const rows = (markup as InlineMarkup)?.inline_keyboard ?? [];
  return rows.filter((row) => !row.some((button) => button.callback_data === data));
}

/**
 * The keyboard with ONE button taken out — its row neighbours stay, and only
 * a row left empty goes. `withoutCallback` removes the whole row and is for
 * lists; a task's «👀 Qabul qildim» shares its row with «✅ Bajarildi», which
 * must survive the press (review telegram-mechanics-4).
 */
export function withoutButton(markup: unknown, data: string): InlineButton[][] {
  const rows = (markup as InlineMarkup)?.inline_keyboard ?? [];
  return rows
    .map((row) => row.filter((button) => button.callback_data !== data))
    .filter((row) => row.length > 0);
}

/** `{inline_keyboard}` or nothing — Telegram refuses an empty keyboard. */
export function keyboardOf(rows: InlineButton[][] | null | undefined): { inline_keyboard: InlineButton[][] } | undefined {
  return rows && rows.length > 0 ? { inline_keyboard: rows } : undefined;
}
