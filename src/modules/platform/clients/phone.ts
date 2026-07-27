/**
 * Finding a client by the number that is ringing.
 *
 * Every staff-facing lookup matched the code and the name only, so a manager
 * holding a client's phone could not find their card — while the Telegram
 * cabinet had been matching phones correctly since Phase 2.2. This is that
 * same rule, in the one form SQL can use.
 *
 * The rule is the cabinet's (DECISIONS #111): compare the LAST NINE digits.
 * An Uzbek number is nine digits after the country code and the office writes
 * it eight different ways — `+998 90 175-78-00`, `901757800`, `(90) 175 78 00`
 * — so anything else has to guess at a country code, and a wrong guess is what
 * links one person to another person's cargo.
 */

/** Digits only, however the number was typed. */
export function phoneDigits(raw: string): string {
  return raw.replace(/\D/g, '');
}

/**
 * The fragment to search for, or null when the query is not a phone number at
 * all.
 *
 * Five digits is the floor: below it a "phone search" matches half the book
 * and buries the code and name hits the person was actually looking for.
 * Longer queries are cut to the last nine, so a number typed WITH its country
 * code still finds a card stored without one — and the other way round.
 */
export function phoneNeedle(query: string): string | null {
  const digits = phoneDigits(query);
  if (digits.length < 5) return null;
  return digits.slice(-9);
}
