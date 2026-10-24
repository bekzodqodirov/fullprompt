import { createHash, createHmac } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { getSetting } from '../../platform/settings/service';
import { parseReasonList } from '../../platform/settings/reason-list';
import { AGENT_SOURCE_KEY } from './agent-source';

/**
 * What the client-finding agent may read back (docs/AGENT-FEED.md, the
 * owner's 2026-10-23 split: the agent finds and scores, the ERP holds the
 * leads, the managers and the outcomes).
 *
 * Two feeds and one belt, all on the `agent` door's own key:
 *
 *  - SUPPRESSION — every phone the agent must never propose: the client book
 *    (active AND inactive — a former client is still «bizning mijoz»), and
 *    every lead lost with a reason the owner listed in
 *    `agent_no_contact_reasons` («Qayta qilinmasin»). As HASHES: the agent
 *    holds the secret and can compare its own candidates, but the answer is
 *    not a readable copy of the client book sitting in another system's
 *    database and backups.
 *  - OUTCOMES — what became of each arrival the agent pushed: created /
 *    joined / dropped, the lead's stage, the first contact. Never a name, a
 *    phone, a note, an owner or a price.
 *  - the BELT (`isSuppressedTail`) — the landing's own check, over the SAME
 *    derived table the feed reads, for the push the agent made on a stale
 *    copy.
 *
 * Rules honoured: no transaction anywhere (#714); every instant crosses into
 * SQL as an ISO string with `::timestamptz` (#156) and comes back formatted
 * by postgres (#925 — raw `db.execute` timestamps are TEXT); the label list
 * through `sql.join` (a JS array is not a postgres array); every page ORDERED
 * on a unique key (#524); one statement per page (#432).
 */

export const HASH_RULE = 'hmac-sha256(secret, last9digits) hex[0:20]';
export const FEED_LIMIT_DEFAULT = 1000;
export const FEED_LIMIT_MAX = 5000;
/** How far back the outcomes feed reaches — enough for the agent's 30-day precision and a year's history. */
const OUTCOMES_WINDOW = sql`interval '1 year'`;
/**
 * A lost reason is TEXT the seller chose — the dictionary's label once the
 * owner keeps one, free text before that — so it is clipped rather than
 * trusted to be short.
 */
export const LOST_REASON_MAX = 200;

/** The feed's phone identity: never the digits, only this. */
export function hashTail(secret: string, tail9: string): string {
  return createHmac('sha256', secret).update(tail9).digest('hex').slice(0, 20);
}

