import { sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';

/** A code more than this far above its predecessor starts a new group. */
const GROUP_GAP = 50;

/**
 * Auto-assigned client codes continue the MAIN sequence (owner's report:
 * codes run 1..425, but one-off manual markings like 777/5564/5909 exist —
 * plain MAX+1 jumped to 5910 instead of 426).
 *
 * The numbers are split into groups (a gap over GROUP_GAP starts a new one);
 * the biggest group is the main sequence — ties go to the higher group — and
 * the next code is the first free number above it. Isolated special codes
 * form one-member groups and are stepped over instead of dragging the
 * counter with them.
 */
export function nextClientNumber(existing: number[]): number {
  const uniq = [...new Set(existing.filter((n) => Number.isSafeInteger(n) && n > 0))].sort(
    (a, b) => a - b,
  );
  if (uniq.length === 0) return 100; // fresh install: {prefix}100

  const groups: number[][] = [[uniq[0]!]];
  for (let i = 1; i < uniq.length; i += 1) {
    const value = uniq[i]!;
    const group = groups[groups.length - 1]!;
    if (value - group[group.length - 1]! > GROUP_GAP) groups.push([value]);
    else group.push(value);
  }
  // Biggest group wins; on a tie the higher one does (scattered one-off codes
  // then behave exactly like the old MAX+1 rule).
  const main = groups.reduce((best, g) => (g.length >= best.length ? g : best));

  const taken = new Set(uniq);
  let next = main[main.length - 1]! + 1;
  while (taken.has(next)) next += 1;
  return next;
}

/** Regex-escape the admin-configured prefix before it enters a POSIX pattern. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * Next sequential client code for the configured prefix. Runs under an
 * advisory transaction lock so two concurrent auto-creates never collide.
 */
export async function nextClientCode(tx: Db | Tx, rawPrefix: string): Promise<string> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('client_code_seq'))`);
  // Stored codes are uppercase (clients_code_upper_check) — a lowercase
  // prefix setting must not generate codes the DB then rejects.
  const prefix = rawPrefix.toUpperCase();
  const pattern = `^${escapeRegex(prefix)}[0-9]+$`;
  // Suffix taken by prefix LENGTH, not by a trailing-digits regex: a prefix
  // that itself ends in a digit (GS2) must not swallow its own last char.
  // substr(), not substring(... from $1) — the latter resolves to the REGEX
  // overload when the offset is a bound parameter and silently returns junk.
  const rows = (await tx.execute(sql`
    SELECT substr(client_code, ${prefix.length + 1})::bigint AS n
    FROM clients
    WHERE client_code ~ ${pattern}
  `)) as unknown as { n: string | number }[];
  const numbers = rows.map((r) => Number(r.n));
  return `${prefix}${nextClientNumber(numbers)}`;
}
