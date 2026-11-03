import { createHash, createHmac } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { withoutJit } from '../../platform/db/no-jit';
import { getSetting } from '../../platform/settings/service';
import { parseReasonList, REASON_SPACE_RUN_PG } from '../../platform/settings/reason-list';
import { AGENT_SOURCE_KEY } from './agent-source';

/**
 * What the client-finding agent may read back (docs/AGENT-FEED.md, the
 * owner's 2026-10-23 split: the agent finds and scores, the ERP holds the
 * leads, the managers and the outcomes).
 *
 * Two feeds and one belt, all on the `agent` door's own key:
 *
 *  - SUPPRESSION — every phone the agent must never propose: the client book
 *    (active AND inactive — a former client is still «bizning mijoz»), every
 *    lead that BECAME a client (won, or attached to a code — the attach does
 *    not copy the lead's phone onto the card), and every lead lost with a
 *    reason the owner listed in `agent_no_contact_reasons` («Qayta
 *    qilinmasin»). As HASHES: the agent
 *    holds the secret and can compare its own candidates, but the answer is
 *    not a readable copy of the client book sitting in another system's
 *    database and backups.
 *  - OUTCOMES — what became of each arrival the agent pushed: created /
 *    joined / dropped, the lead's stage, the first contact. Never a name, a
 *    phone, a note, an owner or a price — and a lost reason only when it is a
 *    LABEL (the dictionary's, or the setting's), never a seller's free text.
 *  - the BELT (`isSuppressedTail`) — the landing's own check, over the SAME
 *    derived table the feed reads, for the push the agent made on a stale
 *    copy; matched by the app's own phone rule (`phonesMatch`), so it is
 *    never narrower than the landing's client check below it.
 *
 * Rules honoured: no transaction but `withoutJit`'s one-statement read, and
 * nothing pooled inside it (#714 — the setting is read BEFORE); every instant crosses into
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
 * owner keeps one, free text before that. Only a label leaves
 * (`outcomesPage`), and even a label is clipped rather than trusted to be
 * short.
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

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * `?since=` as a full ISO 8601 instant — date, time AND a zone (`Z` or an
 * offset); null = absent, 'invalid' = present and unreadable. `Date.parse`
 * alone reads «0» as the year 2000 and rolls «02-30» into March, so a since
 * the agent got wrong became a quiet delta from the wrong day (review: the
 * cursor's own round-99 trap, one parameter over). The answer is UTC at
 * postgres's precision: the sub-millisecond digits are kept, not cut.
 */
export function parseSince(raw: string | null): string | null | 'invalid' {
  if (!raw) return null;
  const m = ISO_INSTANT.exec(raw);
  if (!m) return 'invalid';
  const [, y, mo, d, h, mi, sec = '00', frac = ''] = m as unknown as string[];
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    day.getUTCFullYear() !== Number(y) ||
    day.getUTCMonth() !== Number(mo) - 1 ||
    day.getUTCDate() !== Number(d) ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    Number(sec) > 59
  )
    return 'invalid';
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return 'invalid';
  // Offsets are whole minutes, so the digits past the millisecond are the
  // instant's own whatever the zone.
  return `${new Date(ms).toISOString().slice(0, 19)}.${frac.padEnd(6, '0').slice(0, 6)}Z`;
}

/** `?limit=`: absent, zero or garbage → the default; never past the ceiling; whole rows only. */
export const clampLimit = (raw: string | null): number =>
  Math.min(FEED_LIMIT_MAX, Math.max(1, Math.floor(Number(raw)) || FEED_LIMIT_DEFAULT));

