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

  // ROUND 112 — the counter. The group rule below reads the whole book and
  // follows its densest run, and his imported Kashgar markings form a ladder
  // above the real sequence (470…712, each within 50 of the next), so the
  // sequence «continued» 446 → 713 by itself. A number that only the
  // generator advances cannot be pulled anywhere by what people type.
  //
  // Read AND written on the TRANSACTION handle, never through getSetting/
  // setSetting: those run on the pool, and a pooled call inside a transaction
  // that already holds a connection is #714's total freeze. Unset (or not a
  // whole number) means the rule below runs unchanged — nothing moves until
  // he types the start on /admin/settings.
  const counter = await readCounter(tx);
  if (counter !== null) {
    const taken = new Set(numbers);
    // A marking on unclaimed cargo is a number somebody wrote on a carton
    // that may become a code the day the cargo is claimed — handing it to a
    // stranger first would put two customers on one label.
    for (const n of await unclaimedNumbers(tx, prefix)) taken.add(n);
    let n = counter;
    while (taken.has(n)) n += 1;
    await writeCounter(tx, n + 1);
    return `${prefix}${n}`;
  }
  return `${prefix}${nextClientNumber(numbers)}`;
}

const COUNTER_KEY = 'client_code_next';

async function readCounter(tx: Db | Tx): Promise<number | null> {
  const rows = (await tx.execute(
    sql`SELECT value FROM settings WHERE key = ${COUNTER_KEY}`,
  )) as unknown as { value: unknown }[];
  const raw = rows[0]?.value;
  const text = typeof raw === 'string' ? raw.trim() : raw === null || raw === undefined ? '' : String(raw);
  // Whole digits only. «gs451» or «4 51» is a typo, and a typo must read as
  // «not set» rather than as NaN walking the taken-set loop for ever (#762).
  if (!/^[0-9]{1,9}$/.test(text)) return null;
  return Number(text);
}

async function writeCounter(tx: Db | Tx, next: number): Promise<void> {
  // The settings row's value is jsonb; the setting is a STRING everywhere
  // else (the admin screen types it), so it is stored as one here too.
  await tx.execute(sql`
    INSERT INTO settings (key, value, updated_at)
    VALUES (${COUNTER_KEY}, to_jsonb(${String(next)}::text), now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `);
}

/** Numbers written on UNCLAIMED cargo under this prefix (`GS470`, `GS500MANIKEN-AL`). */
async function unclaimedNumbers(tx: Db | Tx, prefix: string): Promise<number[]> {
  const pattern = `^${escapeRegex(prefix)}([0-9]+)`;
  const rows = (await tx.execute(sql`
    SELECT DISTINCT (regexp_match(upper(unclaimed_marking), ${pattern}))[1] AS n
    FROM receipts
    WHERE client_id IS NULL AND unclaimed_marking IS NOT NULL
      AND status <> 'void'
      AND upper(unclaimed_marking) ~ ${pattern}
  `)) as unknown as { n: string | null }[];
  return rows.map((r) => Number(r.n)).filter((n) => Number.isSafeInteger(n));
}