/** Changes when the door's key is re-minted — the agent then pulls everything again. */
export function saltIdFor(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

/** The owner's «never again» labels, normalised (`platform/settings/reason-list.ts`). */
export async function noContactReasons(): Promise<string[]> {
  return parseReasonList(await getSetting('agent_no_contact_reasons'));
}

/**
 * A page boundary: the row's instant AS POSTGRES HOLDS IT (microseconds — a
 * JS Date keeps milliseconds, and a cursor cut to the millisecond re-reads
 * the very row it names, which at `limit=1` is a loop that never ends), its
 * id, and `n`, the phone's position on a client card: one client with two
 * phones is two rows with the same instant and id, and a key that cannot
 * tell them apart skips the second at a page edge. Opaque to the agent — it
 * hands back `next` as it got it.
 */
export interface Cursor {
  at: string;
  id: string;
  n: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_MICRO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export const encodeCursor = (c: Cursor): string =>
  Buffer.from(`${c.at}|${c.id}|${c.n}`, 'utf8').toString('base64url');

/** null = absent; 'invalid' = present and unreadable (the route answers 400). Never throws. */
export function decodeCursor(raw: string | null): Cursor | null | 'invalid' {
  if (!raw) return null;
  const parts = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (parts.length !== 2 && parts.length !== 3) return 'invalid';
  const [at, id, n = '0'] = parts as [string, string, string?];
  if (!ISO_MICRO.test(at) || !UUID.test(id) || !/^\d{1,6}$/.test(n)) return 'invalid';
  const ms = Date.parse(at);
  // V8 rolls «02-30» into March; a date that does not survive the round trip
  // is not a date postgres would read the same way.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== at.slice(0, 19))
    return 'invalid';
  return { at, id: id.toLowerCase(), n: Number(n) };
}

/** `?since=` as an ISO instant; null = absent, 'invalid' = present and unreadable. */
export function parseSince(raw: string | null): string | null | 'invalid' {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 'invalid' : new Date(ms).toISOString();
}

/** `?limit=`: absent, zero or garbage → the default; never past the ceiling; whole rows only. */
export const clampLimit = (raw: string | null): number =>
  Math.min(FEED_LIMIT_MAX, Math.max(1, Math.floor(Number(raw)) || FEED_LIMIT_DEFAULT));

/** A timestamp as the feed spells it: UTC, microseconds, `Z`. */
const isoSql = (expr: SQL) =>
  sql`to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/** The same text the reason list is normalised to, on the column side. */
const reasonSql = sql`lower(regexp_replace(btrim(coalesce(l.lost_reason, '')), '\\s+', ' ', 'g'))`;
const tailSql = (expr: SQL) => sql`right(regexp_replace(${expr}, '[^0-9]', '', 'g'), 9)`;

/**
 * THE suppression set as a derived table `(tail, kind, at, id, n)` — the
 * feed's rows and the belt's question, one sentence (#513).
 *
 * `at` is the moment the row last moved, so a delta pull finds a client whose
 * card was edited or a lead re-decided: the client card's `updated_at`, the
 * lead's later of `closed_at` and `updated_at`. What a delta cannot carry is
 * a DELETION, and a label added to the setting (its leads keep their old
 * instant) — the nightly full pull is the truth, the delta an optimisation.
 */
function suppressionTailsSql(labels: string[]): SQL {
  const listed = labels.length
    ? sql`${reasonSql} IN (${sql.join(
        labels.map((label) => sql`${label}`),
        sql`, `,
      )})`
    : sql`false`;
  return sql`(
    SELECT ${tailSql(sql`p.v`)} AS tail, 'client'::text AS kind,
           greatest(c.created_at, c.updated_at) AS at, c.id, p.n::int AS n
      FROM clients c
      -- A phones value that is not an array (by hand, by an old import) is
      -- read as no phones rather than failing the whole page.
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(c.phones) = 'array' THEN c.phones ELSE '[]'::jsonb END
      ) WITH ORDINALITY AS p(v, n)
    UNION ALL
    SELECT ${tailSql(sql`coalesce(l.phone, '')`)}, 'lost'::text,
           greatest(l.closed_at, l.updated_at), l.id, 0
      FROM leads l
      JOIN lead_stages s ON s.id = l.stage_id AND s.kind = 'lost'
     WHERE ${listed}
  )`;
}

export interface SuppressionEntry {
  h: string;
  kind: 'client' | 'lost';
  at: string;
}

export async function suppressionPage(o: {
  secret: string;
  since: string | null;
  cursor: Cursor | null;
  limit: number;
}): Promise<{ entries: SuppressionEntry[]; next: string | null }> {
  const labels = await noContactReasons();
  const c = o.cursor;
  const rows = await db.execute<{
    tail: string;
    kind: 'client' | 'lost';
    at: string;
    id: string;
    n: number;
  }>(sql`
    SELECT t.tail, t.kind, ${isoSql(sql`t.at`)} AS at, t.id::text AS id, t.n
      FROM ${suppressionTailsSql(labels)} t
     WHERE length(t.tail) = 9
       AND (${o.since}::timestamptz IS NULL OR t.at > ${o.since}::timestamptz)
       AND (${c?.at ?? null}::timestamptz IS NULL
            OR (t.at, t.id, t.n) > (${c?.at ?? null}::timestamptz, ${c?.id ?? null}::uuid, ${c?.n ?? 0}::int))
     ORDER BY t.at, t.id, t.n
     LIMIT ${o.limit + 1}`);
  const page = rows.slice(0, o.limit);
  const last = page.at(-1);
  return {
    entries: page.map((r) => ({
      h: hashTail(o.secret, r.tail),
      kind: r.kind,
      at: new Date(r.at).toISOString(),
    })),
    next:
      rows.length > o.limit && last
        ? encodeCursor({ at: last.at, id: last.id, n: Number(last.n) })
        : null,
  };
}

/**
 * The landing belt's question: is this phone in the suppression set? Over the
 * feed's own derived table, so the belt and the feed cannot disagree about a
 * number. `phone` as typed or already cut; the nine digits are taken here.
 */
export async function isSuppressedTail(phone: string, labels: string[]): Promise<boolean> {
  const tail = phone.replace(/[^0-9]/g, '').slice(-9);
  if (tail.length < 9) return false;
  const rows = await db.execute<{ hit: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM ${suppressionTailsSql(labels)} t WHERE t.tail = ${tail}) AS hit`);
  return rows[0]?.hit === true;
}

