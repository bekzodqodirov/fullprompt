/**
 * «🗺 Xaritada» under a client-code answer in the staff bot (item 12): the
 * site's /map narrowed to that client (`?mijoz=`), opened in the phone's
 * browser with the person's own session — a URL button, never a Mini App,
 * because the map is a staff page behind a login and `web_app` would open it
 * with no cookie at all.
 *
 * Public HTTPS only, the cabinet button's rule (#275): Telegram refuses a
 * button pointing at localhost, and a refused keyboard takes the ANSWER down
 * with it — the text must never depend on the button.
 */
export function clientMapKeyboard(
  appUrl: string | undefined,
  clientCode: string,
): { inline_keyboard: { text: string; url: string }[][] } | null {
  const base = (appUrl ?? '').trim().replace(/\/+$/, '');
  if (!base.startsWith('https://') || !clientCode) return null;
  return {
    inline_keyboard: [
      [{ text: '🗺 Xaritada', url: `${base}/map?mijoz=${encodeURIComponent(clientCode)}` }],
    ],
  };
}

/**
 * A phone as the number `t.me/+…` opens a chat with: international digits
 * only. A bare nine-digit Uzbek number gains its country code; anything
 * shorter cannot be a reachable number and gets no button.
 */
export function telegramPhoneUrl(phone: string): string | null {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 9) digits = `998${digits}`;
  if (digits.length < 10 || digits.length > 15) return null;
  return `https://t.me/+${digits}`;
}

/**
 * The buttons under a client-code answer: «🗺 Xaritada» (item 12) and one
 * «💬» per phone — Telegram's own `t.me/+<number>` link, which opens a chat
 * with whoever holds that number when their privacy allows it (the owner,
 * 2026-09-26: «linkga ohshab chiqsin chatga otib ketgani»). Null when there
 * is nothing to offer, so the answer goes out with no keyboard at all.
 */
export function clientAnswerKeyboard(
  appUrl: string | undefined,
  answer: { mapClientCode?: string; phones?: string[] },
): { inline_keyboard: { text: string; url: string }[][] } | null {
  const rows: { text: string; url: string }[][] = [];
  const map = answer.mapClientCode ? clientMapKeyboard(appUrl, answer.mapClientCode) : null;
  if (map) rows.push(...map.inline_keyboard);
  for (const phone of answer.phones ?? []) {
    const url = telegramPhoneUrl(phone);
    if (url) rows.push([{ text: `💬 ${phone}`, url }]);
  }
  return rows.length ? { inline_keyboard: rows } : null;
}
