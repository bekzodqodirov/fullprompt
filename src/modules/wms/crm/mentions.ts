/**
 * @mentions — phase 4, on the note mechanism that already exists.
 *
 * A mention is plain text: the dropdown inserts `@Full Name` and the parser
 * finds it again at save time. No markup, no ids in the text — the note
 * stays a note, readable in Telegram, in exports, in the audit trail. The
 * price is that a hand-typed half-name matches nobody; the dropdown-inserted
 * canonical name is the contract.
 *
 * PURE on purpose (no db, no server imports): the same file serves the
 * server-side parser and the client-side autocomplete, and the whole
 * decision is unit-testable without a database.
 */

export interface MentionPerson {
  id: string;
  name: string;
}

/**
 * Who is named in this text. Longest names claim their span first, so
 * "@Aziz Karimov" is one mention of one person, never "@Aziz" plus a
 * surname; an identical span still matches every holder of a duplicate
 * name — both Azizes get told, which beats guessing. An email's @ is not a
 * mention: the character before must be whitespace or the start.
 */
export function extractMentions(text: string, people: MentionPerson[]): string[] {
  const hay = text.toLowerCase();
  const matched = new Set<string>();
  const taken: [number, number][] = [];
  const sorted = [...people].sort((a, b) => b.name.length - a.name.length);

  for (const person of sorted) {
    const name = person.name.trim();
    if (!name) continue;
    const needle = `@${name.toLowerCase()}`;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      from = at + 1;
      if (at > 0 && !/\s/.test(hay[at - 1]!)) continue;
      const after = hay[at + needle.length];
      if (after !== undefined && /[\p{L}\p{N}]/u.test(after)) continue;
      const end = at + needle.length;
      // A shorter name inside a longer, already-claimed mention is not a
      // second mention; the exact same span (a duplicate full name) is.
      const overlaps = taken.some(([s, e]) => at < e && end > s && !(s === at && e === end));
      if (overlaps) continue;
      taken.push([at, end]);
      matched.add(person.id);
    }
  }
  return [...matched];
}

/** The dropdown's shortlist while somebody is still typing after the @. */
export function mentionCandidates(
  query: string,
  people: MentionPerson[],
  limit = 6,
): MentionPerson[] {
  const q = query.trim().toLowerCase();
  const pool = q ? people.filter((p) => p.name.toLowerCase().includes(q)) : people;
  return pool.slice(0, limit);
}
