/**
 * Text that a stranger sent, made safe for a `jsonb` column.
 *
 * Postgres's jsonb refuses a LONE surrogate (22P02 «Unicode low surrogate must
 * follow a high surrogate»), and a JS string can hold one two ways: a `slice`
 * that counts UTF-16 units cuts an emoji in half at the edge, and a JSON body
 * may carry one outright (`"\ud83d"` is valid JSON and `JSON.parse` keeps it).
 * Either reaches jsonb through `JSON.stringify`, which writes the lone half as
 * an escape postgres will not read — and the write that throws is usually not
 * the first one (an audit row after the lead's own INSERT), so the record
 * stands half-written (#1106 found it for Telegram copies; `clipText` in
 * `platform/telegram/format.ts` is the same rule with an ellipsis).
 *
 * Pure, no imports: the landing, the field map and the activity audit all ask
 * it, and none of them may pull a module graph in for a string rule.
 */

/** Every lone surrogate replaced by U+FFFD; a well-formed string comes back unchanged. */
export const wellFormed = (text: string): string => text.toWellFormed();

/**
 * At most `max` characters, counted in CODE POINTS, no mark at the cut — never
 * half an emoji, and no lone half left from the input either.
 */
export function clipCodePoints(text: string, max: number): string {
  const safe = text.toWellFormed();
  // A string no longer than `max` UTF-16 units has no more than `max` code
  // points: the common case pays no array.
  if (safe.length <= max) return safe;
  return Array.from(safe).slice(0, Math.max(0, max)).join('');
}

/**
 * A whole JSON value with every string — keys too — made well-formed, as the
 * text `JSON.stringify` would write. For the bodies stored whole (an
 * arrival's `ref`): a value that is already well-formed serialises exactly as
 * before.
 */
export function wellFormedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'string') return v.toWellFormed();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // The replacer sees VALUES; an object's own keys are rebuilt here, and
      // the serialiser then walks the rebuilt object's values through this
      // same function.
      return Object.fromEntries(Object.entries(v).map(([k, inner]) => [k.toWellFormed(), inner]));
    }
    return v;
  });
}
