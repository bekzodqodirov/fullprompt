/**
 * Telegram's 4096 characters, one home (docs/SAKKIZ-R3.md K15). Moved out of
 * `ai-reply.ts` so the bot's line table (P3) fits by the same rule as the AI
 * answer; zero imports, so a pure module on either side may read it.
 */

/** Telegram refuses a message past this; the caller never sends a longer one. */
export const TELEGRAM_LIMIT = 4096;
/** Past this many lines the list collapses — with a count, never in silence. */
export const MAX_REPLY_LINES = 25;

/**
 * Within Telegram's cap WITHOUT losing the end (§2.9).
 *
 * The head and the tail — the totals, the road, the JAMI, the caveat, the
 * legend, the link — are what the seller acts on and repeats; a trailing
 * `slice` cut exactly those off a long invoice and kept the lines. So the
 * LINE LIST shrinks, with «… va yana N ta qator», until the text fits, and a
 * slice is the last resort for a single head line longer than the cap.
 *
 * `maxLines`: the reply keeps the default; the table passes `Infinity`
 * (every line of it is a question the seller may answer, product-fit-10).
 */
export function fitTelegram(
  head: string[],
  lines: string[],
  fixed: string[],
  tail: string[],
  opts: { maxLines?: number } = {},
): string {
  const maxLines = opts.maxLines ?? MAX_REPLY_LINES;
  for (let k = Math.min(lines.length, maxLines); k >= 0; k -= 1) {
    const more = lines.length > k ? [`… va yana ${lines.length - k} ta qator`] : [];
    const text = [...head, ...lines.slice(0, k), ...more, ...fixed, ...tail].join('\n');
    if (text.length <= TELEGRAM_LIMIT) return text;
  }
  const text = [...head, ...fixed, ...tail].join('\n');
  return text.length <= TELEGRAM_LIMIT ? text : `${text.slice(0, TELEGRAM_LIMIT - 20)}\n… (qisqartirildi)`;
}
