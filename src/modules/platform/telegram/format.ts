import { MAX_MESSAGE_CHARS, splitMessage } from './limits';

/**
 * Telegram HTML — built from escaped parts, never trusted from a string.
 *
 * Until round C every message the bot sent was plain text: no bold, no
 * layout, a wall of lines where the one number a customer wants sits in the
 * same weight as the warehouse code under it. HTML is what makes a message
 * readable at a glance, and it is also the one formatting mode where a single
 * unescaped `<` in a goods name makes Telegram refuse the WHOLE message — so
 * the rule is structural rather than remembered:
 *
 *   every helper here takes HTML that is ALREADY safe, and the only way a
 *   typed value (a client's name, a product, a note, a model's answer) gets
 *   in is through `h()`.
 *
 * Stored texts stay plain. `payload.text` has readers that are not Telegram —
 * the lenta, the forwarded offer, a dozen tests — so markup is added at the
 * moment of SENDING, from values, and a stored string is only ever escaped
 * whole (`plainAsHtml`).
 *
 * Pure: no imports but the limits, so the wording tests need nothing.
 */

/** The three characters Telegram's HTML mode needs escaped in text. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A typed value, made safe for a message body. */
export function h(value: string | number | null | undefined): string {
  return escapeHtml(value === null || value === undefined ? '' : String(value));
}

/** Bold — the argument is already-safe HTML. */
export function b(html: string): string {
  return html === '' ? '' : `<b>${html}</b>`;
}

/** Italic — the argument is already-safe HTML. */
export function i(html: string): string {
  return html === '' ? '' : `<i>${html}</i>`;
}

/** Monospace — codes a person copies (a receipt number, a client code). */
export function code(html: string): string {
  return html === '' ? '' : `<code>${html}</code>`;
}

/**
 * A link, only to a place Telegram will open. Anything else — an empty
 * `APP_URL`, a `http://localhost` in CI, a relative path — prints the text
 * alone: a refused link would take the whole message down with it, and the
 * sentence must never depend on the link (map-link.ts's rule).
 */
export function a(href: string | null | undefined, textHtml: string): string {
  const url = (href ?? '').trim();
  if (!/^(https:\/\/|tg:\/\/)/.test(url)) return textHtml;
  return `<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${textHtml}</a>`;
}

/**
 * The same message with the markup removed — the fallback Telegram gets when
 * it refuses to parse, and the thing its limits are measured against.
 */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * How long Telegram will think this is. The 4096 and 1024 ceilings count the
 * PARSED text, in UTF-16 units (`String.length`), not the markup.
 */
export function visibleLength(html: string): number {
  return htmlToPlain(html).length;
}

/**
 * At most `max` characters with «…» at the cut, counted in CODE POINTS. A
 * `slice` counts UTF-16 units and can halve an emoji: the lone surrogate it
 * leaves is refused by postgres's jsonb (a staff copy IS a `payload.text`, so
 * the customer's message was lost with an error) and drawn as a box by
 * Telegram (round C review, CONV-2/PA-3). Whitespace is left as it came.
 */
export function clipText(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : text;
}

/**
 * A stored plain text, sent as HTML: escaped whole, its first line bolded.
 *
 * This is how the staff drain turns thirty-odd pre-rendered messages into
 * something with a title without touching one of them: every character that
 * was typed stays typed, and the only markup is the one pair this adds.
 */
export function plainAsHtml(text: string, opts: { boldTitle?: boolean } = {}): string {
  const safe = escapeHtml(text);
  if (!opts.boldTitle) return safe;
  const nl = safe.indexOf('\n');
  const title = nl === -1 ? safe : safe.slice(0, nl);
  const rest = nl === -1 ? '' : safe.slice(nl);
  return title.trim() === '' ? safe : `${b(title)}${rest}`;
}

const NBSP = ' ';

/**
 * Kilos and cubic metres as the CUSTOMER reads them, on every surface — the
 * push, the bot's «📦 Yuklarim», the Mini App's lot cards, totals and handover
 * history. A box's weight is a SHARE of its lot's, so a raw figure carries as
 * many places as the division gives; rounding it in one place and printing it
 * raw in another made the push and the app one tap apart disagree (round C
 * review). Two places for kilos, three for m³ (two turned a 0.004 m³ lot into
 * «0 m³»).
 */
export function roundKg(value: number): number {
  return Math.round(value * 100) / 100;
}