/** One arrival the agent pushed, as the agent may see it — the 14 fields of docs/AGENT-FEED.md §3. */
export interface OutcomeRow {
  external_id: string;
  intake_id: string;
  outcome: string;
  reason: string | null;
  lead_id: string | null;
  client_id: string | null;
  stage_kind: 'open' | 'won' | 'lost' | null;
  stage_name: string | null;
  lost_reason: string | null;
  closed_at: string | null;
  contacted_at: string | null;
  contact_kind: string | null;
  quoted_volume_m3: number | null;
  at: string;
}

export async function outcomesPage(o: {
  since: string | null;
  cursor: Cursor | null;
  limit: number;
}): Promise<{ rows: OutcomeRow[]; next: string | null }> {
  const c = o.cursor;
  // When the row last moved: the arrival, its first contact, any change on
  // its lead (a stage move, an edit) or the lead's decision.
  const moved = sql`greatest(i.created_at, i.contacted_at, l.updated_at, l.closed_at)`;
  const rows = await db.execute<
    Omit<OutcomeRow, 'quoted_volume_m3'> & { quoted_volume_m3: string | null }
  >(sql`
    SELECT i.external_id, i.id::text AS intake_id, i.outcome, i.reason,
           i.lead_id::text AS lead_id, coalesce(l.client_id, i.client_id)::text AS client_id,
           s.kind AS stage_kind, s.name AS stage_name,
           left(l.lost_reason, ${LOST_REASON_MAX}) AS lost_reason,
           ${isoSql(sql`l.closed_at`)} AS closed_at,
           ${isoSql(sql`i.contacted_at`)} AS contacted_at, i.contact_kind,
           l.quoted_volume_m3::text AS quoted_volume_m3,
           ${isoSql(moved)} AS at
      FROM lead_intakes i
      LEFT JOIN leads l ON l.id = i.lead_id
      LEFT JOIN lead_stages s ON s.id = l.stage_id
     WHERE i.channel = 'webhook'
       AND i.external_id LIKE 'cs:%'
       -- The fallback months: pushes that went through the «Boshqa» door
       -- before the agent's own door existed are the agent's too.
       AND (i.source_key = ${AGENT_SOURCE_KEY}
            OR (i.source_key = 'other' AND i.ref ->> 'utm_source' = 'clientscrapper'))
       AND i.created_at > now() - ${OUTCOMES_WINDOW}
       AND (${o.since}::timestamptz IS NULL OR ${moved} > ${o.since}::timestamptz)
       AND (${c?.at ?? null}::timestamptz IS NULL
            OR (${moved}, i.id) > (${c?.at ?? null}::timestamptz, ${c?.id ?? null}::uuid))
     ORDER BY ${moved}, i.id
     LIMIT ${o.limit + 1}`);
  const cut = rows.slice(0, o.limit);
  const last = cut.at(-1);
  const iso = (value: string | null) => (value === null ? null : new Date(value).toISOString());
  return {
    rows: cut.map((r) => ({
      external_id: r.external_id,
      intake_id: r.intake_id,
      outcome: r.outcome,
      reason: r.reason,
      lead_id: r.lead_id,
      client_id: r.client_id,
      stage_kind: r.stage_kind,
      stage_name: r.stage_name,
      lost_reason: r.lost_reason,
      closed_at: iso(r.closed_at),
      contacted_at: iso(r.contacted_at),
      contact_kind: r.contact_kind,
      // numeric comes back as a string (#503): one conversion, here.
      quoted_volume_m3: r.quoted_volume_m3 === null ? null : Number(r.quoted_volume_m3),
      at: iso(r.at)!,
    })),
    next:
      rows.length > o.limit && last
        ? encodeCursor({ at: last.at, id: last.intake_id, n: 0 })
        : null,
  };
}