/** A timestamp as the feed spells it: UTC, microseconds, `Z`. */
const isoSql = (expr: SQL) =>
  sql`to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
/**
 * A reason's text as `normaliseReason` makes it, on the column side: JS's
 * whitespace class collapsed FIRST, then the single spaces at the edges
 * trimmed, then lower case (`platform/settings/reason-list.ts`; a test holds
 * the two to one answer).
 */
export const reasonTextSql = (expr: SQL) =>
  sql`lower(btrim(regexp_replace(coalesce(${expr}, ''), ${REASON_SPACE_RUN_PG}, ' ', 'g'), ' '))`;
const reasonSql = reasonTextSql(sql`l.lost_reason`);

/** Is the lead's reason one of these labels (already normalised)? `false` for none. */
function listedSql(labels: string[]): SQL {
  return labels.length
    ? sql`${reasonSql} IN (${sql.join(
        labels.map((label) => sql`${label}`),
        sql`, `,
      )})`
    : sql`false`;
}

/**
 * Where ONE phones value splits into several numbers: list punctuation, a
 * line break, two spaces, or a space before a «+». The client form splits on
 * commas only, so «+998 90 … / +998 91 …» is one element — and its last nine
 * digits are only the second number.
 */
const PHONE_SPLIT_PG = '[,;/|\\\\\\r\\n]+|[\\t ]{2,}|[\\t ]+(?=\\+)';

/**
 * Every tail one phones value answers to, as a LATERAL `(tail, o)` — `o` a
 * stable order inside the value:
 *
 *  - the WHOLE value's last nine digits (`o = 0`) — exactly what the app's
 *    own phone rule (`phonesMatch`) reads, so the belt is never narrower than
 *    the landing's client check;
 *  - each split part's last nine (above) — only a part of nine digits or
 *    more: a shorter part («90/283-65-94» → «2836594») is a FRAGMENT of one
 *    number, and matched by suffix it would answer a hundred strangers'
 *    numbers that `phonesMatch` never reads (review, 2026-10-24);
 *  - a part of more than fifteen digits is no single phone (E.164 stops at
 *    15): the client import keeps a multi-number cell as ONE run of digits,
 *    so whole 12-digit «998…» numbers are cut out of it — or, when the run is
 *    NOT made of those, whole 9-digit ones. Never both: three 998 numbers are
 *    36 digits, a multiple of nine too, and their 9-digit chunks («998902836»)
 *    are nobody's phone yet read as valid Uzbek mobiles (review, 2026-10-24).
 *    A run that is neither is read by its last nine only.
 *
 * So the only tails shorter than nine digits are WHOLE values — the card of
 * seven or eight digits `phonesMatch` matches by suffix, which the belt does
 * too; the feed drops them.
 *
 * Read with JIT OFF (`withoutJit`, #1039): postgres estimates a thousand rows
 * for each `regexp_split_to_table` / `generate_series`, so even a twenty-card
 * client book plans past `jit_above_cost`, and the compilation — measured
 * ~0.8 s — was paid on every page and every agent arrival.
 */
const tailsSql = (expr: SQL) => sql`(
  SELECT right(regexp_replace(${expr}, '[^0-9]', '', 'g'), 9) AS tail, 0::bigint AS o
  UNION ALL
  SELECT ch.tail, pt.k * 1000 + ch.c
    FROM regexp_split_to_table(${expr}, ${PHONE_SPLIT_PG}) WITH ORDINALITY AS pt(s, k)
    CROSS JOIN LATERAL (SELECT regexp_replace(pt.s, '[^0-9]', '', 'g') AS d) pd
    CROSS JOIN LATERAL (
      SELECT right(pd.d, 9) AS tail, 0 AS c
       WHERE length(pd.d) >= 9
      UNION ALL
      SELECT substr(pd.d, g.i * 12 + 4, 9), 1 + g.i
        FROM generate_series(0, length(pd.d) / 12 - 1) AS g(i)
       WHERE length(pd.d) > 15 AND length(pd.d) <= 120 AND pd.d ~ '^(998[0-9]{9})+$'
      UNION ALL
      SELECT substr(pd.d, g.i * 9 + 1, 9), 500 + g.i
        FROM generate_series(0, length(pd.d) / 9 - 1) AS g(i)
       WHERE length(pd.d) > 15 AND length(pd.d) <= 120 AND length(pd.d) % 9 = 0
         AND pd.d !~ '^(998[0-9]{9})+$'
    ) ch
   WHERE pd.d <> ''
)`;

/** The digits of a phone text, every separator gone. */
const digitsSql = (expr: SQL) => sql`regexp_replace(${expr}, '[^0-9]', '', 'g')`;

/**
 * The belt's narrowing: only phone texts whose digits CONTAIN the arrival's
 * last seven. Every tail a text yields is a run of its digits (a split drops
 * only separators), and a tail the belt matches — the nine digits, or a
 * seven- or eight-digit suffix of them — holds the last seven; so this drops
 * nothing the belt could answer, and the split, the chunks, the DISTINCT and
 * the numbering run over the handful of texts that can match instead of over
 * the whole client book and lead history. MEASURED on a shaped copy (2,000
 * clients, 1,000 people, 40,000 leads, JIT off): a miss ~240 ms → ~90 ms
 * median (review, 2026-10-24). What is left is one digit pass over every
 * lead's phone — linear in the lead history, and the only thing an index
 * (a migration) could take away. The FEED passes none.
 */
const nearSql = (text: SQL, near7: string | null): SQL =>
  near7 === null ? sql`` : sql`AND strpos(${digitsSql(text)}, ${near7}) > 0`;

/**
 * A record with a `phones` jsonb list (a client card, a person) as `client`
 * rows: its DISTINCT tails, `n` numbering them in their order on the record.
 */
function phoneCardTailsSql(o: {
  from: SQL;
  id: SQL;
  phones: SQL;
  at: SQL;
  where?: SQL;
  near7: string | null;
}): SQL {
  return sql`
    SELECT x.tail, 'client'::text AS kind, x.at, x.id,
           (row_number() OVER (PARTITION BY x.id ORDER BY x.o))::int AS n
      FROM (
        SELECT DISTINCT ON (${o.id}, tl.tail) tl.tail, ${o.at} AS at, ${o.id} AS id,
               p.n * 1000000 + tl.o AS o
          FROM ${o.from}
          -- A phones value that is not an array (by hand, by an old import) is
          -- read as no phones rather than failing the whole page.
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(${o.phones}) = 'array' THEN ${o.phones} ELSE '[]'::jsonb END
          ) WITH ORDINALITY AS p(v, n)
          CROSS JOIN LATERAL ${tailsSql(sql`p.v`)} tl
         WHERE tl.tail <> '' ${o.where ? sql`AND ${o.where}` : sql``} ${nearSql(sql`p.v`, o.near7)}
         ORDER BY ${o.id}, tl.tail, p.n * 1000000 + tl.o
      ) x`;
}

/**
 * THE suppression set as a derived table `(tail, kind, at, id, n)` — the
 * feed's rows and the belt's question, one sentence (#513).
 *
 * Rows: every phone on every client card (active or not), and on the person
 * record that ties several codes together; every lead that
 * became a client — won, or carrying a `client_id` (winLead's attach-by-code
 * links the lead and leaves its phone on the LEAD) — as `client`; every lead
 * lost with a listed reason as `lost`. One kind per lead, so `(at, id, n)`
 * stays unique: `n` numbers a record's DISTINCT tails in their order on it.
 *
 * `at` is the moment the row last moved, so a delta pull finds a client whose
 * card was edited or a lead re-decided: the client card's `updated_at`, the
 * lead's later of `closed_at` and `updated_at`, and a person's later of its
 * own and of every card that holds it — tying a code to a person writes the
 * CARD (`attachClient`), and the person's numbers join the set at that
 * moment, not at the person's own old one (review, 2026-10-24). What a delta
 * cannot carry is a DELETION, and a label added to the setting (its leads
 * keep their old instant) — the nightly full pull is the truth, the delta an
 * optimisation.
 *
 * `near7` (the belt) narrows every branch to the phone texts that can match
 * those seven digits (`nearSql`); null — the feed — reads everything.
 */
function suppressionTailsSql(labels: string[], near7: string | null = null): SQL {
  return sql`(
    ${phoneCardTailsSql({
      from: sql`clients c`,
      id: sql`c.id`,
      phones: sql`c.phones`,
      at: sql`greatest(c.created_at, c.updated_at)`,
      near7,
    })}
    UNION ALL
    -- The PERSON behind several codes (crm/people.ts) keeps a phone list of
    -- its own, seeded from the card and edited apart from it: a client's
    -- second number may live there alone. Only a person who holds a code.
    ${phoneCardTailsSql({
      from: sql`crm_people pp`,
      id: sql`pp.id`,
      phones: sql`pp.phones`,
      at: sql`greatest(pp.created_at, pp.updated_at,
                       (SELECT max(pc.updated_at) FROM clients pc WHERE pc.person_id = pp.id))`,
      where: sql`EXISTS (SELECT 1 FROM clients pc WHERE pc.person_id = pp.id)`,
      near7,
    })}
    UNION ALL
    SELECT y.tail, y.kind, y.at, y.id,
           (row_number() OVER (PARTITION BY y.id ORDER BY y.o))::int
      FROM (
        SELECT DISTINCT ON (l.id, tl.tail) tl.tail,
               CASE WHEN l.client_id IS NOT NULL OR s.kind = 'won' THEN 'client' ELSE 'lost' END AS kind,
               greatest(l.closed_at, l.updated_at) AS at, l.id, tl.o
          FROM leads l
          JOIN lead_stages s ON s.id = l.stage_id
          CROSS JOIN LATERAL ${tailsSql(sql`coalesce(l.phone, '')`)} tl
         WHERE tl.tail <> ''
           AND (l.client_id IS NOT NULL OR s.kind = 'won' OR (s.kind = 'lost' AND ${listedSql(labels)}))
           ${nearSql(sql`coalesce(l.phone, '')`, near7)}
         ORDER BY l.id, tl.tail, tl.o
      ) y
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
}): Promise<{ entries: SuppressionEntry[]; next: string | null; resume: string | null }> {
  const labels = await noContactReasons();
  const c = o.cursor;
  const rows = await withoutJit((exec) =>
    exec.execute<{
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
     LIMIT ${o.limit + 1}`),
  );
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
    resume: resumeAfter(last ? { at: last.at, id: last.id, n: Number(last.n) } : null, c),
  };
}

/**
 * Where the NEXT walk starts: the last row's own cursor, even on the last
 * page (where `next` is null) — or, on a page that came back empty, the
 * cursor the caller sent. Without it a walk that reached the end holds only
 * the previous page's `next` and re-reads that page every night; and a row's
 * printed `at` is cut to milliseconds, so a cursor built from it is a floor,
 * not the row (review, feed lens).
 */
function resumeAfter(last: Cursor | null, sent: Cursor | null): string | null {
  const at = last ?? sent;
  return at ? encodeCursor(at) : null;
}

/**
 * The landing belt's question: is this phone in the suppression set? Over the
 * feed's own derived table, so the belt and the feed cannot disagree about a
 * number — narrowed to the phone texts holding the arrival's last seven
 * digits (`nearSql`, which drops nothing the belt could match). `phone` as
 * typed or already cut; the nine digits are taken here.
 *
 * Only a WHOLE phones value shorter than nine digits answers by suffix — the
 * table yields no shorter tail (a fragment of one number is no number).
 *
 * Matched by `phonesMatch`'s rule, not by the feed's nine digits alone: a
 * card holding seven or eight digits (a truncated import, a number typed
 * without its code) answers the arrival whose last seven or eight are the
 * same. The landing's client check below the belt reads phones that way, so
 * a narrower belt let such a push land on the client's card and tell the
 * client's manager (review, three lenses). The FEED cannot carry those — its
 * rule is nine digits and the agent's gate hashes nine — so for them the belt
 * is the only guard, and it holds.
 */
export async function isSuppressedTail(phone: string, labels: string[]): Promise<boolean> {
  const tail = phone.replace(/[^0-9]/g, '').slice(-9);
  if (tail.length < 9) return false;
  const rows = await withoutJit((exec) =>
    exec.execute<{ hit: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM ${suppressionTailsSql(labels, tail.slice(-7))} t
         WHERE t.tail = ${tail}
            OR (length(t.tail) IN (7, 8) AND right(${tail}, length(t.tail)) = t.tail)
      ) AS hit`),
  );
  return rows[0]?.hit === true;
}

