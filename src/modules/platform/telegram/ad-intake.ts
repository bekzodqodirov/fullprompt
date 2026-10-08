import { armWait, dropWait, nowSec, readWait, waitVerdict } from './waits';

/**
 * The third door: an advert that points at the bot.
 *
 * `t.me/<bot>?start=ad_instagram` is what an Instagram or Telegram advert can
 * link to when there is no lead form to fill in — and in this market that link
 * is often the whole advert. The person arrives in a chat, so the only thing
 * we need from them is the one thing Telegram can prove: their number.
 *
 * Deliberately tiny: no state machine, no second way to link a client. The
 * visit is remembered for half an hour as one of the bot's durable waits
 * (0130, Q5 a) — memory first, written through to `telegram_chat_waits` so a
 * deploy between «send your number» and the contact no longer loses a paid
 * enquiry and tells the person «raqam topilmadi». The contact handler that
 * already serves the cabinet asks whether an advert brought this chat here,
 * and if it did, and the number belongs to nobody we know, the enquiry lands
 * through the same `landInboundLead` the form and the webhook use.
 */

/** How long an advert visit is still the reason this chat is here. */
const TTL_MS = 30 * 60 * 1000;

/**
 * `ad_instagram` → `instagram`. Anything else → null.
 *
 * The key is NOT validated against the source list here: `landInboundLead`
 * already coerces an unknown key to «Boshqa», and it must, because a deep-link
 * payload is a stranger's string. Checking it twice in two places is how the
 * two checks end up disagreeing.
 */
export function adSourceFromPayload(payload: string | undefined | null): string | null {
  const match = /^ad[_-]([a-z0-9]{2,16})$/i.exec((payload ?? '').trim());
  return match ? match[1]!.toLowerCase() : null;
}

/** Armed AFTER «send your number» is out, at that prompt's own date; the same advert again keeps the earlier time. */
export function rememberAdVisit(chatId: number, sourceKey: string, armedAt: number = nowSec()): void {
  armWait(chatId, 'ad_visit', { sourceKey }, TTL_MS, armedAt, (prev) => prev.sourceKey === sourceKey);
}

/**
 * The advert that brought this chat, for a contact dated `atSec`. Expiry
 * only: a contact is the person's own number, and the «📱» keyboard can be
 * pressed before a late prompt arrives (judge TG-3).
 */
export function adVisitFor(chatId: number, atSec: number = nowSec()): string | null {
  const visit = readWait<{ sourceKey: string }>(chatId, 'ad_visit');
  if (!visit) return null;
  const verdict = waitVerdict(visit, atSec, false);
  if (verdict === 'expired') {
    dropWait(chatId, 'ad_visit');
    return null;
  }
  return verdict === 'answers' ? visit.payload.sourceKey : null;
}

export function clearAdVisit(chatId: number): void {
  dropWait(chatId, 'ad_visit');
}
