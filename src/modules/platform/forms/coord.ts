import { z } from 'zod';

/**
 * A coordinate box on a form (round 100, 9B).
 *
 * Emptiness is decided BEFORE coercion, and that ordering is the whole
 * reason this helper exists: `z.coerce.number('')` is 0, and 0°N 0°E is a
 * real place in the Atlantic that passes every range check — an empty box
 * left to the naive recipe becomes a stored coordinate that then BEATS the
 * map's built-in point. Empty stays `undefined`, which the caller stores as
 * NULL; a comma decimal is accepted because that is how the office types.
 */
export function coordField(min: number, max: number) {
  return z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z
      .string()
      .trim()
      .transform((v) => v.replace(',', '.'))
      .pipe(z.coerce.number().min(min).max(max))
      .optional(),
  );
}
