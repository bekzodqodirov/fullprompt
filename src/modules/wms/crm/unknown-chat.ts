import type { DialogVerdict } from './telegram-import';

/**
 * What to do with a conversation that belongs to nobody we know.
 *
 * Until now the answer was «nothing», and it was the right answer for one
 * reason and the wrong one for another. Right, because a manager's Telegram
 * is also their private life and the client book was the only thing standing
 * between that and the company database. Wrong, because a NEW customer
 * writing in for the first time is not in the book yet by definition — which
 * is exactly what the owner reported: «telegramdan yangi klientlar ochsa
 * smslar chatlar nega korinmayabti».
 *
 * The fix is not to drop the fence but to ask WHOSE number it is, which the
 * connected account now answers about itself (`tg_accounts.work_account`):
 *
 *  - a WORK number is only ever used for clients, so an unknown chat on it is
 *    a customer and becomes a lead by itself — whether Telegram shows the
 *    number or hides it (2026-10-29, below);
 *  - a PERSONAL number carries the manager's whole life, so an unknown chat
 *    becomes a QUESTION on a tray — and until it is answered nothing about
 *    the conversation is stored except that it was asked about.
 *
 * The default is personal, because the safe answer must be the one nobody has
 * to choose. Both directions are treated the same: the owner asked for the
 * seller writing OUT to a new person to count too, and the listener has seen
 * outgoing messages since #315 fixed the peer resolution for them.
 */

export type UnknownChatAction =
  /** Mint a lead and keep the conversation on it. */
  | { action: 'open_lead' }
  /** Put it on the tray and store nothing until somebody answers. */
  | { action: 'ask' }
  /** A refusal that is nothing to do with «do we know them» — leave it alone. */
  | { action: 'skip'; reason: string };

/**
 * `verdict` is the existing classification; `workAccount` is the switch.
 *
 * Two refusals are reconsidered here, both about acquaintance and nothing
 * else:
 *
 *  - `not_a_client` — a real private chat with a real number that is in no
 *    book: a lead on a work number, a tray question on a personal one;
 *  - `no_phone` — a real private chat with a real person whose number
 *    Telegram hides from this account. It used to stay refused everywhere,
 *    on the argument that a lead nobody can ring is a row with a name in it.
 *    The owner overruled that for WORK numbers (2026-10-29, his «1 a» to
 *    «Telegramda raqamini yashirgan odam yangi raqamingizga yozsa, nima
 *    qilaylik?»: «tizim uni avtomatik lid qilib ochadi va AI darhol javob
 *    tayyorlaydi — bu raqam faqat mijozlar uchun»): a number that exists only
 *    for customers has no private life to protect, and the Telegram chat
 *    itself is the contact — the seller answers in it, the AI drafts in it.
 *    On a PERSONAL number nothing changes: a hidden number stays out of the
 *    tray (there is no number to ask about) and only the AI's «📵» card asks
 *    him (`noteStranger`).
 *
 * The others keep their answers: a group is not a customer, a bot is not a
 * customer, Saved Messages is the manager talking to himself, Telegram's own
 * service chat is login codes, and an excluded chat is a decision somebody
 * already wrote down. `classifyDialog` asks every one of those BEFORE the
 * phone, so `no_phone` is only ever a private, non-bot, non-self person who
 * is not 777000.
 */
export function unknownChatAction(
  verdict: DialogVerdict,
  workAccount: boolean,
): UnknownChatAction {
  if (verdict.keep) return { action: 'skip', reason: 'known' };
  if (verdict.reason === 'not_a_client') return workAccount ? { action: 'open_lead' } : { action: 'ask' };
  if (verdict.reason === 'no_phone' && workAccount) return { action: 'open_lead' };
  return { action: 'skip', reason: verdict.reason };
}

/**
 * The name a hidden-number lead gets when Telegram showed no name and no
 * username either — a placeholder, never a person's name, so the 📌 general
 * fact's name check leaves it out (its words «Telegram», «raqam» are not
 * anybody's name). Both hidden-number doors mint under it: the AI's «📵» card
 * (his Q18 ⭐) and a work number's own lead (his «1 a», 2026-10-29).
 */
export const PHONELESS_LEAD_NAME = 'Telegram (raqam yashirin)';

/** `peerTitle`'s last resort — «#<Telegram id>» — which names a row and never a lead. */
const ID_LABEL = /^#\d+$/;

/**
 * The name a minted lead gets.
 *
 * Telegram's display name when there is one (`peerTitle` already falls back
 * to the @username), then the number, then the placeholder — never an empty
 * string, because a nameless card on the funnel is a card nobody can tell
 * from the next one, and never the chat id: `peerTitle` ends on «#<id>» so a
 * tray row is never blank, and an id on a funnel card is a number nobody can
 * ring that reads like one. A hidden number has no phone to fall back to.
 */
export function leadNameForChat(title: string | null | undefined, phone: string | null): string {
  const clean = (title ?? '').trim();
  if (clean.length > 0 && !ID_LABEL.test(clean)) return clean;
  const number = (phone ?? '').trim();
  return number.length > 0 ? number : PHONELESS_LEAD_NAME;
}