/** One arrival the agent pushed, as the agent may see it — the 15 fields of docs/AGENT-FEED.md §3. */
export interface OutcomeRow {
  external_id: string;
  intake_id: string;
  outcome: string;
  reason: string | null;
  lead_id: string | null;
  client_id: string | null;
  stage_kind: 'open' | 'won' | 'lost' | null;
  stage_name: string | null;
  /** The reason only when it is a LABEL — the dictionary's or the setting's; a seller's free text is null. */
  lost_reason: string | null;
  /** Lost with a reason `agent_no_contact_reasons` lists — the ERP's own answer, so the agent mirrors no list. */
  no_contact: boolean;
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
}): Promise<{ rows: OutcomeRow[]; next: string | null; resume: string | null }> {
  const labels = await noContactReasons();
  const c = o.cursor;
  // A reason leaves only as a label: one of the owner's dictionary rows
  // (active or retired — an owner's word either way), or one the setting
  // lists. Before the dictionary exists a lost reason is whatever a seller
  // typed, and that is where a name or a number gets written down
  // («Akmal aka +998 90 …»): the privacy line is «never a name, a phone».
  const labelled = sql`(${listedSql(labels)} OR EXISTS (
    SELECT 1 FROM lost_reasons lr WHERE ${reasonTextSql(sql`lr.label`)} = ${reasonSql}))`;
  // When the row last moved: the arrival, its first contact, any change on
  // its lead (a stage move, an edit) or the lead's decision.
  const moved = sql`greatest(i.created_at, i.contacted_at, l.updated_at, l.closed_at)`;
  const rows = await db.execute<
    Omit<OutcomeRow, 'quoted_volume_m3'> & { quoted_volume_m3: string | null }
  >(sql`
    SELECT i.external_id, i.id::text AS intake_id, i.outcome, i.reason,
           i.lead_id::text AS lead_id, coalesce(l.client_id, i.client_id)::text AS client_id,
           s.kind AS stage_kind, s.name AS stage_name,
           CASE WHEN l.lost_reason IS NOT NULL AND ${labelled}
                THEN left(l.lost_reason, ${LOST_REASON_MAX}) END AS lost_reason,
           coalesce(s.kind = 'lost' AND ${listedSql(labels)}, false) AS no_contact,
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
      no_contact: r.no_contact === true,
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
    resume: resumeAfter(last ? { at: last.at, id: last.intake_id, n: 0 } : null, c),
  };
}
