/**
 * What the person typed, before any database is touched.
 *
 * Kept pure and separate because the shape of a query decides which searches
 * run at all: `GS777-A` is a lot and nothing else, a batch code is a batch,
 * and nine digits are a phone number rather than a name. Getting that wrong
 * is the difference between one indexed lookup and eight table scans on every
 * keystroke of a live-updating box.
 */

/** Shorter than this is noise: two letters match half the client book. */
export const MIN_QUERY = 2;

export interface ParsedQuery {
  /** Trimmed, never empty when `ok` is true. */
  text: string;
  ok: boolean;
  /** `gs777-a` → the lot of client GS777, letter A. */
  lot?: { clientCode: string; letter: string };
  /** The last nine digits, when what was typed looks like a phone number. */
  phone?: string;
  /** Looks like a client code (letters then digits) — search codes first. */
  clientCode?: boolean;
  /** Looks like a batch code (`YW-001`, `TAS-2026-014`). */
  batchCode?: boolean;
}

export function parseQuery(raw: string): ParsedQuery {
  const text = raw.trim();
  if (text.length < MIN_QUERY) return { text, ok: false };

  const upper = text.toUpperCase();

  // The combined form the warehouse says out loud: client code, dash, letter.
  const lot = upper.match(/^([A-Z]+\d+)-([A-Z]{1,2})$/);
  if (lot) return { text, ok: true, lot: { clientCode: lot[1]!, letter: lot[2]! } };

  const digits = text.replace(/[^0-9]/g, '');
  // Nine is the length of an Uzbek subscriber number, and the same rule the
  // client book and the cabinet check already use (#111) — a shorter run of
  // digits is a code or a quantity, not somebody's phone.
  const phone = digits.length >= 9 ? digits.slice(-9) : undefined;

  return {
    text,
    ok: true,
    ...(phone ? { phone } : {}),
    clientCode: /^[A-Za-z]{1,4}\d+$/.test(text),
    batchCode: /^[A-Za-z]{2,4}-[\d-]+$/.test(text),
  };
}

/** The `%needle%` for an ILIKE, with the wildcards escaped out of the input. */
export function likeNeedle(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}