export function roundM3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * A box's weight (or volume) is its lot's SHARE — the lot is weighed once,
 * never box by box — and the share is computed ONE way: total × n ÷ boxes.
 * `n × (total ÷ boxes)` and `total × (n ÷ boxes)` are the same number on paper
 * and land on opposite sides of a half-hundredth in floating point (10.1 kg,
 * 7 of 20 boxes: 3.54 against 3.53), which is two figures one tap apart even
 * through the same `roundKg` (round C review, second pass).
 */
export function shareOf(total: number, n: number, of: number): number {
  if (of <= 0) return 0;
  // The whole lot is its typed total, exactly: `(0.1125 × 9) ÷ 9` is
  // 0.11249999999999999 in floating point, which rounds to 0.112 under a
  // «qabul qilindi» push that printed the stored 0.113 (round C review,
  // third pass).
  if (n === of) return total;
  return (total * n) / of;
}

/**
 * A total the customer can add up: the sum of the lines AS PRINTED. Summing
 * the raw shares and rounding once made a push's «Jami» 0.189 m³ under two
 * lines of 0.095, and the Mini App (which sums its rounded lot cards) 0.19.
 */
export function sumRounded(values: readonly number[], round: (v: number) => number): number {
  return round(values.reduce((acc, v) => acc + round(v), 0));
}

/**
 * «12 845.5» — thousands grouped with a no-break space, so a number never
 * wraps across a line on a phone and a customer reads «12 845» and not
 * «12845». `decimals` fixes the places (money); without it up to three are
 * kept and trailing zeros dropped (kilos, cubic metres).
 *
 * A dot for the decimal, in every language: the rest of the app, the
 * warehouse screens and every printed document already write it that way,
 * and two conventions on one screen is worse than either.
 */
export function groupDigits(value: number, decimals?: number): string {
  if (!Number.isFinite(value)) return '0';
  const negative = value < 0;
  const abs = Math.abs(value);
  let fixed = decimals === undefined ? String(Math.round(abs * 1000) / 1000) : abs.toFixed(decimals);
  // `String()` switches to exponent notation for tiny values; the weights here
  // never need it, and «1e-7 kg» is not a thing to show a customer.
  if (fixed.includes('e')) fixed = abs.toFixed(decimals ?? 3).replace(/\.?0+$/, '');
  const [whole = '0', frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const out = frac ? `${grouped}.${frac}` : grouped;
  return negative && out !== '0' ? `-${out}` : out;
}

/** «$1 250.00» — dollars, always two places, the sign before the symbol. */
export function usd(value: number): string {
  const body = groupDigits(Math.abs(value), 2);
  return value < 0 && body !== '0.00' ? `-$${body}` : `$${body}`;
}

/**
 * «🟩🟩🟩⬜⬜» — where the cargo is on its five-step road, drawn with
 * characters every phone renders in colour. `step` is 0-based; a step at or
 * past the end is all green (handed over).
 */
export function stepBar(step: number, total: number): string {
  const done = Math.max(0, Math.min(total, step + 1));
  return '🟩'.repeat(done) + '⬜'.repeat(total - done);
}

/**
 * Pack whole blocks into as few messages as fit — never splitting a block,
 * so no tag is ever cut in half. Each block must be self-contained HTML (no
 * tag opened in one and closed in another). One block larger than a message
 * on its own is the only thing ever cut, and it is cut as PLAIN text, because
 * a cut through markup is a message Telegram refuses.
 *
 * `limit` counts visible characters and stays under 4096 with room for the
 * markup Telegram does not count but a careless edit might add.
 */
export function packHtmlBlocks(
  blocks: string[],
  limit = MAX_MESSAGE_CHARS - 296,
  separator = '\n\n',
): string[] {
  const out: string[] = [];
  let current = '';
  const flush = () => {
    if (current !== '') out.push(current);
    current = '';
  };
  for (const block of blocks) {
    if (block === '') continue;
    if (visibleLength(block) > limit) {
      flush();
      for (const piece of splitMessage(htmlToPlain(block), limit)) out.push(escapeHtml(piece));
      continue;
    }
    const candidate = current === '' ? block : `${current}${separator}${block}`;
    if (visibleLength(candidate) > limit) {
      flush();
      current = block;
    } else {
      current = candidate;
    }
  }
  flush();
  return out;
}
