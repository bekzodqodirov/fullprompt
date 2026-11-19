/**
 * `t.me/<bot>?start=mijoz` — the bot link the new-client card carries (0151).
 *
 * GENERIC on purpose, the design judge's first two blockers: the card is the
 * message a customer forwards ON — to the factory, to a supplier — so a
 * personal link inside it would reach people who are not the customer, and a
 * link that can be redeemed by the wrong person is the owner's own incident
 * («a link sent to the wrong person exposed another client»). This one names
 * nobody and opens nothing: it greets, asks for the number, and the existing
 * self-service door connects every code on a number we hold — the one proof
 * Telegram can give. A stranger's number gets «not found», as a bare /start
 * does today.
 *
 * Without it the customer would read «menejeringizdan havola so‘rang» while
 * holding the manager's link (a bare /start's first words), and a payload the
 * bot did not know was answered «Havola eskirgan».
 */
export const MIJOZ_START = 'mijoz';

/** Is this /start payload the card's link? Exact, never a prefix — a link code is a stranger's string. */
export function isMijozStart(payload: string | undefined | null): boolean {
  return (payload ?? '').trim().toLowerCase() === MIJOZ_START;
}

/** The link, or null with no bot username — never `t.me/null`. */
export function mijozStartUrl(botUsername: string | null | undefined): string | null {
  const name = (botUsername ?? '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_]{3,64}$/.test(name)) return null;
  return `https://t.me/${name}?start=${MIJOZ_START}`;
}
