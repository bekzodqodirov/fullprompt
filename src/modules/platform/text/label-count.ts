/**
 * «Клавиатура +2» — a name with a COUNT at its end, and the count is the half
 * that must survive (the owner's item 4, 2026-11-10: «yonida + nechta
 * tarkibligi yozilsin»). A lot's tarkib label is one string everywhere it
 * travels — a list cell, a Telegram button, a push — and everything that
 * shortens a string cuts its END: a CSS `truncate`, a clip at 40 or 80
 * characters. So on a long first name the count was the first thing to go.
 * These three are what a shortener asks instead; pure, importable from the
 * browser, from platform and from wms alike.
 *
 * The count is found in the TEXT, never passed beside it. A warehouse's own
 * name that happens to end in « +2» reads the same characters either way —
 * only what gives way under shortening differs — so nothing here has to know
 * whether the string came from a tarkib.
 */

/** A trailing count: one plain space, «+», one or two digits (a tarkib has at most 20 lines). */
const LABEL_COUNT = /^(.*\S) (\+\d{1,2})$/u;

/** «Клавиатура +2» → `{ name: 'Клавиатура', count: '+2' }`; no count → the text whole. */
export function splitLabelCount(text: string): { name: string; count: string | null } {
  const found = LABEL_COUNT.exec(text);
  return found ? { name: found[1]!, count: found[2]! } : { name: text, count: null };
}

/**
 * At most `max` characters, «…» at the cut, the count KEPT: «Клавиатура
 * проводн… +2». Counted in CODE POINTS like `clipText` (telegram/format.ts) —
 * a `slice` can halve an emoji, and the lone surrogate is refused by jsonb.
 * A text with no count, or a `max` too small to hold a name beside it, is
 * clipped at the end as before.
 */
export function clipKeepingCount(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const { name, count } = splitLabelCount(text);
  const room = count === null ? 0 : max - Array.from(count).length - 2;
  if (count === null || room < 1) return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
  return `${Array.from(name).slice(0, room).join('')}… ${count}`;
}

/**
 * A search needle without a label's count: a person who copies «Клавиатура
 * +2» off a card and pastes it into a search means the goods, and no stored
 * name or tarkib line says «+2».
 */
export function withoutLabelCount(needle: string): string {
  return splitLabelCount(needle.trim()).name;
}
