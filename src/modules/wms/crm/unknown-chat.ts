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
 *    a customer and becomes a lead by itself;
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
 * Only ONE refusal is reconsidered here — `not_a_client`, which means «a real
 * private chat with a real number that is in no book». The others are not
 * about acquaintance and must keep their answers: a group is not a customer,
 * a bot is not a customer, Saved Messages is the manager talking to himself,
 * an excluded chat is a decision somebody already wrote down, and `no_phone`
 * cannot become a lead worth having — a lead nobody can ring is a row with a
 * name in it.
 */
export function unknownChatAction(
  verdict: DialogVerdict,
  workAccount: boolean,
): UnknownChatAction {
  if (verdict.keep) return { action: 'skip', reason: 'known' };
  if (verdict.reason !== 'not_a_client') return { action: 'skip', reason: verdict.reason };
  return workAccount ? { action: 'open_lead' } : { action: 'ask' };
}

/**
 * The name a minted lead gets.
 *
 * Telegram's display name when there is one, and the number when there is
 * not — never an empty string, because a nameless card on the funnel is a
 * card nobody can tell from the next one. The number is already known here:
 * `not_a_client` is only reached once the phone was visible.
 */
export function leadNameForChat(title: string | null | undefined, phone: string): string {
  const clean = (title ?? '').trim();
  return clean.length > 0 ? clean : phone;
}
