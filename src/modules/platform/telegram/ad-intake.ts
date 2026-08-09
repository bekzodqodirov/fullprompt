/**
 * The third door: an advert that points at the bot.
 *
 * `t.me/<bot>?start=ad_instagram` is what an Instagram or Telegram advert can
 * link to when there is no lead form to fill in — and in this market that link
 * is often the whole advert. The person arrives in a chat, so the only thing
 * we need from them is the one thing Telegram can prove: their number.
 *
 * Deliberately tiny. The chat is remembered in memory for half an hour and
 * nothing else about this flow exists: no table, no state machine, no second
 * way to link a client. The contact handler that already serves the cabinet
 * asks whether an advert brought this chat here, and if it did, and the number
 * belongs to nobody we know, the enquiry lands through the same
 * `landInboundLead` the form and the webhook use.
 */

/** How long an advert visit is still the reason this chat is here. */
const TTL_MS = 30 * 60 * 1000;

const visits = new Map<number, { sourceKey: string; at: number }>();

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

export function rememberAdVisit(chatId: number, sourceKey: string): void {
  visits.set(chatId, { sourceKey, at: Date.now() });
}

export function adVisitFor(chatId: number): string | null {
  const visit = visits.get(chatId);
  if (!visit) return null;
  if (Date.now() - visit.at > TTL_MS) {
    visits.delete(chatId);
    return null;
  }
  return visit.sourceKey;
}

export function clearAdVisit(chatId: number): void {
  visits.delete(chatId);
}
