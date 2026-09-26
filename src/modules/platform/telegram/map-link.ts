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
