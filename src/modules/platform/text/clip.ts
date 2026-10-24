/**
 * Text that a stranger sent, made safe for postgres.
 *
 * A JS string can hold two things postgres refuses, and a JSON body carries
 * either outright (`"\ud83d"` and `"\u0000"` are valid JSON, and `JSON.parse`
 * keeps both):
 *
 *  - a LONE surrogate, which jsonb refuses (22P02 «Unicode low surrogate must
 *    follow a high surrogate»). A UTF-16 `slice` makes one too, when it cuts
 *    an emoji in half at the edge.
 *  - NUL (U+0000), which a text column refuses (22021 «invalid byte sequence
 *    for encoding UTF8: 0x00») and jsonb refuses as `\u0000` (22P05).
 *
 * The write that refuses is usually not the first one — an audit row or the
 * arrival's ledger row after the lead's own INSERT — so the record stood
 * half-written (#1106 found it for Telegram copies; `clipText` in
 * `platform/telegram/format.ts` is the same idea with an ellipsis). Both
 * become U+FFFD: one UTF-16 unit for one, so no length and no cut moves.
 *
 * A cut counts UTF-16 units — the budget `slice` always counted — and only
 * backs off a high half left dangling at the edge. So every string the old
 * cut could store comes out spelled exactly as before (a field-map key saved
 * last month still matches next month's arrival), and only the case that used
 * to throw changes (third review, 2026-10-24: a cut by code points spelled a
 * long emoji question one unit longer than the map had stored it).
 *
 * Pure, no imports: the landing, the field map and the activity audit all ask
 * it, and none of them may pull a module graph in for a string rule.
 */

/** Every lone surrogate and every NUL replaced by U+FFFD; anything else comes back unchanged. */
export function storableText(text: string): string {
  return text.toWellFormed().replace(/\u0000/g, '�');
}

/**
 * At most `max` UTF-16 units, `storableText`, and never a high half dangling
 * at the cut — an emoji that does not fit is left out whole. Equal to
 * `text.slice(0, max)` for every text that slice could store.
 */
export function clipUnits(text: string, max: number): string {
  const cut = storableText(text).slice(0, Math.max(0, max));
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * The escapes `JSON.stringify` writes for what jsonb refuses: `\u0000`, and a
 * lone surrogate (since ES2019 a lone half is written as `\udXXX`; a pair is
 * written as the character itself). The backslashes before it are counted: an
 * odd run ends in the escape's own backslash, an even one is escaped
 * backslashes followed by the plain letters «u0000».
 */
const REFUSED_ESCAPE = /(\\+)u(?:0000|d[89a-f][0-9a-f]{2})/gi;

/**
 * A whole JSON value as `JSON.stringify` writes it, with every string — keys
 * too — made storable: each escape jsonb refuses becomes `�`. For the
 * bodies stored whole (an arrival's `ref`). A value that holds neither comes
 * out byte for byte as `JSON.stringify` writes it, and it nests exactly as
 * deep before it throws (a replacer function costs the serialiser stack —
 * measured, it overflowed at half the depth).
 */
export function storableJson(value: unknown): string {
  return JSON.stringify(value).replace(REFUSED_ESCAPE, (escape, slashes: string) =>
    slashes.length % 2 === 1 ? `${slashes.slice(1)}\\ufffd` : escape,
  );
}
